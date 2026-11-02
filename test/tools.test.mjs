import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { apply } from '../lib/index.js'
import { registerWorktreeCommand } from '../lib/commands.js'
import { registerTools } from '../lib/tools.js'
import { cleanup, makeFakeCtx, makeRepo, run } from './helpers.mjs'

async function withRepo(options, fn) {
  const ctx = await makeRepo(options)
  try {
    return await fn(ctx)
  } finally {
    await cleanup(ctx.base)
  }
}

function execFor(cwd) {
  return { agent: { session: { header: { cwd } } } }
}

test('registerTools：注册三个工具，参数与输出契约稳定', async () => {
  await withRepo({}, async ({ repo, manager }) => {
    const ctx = makeFakeCtx()
    registerTools(ctx, manager)
    assert.deepEqual(ctx.registeredTools.map((tool) => tool.name).sort(), ['worktree_create', 'worktree_list', 'worktree_status'])
    const create = ctx.registeredTools.find((tool) => tool.name === 'worktree_create')
    // 注册到宿主的定义里 parameters 已是 JSON Schema（required 提升到数组）
    assert.equal(create.parameters.type, 'object')
    assert.equal(create.parameters.properties.name.type, 'string')
    assert.deepEqual(create.parameters.required, ['name'])
    assert.equal(create.output.schema.additionalProperties, false)
    assert.ok(create.output.schema.required.includes('name'))
    assert.equal(create.presentCall({ name: 'x' }).card, 'generic')
    assert.equal(typeof create.output.render, 'function')
  })
})

test('worktree_create/list/status：端到端跑通', async () => {
  await withRepo({}, async ({ repo, manager }) => {
    const ctx = makeFakeCtx()
    registerTools(ctx, manager)
    const byName = (name) => ctx.registeredTools.find((tool) => tool.name === name)

    const created = await byName('worktree_create').execute({ name: 'feature/api' }, execFor(repo))
    assert.equal(created.branch, 'wt/feature/api')
    assert.equal(created.repoRoot, repo)
    assert.ok(created.path.includes(path.join('portal.wt', 'feature', 'api')))
    assert.ok(created.manifestPath.endsWith('registry.json'))

    const listed = await byName('worktree_list').execute({}, execFor(repo))
    assert.equal(listed.worktrees.length, 1)
    assert.equal(listed.worktrees[0].name, 'feature/api')
    assert.equal(listed.baseBranch, 'main')

    const status = await byName('worktree_status').execute({ name: 'feature/api' }, execFor(repo))
    assert.equal(status.inWorktree, true)

    const rendered = byName('worktree_list').output.render({}, listed)
    assert.equal(rendered[0].type, 'text')
    assert.equal(JSON.parse(rendered[0].text).worktrees.length, 1)

    // 重复创建要抛出可读错误（含 hint）
    await assert.rejects(byName('worktree_create').execute({ name: 'feature/api' }, execFor(repo)), (error) => /already|已/.test(error.message))
  })
})

test('worktree：命令注册表与子命令行为', async () => {
  await withRepo({}, async ({ repo, wtRoot, manager }) => {
    const ctx = makeFakeCtx()
    registerWorktreeCommand(ctx, manager)
    assert.equal(ctx.registeredCommands.length, 1)
    const command = ctx.registeredCommands[0]
    assert.equal(command.name, 'worktree')
    assert.equal(typeof command.handler, 'function')
    const invoke = (rawInput) => command.handler({ agent: { session: { header: { cwd: repo } } }, rawInput })

    const help = await invoke('help')
    assert.equal(help.kind, 'success')
    assert.ok(help.text.includes('create'))

    const created = await invoke('create feature/cmd --base main')
    assert.equal(created.kind, 'success')
    assert.ok(created.text.includes(path.join(wtRoot, 'feature', 'cmd')))

    const listed = await invoke('list')
    assert.equal(listed.kind, 'success')
    assert.ok(listed.text.includes('feature/cmd'))
    assert.ok(listed.text.includes('分支'))

    const status = await invoke('status feature/cmd')
    assert.equal(status.kind, 'success')

    const pathOut = await invoke('path feature/cmd')
    assert.equal(pathOut.kind, 'success')
    assert.ok(pathOut.text.includes(path.join(wtRoot, 'feature', 'cmd')))

    const bad = await invoke('nope')
    assert.equal(bad.kind, 'error')
    assert.ok(bad.text.startsWith('✗'))

    const dup = await invoke('create feature/cmd')
    assert.equal(dup.kind, 'error')
    assert.ok(dup.text.includes('✗'))
  })
})

test('worktree：merge / sync / remove 走完整人类流程', async () => {
  await withRepo({}, async ({ repo, manager }) => {
    const ctx = makeFakeCtx()
    registerWorktreeCommand(ctx, manager)
    const command = ctx.registeredCommands[0]
    const invoke = (rawInput) => command.handler({ agent: { session: { header: { cwd: repo } } }, rawInput })

    await invoke('create flow')
    const wtPath = path.join(repo, '..', 'portal.wt', 'flow')
    await fs.writeFile(path.join(wtPath, 'flow.txt'), 'flow\n', 'utf8')
    run(wtPath, ['add', '-A'])
    run(wtPath, ['commit', '-q', '-m', 'flow'])

    // 主干前进 → sync
    await fs.writeFile(path.join(repo, 'main.txt'), 'm\n', 'utf8')
    run(repo, ['add', '-A'])
    run(repo, ['commit', '-q', '-m', 'main advance'])
    const synced = await invoke('sync flow')
    assert.equal(synced.kind, 'success')
    assert.ok(synced.text.length > 0)

    const merged = await invoke('merge flow --message "merge flow" --remove --delete-branch')
    assert.equal(merged.kind, 'success')
    assert.equal(await fs.readFile(path.join(repo, 'flow.txt'), 'utf8'), 'flow\n')
    const listed = await invoke('list')
    assert.ok(listed.text.includes('还没有注册任何 worktree'))
    assert.equal(run(repo, ['branch', '--list', 'wt/flow']), '')
  })
})

test('apply：默认配置注册工具与命令，enabled:false 时不注册', async () => {
  await withRepo({}, async ({ repo }) => {
    const ctx = makeFakeCtx()
    apply(ctx, { branchPrefix: 'parallel/', layout: 'inside' })
    assert.equal(ctx.registeredTools.length, 3)
    assert.equal(ctx.registeredCommands.length, 1)
    assert.ok(ctx.logs.some((line) => String(line).includes('inside')))

    const created = await ctx.registeredTools.find((tool) => tool.name === 'worktree_create').execute({ name: 'omega' }, execFor(repo))
    assert.equal(created.branch, 'parallel/omega')
    assert.ok(created.path.includes(path.join('.worktrees', 'omega')))

    const offCtx = makeFakeCtx()
    apply(offCtx, { enabled: false })
    assert.equal(offCtx.registeredTools.length, 0)
    assert.equal(offCtx.registeredCommands.length, 0)
  })
})
