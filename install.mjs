#!/usr/bin/env node
/**
 * 把 dsh-parallel-worktree 装进 DSH 桌面 profile（离线/自带包路径）。
 *
 * 依据 DSH 0.2.2-rc.3 的插件管理器契约（profile-plugins.ts），要让插件出现在
 * 「设置 → 插件」的卡片列表里，需要三件事同时成立：
 *   1. 包名作为依赖写进 <profile>/package.json 的 dependencies（精确版本）
 *   2. 包文件在 <profile>/node_modules/<包名>（readProfilePlugins 从这里读版本）
 *   3. 包名出现在 dsh.profile.bundles（reconcileProfilePlugins 会自动保持启用）
 *
 * 所以脚本把主副本放进 profile/node_modules 并写 dependencies（等价于在
 * 「设置 → 插件 → 添加插件」跑 pnpm add 的落盘产物，但离线完成）；同时往
 * <DSH_HOME>/node_modules 放一份兜底副本——万一 pnpm install 把 profile 里
 * 的目录清掉，bundle 解析仍能从上级目录命中，插件退化为「不在列表但照常工作」，
 * 而不是启动报 cannot resolve profile bundle。
 *
 * 改 package.json 前备份成 package.json.bak-<时间戳>；写入失败自动回滚。
 * 依赖版本与 pnpm-lock 不一致时 pnpm install 会重算依赖，npm 上的 0.2.x
 * 同名包存在，重算不会失败。
 *
 * 用法：
 *   node install.mjs [--profile <dir|name>] [--dry-run] [--force] [--no-bundles] [--no-deps]
 *     --no-deps  不写 dependencies、不往 profile/node_modules 复制（旧行为：只有
 *               DSH_HOME 兜底副本 + bundles，不出现在插件管理器列表）
 */
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_NAME = 'dsh-parallel-worktree'
/** Config schema 依赖的运行库：从仓库 node_modules 一并复制，使插件自带 Config 生效。 */
const RUNTIME_DEPS = ['@deepseek-ai/schemastery', '@deepseek-ai/cosmokit']
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
  '用法：node install.mjs [--profile <dir>] [--dry-run] [--force] [--no-bundles] [--no-deps]',
  '',
  '  --profile <dir|name>  DSH profile 目录或名字（如 desktop、web），缺省 ' + defaultProfile(),
  '  --dry-run         只做预检并打印计划，不写任何文件',
  '  --force           目标已安装同版本时仍强制覆盖',
  '  --no-bundles      只复制文件、不改 dsh.profile.bundles（手工启用时用）',
  '  --no-deps         不写 dependencies、不放 profile/node_modules（不出现在插件管理器列表）',
].join('\n')

function parseArgv(argv) {
  const options = { profile: null, dryRun: false, force: false, bundles: true, deps: true, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--dry-run') options.dryRun = true
    else if (token === '--force') options.force = true
    else if (token === '--no-bundles') options.bundles = false
    else if (token === '--no-deps') options.deps = false
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
  // 主副本放 profile/node_modules（插件管理器的卡片列表从这里读）；DSH_HOME 留兜底副本。
  // --no-deps 时回退到旧行为：只有 DSH_HOME 副本 + bundles。
  const primaryTarget = path.join(profile, 'node_modules', PACKAGE_NAME)
  const fallbackTarget = path.join(dshHome(), 'node_modules', PACKAGE_NAME)
  const target = options.deps ? primaryTarget : fallbackTarget

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
  console.log('目标     ' + target + (options.deps ? '（主副本，插件管理器从这里读卡片信息）' : '（DSH_HOME 的 node_modules，pnpm 不管理）'))
  if (options.deps) console.log('兜底     ' + fallbackTarget + '（被 pnpm 清掉时保底）')
  console.log('profile  ' + profile + (options.deps ? '（写 dependencies + dsh.profile.bundles）' : '（只改 dsh.profile.bundles）'))
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

  const wanted = JSON.parse(JSON.stringify(profileManifest))
  if (options.deps) {
    wanted.dependencies = wanted.dependencies ?? {}
    wanted.dependencies[PACKAGE_NAME] = String(ownManifest.version)
  } else if (wanted.dependencies && PACKAGE_NAME in wanted.dependencies) {
    // --no-deps 的旧行为里不该留 dependencies 条目（否则 pnpm 重算时对不上）。
    delete wanted.dependencies[PACKAGE_NAME]
  }
  wanted.dsh = wanted.dsh ?? {}
  wanted.dsh.profile = wanted.dsh.profile ?? {}
  const bundles = Array.isArray(wanted.dsh.profile.bundles) ? wanted.dsh.profile.bundles.slice() : []
  const willAdd = options.bundles === true && !bundles.includes(PACKAGE_NAME)
  if (willAdd) bundles.push(PACKAGE_NAME)
  wanted.dsh.profile.bundles = bundles
  const manifestChanged = JSON.stringify(wanted) !== JSON.stringify(profileManifest)
  if (options.deps) {
    log(options, 'dependencies 写入 ' + PACKAGE_NAME + '@' + String(ownManifest.version) + '（精确版本，与 pnpm add 落盘一致）')
  } else {
    log(options, '--no-deps：不写 dependencies（不出现在插件管理器列表）')
  }
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
  const copyTo = async (dest) => {
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.rm(dest, { recursive: true, force: true })
    await fs.cp(HERE, dest, {
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
  }
  /** 把仓库 node_modules 里的运行库复制到目标 node_modules（Config schema 依赖）。 */
  const copyRuntimeDeps = async (destNodeModules) => {
    for (const dep of RUNTIME_DEPS) {
      const source = path.join(HERE, 'node_modules', dep)
      if (!(await exists(source))) continue
      const dest = path.join(destNodeModules, dep)
      await fs.mkdir(path.dirname(dest), { recursive: true })
      await fs.cp(source, dest, { recursive: true, force: true })
    }
  }
  try {
    if (manifestChanged) {
      await fs.copyFile(profilePackagePath, backup)
      backedUp = true
      console.log('已备份   ' + backup)
    }
    if (options.deps) {
      log(options, '复制插件文件 → ' + primaryTarget)
      await copyTo(primaryTarget)
      await copyRuntimeDeps(path.dirname(primaryTarget))
      log(options, '复制兜底副本 → ' + fallbackTarget)
      await copyTo(fallbackTarget)
      await copyRuntimeDeps(path.dirname(fallbackTarget))
    } else {
      log(options, '复制插件文件 → ' + fallbackTarget)
      await copyTo(fallbackTarget)
      await copyRuntimeDeps(path.dirname(fallbackTarget))
      // 旧行为不留 profile 副本：pnpm 会把它当多余目录，留着反而混淆排查。
      await fs.rm(primaryTarget, { recursive: true, force: true })
    }
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
  if (options.deps) {
    console.log('     设置 → 插件 列表会出现本插件卡片（读 dependencies + profile/node_modules）')
  }
  console.log('  2. 在仓库目录的会话里执行 /worktree help，能列出子命令即激活成功')
  console.log('  3. 让 Agent 调 worktree_create，或直接执行 /worktree create feature/demo')
  console.log('卸载：node uninstall.mjs' + (options.profile === null ? '' : ' --profile "' + profile + '"'))
}

main().catch((error) => {
  console.error('安装失败：' + String(error?.message ?? error))
  process.exitCode = 1
})
