/**
 * 测试脚手架：临时 git 仓库 + 假 ctx（无宿主）。
 */
import { execFileSync, spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createProcessRunner } from '../lib/git.js'
import { createWorktreeManager } from '../lib/manager.js'

export function run(cwd, args, options = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', ...options }).trim()
}

export async function makeRepo(options = {}) {
  // 规范化临时目录：Windows CI 的 TEMP 可能是 8.3 短名（RUNNER~1），
  // 而 git 输出的是长路径，两边直接比较会失败。realpath.native 得到长名。
  const baseRaw = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-pw-'))
  const base = realpathSync.native(baseRaw)
  const repo = path.join(base, 'portal')
  await fs.mkdir(path.join(repo, 'src'), { recursive: true })
  run(repo, ['init', '-q', '-b', 'main'])
  run(repo, ['config', 'user.name', 'Parallel Worktree Test'])
  run(repo, ['config', 'user.email', 'pw@example.com'])
  run(repo, ['config', 'commit.gpgsign', 'false'])
  run(repo, ['config', 'core.autocrlf', 'false'])
  await fs.writeFile(path.join(repo, 'README.md'), '# portal\n', 'utf8')
  await fs.writeFile(path.join(repo, 'src', 'app.txt'), 'v1\n', 'utf8')
  run(repo, ['add', '-A'])
  run(repo, ['commit', '-q', '-m', 'init'])
  if (options.env === true) {
    await fs.writeFile(path.join(repo, '.env'), 'TOKEN=1\n', 'utf8')
    await fs.writeFile(path.join(repo, '.env.local'), 'LOCAL=2\n', 'utf8')
  }
  if (options.nodeModules === true) {
    await fs.mkdir(path.join(repo, 'node_modules', 'demo-pkg'), { recursive: true })
    await fs.writeFile(path.join(repo, 'node_modules', 'demo-pkg', 'index.js'), 'module.exports = 1\n', 'utf8')
  }
  const manager = createWorktreeManager({
    git: createProcessRunner(),
    ...(options.manager ?? {}),
  })
  return {
    base,
    repo,
    wtRoot: path.join(base, 'portal.wt'),
    manager,
  }
}

export async function cleanup(base) {
  await fs.rm(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}

/** 复刻 ctx.subprocess 的 spawn 句柄形状，转调真实 git 子进程。 */
export function fakeSubprocess() {
  return {
    spawn({ argv, cwd }) {
      const [command, ...args] = argv
      let stdout = ''
      let stderr = ''
      const done = new Promise((resolve) => {
        const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        child.stdout.on('data', (chunk) => { stdout += String(chunk) })
        child.stderr.on('data', (chunk) => { stderr += String(chunk) })
        child.on('error', (error) => {
          stderr += String(error?.message ?? error)
          resolve({ exitCode: 1, signal: null })
        })
        child.on('close', (code, signal) => resolve({ exitCode: code ?? 1, signal }))
      })
      return {
        done,
        collected: {
          stdout: { readFrom: () => ({ text: stdout }) },
          stderr: { readFrom: () => ({ text: stderr }) },
        },
      }
    },
  }
}

/** 最小 cordis ctx：只记录注册结果。 */
export function makeFakeCtx(options = {}) {
  const registeredTools = []
  const registeredCommands = []
  const logs = []
  return {
    registeredTools,
    registeredCommands,
    logs,
    tools: { register: (definition) => { registeredTools.push(definition); return definition } },
    commands: { register: (definition) => { registeredCommands.push(definition); return definition } },
    get: (name) => (name === 'subprocess' ? fakeSubprocess() : undefined),
    logger: { info: (message) => logs.push(message), warn: (message) => logs.push(message) },
    on: () => {},
    ...options,
  }
}
