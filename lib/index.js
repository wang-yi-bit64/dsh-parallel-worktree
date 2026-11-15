/**
 * dsh-parallel-worktree — 插件入口。
 *
 * 能力：
 * - 模型工具 worktree_create / worktree_list / worktree_status（只读与新建）；
 * - 人类命令 /worktree create|batch|list|status|sync|merge|remove|prune|path；
 * - 仓库级注册表（默认放在仓库外的 <repo>.wt/，主仓库不被污染）；
 * - 创建时可选复制 .env 类文件、链接 node_modules、携带未提交改动。
 *
 * @module dsh-parallel-worktree
 */
import { registerWorktreeCommand } from './commands.js'
import { createSubprocessRunner } from './git.js'
import { createWorktreeManager } from './manager.js'
import { registerTools } from './tools.js'

export const name = 'parallel-worktree'
export const inject = ['tools', 'commands', 'subprocess']

/**
 * 插件配置 schema：设置页据此自动渲染表单，cordis.patch.yml 的 config 节提供值。
 * schemastery 是 DSH 自带包（install.mjs 会把 schemastery + cosmokit 一并复制到
 * 安装位置），解析失败时导出 undefined——cordis 对没有 Config 导出的插件照常
 * 透传 config，只是没有设置表单。
 * storageRoot 支持 {repo} 占位符（展开成仓库名）；空串表示沿用 sibling 约定。
 */
let Config
try {
  const mod = await import('@deepseek-ai/schemastery')
  const z = mod.default ?? mod
  // 全部业务字段 .volatile()：DSH 的设置表单只暴露 volatile 字段（写入后 fiber
  // 不重挂载、配置引用原地更新——manager 经活配置对象实时读取，下一次
  // create/list/sync 即用新值）。enabled 留作普通字段（重挂载级开关）。
  Config = z.object({
    storageRoot: z.string().default('').volatile().description(
      'worktree 存放根目录模板；空串表示沿用仓库旁的 <repo>.wt/。支持 {repo} 占位符（展开成仓库名），相对路径按仓库父目录解析。inside 布局下忽略。'),
    layout: z.union(['sibling', 'inside']).default('sibling').volatile().description(
      'sibling：worktree 放在仓库外（默认）；inside：放在仓库内的 .worktrees/（自动写入 .gitignore）。'),
    dirName: z.string().default('.worktrees').volatile().description('inside 布局时仓库内的目录名。'),
    siblingSuffix: z.string().default('.wt').volatile().description('sibling 布局时仓库名后的后缀（<repo><后缀>/）。'),
    branchPrefix: z.string().default('wt/').volatile().description('创建分支时的前缀；空串表示直接用 worktree 名。'),
    copyEnv: z.array(z.string()).default(['.env', '.env.local']).volatile().description(
      '创建 worktree 时从主仓库复制的环境文件列表；设为 [] 表示不复制。'),
    linkNodeModules: z.boolean().default(false).volatile().description('创建时默认把主仓库 node_modules 链接进新 worktree（Windows 用 junction）。'),
    syncMode: z.union(['rebase', 'merge']).default('rebase').volatile().description('/worktree sync 的默认同步策略。'),
    baseBranch: z.string().default('').volatile().description('默认基准分支；空串表示自动探测仓库当前分支。'),
    enabled: z.boolean().default(true).description('总开关；false 时插件不注册工具与命令（改动需重启）。'),
  })
} catch {
  Config = undefined
}

export { Config }

/**
 * 挂载插件。
 * @param ctx cordis context
 * @param config profile patch 里的 config：storageRoot、layout('sibling'|'inside')、dirName、
 *   siblingSuffix、branchPrefix、copyEnv、linkNodeModules、syncMode('rebase'|'merge')、baseBranch、enabled。
 */
export function apply(ctx, config = {}) {
  if (config?.enabled === false) return
  const git = createSubprocessRunner(ctx)
  const manager = createWorktreeManager({
    git,
    // 活配置对象：volatile 字段的设置写入会原地更新它，manager 实时读取。
    settings: config,
    layout: config?.layout,
    dirName: config?.dirName,
    siblingSuffix: config?.siblingSuffix,
    branchPrefix: config?.branchPrefix,
    copyEnv: config?.copyEnv,
    linkNodeModules: config?.linkNodeModules,
    syncMode: config?.syncMode,
    baseBranch: config?.baseBranch,
    storageRoot: config?.storageRoot,
  })
  registerTools(ctx, manager)
  registerWorktreeCommand(ctx, manager)
  if (typeof ctx.logger?.info === 'function') {
    const settings = manager.config()
    ctx.logger.info('parallel-worktree 已就绪：layout=' + settings.layout + ', branchPrefix=' + (settings.branchPrefix === '' ? '(空)' : settings.branchPrefix))
  }
}
