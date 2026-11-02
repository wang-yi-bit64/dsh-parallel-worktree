/**
 * dsh-parallel-worktree — 人类命令面 /worktree。
 *
 * 收尾动作（sync / merge / remove / prune）只在这里出现，模型拿不到，
 * 保证「破坏性操作必须由人确认」。
 *
 * @module dsh-parallel-worktree/commands
 */
import { WorktreeError, isWorktreeError, parseArgv, resolveSessionCwd } from './util.js'

const HELP = [
  '并行 worktree（git worktree 多分支同时开发）',
  '',
  '  /worktree create <name> [--base <ref>] [--carry] [--link] [--no-env]',
  '  /worktree batch <name1> <name2> ...  [--base <ref>]',
  '  /worktree list                     列出全部 worktree 与状态',
  '  /worktree status [name]            查看某个（或当前所在）worktree',
  '  /worktree path <name>              打印路径（用于开新会话或 cd）',
  '  /worktree sync <name> [--base <ref>] [--merge|--rebase]',
  '  /worktree merge <name> [--base <ref>] [--message <msg>] [--remove] [--delete-branch]',
  '  /worktree remove <name> [--force] [--delete-branch]',
  '  /worktree prune                    清理目录已消失的注册项',
  '',
  '任意子命令都可加 --json：把结构化结果作为 JSON 文本返回（供面板/脚本解析）。',
  '',
  '说明：create 只新建隔离检出；合并/删除不可自动撤销，故仅人工执行。',
  '      name 默认为分支 wt/<name>，可含 / 分层。',
].join('\n')

function resolveCwd(invocation, ctx) {
  return resolveSessionCwd(ctx, invocation?.agent)
    ?? invocation?.agent?.session?.header?.cwd
    ?? invocation?.agent?.session?.cwd
    ?? invocation?.cwd
    ?? null
}

function requireCwd(invocation, ctx) {
  const cwd = resolveCwd(invocation, ctx)
  if (typeof cwd !== 'string' || cwd === '') {
    throw new WorktreeError('NO_CWD', '无法确定当前会话的工作目录', '请在某个仓库目录的会话里执行该命令')
  }
  return cwd
}

function takeOptions(tokens) {
  const positional = []
  const flags = {}
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (typeof token !== 'string') continue
    if (token.startsWith('--')) {
      const raw = token.slice(2)
      const equals = raw.indexOf('=')
      if (equals >= 0) {
        flags[raw.slice(0, equals)] = raw.slice(equals + 1)
        continue
      }
      const next = tokens[index + 1]
      if (next !== undefined && !String(next).startsWith('--')) {
        flags[raw] = next
        index += 1
      } else {
        flags[raw] = true
      }
      continue
    }
    if (token.startsWith('-') && token.length > 1 && !/^-[0-9]/.test(token)) {
      flags[token.slice(1)] = true
      continue
    }
    positional.push(token)
  }
  return { positional, flags }
}

function displayWidth(text) {
  let width = 0
  for (const ch of String(text)) {
    const code = ch.codePointAt(0) ?? 0
    width += (code >= 0x1100 && (
      code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)
      || (code >= 0x1f300 && code <= 0x1f64f)
    )) ? 2 : 1
  }
  return width
}

function pad(text, width) {
  const value = String(text ?? '')
  const gap = width - displayWidth(value)
  return gap > 0 ? value + ' '.repeat(gap) : value
}

function table(headers, rows) {
  const widths = headers.map((header, index) => Math.max(
    displayWidth(header),
    ...rows.map((row) => displayWidth(row[index] ?? '')),
  ))
  const head = headers.map((header, index) => pad(header, widths[index])).join('  ')
  const separator = widths.map((width) => '-'.repeat(width)).join('  ')
  const body = rows.map((row) => row.map((cell, index) => pad(cell, widths[index])).join('  '))
  return [head, separator, ...body].join('\n')
}

function yesNo(value) {
  return value ? '是' : '否'
}

function shortSha(sha) {
  return typeof sha === 'string' ? sha.slice(0, 8) : ''
}

/** 结构化结果（供客户端面板/脚本解析）：成功走 text 通道，保持 kind 合法。 */
function emitJson(payload) {
  return { kind: 'success', text: JSON.stringify({ ok: true, ...payload }) }
}

/** 结构化错误：同样只能走 text 通道。 */
function emitJsonError(error) {
  const code = isWorktreeError(error) ? error.code : 'ERROR'
  const hint = isWorktreeError(error) && typeof error.hint === 'string' ? error.hint : null
  return { kind: 'error', text: JSON.stringify({ ok: false, code, message: String(error?.message ?? error), hint }) }
}

function formatList(result) {
  const lines = [
    '仓库   ' + result.repoRoot,
    'worktree 根目录  ' + result.wtRoot,
    '布局   ' + result.layout + '    主干  ' + (result.baseBranch ?? '(未探测到，合并时用 --base 指定)'),
    '注册表 ' + result.registry,
    '',
  ]
  if (result.worktrees.length === 0) {
    lines.push('（还没有注册任何 worktree，用 /worktree create <name> 创建）')
    return lines.join('\n')
  }
  const rows = result.worktrees.map((entry, index) => [
    String(index + 1),
    entry.name,
    entry.branch,
    entry.state,
    yesNo(entry.dirty),
    shortSha(entry.head) || '-',
    '+' + String(entry.ahead) + '/-' + String(entry.behind),
    entry.path,
  ])
  lines.push(table(['#', '名字', '分支', '状态', '脏', 'HEAD', '领先/落后', '路径'], rows))
  return lines.join('\n')
}

function formatStatus(result) {
  if (result.worktree === null) {
    return [
      '当前不在受管理的 worktree 内（主工作区或未注册目录）。',
      '仓库   ' + result.repoRoot,
      'worktree 根目录  ' + result.wtRoot,
    ].join('\n')
  }
  const entry = result.worktree
  return [
    'worktree ' + entry.name,
    '  分支   ' + entry.branch,
    '  路径   ' + entry.path,
    '  状态   ' + entry.state + (entry.exists ? '' : '（目录已丢失，可 /worktree prune）'),
    '  脏     ' + yesNo(entry.dirty),
    '  HEAD   ' + (shortSha(entry.head) || '-'),
    '  相对主干 领先 ' + String(entry.ahead) + ' / 落后 ' + String(entry.behind),
    '  创建于 ' + (entry.createdAt ?? '-'),
  ].join('\n')
}

async function handle(ctx, manager, invocation) {
  const raw = parseArgv(invocation?.rawInput ?? '')
  const json = raw.some((token) => token === '--json' || token === '-j')
  const tokens = raw.filter((token) => token !== '--json' && token !== '-j')
  const sub = (tokens.shift() ?? '').toLowerCase()
  try {
    if (sub === '' || sub === 'help' || sub === '-h' || sub === '--help') {
      return { kind: 'success', text: HELP }
    }
    if (sub === 'create' || sub === 'new') {
      const { positional, flags } = takeOptions(tokens)
      const name = positional[0]
      if (name === undefined) {
        throw new WorktreeError('NAME_REQUIRED', '用法：/worktree create <name> [--base <ref>] [--carry] [--link] [--no-env]')
      }
      const result = await manager.create({
        name,
        base: typeof flags.base === 'string' ? flags.base : undefined,
        carryUncommitted: flags.carry === true,
        linkNodeModules: flags.link === true ? true : undefined,
        copyEnv: flags['no-env'] === true ? false : undefined,
        cwd: requireCwd(invocation, ctx),
        createdBy: invocation?.agent?.session?.id ?? null,
        signal: invocation?.signal,
      })
      const entry = result.worktree
      if (json) {
        return emitJson({
          action: 'create',
          name: entry.name,
          branch: entry.branch,
          path: entry.path,
          baseRef: entry.baseRef,
          baseCommit: entry.baseCommit,
          repoRoot: result.repoRoot,
          wtRoot: result.wtRoot,
          manifestPath: result.manifestPath,
          warnings: result.warnings,
        })
      }
      const lines = [
        '✓ 已创建 worktree ' + entry.name,
        '  分支   ' + entry.branch,
        '  路径   ' + entry.path,
        '  起点   ' + entry.baseRef + ' @ ' + shortSha(entry.baseCommit),
        '  注册表 ' + result.manifestPath,
      ]
      if (result.warnings.length > 0) {
        lines.push('', '警告：', ...result.warnings.map((warning) => '  ! ' + warning))
      }
      lines.push('', '在终端 cd 到上面的路径，或在新会话里把它设为工作目录；该目录的改动与主工作区隔离。')
      return { kind: 'success', text: lines.join('\n') }
    }
    if (sub === 'batch') {
      const { positional, flags } = takeOptions(tokens)
      if (positional.length === 0) {
        throw new WorktreeError('NAME_REQUIRED', '用法：/worktree batch <name1> <name2> ... [--base <ref>]')
      }
      const result = await manager.batch({
        names: positional,
        base: typeof flags.base === 'string' ? flags.base : undefined,
        carryUncommitted: flags.carry === true,
        copyEnv: flags['no-env'] === true ? false : undefined,
        cwd: requireCwd(invocation, ctx),
        createdBy: invocation?.agent?.session?.id ?? null,
        signal: invocation?.signal,
      })
      if (json) return emitJson({ action: 'batch', created: result.created, failed: result.failed })
      const lines = ['批量创建：成功 ' + String(result.created.length) + '，失败 ' + String(result.failed.length)]
      for (const entry of result.created) {
        lines.push('  ✓ ' + entry.name + '  → ' + entry.branch + '  ' + entry.path)
      }
      for (const failure of result.failed) {
        lines.push('  ✗ ' + failure.name + '  [' + failure.code + '] ' + failure.message)
      }
      return { kind: result.failed.length > 0 ? 'error' : 'success', text: lines.join('\n') }
    }
    if (sub === 'list' || sub === 'ls') {
      const result = await manager.list({ cwd: requireCwd(invocation, ctx), signal: invocation?.signal })
      if (json) {
        return emitJson({
          action: 'list',
          repoRoot: result.repoRoot,
          wtRoot: result.wtRoot,
          layout: result.layout,
          baseBranch: result.baseBranch ?? null,
          registry: result.registry,
          worktrees: result.worktrees,
        })
      }
      return { kind: 'success', text: formatList(result) }
    }
    if (sub === 'status' || sub === 'st') {
      const { positional } = takeOptions(tokens)
      const result = await manager.status({ name: positional[0], cwd: requireCwd(invocation, ctx), signal: invocation?.signal })
      if (json) {
        return emitJson({
          action: 'status',
          repoRoot: result.repoRoot,
          wtRoot: result.wtRoot,
          layout: result.layout,
          baseBranch: result.baseBranch ?? null,
          inWorktree: result.inWorktree === true,
          worktree: result.worktree,
        })
      }
      return { kind: 'success', text: formatStatus(result) }
    }
    if (sub === 'path') {
      const { positional } = takeOptions(tokens)
      const name = positional[0]
      if (name === undefined) throw new WorktreeError('NAME_REQUIRED', '用法：/worktree path <name>')
      const result = await manager.status({ name, cwd: requireCwd(invocation, ctx), signal: invocation?.signal })
      if (result.worktree === null) throw new WorktreeError('WORKTREE_NOT_FOUND', '找不到 worktree：' + name)
      if (json) return emitJson({ action: 'path', name, path: result.worktree.path })
      return { kind: 'success', text: result.worktree.path }
    }
    if (sub === 'sync') {
      const { positional, flags } = takeOptions(tokens)
      const name = positional[0]
      if (name === undefined) throw new WorktreeError('NAME_REQUIRED', '用法：/worktree sync <name> [--base <ref>] [--merge|--rebase]')
      const mode = flags.merge === true ? 'merge' : (flags.rebase === true ? 'rebase' : undefined)
      const result = await manager.sync({
        name,
        base: typeof flags.base === 'string' ? flags.base : undefined,
        mode,
        cwd: requireCwd(invocation, ctx),
        signal: invocation?.signal,
      })
      if (json) {
        return emitJson({
          action: 'sync',
          name: result.worktree.name,
          branch: result.worktree.branch,
          path: result.worktree.path,
          base: result.base,
          baseCommit: result.baseCommit,
          head: result.head,
          mode: result.mode,
          dirtyBefore: result.dirtyBefore,
        })
      }
      return {
        kind: 'success',
        text: [
          '✓ 已把 ' + result.base + ' 同步进 worktree ' + result.worktree.name + '（' + result.mode + '）',
          '  BASE   ' + shortSha(result.baseCommit),
          '  HEAD   ' + shortSha(result.head),
          result.dirtyBefore ? '  注意：同步前存在未提交改动（rebase 已自动 autostash）' : '',
        ].filter((line) => line !== '').join('\n'),
      }
    }
    if (sub === 'merge') {
      const { positional, flags } = takeOptions(tokens)
      const name = positional[0]
      if (name === undefined) {
        throw new WorktreeError('NAME_REQUIRED', '用法：/worktree merge <name> [--base <ref>] [--message <msg>] [--remove] [--delete-branch]')
      }
      const result = await manager.merge({
        name,
        base: typeof flags.base === 'string' ? flags.base : undefined,
        message: typeof flags.message === 'string' ? flags.message : undefined,
        removeWorktree: flags.remove === true,
        deleteBranch: flags['delete-branch'] === true,
        cwd: requireCwd(invocation, ctx),
        signal: invocation?.signal,
      })
      if (json) {
        return emitJson({
          action: 'merge',
          name: result.worktree.name,
          branch: result.worktree.branch,
          base: result.base,
          mergeCommit: result.mergeCommit ?? null,
          switchedFrom: result.switchedFrom ?? null,
          removed: result.removed,
          branchDeleted: result.branchDeleted,
          note: result.note ?? null,
        })
      }
      const lines = [
        '✓ 已把 ' + result.worktree.branch + ' 合并进 ' + result.base,
        '  合并提交  ' + shortSha(result.mergeCommit),
        result.switchedFrom !== null ? '  主工作区已从 ' + result.switchedFrom + ' 切换到 ' + result.base : '',
        result.removed ? '  checkout  已移除' : '  checkout  保留（--remove 可在合并后移除）',
        result.branchDeleted ? '  分支      已删除' : '  分支      保留（--delete-branch 可删除）',
        result.note !== null ? '  注意      ' + result.note : '',
      ]
      return { kind: 'success', text: lines.filter((line) => line !== '').join('\n') }
    }
    if (sub === 'remove' || sub === 'rm') {
      const { positional, flags } = takeOptions(tokens)
      const name = positional[0]
      if (name === undefined) throw new WorktreeError('NAME_REQUIRED', '用法：/worktree remove <name> [--force] [--delete-branch]')
      const result = await manager.remove({
        name,
        force: flags.force === true || flags.f === true,
        deleteBranch: flags['delete-branch'] === true,
        cwd: requireCwd(invocation, ctx),
        signal: invocation?.signal,
      })
      if (json) {
        return emitJson({
          action: 'remove',
          name: result.name,
          path: result.path,
          branch: result.branch,
          deletedBranch: result.deletedBranch,
          dirty: result.dirty,
        })
      }
      const lines = [
        '✓ 已移除 worktree ' + result.name,
        '  路径   ' + result.path,
        result.deletedBranch ? '  分支   ' + result.branch + ' 已删除' : '  分支   ' + result.branch + ' 保留（未加 --delete-branch）',
        result.dirty ? '  注意   移除时丢弃了未提交改动（--force）' : '',
      ]
      return { kind: 'success', text: lines.filter((line) => line !== '').join('\n') }
    }
    if (sub === 'prune') {
      const result = await manager.prune({ cwd: requireCwd(invocation, ctx), signal: invocation?.signal })
      if (json) return emitJson({ action: 'prune', pruned: result.pruned, kept: result.kept })
      if (result.pruned.length === 0) {
        return { kind: 'success', text: '✓ 没有需要清理的注册项（保留 ' + String(result.kept) + ' 个）' }
      }
      return {
        kind: 'success',
        text: ['✓ 已清理 ' + String(result.pruned.length) + ' 个目录已消失的注册项：']
          .concat(result.pruned.map((entry) => '  - ' + entry.name + '  ' + entry.path))
          .join('\n'),
      }
    }
    if (json) return { kind: 'error', text: JSON.stringify({ ok: false, code: 'UNKNOWN_SUBCOMMAND', message: '未知子命令：' + sub }) }
    return {
      kind: 'error',
      text: '✗ 未知子命令：' + sub + '\n\n' + HELP,
    }
  } catch (error) {
    if (json) return emitJsonError(error)
    if (isWorktreeError(error)) {
      const hint = error.hint === null || error.hint === undefined || error.hint === '' ? '' : '\n  → ' + error.hint
      return { kind: 'error', text: '✗ ' + error.message + hint }
    }
    return { kind: 'error', text: '✗ ' + String(error?.message ?? error) }
  }
}

/**
 * 注册 /worktree 命令。
 * @param ctx cordis context
 * @param manager worktree 管理器
 */
export function registerWorktreeCommand(ctx, manager) {
  ctx.commands.register({
    name: 'worktree',
    description: '并行 worktree：创建/列出/同步/合并/清理（git worktree 多分支同时开发）',
    input: {
      hint: '<create|batch|list|status|sync|merge|remove|prune|path> [参数]（/worktree help 查看全部用法）',
    },
    handler: (invocation) => handle(ctx, manager, invocation),
  })
}
