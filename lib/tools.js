/**
 * dsh-parallel-worktree — 模型侧工具。
 *
 * 只暴露「只读 + 新建」能力：create / list / status。合并、同步、删除、
 * 清理这类会改用户主分支或销毁数据的收尾动作只放在 /worktree 命令面，
 * 由人确认后执行（与 Codex / Claude Code 的 worktree 心智一致）。
 *
 * @module dsh-parallel-worktree/tools
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { localDefineTool } from './schema.js'
import { renderJson, resolveSessionCwd, sessionCwdOf } from './util.js'

/**
 * 解析宿主自带的 @deepseek-ai/dsh-tools。
 *
 * 优先走正常包解析（宿主进程里能解析到）。桌面版把依赖装进 app.asar，
 * 第三方 profile 的 node_modules 里没有该包，因此再按 resourcesPath 试
 * 几个固定位置——Electron 的 ESM loader 支持 asar 内的 file:// 路径。
 */
async function loadHostDefineTool() {
  const specifiers = ['@deepseek-ai/dsh-tools']
  const resources = process.resourcesPath
  if (typeof resources === 'string' && resources !== '') {
    const candidates = [
      path.join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
      path.join(resources, 'app', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
      path.join(resources, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
    ]
    for (const candidate of candidates) specifiers.push(pathToFileURL(candidate).href)
  }
  const tried = []
  for (const specifier of specifiers) {
    try {
      const mod = await import(specifier)
      if (typeof mod?.defineTool === 'function') return { defineTool: mod.defineTool, via: specifier }
    } catch (error) {
      tried.push(specifier + ' → ' + String(error?.code ?? error?.message ?? error))
    }
  }
  return { defineTool: null, via: null, tried }
}

const resolved = await loadHostDefineTool()
/** 宿主可用时用宿主的 defineTool（含严格参数校验），否则用本地等价实现。 */
export const defineTool = resolved.defineTool ?? localDefineTool
export const defineToolSource = resolved.defineTool === null ? 'local' : resolved.via
if (resolved.defineTool === null) {
  // 不抛错：桌面版可尝试 asar 路径；独立运行时有本地实现兜底
  console.warn?.('[dsh-parallel-worktree] 未解析到宿主 dsh-tools，改用本地 schema 实现' + (resolved.tried.length > 0 ? '：' + resolved.tried.join('; ') : ''))
}

function resolveCwd(exec, ctx) {
  return resolveSessionCwd(ctx, exec?.agent)
    ?? ctx?.get?.('sessions')?.get?.(exec?.agent?.session?.id)?.header?.cwd
    ?? null
}

/**
 * 注册工具。
 * @param ctx cordis context
 * @param manager worktree 管理器
 */
export function registerTools(ctx, manager) {
  ctx.tools.register(defineTool({
    name: 'worktree_create',
    description: '为一项独立任务创建 git worktree：在当前仓库的兄弟目录新建独立检出与分支，改动与主工作区完全隔离，可同时并行多个任务而互不干扰。创建后请在返回的绝对路径内开展该任务的全部改动，不要污染主工作区。收尾（同步/合并/删除）由人执行 /worktree 命令。',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'worktree 名（同时用于路径与分支名，默认分支 wt/<name>）。可含 / 分层，如 feature/login；每段由字母数字 . _ - 组成，禁止 ..、反斜杠、空格与 ~^:?*[]@{} ，总长 ≤100。',
      },
      base: {
        type: 'string',
        description: '起点 ref（分支/提交/tag），缺省为仓库当前主干分支。',
      },
      carryUncommitted: {
        type: 'boolean',
        description: '是否把主工作区当前未提交的改动（含未跟踪文件）复制进新 worktree，缺省 false。',
      },
      linkNodeModules: {
        type: 'boolean',
        description: '是否把主仓库的 node_modules 以链接（Windows 用 junction）挂进新 worktree，缺省用插件配置。',
      },
      copyEnv: {
        type: 'boolean',
        description: '是否复制插件事先配置的环境文件（默认 .env、.env.local），缺省 true。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          branch: { type: 'string', required: true },
          path: { type: 'string', required: true },
          repoRoot: { type: 'string', required: true },
          baseCommit: { type: 'string', required: true },
          createdAt: { type: 'string', required: true },
          manifestPath: { type: 'string', required: true },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args, exec) {
      const cwd = resolveCwd(exec, ctx)
      if (cwd === null || cwd === '') throw new Error('无法确定当前会话的工作目录')
      const result = await manager.create({
        name: args.name,
        base: args.base,
        carryUncommitted: args.carryUncommitted === true,
        linkNodeModules: args.linkNodeModules,
        copyEnv: args.copyEnv,
        cwd,
        createdBy: exec?.agent?.session?.id ?? null,
        signal: exec?.signal,
      })
      const entry = result.worktree
      return {
        name: entry.name,
        branch: entry.branch,
        path: entry.path,
        repoRoot: result.repoRoot,
        baseCommit: entry.baseCommit,
        createdAt: entry.createdAt,
        manifestPath: result.manifestPath,
        warnings: result.warnings,
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Create parallel worktree', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'worktree_list',
    description: '列出当前仓库已注册的所有并行 worktree：名字、分支、路径、是否存在、是否脏、HEAD、相对主干的领先/落后提交数。用于在并行开发前确认哪些分支已经存在，避免重复创建。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repoRoot: { type: 'string', required: true },
          wtRoot: { type: 'string', required: true },
          layout: { type: 'string', required: true },
          baseBranch: { type: 'string' },
          registry: { type: 'string', required: true },
          worktrees: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                branch: { type: 'string', required: true },
                path: { type: 'string', required: true },
                state: { type: 'string', required: true },
                exists: { type: 'boolean', required: true },
                dirty: { type: 'boolean', required: true },
                head: { type: 'string' },
                ahead: { type: 'number', required: true },
                behind: { type: 'number', required: true },
                baseCommit: { type: 'string' },
                createdAt: { type: 'string' },
                lastSyncAt: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(_args, exec) {
      const cwd = resolveCwd(exec, ctx)
      if (cwd === null || cwd === '') throw new Error('无法确定当前会话的工作目录')
      const result = await manager.list({ cwd, signal: exec?.signal })
      return {
        repoRoot: result.repoRoot,
        wtRoot: result.wtRoot,
        layout: result.layout,
        ...(result.baseBranch ? { baseBranch: result.baseBranch } : {}),
        registry: result.registry,
        worktrees: result.worktrees.map((entry) => ({
          name: entry.name,
          branch: entry.branch,
          path: entry.path,
          state: entry.state,
          exists: entry.exists,
          dirty: entry.dirty,
          ...(entry.head ? { head: entry.head } : {}),
          ahead: entry.ahead,
          behind: entry.behind,
          ...(entry.baseCommit ? { baseCommit: entry.baseCommit } : {}),
          ...(entry.createdAt ? { createdAt: entry.createdAt } : {}),
          ...(entry.lastSyncAt ? { lastSyncAt: entry.lastSyncAt } : {}),
        })),
      }
    },
    presentCall: () => ({ card: 'generic', title: 'List parallel worktrees', kind: 'other', rawInput: {} }),
  }))

  ctx.tools.register(defineTool({
    name: 'worktree_status',
    description: '查看某个并行 worktree 的状态；不带 name 时自动匹配当前会话所在的那个 worktree（返回 inWorktree=false 表示当前在主工作区）。',
    parameters: {
      name: { type: 'string', description: 'worktree 名或分支名；缺省按当前会话工作目录自动匹配。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repoRoot: { type: 'string', required: true },
          layout: { type: 'string', required: true },
          inWorktree: { type: 'boolean', required: true },
          worktree: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', required: true },
              branch: { type: 'string', required: true },
              path: { type: 'string', required: true },
              state: { type: 'string', required: true },
              exists: { type: 'boolean', required: true },
              dirty: { type: 'boolean', required: true },
              head: { type: 'string' },
              ahead: { type: 'number', required: true },
              behind: { type: 'number', required: true },
              baseCommit: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args, exec) {
      const cwd = resolveCwd(exec, ctx)
      if (cwd === null || cwd === '') throw new Error('无法确定当前会话的工作目录')
      const result = await manager.status({ name: args.name, cwd, signal: exec?.signal })
      const worktree = result.worktree === null
        ? undefined
        : {
            name: result.worktree.name,
            branch: result.worktree.branch,
            path: result.worktree.path,
            state: result.worktree.state,
            exists: result.worktree.exists,
            dirty: result.worktree.dirty,
            ...(result.worktree.head ? { head: result.worktree.head } : {}),
            ahead: result.worktree.ahead,
            behind: result.worktree.behind,
            ...(result.worktree.baseCommit ? { baseCommit: result.worktree.baseCommit } : {}),
          }
      return {
        repoRoot: result.repoRoot,
        layout: result.layout,
        inWorktree: result.inWorktree,
        ...(worktree ? { worktree } : {}),
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Parallel worktree status', kind: 'other', rawInput: args }),
  }))
}
