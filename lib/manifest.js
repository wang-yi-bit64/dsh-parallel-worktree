/**
 * dsh-parallel-worktree — 仓库级注册表（registry.json）。
 *
 * 注册表刻意放在仓库之外（默认 sibling 布局 <repo>.wt/registry.json），
 * 因此主仓库的工作树始终干净；inside 布局时才写入 <repo>/.worktrees/ 并
 * 自动追加 .gitignore。写入走 tmp + rename 原子替换，读改写走文件锁。
 *
 * @module dsh-parallel-worktree/manifest
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { WorktreeError, nowIso } from './util.js'

export const MANIFEST_VERSION = 1

export function manifestPathFor(wtRoot) {
  return path.join(wtRoot, 'registry.json')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 读取注册表；不存在返回 null，损坏抛 MANIFEST_CORRUPT。
 * @param wtRoot worktree 根目录
 */
export async function readManifest(wtRoot) {
  const file = manifestPathFor(wtRoot)
  let text
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  let data
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new WorktreeError('MANIFEST_CORRUPT', '注册表不是合法 JSON：' + file, String(error?.message ?? error))
  }
  if (data === null || typeof data !== 'object' || data.version !== MANIFEST_VERSION || !Array.isArray(data.worktrees)) {
    throw new WorktreeError('MANIFEST_CORRUPT', '注册表结构不符合 v' + String(MANIFEST_VERSION) + '：' + file, '可备份后删除该文件重建（worktree 目录本身不受影响）')
  }
  return data
}

/** 原子写入注册表。 */
export async function writeManifest(wtRoot, data) {
  await fs.mkdir(wtRoot, { recursive: true })
  const file = manifestPathFor(wtRoot)
  const tmp = file + '.' + String(process.pid) + '.tmp'
  const body = JSON.stringify(data, null, 2) + '\n'
  await fs.writeFile(tmp, body, 'utf8')
  await fs.rename(tmp, file)
}

/**
 * 注册表读改写互斥（跨进程文件锁）。批量创建不需要外层重入。
 * @param wtRoot worktree 根目录
 * @param fn 临界区回调
 */
export async function withManifestLock(wtRoot, fn) {
  await fs.mkdir(wtRoot, { recursive: true })
  const lockFile = path.join(wtRoot, 'registry.lock')
  let handle = null
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      handle = await fs.open(lockFile, 'wx')
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        const stat = await fs.stat(lockFile)
        if (Date.now() - stat.mtimeMs > 30_000) {
          await fs.unlink(lockFile).catch(() => {})
          continue
        }
      } catch {
        // 锁刚被释放，重试
      }
      await sleep(50)
    }
  }
  if (handle === null) {
    throw new WorktreeError('LOCK_TIMEOUT', '注册表锁等待超时：' + lockFile, '确认没有其他 dsh 进程卡住，或手动删除该锁文件')
  }
  try {
    return await fn()
  } finally {
    await handle.close().catch(() => {})
    await fs.unlink(lockFile).catch(() => {})
  }
}

/** 构造空注册表。 */
export function emptyManifest(layout, repoRoot, baseBranch) {
  return {
    version: MANIFEST_VERSION,
    layout,
    repoRoot,
    baseBranch: baseBranch ?? null,
    createdAt: nowIso(),
    worktrees: [],
  }
}
