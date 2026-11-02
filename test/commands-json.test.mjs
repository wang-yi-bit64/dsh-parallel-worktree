/**
 * /worktree --json：结构化输出的回归测试（供客户端面板/脚本解析）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { cleanup, makeFakeCtx, makeRepo } from './helpers.mjs'
import { registerWorktreeCommand } from '../lib/commands.js'

function invocation(cwd, rawInput) {
  return { rawInput, signal: undefined, agent: { session: { id: 'session-json', header: { cwd } } } }
}

function parse(result) {
  assert.equal(typeof result.text, 'string')
  return JSON.parse(result.text)
}

test('/worktree <sub> --json 返回可解析的结构化结果', async () => {
  const { base, repo, manager } = await makeRepo()
  try {
    const ctx = makeFakeCtx()
    registerWorktreeCommand(ctx, manager)
    const handler = ctx.registeredCommands[0].handler

    // help 里要写上 --json，避免面板用法无从发现
    const help = await handler(invocation(repo, 'help'))
    assert.equal(help.kind, 'success')
    assert.match(help.text, /--json/)

    // 空列表
    const empty = parse(await handler(invocation(repo, 'list --json')))
    assert.equal(empty.ok, true)
    assert.equal(empty.action, 'list')
    assert.equal(empty.repoRoot, repo)
    assert.deepEqual(empty.worktrees, [])

    // 创建
    const created = parse(await handler(invocation(repo, 'create json-a --json')))
    assert.equal(created.ok, true)
    assert.equal(created.action, 'create')
    assert.equal(created.name, 'json-a')
    assert.equal(created.branch, 'wt/json-a')
    assert.equal(created.path, path.join(base, 'portal.wt', 'json-a'))
    assert.equal(created.repoRoot, repo)
    assert.ok(typeof created.manifestPath === 'string')

    // 列表里能看到
    const listed = parse(await handler(invocation(repo, 'list --json')))
    assert.equal(listed.worktrees.length, 1)
    assert.equal(listed.worktrees[0].name, 'json-a')
    assert.equal(listed.worktrees[0].state, 'active')

    // 主工作区里 status：worktree 为 null，且带上客户端徽标要用的字段
    const mainStatus = parse(await handler(invocation(repo, 'status --json')))
    assert.equal(mainStatus.action, 'status')
    assert.equal(mainStatus.worktree, null)
    assert.equal(mainStatus.inWorktree, false)
    assert.equal(mainStatus.layout, 'sibling')
    assert.ok('baseBranch' in mainStatus)

    // worktree 目录里 status：识别到自身，inWorktree 为 true
    const inWt = parse(await handler(invocation(created.path, 'status --json')))
    assert.equal(inWt.inWorktree, true)
    assert.equal(inWt.worktree.name, 'json-a')
    assert.equal(inWt.worktree.branch, 'wt/json-a')

    // path
    const p = parse(await handler(invocation(repo, 'path json-a --json')))
    assert.equal(p.action, 'path')
    assert.equal(p.path, created.path)

    // 错误也走 JSON（kind=error，便于面板统一处理）
    const missing = await handler(invocation(repo, 'remove nope --json'))
    assert.equal(missing.kind, 'error')
    const failure = parse(missing)
    assert.equal(failure.ok, false)
    assert.equal(typeof failure.code, 'string')

    // 未知子命令
    const unknown = await handler(invocation(repo, 'wat --json'))
    assert.equal(unknown.kind, 'error')
    assert.equal(parse(unknown).code, 'UNKNOWN_SUBCOMMAND')

    // 不带 --json 时仍是人类可读文本
    const human = await handler(invocation(repo, 'list'))
    assert.equal(human.kind, 'success')
    assert.match(human.text, /仓库/)
    assert.throws(() => JSON.parse(human.text))
  } finally {
    await cleanup(base)
  }
})

test('/worktree prune --json 返回清理结果', async () => {
  const { base, repo, manager } = await makeRepo()
  try {
    const ctx = makeFakeCtx()
    registerWorktreeCommand(ctx, manager)
    const handler = ctx.registeredCommands[0].handler
    parse(await handler(invocation(repo, 'create gone --json')))
    const pruned = parse(await handler(invocation(repo, 'prune --json')))
    assert.equal(pruned.action, 'prune')
    assert.deepEqual(pruned.pruned, [])
    assert.ok(Number.isInteger(pruned.kept))
  } finally {
    await cleanup(base)
  }
})
