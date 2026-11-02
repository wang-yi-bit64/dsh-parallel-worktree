#!/usr/bin/env node
/**
 * 把 dsh-parallel-worktree 装进 DSH 桌面 profile（离线/自带包路径）。
 *
 * 依据 DSH 0.2.1-rc.5 的激活契约，激活的最小充分条件是：
 *   1. 包里有 dsh.bundle.patch 指向的 patch（本插件自带 cordis.patch.yml）
 *   2. 包名出现在 <profile>/package.json 的 dsh.profile.bundles
 *   3. 包文件在 <profile>/node_modules/<包名>（或宿主安装目录）
 *   4. 重启 DSH Desktop
 *
 * 放哪儿有讲究：profile 目录是 pnpm 工程（有 pnpm-lock.yaml / .modules.yaml），
 * 应用自己的插件管理会跑 pnpm install，凡是没写进 dependencies 的目录都会被当成
 * 多余文件删掉（真实报错：cannot resolve profile bundle "dsh-parallel-worktree"）。
 * 所以脚本把包放进 <DSH_HOME>/node_modules/<包名>——这是 Node 解析 node_modules 时
 * 的上级目录，app-boot 的 require.resolve.paths 也会走到它，pnpm 从不管理它。
 * 不写 dependencies、不碰 pnpm-lock.yaml，避免把 profile 的锁文件搞坏。
 *
 * 改 package.json 前备份成 package.json.bak-<时间戳>；写入失败自动回滚。
 *
 * 用法：
 *   node install.mjs [--profile <dir|name>] [--dry-run] [--force] [--no-bundles]
 */
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_NAME = 'dsh-parallel-worktree'
const SKIP_DIRS = new Set(['test', 'node_modules', '.git'])
const SKIP_FILES = new Set(['install.mjs', 'uninstall.mjs', 'test-run.log', 'test-run.pid', 'package-lock.json'])

function dshHome() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
}

function defaultProfile() {
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR
  return path.join(dshHome(), 'profiles', 'desktop')
}

// --profile 既接受目录/路径，也接受 profile 名字（desktop、web ...）：
// 纯名字且不含路径分隔符时优先按 <DSH_HOME>/profiles/<名字> 解析。
function resolveProfile(value) {
  const raw = value ?? defaultProfile()
  if (!path.isAbsolute(raw) && !/[\\/]/.test(raw)) {
    const named = path.join(dshHome(), 'profiles', raw)
    if (existsSync(named)) return named
  }
  return path.resolve(raw)
}

const HELP = [
  '用法：node install.mjs [--profile <dir>] [--dry-run] [--force] [--no-bundles]',
  '',
  '  --profile <dir|name>  DSH profile 目录或名字（如 desktop、web），缺省 ' + defaultProfile(),
  '  --dry-run         只做预检并打印计划，不写任何文件',
  '  --force           目标已安装同版本时仍强制覆盖',
  '  --no-bundles      只复制文件、不改 dsh.profile.bundles（手工启用时用）',
].join('\n')

function parseArgv(argv) {
  const options = { profile: null, dryRun: false, force: false, bundles: true, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--dry-run') options.dryRun = true
    else if (token === '--force') options.force = true
    else if (token === '--no-bundles') options.bundles = false
    else if (token === '--help' || token === '-h') options.help = true
    else if (token === '--profile') { options.profile = argv[index + 1]; index += 1 }
    else if (token.startsWith('--profile=')) options.profile = token.slice('--profile='.length)
    else throw new Error('未知参数：' + token)
  }
  return options
}

function timestamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return String(now.getFullYear()) + pad(now.getMonth() + 1) + pad(now.getDate())
    + '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds())
}

function log(options, message) {
  console.log((options.dryRun ? '[dry-run] ' : '') + message)
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

async function exists(target) {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}

/** 预检：包自身是否具备激活条件（dsh.bundle.patch 存在且文件在）。 */
async function preflight(options, ownManifest, profileManifest, target, existing) {
  const problems = []
  const notes = []
  const patch = ownManifest?.dsh?.bundle?.patch
  if (typeof patch !== 'string' || patch.length === 0) {
    problems.push('package.json 缺少 dsh.bundle.patch：DSH 不会把这个包当作 bundle 加载')
  } else {
    const patchFile = path.resolve(HERE, patch)
    if (patchFile.indexOf(HERE) !== 0) {
      problems.push('dsh.bundle.patch 指向插件目录之外：' + patch)
    } else if (!(await exists(patchFile))) {
      problems.push('dsh.bundle.patch 指向的文件不存在：' + patch)
    } else {
      notes.push('bundle patch: ' + path.relative(HERE, patchFile))
    }
  }
  const bundles = profileManifest?.dsh?.profile?.bundles
  if (bundles !== undefined && !Array.isArray(bundles)) {
    problems.push('profile package.json 的 dsh.profile.bundles 不是数组')
  }
  const engines = ownManifest?.engines?.node
  if (typeof engines === 'string' && !satisfiesNode(process.version, engines)) {
    notes.push('engines.node = ' + engines + '，当前脚本运行在 ' + process.version + '（插件在 DSH 内置 Node 上运行，通常无影响）')
  }
  if (existing !== null && existing.version !== ownManifest.version && options.force !== true) {
    notes.push('目标位置已有 ' + String(existing.version) + '，将覆盖为 ' + String(ownManifest.version) + '（加 --force 可跳过此提示）')
  }
  const inBundles = Array.isArray(bundles) && bundles.includes(PACKAGE_NAME)
  return { problems, notes, inBundles }
}

/** 极简 semver 主版本比较，只用于给 engines 提示。 */
function satisfiesNode(current, range) {
  const major = Number(String(current).replace(/^v/, '').split('.')[0])
  const match = /[><=~^]*\s*(\d+)/.exec(String(range))
  if (Number.isNaN(major) || match === null) return true
  const wanted = Number(match[1])
  return major >= wanted
}

async function main() {
  const options = parseArgv(process.argv.slice(2))
  if (options.help) {
    console.log(HELP)
    return
  }
  const profile = resolveProfile(options.profile)
  const profilePackagePath = path.join(profile, 'package.json')
  // 放在 DSH_HOME/node_modules 而不是 profile/node_modules：profile 是 pnpm 工程，
  // pnpm install 会删掉没有写进 dependencies 的多余目录（本插件不写 dependencies）。
  const target = path.join(dshHome(), 'node_modules', PACKAGE_NAME)
  // 老版本把包放在 profile/node_modules，pnpm 会把它当多余文件删掉；这里顺手清理残留。
  const legacyTarget = path.join(profile, 'node_modules', PACKAGE_NAME)

  let ownManifest
  try {
    ownManifest = await readJson(path.join(HERE, 'package.json'))
  } catch {
    throw new Error('无法读取插件自己的 package.json：' + HERE)
  }
  let profileManifest
  try {
    profileManifest = await readJson(profilePackagePath)
  } catch {
    throw new Error('找不到 profile 的 package.json：' + profilePackagePath + '（先用 --profile 指定，或先启动一次 DSH Desktop 初始化 profile）')
  }

  let existing = null
  try {
    existing = await readJson(path.join(target, 'package.json'))
  } catch {
    existing = null
  }

  console.log('插件     ' + String(ownManifest.name) + '@' + String(ownManifest.version))
  console.log('来源     ' + HERE)
  console.log('目标     ' + target + '（DSH_HOME 的 node_modules，pnpm 不会删）')
  console.log('profile  ' + profile + '（只改 dsh.profile.bundles）')
  console.log('')

  const { problems, notes, inBundles } = await preflight(options, ownManifest, profileManifest, target, existing)
  for (const note of notes) console.log('提示     ' + note)
  if (problems.length > 0) {
    console.error('预检失败：')
    for (const problem of problems) console.error('  ✗ ' + problem)
    process.exitCode = 1
    return
  }
  console.log('预检通过 ' + (inBundles ? '（bundles 已包含该包，将刷新文件）' : '（bundles 待追加）'))
  console.log('')

  log(options, '复制插件文件 → ' + target)
  const wanted = JSON.parse(JSON.stringify(profileManifest))
  wanted.dsh = wanted.dsh ?? {}
  wanted.dsh.profile = wanted.dsh.profile ?? {}
  const bundles = Array.isArray(wanted.dsh.profile.bundles) ? wanted.dsh.profile.bundles.slice() : []
  const willAdd = options.bundles === true && !bundles.includes(PACKAGE_NAME)
  if (willAdd) bundles.push(PACKAGE_NAME)
  wanted.dsh.profile.bundles = bundles
  const manifestChanged = JSON.stringify(wanted) !== JSON.stringify(profileManifest)
  if (manifestChanged) {
    if (willAdd) log(options, 'bundles 追加 ' + PACKAGE_NAME + '（新顺序：' + bundles.join(' → ') + '）')
    else log(options, '更新 ' + profilePackagePath)
  } else {
    log(options, 'profile/package.json 无需改动')
  }

  if (options.dryRun === true) {
    console.log('')
    console.log('dry-run 完成，未写入任何文件。')
    return
  }

  const backup = profilePackagePath + '.bak-' + timestamp()
  let backedUp = false
  try {
    if (manifestChanged) {
      await fs.copyFile(profilePackagePath, backup)
      backedUp = true
      console.log('已备份   ' + backup)
    }
    await fs.rm(legacyTarget, { recursive: true, force: true })
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.rm(target, { recursive: true, force: true })
    await fs.cp(HERE, target, {
      recursive: true,
      force: true,
      filter: (source) => {
        const relative = path.relative(HERE, source)
        if (relative === '') return true
        const segments = relative.split(path.sep)
        if (segments.some((segment) => SKIP_DIRS.has(segment))) return false
        return !SKIP_FILES.has(path.basename(relative))
      },
    })
    if (manifestChanged) {
      await fs.writeFile(profilePackagePath, JSON.stringify(wanted, null, 2) + '\n', 'utf8')
    }
  } catch (error) {
    if (backedUp) {
      await fs.copyFile(backup, profilePackagePath)
      console.error('已回滚   ' + profilePackagePath)
    }
    throw error
  }

  console.log('')
  console.log('安装完成。接下来：')
  console.log('  1. 完全退出 DSH Desktop（不是关窗口）再重新启动，profile 在启动时 compose')
  console.log('     之前报 cannot resolve profile bundle 的，重启前别再让应用跑一次 pnpm install')
  console.log('  2. 在仓库目录的会话里执行 /worktree help，能列出子命令即激活成功')
  console.log('  3. 让 Agent 调 worktree_create，或直接执行 /worktree create feature/demo')
  console.log('卸载：node uninstall.mjs' + (options.profile === null ? '' : ' --profile "' + profile + '"'))
}

main().catch((error) => {
  console.error('安装失败：' + String(error?.message ?? error))
  process.exitCode = 1
})
