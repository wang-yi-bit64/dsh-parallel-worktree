#!/usr/bin/env node
/**
 * 从 DSH 桌面 profile 卸载 dsh-parallel-worktree。
 *
 * 反向执行 install.mjs：从 dsh.profile.bundles 与 dependencies 里移除条目，
 * 删掉 <DSH_HOME>/node_modules/dsh-parallel-worktree（以及老版本留在 profile 里的副本），
 * 并把包名从 profile 的 dsh.profile.bundles 移除（先备份 package.json）。
 *
 * 用法：node uninstall.mjs [--profile <dir|name>] [--dry-run]
 */
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const PACKAGE_NAME = 'dsh-parallel-worktree'

function dshHome() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
}

function defaultProfile() {
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR
  return path.join(dshHome(), 'profiles', 'desktop')
}

// 同 install.mjs：--profile 既接受目录路径，也接受 profile 名字。
function resolveProfile(value) {
  const raw = value ?? defaultProfile()
  if (!path.isAbsolute(raw) && !/[\\/]/.test(raw)) {
    const named = path.join(dshHome(), 'profiles', raw)
    if (existsSync(named)) return named
  }
  return path.resolve(raw)
}

function timestamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return String(now.getFullYear()) + pad(now.getMonth() + 1) + pad(now.getDate())
    + '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds())
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

async function main() {
  const argv = process.argv.slice(2)
  let profile = null
  let dryRun = false
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--dry-run') dryRun = true
    else if (token === '--profile') { profile = argv[index + 1]; index += 1 }
    else if (token.startsWith('--profile=')) profile = token.slice('--profile='.length)
    else if (token === '--help' || token === '-h') {
      console.log('用法：node uninstall.mjs [--profile <dir|name>] [--dry-run]')
      return
    } else throw new Error('未知参数：' + token)
  }
  profile = resolveProfile(profile)
  const profilePackagePath = path.join(profile, 'package.json')
  // 新版本安装在 DSH_HOME/node_modules；老版本在 profile/node_modules，两个都删。
  const target = path.join(dshHome(), 'node_modules', PACKAGE_NAME)
  const legacyTarget = path.join(profile, 'node_modules', PACKAGE_NAME)

  let manifest
  try {
    manifest = await readJson(profilePackagePath)
  } catch {
    throw new Error('找不到 profile 的 package.json：' + profilePackagePath + '（用 --profile 指定）')
  }

  const wanted = JSON.parse(JSON.stringify(manifest))
  let changed = false
  if (wanted.dependencies !== undefined && wanted.dependencies !== null && PACKAGE_NAME in wanted.dependencies) {
    delete wanted.dependencies[PACKAGE_NAME]
    changed = true
  }
  const bundles = wanted.dsh?.profile?.bundles
  if (Array.isArray(bundles) && bundles.includes(PACKAGE_NAME)) {
    wanted.dsh.profile.bundles = bundles.filter((name) => name !== PACKAGE_NAME)
    changed = true
  }

  if (changed) {
    if (dryRun) {
      console.log('[dry-run] 会从 ' + profilePackagePath + ' 移除 ' + PACKAGE_NAME)
    } else {
      const backup = profilePackagePath + '.bak-' + timestamp()
      await fs.copyFile(profilePackagePath, backup)
      await fs.writeFile(profilePackagePath, JSON.stringify(wanted, null, 2) + '\n', 'utf8')
      console.log('已更新   ' + profilePackagePath + '（备份 ' + backup + '）')
    }
  } else {
    console.log('profile/package.json 里没有 ' + PACKAGE_NAME + ' 的条目')
  }

  let exists = true
  try {
    await fs.stat(target)
  } catch {
    exists = false
  }
  if (exists) {
    if (dryRun) console.log('[dry-run] 会删除 ' + target)
    else {
      await fs.rm(target, { recursive: true, force: true })
      await fs.rm(legacyTarget, { recursive: true, force: true })
      console.log('已删除   ' + target)
    }
  } else {
    console.log('目标目录不存在：' + target)
  }

  console.log('')
  console.log('完成。重启 DSH Desktop 后 /worktree 命令即消失（已创建的 worktree 目录不受影响）。')
}

main().catch((error) => {
  console.error('卸载失败：' + String(error?.message ?? error))
  process.exitCode = 1
})
