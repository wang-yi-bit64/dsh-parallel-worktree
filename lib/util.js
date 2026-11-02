/**
 * dsh-parallel-worktree — 共享工具：错误类型、ref 名校验、JSON 渲染、argv 解析。
 *
 * @module dsh-parallel-worktree/util
 */

/** 带稳定 code 的插件错误，命令层据此生成可读提示。 */
export class WorktreeError extends Error {
  constructor(code, message, hint) {
    super(message)
    this.name = 'WorktreeError'
    this.code = code
    this.hint = hint ?? null
  }
}

export function isWorktreeError(value) {
  return value instanceof WorktreeError
}

export function nowIso() {
  return new Date().toISOString()
}

const NAME_MAX = 100
// git check-ref-format 禁止的字符（含控制字符、空格、~ ^ : ? * [ ] @ { } 反斜杠）
const BAD_CHARS = /[\u0000-\u0020~^:?*[\]@{}]/

/**
 * 校验 worktree 名：允许斜杠分层，禁止空段、点段、路径穿越与 git 保留字符。
 * @param name
 * @returns boolean
 */
export function isValidRefName(name) {
  if (typeof name !== 'string') return false
  if (name.length === 0 || name.length > NAME_MAX) return false
  if (name.includes('\\') || name.includes('//') || name.includes('..')) return false
  if (name.startsWith('/') || name.endsWith('/') || name.startsWith('.') || name.endsWith('.')) return false
  if (BAD_CHARS.test(name)) return false
  return name.split('/').every((segment) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))
}

/** 把值渲染成 DSH 工具输出要求的 content 块数组。 */
export function renderJson(value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** 从 agent 上读会话工作目录（session.header.cwd 优先）。 */
export function sessionCwdOf(agent) {
  const session = agent?.session
  return session?.header?.cwd ?? session?.cwd ?? null
}

/**
 * 解析会话当前工作目录：优先 working-directory projection（权威状态），
 * 拿不到时回退到 session.header.cwd（它只是新建会话时的初始种子）。
 * @param ctx Cordis 上下文
 * @param agent 会话所属 agent
 */
export function resolveSessionCwd(ctx, agent) {
  const session = agent?.session
  try {
    const workingDirectory = ctx?.get?.('workingDirectory')
    if (workingDirectory !== undefined && workingDirectory !== null && typeof workingDirectory.get === 'function' && session !== undefined) {
      const current = workingDirectory.get(session)
      if (typeof current === 'string' && current.length > 0) return current
    }
  } catch {
    // projection 服务不可用时退回 header.cwd
  }
  return sessionCwdOf(agent)
}

/**
 * 轻量 argv 解析：支持单双引号、反斜杠转义引号；不通配 shell。
 * @param input 原始参数串
 * @returns string[]
 */
export function parseArgv(input) {
  const out = []
  const text = String(input ?? '')
  let current = ''
  let started = false
  let quote = null
  for (const ch of text) {
    if (quote !== null) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (started) {
        out.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += ch
    started = true
  }
  if (started) out.push(current)
  return out
}

/** 取短 sha；输入为空时返回空串。 */
export function shortSha(sha) {
  return typeof sha === 'string' ? sha.slice(0, 8) : ''
}
