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
 * 挂载插件。
 * @param ctx cordis context
 * @param config profile patch 里的 config：layout('sibling'|'inside')、dirName、siblingSuffix、
 *   branchPrefix、copyEnv、linkNodeModules、syncMode('rebase'|'merge')、baseBranch、enabled。
 */
export function apply(ctx, config = {}) {
  if (config?.enabled === false) return
  const git = createSubprocessRunner(ctx)
  const manager = createWorktreeManager({
    git,
    layout: config?.layout,
    dirName: config?.dirName,
    siblingSuffix: config?.siblingSuffix,
    branchPrefix: config?.branchPrefix,
    copyEnv: config?.copyEnv,
    linkNodeModules: config?.linkNodeModules,
    syncMode: config?.syncMode,
    baseBranch: config?.baseBranch,
  })
  registerTools(ctx, manager)
  registerWorktreeCommand(ctx, manager)
  if (typeof ctx.logger?.info === 'function') {
    const settings = manager.config()
    ctx.logger.info('parallel-worktree 已就绪：layout=' + settings.layout + ', branchPrefix=' + (settings.branchPrefix === '' ? '(空)' : settings.branchPrefix))
  }
}
