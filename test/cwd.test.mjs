/**
 * cwd 解析：working-directory projection 优先，header.cwd 只作回退。
 * DSH 里 session.header.cwd 是新建会话的初始种子，切换目录后权威状态在 projection。
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { registerWorktreeCommand } from '../lib/commands.js'
import { registerTools } from '../lib/tools.js'
import { resolveSessionCwd, sessionCwdOf } from '../lib/util.js'
import { cleanup, fakeSubprocess, makeFakeCtx, makeRepo } from './helpers.mjs'

function projectionCtx(directory) {
  return makeFakeCtx({
    get: (name) => {
      if (name === 'subprocess') return fakeSubprocess()
      if (name === 'workingDirectory') return { get: () => directory }
      return undefined
    },
  })
}

test('resolveSessionCwd：projection 优先于 session.header.cwd', () => {
  const agent = { session: { header: { cwd: 'C:/repo' } } }
  const ctx = projectionCtx('C:/repo.wt/feature/a')
  assert.equal(resolveSessionCwd(ctx, agent), 'C:/repo.wt/feature/a')
  // 没有 projection 服务时退回 header.cwd
  assert.equal(resolveSessionCwd(makeFakeCtx(), agent), 'C:/repo')
  assert.equal(sessionCwdOf(agent), 'C:/repo')
})

test('resolveSessionCwd：projection 抛错或返回空值时安静回退', () => {
  const agent = { session: { header: { cwd: 'C:/repo' } } }
  const throwing = makeFakeCtx({ get: () => ({ get: () => { throw new Error('no projection') } }) })
  assert.equal(resolveSessionCwd(throwing, agent), 'C:/repo')
  const empty = makeFakeCtx({ get: () => ({ get: () => '' }) })
  assert.equal(resolveSessionCwd(empty, agent), 'C:/repo')
  const noSession = makeFakeCtx({ get: () => ({ get: () => 'C:/x' }) })
  assert.equal(resolveSessionCwd(noSession, null), null)
})

test('工具侧：会话目录切换后 worktree_status 按 projection 识别所在 worktree', async () => {
  const { base, repo, manager } = await makeRepo({})
  try {
    const created = await manager.create({ name: 'feature/cwd', cwd: repo })
    const ctx = projectionCtx(created.worktree.path)
    registerTools(ctx, manager)
    const byName = (name) => ctx.registeredTools.find((tool) => tool.name === name)
    // 故意让 header.cwd 留在主仓库：模拟「会话已经 cd 进 worktree，但 header 没变」
    const exec = { agent: { session: { header: { cwd: repo } } } }
    const status = await byName('worktree_status').execute({}, exec)
    assert.equal(status.inWorktree, true)
    assert.equal(status.worktree.name, 'feature/cwd')
    assert.equal(status.repoRoot, repo)
    assert.equal(path.dirname(status.worktree.path), path.join(base, 'portal.wt', 'feature'))
  } finally {
    await cleanup(base)
  }
})

test('命令侧：/worktree list 与 path 用 projection 定位仓库', async () => {
  const { base, repo, manager } = await makeRepo({})
  try {
    const created = await manager.create({ name: 'feature/cmd-cwd', cwd: repo })
    const ctx = projectionCtx(created.worktree.path)
    registerWorktreeCommand(ctx, manager)
    const command = ctx.registeredCommands[0]
    const invoke = (rawInput) => command.handler({
      agent: { session: { header: { cwd: repo } } },
      rawInput,
      signal: null,
    })
    const listed = await invoke('list')
    assert.equal(listed.kind, 'success')
    assert.ok(listed.text.includes('feature/cmd-cwd'))
    const shown = await invoke('path feature/cmd-cwd')
    assert.equal(shown.kind, 'success')
    assert.ok(shown.text.includes(path.join('portal.wt', 'feature', 'cmd-cwd')))
  } finally {
    await cleanup(base)
  }
})
