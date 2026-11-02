/**
 * dsh-parallel-worktree — worktree 生命周期管理器（无宿主依赖，可直接单测）。
 *
 * 设计取舍：
 * - 默认 sibling 布局 <repo>.wt/：worktree 与注册表都在仓库之外，主仓库永远
 *   不出现 untracked 目录；inside 布局才写 <repo>/.worktrees/ 并自动 .gitignore。
 * - 分支命名默认 wt/<name>（可配）；worktree 是正常 branch checkout，agent
 *   可自由 commit / rebase / merge。
 * - 收尾动作按「先移除 checkout，再删分支」排序，避免 git 拒绝删除被占用分支。
 * - 写注册表前后加文件锁；每次变更立即原子落盘，进程崩溃不丢账。
 *
 * @module dsh-parallel-worktree/manager
 */
import fs from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { WorktreeError, isValidRefName, nowIso } from './util.js'
import { emptyManifest, manifestPathFor, readManifest, withManifestLock, writeManifest } from './manifest.js'

export const DEFAULT_DIR_NAME = '.worktrees'
export const DEFAULT_BRANCH_PREFIX = 'wt/'
export const DEFAULT_COPY_ENV = ['.env', '.env.local']
export const WORKTREE_STATES = ['active', 'merged', 'missing']

function realpathOr(value) {
  try {
    return realpathSync(value)
  } catch {
    return value
  }
}

function samePath(left, right) {
  const a = path.resolve(realpathOr(left))
  const b = path.resolve(realpathOr(right))
  if (process.platform === 'win32') return a.toLowerCase() === b.toLowerCase()
  return a === b
}

function isInside(parent, child) {
  if (samePath(parent, child)) return true
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function tail(text, lines = 3) {
  const parts = String(text ?? '').split('\n').filter((line) => line.trim() !== '')
  return parts.slice(-lines).join(' | ')
}

/**
 * 创建管理器。
 * @param options
 * @param options.git GitRunner（必需）
 * @param options.layout 'sibling' | 'inside'
 * @param options.dirName inside 布局目录名，默认 .worktrees
 * @param options.siblingSuffix sibling 布局后缀，默认 .wt
 * @param options.branchPrefix 分支前缀，默认 wt/（空串表示直接用 name）
 * @param options.copyEnv 创建时从主仓库复制的环境文件列表
 * @param options.linkNodeModules 是否默认把主仓库 node_modules 链接进新 worktree
 * @param options.syncMode 'rebase' | 'merge'
 * @param options.baseBranch 显式指定基准分支（缺省自动探测）
 */
export function createWorktreeManager(options = {}) {
  const git = options.git
  if (typeof git !== 'function') {
    throw new Error('createWorktreeManager 需要 git runner 函数')
  }
  const layout = options.layout === 'inside' ? 'inside' : 'sibling'
  const dirName = typeof options.dirName === 'string' && options.dirName.trim() !== ''
    ? options.dirName.trim()
    : DEFAULT_DIR_NAME
  const siblingSuffix = typeof options.siblingSuffix === 'string' && options.siblingSuffix !== ''
    ? options.siblingSuffix
    : '.wt'
  const branchPrefix = options.branchPrefix === ''
    ? ''
    : (typeof options.branchPrefix === 'string' ? options.branchPrefix : DEFAULT_BRANCH_PREFIX)
  const copyEnv = Array.isArray(options.copyEnv)
    ? options.copyEnv.filter((file) => typeof file === 'string' && file !== '')
    : DEFAULT_COPY_ENV
  const defaultLinkNodeModules = options.linkNodeModules === true
  const defaultSyncMode = options.syncMode === 'merge' ? 'merge' : 'rebase'
  const baseBranchOverride = typeof options.baseBranch === 'string' && options.baseBranch.trim() !== ''
    ? options.baseBranch.trim()
    : null

  function fail(code, message, hint) {
    throw new WorktreeError(code, message, hint)
  }

  async function run(args, cwd, signal, opts) {
    return git(args, cwd, signal, opts)
  }

  function rootFor(repoRoot) {
    if (layout === 'inside') return path.join(repoRoot, dirName)
    return path.join(path.dirname(repoRoot), path.basename(repoRoot) + siblingSuffix)
  }

  async function resolveContext(cwd, signal) {
    if (typeof cwd !== 'string' || cwd === '') {
      fail('NO_CWD', '无法确定工作目录')
    }
    const inside = await run(['rev-parse', '--is-inside-work-tree'], cwd, signal)
    if (inside.exitCode !== 0 || inside.stdout !== 'true') {
      fail('NOT_GIT_REPO', '不在 git 工作区的检出目录中：' + cwd, '请先 git init 或进入已有仓库')
    }
    const absCommon = await run(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd, signal)
    let commonDir
    if (absCommon.exitCode === 0 && absCommon.stdout !== '') {
      commonDir = path.resolve(absCommon.stdout)
    } else {
      const relCommon = await run(['rev-parse', '--git-common-dir'], cwd, signal)
      if (relCommon.exitCode !== 0) {
        fail('NOT_GIT_REPO', '无法解析 git-common-dir：' + (relCommon.stderr || cwd))
      }
      commonDir = path.resolve(cwd, relCommon.stdout)
    }
    const repoRoot = path.dirname(commonDir)
    const top = await run(['rev-parse', '--show-toplevel'], cwd, signal)
    const checkoutRoot = top.exitCode === 0 && top.stdout !== '' ? path.resolve(top.stdout) : path.resolve(cwd)
    return { repoRoot, commonDir, checkoutRoot, wtRoot: rootFor(repoRoot) }
  }

  async function detectBaseBranch(repoRoot, signal) {
    if (baseBranchOverride !== null) return baseBranchOverride
    const sym = await run(['symbolic-ref', '--quiet', '--short', 'HEAD'], repoRoot, signal)
    if (sym.exitCode === 0 && sym.stdout !== '') return sym.stdout
    const head = await run(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot, signal)
    return head.stdout !== '' && head.stdout !== 'HEAD' ? head.stdout : null
  }

  async function ensureManifest(ctx, signal) {
    const existing = await readManifest(ctx.wtRoot)
    if (existing !== null) {
      if (existing.layout !== layout) {
        fail('LAYOUT_MISMATCH', '该仓库已有 ' + existing.layout + ' 布局的注册表，当前配置为 ' + layout, '删除 ' + manifestPathFor(ctx.wtRoot) + ' 后重试，或把 layout 配置改回 ' + existing.layout)
      }
      return existing
    }
    const base = await detectBaseBranch(ctx.repoRoot, signal)
    return emptyManifest(layout, ctx.repoRoot, base)
  }

  async function requireManifest(ctx, signal) {
    const manifest = await readManifest(ctx.wtRoot)
    if (manifest === null) {
      fail('NO_REGISTRY', '该仓库还没有 worktree 注册表：' + manifestPathFor(ctx.wtRoot), '先用 /worktree create <name> 创建第一个 worktree')
    }
    return manifest
  }

  function findEntry(manifest, name) {
    const wanted = typeof name === 'string' ? name.trim() : ''
    if (wanted === '') fail('NAME_REQUIRED', '请指定 worktree 名')
    const entry = manifest.worktrees.find((item) => item.name === wanted || item.branch === wanted)
    if (entry === undefined) {
      const known = manifest.worktrees.map((item) => item.name).join(', ')
      fail('WORKTREE_NOT_FOUND', '找不到 worktree：' + wanted, '当前已注册：' + (known === '' ? '（空）' : known))
    }
    return entry
  }

  async function ensureIgnored(repoRoot, pattern, signal) {
    const file = path.join(repoRoot, '.gitignore')
    let text = ''
    try {
      text = await fs.readFile(file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const bare = pattern.replace(/^\//, '')
    const lines = text.split(/\r?\n/).map((line) => line.trim())
    if (lines.includes(pattern) || lines.includes(bare)) return false
    const prefix = text === '' || text.endsWith('\n') ? '' : '\n'
    await fs.appendFile(file, prefix + '# dsh-parallel-worktree\n' + pattern + '\n', 'utf8')
    return true
  }

  async function carryUncommitted(changes, ctx, wtPath, params, warnings) {
    const signal = params.signal
    const diff = await run(['diff', '--binary', 'HEAD'], ctx.repoRoot, signal, { raw: true })
    if (diff.stdout.trim() !== '') {
      const patchFile = path.join(ctx.wtRoot, '.carry-' + String(process.pid) + '-' + String(Date.now()) + '.patch')
      await fs.writeFile(patchFile, diff.stdout, 'utf8')
      try {
        const applied = await run(['apply', '--3way', patchFile], wtPath, signal)
        if (applied.exitCode !== 0) warnings.push('已跟踪的未提交改动未能应用：' + tail(applied.stderr))
      } finally {
        await fs.unlink(patchFile).catch(() => {})
      }
    }
    const untracked = await run(['ls-files', '--others', '--exclude-standard', '-z'], ctx.repoRoot, signal, { raw: true })
    for (const rel of untracked.stdout.split('\0')) {
      if (rel === '' || rel.startsWith('node_modules/') || rel.startsWith('.git/')) continue
      const source = path.join(ctx.repoRoot, rel)
      const target = path.join(wtPath, rel)
      if (existsSync(target)) continue
      try {
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.copyFile(source, target)
      } catch (error) {
        warnings.push('复制未跟踪文件 ' + rel + ' 失败：' + String(error?.message ?? error))
      }
    }
  }

  async function createOne(ctx, manifest, params) {
    const rawName = typeof params.name === 'string' ? params.name.trim() : ''
    if (!isValidRefName(rawName)) {
      fail('INVALID_NAME', '不合法的 worktree 名：' + JSON.stringify(rawName), '规则：每段由字母/数字/._- 组成、首字符为字母或数字，可含 / 分层；禁止 ..、反斜杠、空格与 ~ ^ : ? * [ ] @ { } 等字符，总长 ≤100')
    }
    const branch = branchPrefix === '' || rawName.startsWith(branchPrefix) ? rawName : branchPrefix + rawName
    if (!isValidRefName(branch)) {
      fail('INVALID_BRANCH', '不合法的分支名：' + branch, '检查 branchPrefix 配置')
    }
    const duplicate = manifest.worktrees.find((item) => item.name === rawName || item.branch === branch)
    if (duplicate !== undefined) {
      fail('NAME_EXISTS', '已存在同名 worktree：' + duplicate.name, '路径：' + duplicate.path + '；如需重建先 /worktree remove ' + duplicate.name)
    }
    const wtPath = path.join(ctx.wtRoot, ...rawName.split('/'))
    if (existsSync(wtPath)) {
      fail('PATH_EXISTS', '目标目录已存在：' + wtPath, '换一个名字，或先手动删除该目录')
    }
    const branchCheck = await run(['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch], ctx.repoRoot, params.signal)
    if (branchCheck.exitCode === 0) {
      fail('BRANCH_EXISTS', '分支已存在：' + branch, '换名，或先 git branch -D ' + branch + '；也可指定不同的 --base')
    }
    const baseRef = typeof params.base === 'string' && params.base.trim() !== ''
      ? params.base.trim()
      : (manifest.baseBranch !== null && manifest.baseBranch !== undefined ? manifest.baseBranch : 'HEAD')
    const baseCommitResult = await run(['rev-parse', '--verify', baseRef + '^{commit}'], ctx.repoRoot, params.signal)
    if (baseCommitResult.exitCode !== 0) {
      fail('BASE_NOT_RESOLVED', '无法解析起点：' + baseRef, (baseCommitResult.stderr || '') + '（确认该 ref 存在，必要时先 git fetch）')
    }
    const baseCommit = baseCommitResult.stdout
    await fs.mkdir(ctx.wtRoot, { recursive: true })
    await fs.mkdir(path.dirname(wtPath), { recursive: true })
    if (layout === 'inside') await ensureIgnored(ctx.repoRoot, '/' + dirName + '/', params.signal)
    const added = await run(['worktree', 'add', '-b', branch, wtPath, baseCommit], ctx.repoRoot, params.signal)
    if (added.exitCode !== 0) {
      await fs.rm(wtPath, { recursive: true, force: true }).catch(() => {})
      fail('GIT_FAILED', 'git worktree add 失败：' + tail(added.stderr || added.stdout), '目标：' + wtPath)
    }
    const warnings = []
    if (params.carryUncommitted === true) {
      try {
        await carryUncommitted(true, ctx, wtPath, params, warnings)
      } catch (error) {
        warnings.push('未提交改动复制不完整：' + String(error?.message ?? error))
      }
    }
    const envFiles = Array.isArray(params.copyEnv) ? params.copyEnv : copyEnv
    if (params.copyEnv !== false) {
      for (const file of envFiles) {
        const source = path.join(ctx.repoRoot, file)
        const target = path.join(wtPath, file)
        if (!existsSync(source) || existsSync(target)) continue
        try {
          await fs.mkdir(path.dirname(target), { recursive: true })
          await fs.copyFile(source, target)
        } catch (error) {
          warnings.push('复制 ' + file + ' 失败：' + String(error?.message ?? error))
        }
      }
    }
    const wantLink = params.linkNodeModules === true
      || (params.linkNodeModules === undefined && defaultLinkNodeModules)
    if (wantLink) {
      const source = path.join(ctx.repoRoot, 'node_modules')
      const target = path.join(wtPath, 'node_modules')
      if (existsSync(source) && !existsSync(target)) {
        try {
          await fs.symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir')
        } catch (error) {
          warnings.push('node_modules 链接失败：' + String(error?.message ?? error))
        }
      }
    }
    const entry = {
      name: rawName,
      branch,
      path: wtPath,
      baseRef,
      baseCommit,
      createdAt: nowIso(),
      createdBy: params.createdBy ?? null,
      state: 'active',
      lastSyncAt: null,
    }
    manifest.worktrees.push(entry)
    return {
      worktree: entry,
      repoRoot: ctx.repoRoot,
      wtRoot: ctx.wtRoot,
      baseRef,
      warnings,
      manifestPath: manifestPathFor(ctx.wtRoot),
    }
  }

  async function create(params = {}) {
    const ctx = await resolveContext(params.cwd, params.signal)
    return withManifestLock(ctx.wtRoot, async () => {
      const manifest = await ensureManifest(ctx, params.signal)
      const result = await createOne(ctx, manifest, params)
      await writeManifest(ctx.wtRoot, manifest)
      return result
    })
  }

  async function batch(params = {}) {
    const names = Array.isArray(params.names) ? params.names : []
    if (names.length === 0) fail('INVALID_NAME', '批量创建至少需要一个名字')
    const ctx = await resolveContext(params.cwd, params.signal)
    return withManifestLock(ctx.wtRoot, async () => {
      const manifest = await ensureManifest(ctx, params.signal)
      const created = []
      const failed = []
      for (const name of names) {
        try {
          const result = await createOne(ctx, manifest, { ...params, name })
          created.push(result.worktree)
        } catch (error) {
          failed.push({ name, code: error?.code ?? 'ERROR', message: String(error?.message ?? error) })
        }
      }
      if (created.length > 0) await writeManifest(ctx.wtRoot, manifest)
      return { repoRoot: ctx.repoRoot, wtRoot: ctx.wtRoot, created, failed }
    })
  }

  async function describe(ctx, entry, baseBranch, signal) {
    const info = {
      name: entry.name,
      branch: entry.branch,
      path: entry.path,
      state: entry.state,
      exists: existsSync(entry.path),
      dirty: false,
      head: null,
      ahead: 0,
      behind: 0,
      baseCommit: entry.baseCommit,
      createdAt: entry.createdAt,
      lastSyncAt: entry.lastSyncAt ?? null,
    }
    if (!info.exists) {
      info.state = 'missing'
      return info
    }
    const head = await run(['rev-parse', '--short', 'HEAD'], entry.path, signal)
    if (head.exitCode === 0) info.head = head.stdout
    const status = await run(['status', '--porcelain'], entry.path, signal)
    info.dirty = status.stdout !== ''
    const base = baseBranch ?? entry.baseRef
    if (base) {
      const counts = await run(['rev-list', '--left-right', '--count', base + '...HEAD'], entry.path, signal)
      if (counts.exitCode === 0) {
        const parts = counts.stdout.split(/\s+/)
        info.behind = Number(parts[0] ?? 0)
        info.ahead = Number(parts[1] ?? 0)
      }
    }
    return info
  }

  async function list(params = {}) {
    const ctx = await resolveContext(params.cwd, params.signal)
    const manifest = await readManifest(ctx.wtRoot)
    const baseBranch = manifest?.baseBranch ?? null
    const entries = manifest?.worktrees ?? []
    const worktrees = await Promise.all(entries.map((entry) => describe(ctx, entry, baseBranch, params.signal)))
    return {
      repoRoot: ctx.repoRoot,
      wtRoot: ctx.wtRoot,
      checkoutRoot: ctx.checkoutRoot,
      layout,
      baseBranch,
      registry: manifestPathFor(ctx.wtRoot),
      worktrees,
    }
  }

  async function status(params = {}) {
    const ctx = await resolveContext(params.cwd, params.signal)
    const manifest = await readManifest(ctx.wtRoot)
    const entries = manifest?.worktrees ?? []
    let entry = null
    if (typeof params.name === 'string' && params.name.trim() !== '') {
      entry = findEntry(manifest ?? emptyManifest(layout, ctx.repoRoot, null), params.name)
    } else {
      entry = entries.find((item) => isInside(item.path, ctx.checkoutRoot)) ?? null
    }
    const worktree = entry === null ? null : await describe(ctx, entry, manifest?.baseBranch ?? null, params.signal)
    return {
      repoRoot: ctx.repoRoot,
      wtRoot: ctx.wtRoot,
      layout,
      baseBranch: manifest?.baseBranch ?? null,
      inWorktree: entry !== null,
      worktree,
    }
  }

  async function sync(params = {}) {
    const ctx = await resolveContext(params.cwd, params.signal)
    return withManifestLock(ctx.wtRoot, async () => {
      const manifest = await requireManifest(ctx, params.signal)
      const entry = findEntry(manifest, params.name)
      if (!existsSync(entry.path)) {
        fail('WORKTREE_MISSING', 'worktree 目录不存在：' + entry.path, '先 /worktree prune 清理注册表')
      }
      const base = typeof params.base === 'string' && params.base.trim() !== '' ? params.base.trim() : manifest.baseBranch
      if (base === null || base === undefined || base === '') {
        fail('BASE_REQUIRED', '未指定同步基准分支', '用 --base <ref> 指定，或在插件配置里设置 baseBranch')
      }
      const baseOk = await run(['rev-parse', '--verify', '--quiet', base + '^{commit}'], entry.path, params.signal)
      if (baseOk.exitCode !== 0) {
        fail('BASE_NOT_RESOLVED', 'worktree 内无法解析基准：' + base, '可能需要在 worktree 里 git fetch')
      }
      const mode = params.mode === 'merge' || params.mode === 'rebase' ? params.mode : defaultSyncMode
      const dirtyStatus = await run(['status', '--porcelain'], entry.path, params.signal)
      const dirty = dirtyStatus.stdout !== ''
      if (mode === 'rebase') {
        const out = await run(['rebase', '--autostash', base], entry.path, params.signal)
        if (out.exitCode !== 0) {
          await run(['rebase', '--abort'], entry.path, params.signal)
          fail('MERGE_CONFLICT', 'rebase 同步产生冲突，已自动 abort：' + tail(out.stderr || out.stdout), '请在 worktree 内手动 git rebase ' + base + ' 解决冲突')
        }
      } else {
        if (dirty) fail('DIRTY_WORKTREE', 'worktree 有未提交改动，merge 同步前请先提交或 stash')
        const out = await run(['merge', '--no-ff', '--no-edit', base], entry.path, params.signal)
        if (out.exitCode !== 0) {
          await run(['merge', '--abort'], entry.path, params.signal)
          fail('MERGE_CONFLICT', 'merge 同步产生冲突，已自动 abort：' + tail(out.stderr || out.stdout))
        }
      }
      const head = await run(['rev-parse', '--short', 'HEAD'], entry.path, params.signal)
      entry.lastSyncAt = nowIso()
      entry.syncedTo = baseOk.stdout
      await writeManifest(ctx.wtRoot, manifest)
      return { worktree: entry, base, baseCommit: baseOk.stdout, mode, head: head.stdout, dirtyBefore: dirty }
    })
  }

  async function merge(params = {}) {
    const ctx = await resolveContext(params.cwd, params.signal)
    return withManifestLock(ctx.wtRoot, async () => {
      const manifest = await requireManifest(ctx, params.signal)
      const entry = findEntry(manifest, params.name)
      if (!existsSync(entry.path)) {
        fail('WORKTREE_MISSING', 'worktree 目录不存在：' + entry.path, '先 /worktree prune 清理注册表')
      }
      const base = typeof params.base === 'string' && params.base.trim() !== '' ? params.base.trim() : manifest.baseBranch
      if (base === null || base === undefined || base === '') {
        fail('BASE_REQUIRED', '未指定合并目标分支', '用 --base <ref> 指定，或在插件配置里设置 baseBranch')
      }
      const mainStatus = await run(['status', '--porcelain'], ctx.repoRoot, params.signal)
      if (mainStatus.stdout !== '') {
        fail('DIRTY_MAIN', '主工作区有未提交改动，合并前请先提交或 stash', '主仓库：' + ctx.repoRoot)
      }
      const current = await run(['symbolic-ref', '--quiet', '--short', 'HEAD'], ctx.repoRoot, params.signal)
      if (current.exitCode !== 0) {
        fail('DETACHED_MAIN', '主仓库处于 detached HEAD，无法合并', '先手动 git switch ' + base)
      }
      let switchedFrom = null
      if (current.stdout !== base) {
        switchedFrom = current.stdout
        const switched = await run(['switch', base], ctx.repoRoot, params.signal)
        if (switched.exitCode !== 0) {
          const checkout = await run(['checkout', base], ctx.repoRoot, params.signal)
          if (checkout.exitCode !== 0) {
            fail('BASE_NOT_CHECKED_OUT', '主仓库无法切换到 ' + base + '：' + tail(checkout.stderr), '请手动切换后重试')
          }
        }
      }
      const branchOk = await run(['rev-parse', '--verify', '--quiet', 'refs/heads/' + entry.branch], ctx.repoRoot, params.signal)
      if (branchOk.exitCode !== 0) {
        fail('BRANCH_MISSING', '分支不存在：' + entry.branch, 'worktree 可能已被手动移除；/worktree prune 清理注册表')
      }
      const message = typeof params.message === 'string' && params.message.trim() !== ''
        ? params.message.trim()
        : ('Merge worktree ' + entry.name + ' into ' + base)
      const merged = await run(['merge', '--no-ff', '-m', message, entry.branch], ctx.repoRoot, params.signal)
      if (merged.exitCode !== 0) {
        await run(['merge', '--abort'], ctx.repoRoot, params.signal)
        fail('MERGE_CONFLICT', '合并产生冲突，已自动 abort：' + tail(merged.stderr || merged.stdout), '可在主仓库手动 git merge ' + entry.branch + ' 解决')
      }
      const commit = await run(['rev-parse', '--short', 'HEAD'], ctx.repoRoot, params.signal)
      entry.state = 'merged'
      entry.mergedAt = nowIso()
      entry.mergeCommit = commit.stdout
      const result = {
        worktree: entry,
        repoRoot: ctx.repoRoot,
        base,
        switchedFrom,
        mergeCommit: commit.stdout,
        removed: false,
        branchDeleted: false,
        note: null,
      }
      if (params.removeWorktree === true) {
        let removed = await run(['worktree', 'remove', entry.path], ctx.repoRoot, params.signal)
        if (removed.exitCode !== 0) removed = await run(['worktree', 'remove', '--force', entry.path], ctx.repoRoot, params.signal)
        result.removed = removed.exitCode === 0
        if (!result.removed) {
          await run(['worktree', 'prune'], ctx.repoRoot, params.signal)
          result.removed = !existsSync(entry.path)
        }
        result.note = result.removed ? 'checkout 已移除' : 'checkout 移除失败：' + tail(removed.stderr)
      }
      if (params.deleteBranch === true) {
        const del = await run(['branch', '-d', entry.branch], ctx.repoRoot, params.signal)
        result.branchDeleted = del.exitCode === 0
        if (!result.branchDeleted) result.note = '分支删除失败：' + tail(del.stderr)
      }
      if (result.removed) {
        manifest.worktrees = manifest.worktrees.filter((item) => item.name !== entry.name)
      }
      await writeManifest(ctx.wtRoot, manifest)
      return result
    })
  }

  async function remove(params = {}) {
    const ctx = await resolveContext(params.cwd, params.signal)
    return withManifestLock(ctx.wtRoot, async () => {
      const manifest = await requireManifest(ctx, params.signal)
      const entry = findEntry(manifest, params.name)
      const exists = existsSync(entry.path)
      let dirty = false
      if (exists) {
        const statusOutput = await run(['status', '--porcelain'], entry.path, params.signal)
        dirty = statusOutput.stdout !== ''
      }
      if (dirty && params.force !== true) {
        fail('DIRTY_WORKTREE', 'worktree 有未提交改动：' + entry.name, '确认丢弃请加 --force；或先提交/复制改动')
      }
      let removedPath = false
      if (exists) {
        const out = await run(['worktree', 'remove', '--force', entry.path], ctx.repoRoot, params.signal)
        removedPath = out.exitCode === 0
        if (!removedPath) {
          await fs.rm(entry.path, { recursive: true, force: true })
          await run(['worktree', 'prune'], ctx.repoRoot, params.signal)
          removedPath = !existsSync(entry.path)
        }
      }
      let deletedBranch = false
      if (params.deleteBranch === true) {
        const del = await run(['branch', '-D', entry.branch], ctx.repoRoot, params.signal)
        deletedBranch = del.exitCode === 0
      }
      manifest.worktrees = manifest.worktrees.filter((item) => item.name !== entry.name)
      await writeManifest(ctx.wtRoot, manifest)
      return {
        name: entry.name,
        branch: entry.branch,
        path: entry.path,
        removedPath,
        deletedBranch,
        dirty,
      }
    })
  }

  async function prune(params = {}) {
    const ctx = await resolveContext(params.cwd, params.signal)
    return withManifestLock(ctx.wtRoot, async () => {
      const manifest = await readManifest(ctx.wtRoot)
      if (manifest === null) {
        return { repoRoot: ctx.repoRoot, wtRoot: ctx.wtRoot, pruned: [], kept: 0 }
      }
      await run(['worktree', 'prune'], ctx.repoRoot, params.signal)
      const liveOut = await run(['worktree', 'list', '--porcelain'], ctx.repoRoot, params.signal)
      const live = new Set()
      for (const line of liveOut.stdout.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.startsWith('worktree ')) live.add(trimmed.slice('worktree '.length))
      }
      const pruned = []
      const kept = []
      for (const entry of manifest.worktrees) {
        if (live.has(entry.path) || existsSync(entry.path)) kept.push(entry)
        else pruned.push({ name: entry.name, branch: entry.branch, path: entry.path })
      }
      manifest.worktrees = kept
      await writeManifest(ctx.wtRoot, manifest)
      return { repoRoot: ctx.repoRoot, wtRoot: ctx.wtRoot, pruned, kept: kept.length }
    })
  }

  return {
    create,
    batch,
    list,
    status,
    sync,
    merge,
    remove,
    prune,
    describe,
    resolveRepo: (cwd, signal) => resolveContext(cwd, signal),
    config: () => ({ layout, dirName, siblingSuffix, branchPrefix, copyEnv, syncMode: defaultSyncMode, baseBranch: baseBranchOverride, linkNodeModules: defaultLinkNodeModules }),
  }
}
