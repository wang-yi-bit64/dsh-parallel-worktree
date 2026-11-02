import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { WorktreeError } from '../lib/util.js'
import { cleanup, makeRepo, run } from './helpers.mjs'

async function withRepo(options, fn) {
  const ctx = await makeRepo(options)
  try {
    return await fn(ctx)
  } finally {
    await cleanup(ctx.base)
  }
}

function codeOf(error) {
  return error instanceof WorktreeError ? error.code : String(error)
}

test('create：在仓库外建检出，主工作区保持干净', async () => {
  await withRepo({}, async ({ repo, wtRoot, manager }) => {
    const result = await manager.create({ name: 'feature/login', cwd: repo })
    assert.equal(result.worktree.branch, 'wt/feature/login')
    assert.equal(result.worktree.path, path.join(wtRoot, 'feature', 'login'))
    assert.equal(result.worktree.state, 'active')
    const files = await fs.readdir(result.worktree.path)
    assert.ok(files.includes('README.md'))

    // 主仓库没有任何未跟踪/已修改文件（worktree 与注册表都在仓库外）
    assert.equal(run(repo, ['status', '--porcelain']), '')
    assert.equal(run(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main')
    const branches = run(repo, ['branch', '--list', 'wt/feature/login'])
    assert.ok(branches.includes('wt/feature/login'))
    const registry = JSON.parse(await fs.readFile(path.join(wtRoot, 'registry.json'), 'utf8'))
    assert.equal(registry.version, 1)
    assert.equal(registry.worktrees.length, 1)
  })
})

test('create：重复名/非法名/已存在分支都会被拦下', async () => {
  await withRepo({}, async ({ repo, manager }) => {
    await manager.create({ name: 'alpha', cwd: repo })
    await assert.rejects(manager.create({ name: 'alpha', cwd: repo }), (error) => codeOf(error) === 'NAME_EXISTS')
    await assert.rejects(manager.create({ name: 'a/../b', cwd: repo }), (error) => codeOf(error) === 'INVALID_NAME')
    await assert.rejects(manager.create({ name: 'bad name', cwd: repo }), (error) => codeOf(error) === 'INVALID_NAME')
    await assert.rejects(manager.create({ name: '.hidden', cwd: repo }), (error) => codeOf(error) === 'INVALID_NAME')
    run(repo, ['branch', 'wt/existing'])
    await assert.rejects(manager.create({ name: 'existing', cwd: repo }), (error) => codeOf(error) === 'BRANCH_EXISTS')
    await assert.rejects(manager.create({ name: 'alpha', cwd: path.join(repo, 'src') }), (error) => codeOf(error) === 'NAME_EXISTS')
  })
})

test('list/status：给出存在性、脏标记与领先/落后', async () => {
  await withRepo({}, async ({ repo, manager }) => {
    const { worktree } = await manager.create({ name: 'beta', cwd: repo })
    let listed = await manager.list({ cwd: repo })
    assert.equal(listed.worktrees.length, 1)
    assert.equal(listed.worktrees[0].dirty, false)
    assert.equal(listed.worktrees[0].exists, true)
    assert.equal(listed.baseBranch, 'main')

    await fs.writeFile(path.join(worktree.path, 'src', 'app.txt'), 'worktree edit\n', 'utf8')
    listed = await manager.list({ cwd: repo })
    assert.equal(listed.worktrees[0].dirty, true)

    const status = await manager.status({ name: 'beta', cwd: repo })
    assert.equal(status.inWorktree, true)
    assert.equal(status.worktree.dirty, true)

    const inside = await manager.status({ cwd: worktree.path })
    assert.equal(inside.inWorktree, true)
    assert.equal(inside.worktree.name, 'beta')

    const fromMain = await manager.status({ cwd: repo })
    assert.equal(fromMain.inWorktree, false)
  })
})

test('merge：合并回主干、state 变 merged、主仓库干净', async () => {
  await withRepo({}, async ({ repo, manager }) => {
    const { worktree } = await manager.create({ name: 'feature/x', cwd: repo })
    await fs.writeFile(path.join(worktree.path, 'src', 'feature.txt'), 'feature\n', 'utf8')
    run(worktree.path, ['add', '-A'])
    run(worktree.path, ['commit', '-q', '-m', 'add feature'])

    const merged = await manager.merge({ name: 'feature/x', cwd: repo })
    assert.equal(merged.base, 'main')
    assert.ok(merged.mergeCommit)
    const content = await fs.readFile(path.join(repo, 'src', 'feature.txt'), 'utf8')
    assert.equal(content, 'feature\n')
    assert.equal(run(repo, ['status', '--porcelain']), '')
    const listed = await manager.list({ cwd: repo })
    assert.equal(listed.worktrees[0].state, 'merged')
    assert.ok(listed.worktrees[0].ahead === 0)
  })
})

test('merge：主工作区脏时拒绝合并', async () => {
  await withRepo({}, async ({ repo, manager }) => {
    const { worktree } = await manager.create({ name: 'gamma', cwd: repo })
    await fs.writeFile(path.join(worktree.path, 'g.txt'), 'g\n', 'utf8')
    run(worktree.path, ['add', '-A'])
    run(worktree.path, ['commit', '-q', '-m', 'g'])
    await fs.writeFile(path.join(repo, 'dirty.txt'), 'dirty\n', 'utf8')
    await assert.rejects(manager.merge({ name: 'gamma', cwd: repo }), (error) => codeOf(error) === 'DIRTY_MAIN')
    await fs.unlink(path.join(repo, 'dirty.txt'))
  })
})

test('sync：主干前进后 rebase 同步，落后归零', async () => {
  await withRepo({}, async ({ repo, manager }) => {
    const { worktree } = await manager.create({ name: 'delta', cwd: repo })
    await fs.writeFile(path.join(repo, 'src', 'main-only.txt'), 'main\n', 'utf8')
    run(repo, ['add', '-A'])
    run(repo, ['commit', '-q', '-m', 'main advance'])
    let listed = await manager.list({ cwd: repo })
    assert.equal(listed.worktrees[0].behind, 1)

    const synced = await manager.sync({ name: 'delta', cwd: repo })
    assert.equal(synced.mode, 'rebase')
    listed = await manager.list({ cwd: repo })
    assert.equal(listed.worktrees[0].behind, 0)
    assert.ok(await fs.stat(path.join(worktree.path, 'src', 'main-only.txt')))
  })
})

test('remove：脏目录需 --force，删除可选删分支', async () => {
  await withRepo({}, async ({ repo, manager }) => {
    const { worktree } = await manager.create({ name: 'eps', cwd: repo })
    await fs.writeFile(path.join(worktree.path, 'wip.txt'), 'wip\n', 'utf8')
    await assert.rejects(manager.remove({ name: 'eps', cwd: repo }), (error) => codeOf(error) === 'DIRTY_WORKTREE')
    const removed = await manager.remove({ name: 'eps', force: true, deleteBranch: true, cwd: repo })
    assert.equal(removed.removedPath, true)
    assert.equal(removed.deletedBranch, true)
    await assert.rejects(fs.stat(worktree.path))
    assert.equal(run(repo, ['branch', '--list', 'wt/eps']), '')
    const listed = await manager.list({ cwd: repo })
    assert.equal(listed.worktrees.length, 0)
  })
})

test('prune：目录丢失的注册项被清理', async () => {
  await withRepo({}, async ({ repo, manager }) => {
    const { worktree } = await manager.create({ name: 'zeta', cwd: repo })
    await fs.rm(worktree.path, { recursive: true, force: true })
    let listed = await manager.list({ cwd: repo })
    assert.equal(listed.worktrees[0].exists, false)
    assert.equal(listed.worktrees[0].state, 'missing')
    const pruned = await manager.prune({ cwd: repo })
    assert.equal(pruned.pruned.length, 1)
    assert.equal(pruned.kept, 0)
    listed = await manager.list({ cwd: repo })
    assert.equal(listed.worktrees.length, 0)
  })
})

test('batch：部分失败不影响已创建项', async () => {
  await withRepo({}, async ({ repo, manager }) => {
    await manager.create({ name: 'taken', cwd: repo })
    const result = await manager.batch({ names: ['one', 'taken', 'two'], cwd: repo })
    assert.deepEqual(result.created.map((entry) => entry.name), ['one', 'two'])
    assert.equal(result.failed.length, 1)
    assert.equal(result.failed[0].name, 'taken')
    assert.equal(result.failed[0].code, 'NAME_EXISTS')
    const listed = await manager.list({ cwd: repo })
    assert.equal(listed.worktrees.length, 3)
  })
})

test('inside 布局：自动 .gitignore，主仓库仍干净', async () => {
  await withRepo({ manager: { layout: 'inside' } }, async ({ repo, manager }) => {
    const { worktree } = await manager.create({ name: 'eta', cwd: repo })
    assert.equal(worktree.path, path.join(repo, '.worktrees', 'eta'))
    const gitignore = await fs.readFile(path.join(repo, '.gitignore'), 'utf8')
    assert.ok(gitignore.includes('/.worktrees/'))
    // .gitignore 本身是已跟踪外的修改，故提交后再验干净
    run(repo, ['add', '.gitignore'])
    run(repo, ['commit', '-q', '-m', 'ignore worktrees'])
    assert.equal(run(repo, ['status', '--porcelain']), '')
    const listing = await manager.list({ cwd: repo })
    assert.ok(listing.wtRoot.endsWith('.worktrees'))
    assert.equal(listing.layout, 'inside')
    // 第二次创建不应重复追加
    await manager.create({ name: 'eta2', cwd: repo })
    const again = await fs.readFile(path.join(repo, '.gitignore'), 'utf8')
    assert.equal(again.split('/.worktrees/').length, 2)
  })
})

test('环境引导：复制 .env、链接 node_modules', async () => {
  await withRepo({ env: true, nodeModules: true }, async ({ repo, manager }) => {
    const { worktree, warnings } = await manager.create({ name: 'theta', cwd: repo, linkNodeModules: true })
    assert.deepEqual(warnings, [])
    assert.equal(await fs.readFile(path.join(worktree.path, '.env'), 'utf8'), 'TOKEN=1\n')
    assert.equal(await fs.readFile(path.join(worktree.path, '.env.local'), 'utf8'), 'LOCAL=2\n')
    const linked = await fs.readFile(path.join(worktree.path, 'node_modules', 'demo-pkg', 'index.js'), 'utf8')
    assert.equal(linked, 'module.exports = 1\n')
  })
})

test('carryUncommitted：携带已跟踪改动与未跟踪文件', async () => {
  await withRepo({}, async ({ repo, manager }) => {
    await fs.writeFile(path.join(repo, 'src', 'app.txt'), 'v2-dirty\n', 'utf8')
    await fs.writeFile(path.join(repo, 'notes.txt'), 'scratch\n', 'utf8')
    const { worktree, warnings } = await manager.create({ name: 'iota', cwd: repo, carryUncommitted: true })
    assert.deepEqual(warnings, [])
    assert.equal(await fs.readFile(path.join(worktree.path, 'src', 'app.txt'), 'utf8'), 'v2-dirty\n')
    assert.equal(await fs.readFile(path.join(worktree.path, 'notes.txt'), 'utf8'), 'scratch\n')
    // 主仓库保留原始改动
    assert.equal(await fs.readFile(path.join(repo, 'src', 'app.txt'), 'utf8'), 'v2-dirty\n')
  })
})

test('注册表损坏时给出 MANIFEST_CORRUPT', async () => {
  await withRepo({}, async ({ repo, wtRoot, manager }) => {
    await manager.create({ name: 'kappa', cwd: repo })
    await fs.writeFile(path.join(wtRoot, 'registry.json'), '{ not json', 'utf8')
    await assert.rejects(manager.list({ cwd: repo }), (error) => codeOf(error) === 'MANIFEST_CORRUPT')
  })
})

test('非 git 目录给出 NOT_GIT_REPO', async () => {
  await withRepo({}, async ({ base, manager }) => {
    await assert.rejects(manager.list({ cwd: base }), (error) => codeOf(error) === 'NOT_GIT_REPO')
  })
})
