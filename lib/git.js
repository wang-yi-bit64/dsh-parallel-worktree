/**
 * dsh-parallel-worktree — git 执行器。
 *
 * - createSubprocessRunner(ctx)：生产路径，走 DSH 的 ctx.subprocess seam
 *   （harness 管理进程树、沙箱与信号）。
 * - createProcessRunner()：独立路径，走 node:child_process，供测试与
 *   无宿主冒烟使用。
 *
 * @module dsh-parallel-worktree/git
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const GIT_COLLECT_BYTES = 4 << 20
const GIT_GRACE_MS = 120_000

function isSubprocessLike(value) {
  return Boolean(value) && typeof value === 'object' && typeof value.spawn === 'function'
}

function collect(opts, text) {
  if (opts?.raw) return text ?? ''
  return (text ?? '').trim()
}

/**
 * 基于 ctx.subprocess 的 runner。
 * @param ctx cordis context（或任意 get(name) 能取到 subprocess 的容器）
 * @returns GitRunner (args, cwd, signal?, opts?) => {exitCode, signalName, stdout, stderr}
 */
export function createSubprocessRunner(ctx) {
  const subprocess = ctx?.get?.('subprocess') ?? ctx?.subprocess
  if (!isSubprocessLike(subprocess)) {
    throw new Error('ctx.subprocess 服务不可用：请确认插件 inject 中包含 subprocess')
  }
  return async (args, cwd, signal, opts) => {
    const handle = subprocess.spawn({
      argv: ['git', ...args],
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: GIT_COLLECT_BYTES },
        stderr: { maxBytes: GIT_COLLECT_BYTES },
      },
      graceMs: GIT_GRACE_MS,
      signal: signal ?? undefined,
    })
    const outcome = await handle.done
    return {
      exitCode: outcome?.exitCode ?? 1,
      signalName: outcome?.signal ?? null,
      stdout: collect(opts, handle.collected?.stdout?.readFrom(0).text),
      stderr: collect(opts, handle.collected?.stderr?.readFrom(0).text),
    }
  }
}

/**
 * 基于 child_process.execFile 的 runner（不经 shell，避免注入）。
 * @returns GitRunner
 */
export function createProcessRunner() {
  return async (args, cwd, signal, opts) => {
    try {
      const { stdout, stderr } = await exec('git', args, {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: GIT_COLLECT_BYTES,
        signal: signal ?? undefined,
      })
      return { exitCode: 0, signalName: null, stdout: collect(opts, stdout), stderr: collect(opts, stderr) }
    } catch (error) {
      if (error?.killed || error?.signal) {
        return { exitCode: error.code ?? 1, signalName: error.signal ?? null, stdout: '', stderr: '' }
      }
      return {
        exitCode: typeof error?.code === 'number' ? error.code : 1,
        signalName: null,
        stdout: collect(opts, error?.stdout),
        stderr: String(error?.stderr ?? error?.message ?? error).trim(),
      }
    }
  }
}
