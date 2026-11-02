/**
 * 无宿主环境下的本地 defineTool 兜底实现。
 *
 * DSH 的 defineTool 做了两件我们依赖的事：把「作者面参数规范」（字段上的
 * required: true / items / properties）编译成标准 JSON Schema，并在执行前
 * 校验模型给来的参数。插件在桌面版里应优先从宿主解析 @deepseek-ai/dsh-tools；
 * 只有解析不到时（例如独立 node 进程、profile 里没有该包）才用这里的本地
 * 等价实现，保持同样的注册契约与错误语义。
 *
 * @module dsh-parallel-worktree/schema
 */

function authorError(message) {
  throw new Error('schema: ' + message)
}

/** 把作者面节点编译成 JSON Schema 节点（去掉 required: true，交由父级收集）。 */
export function compileNode(node, path = 'schema') {
  if (node === undefined || node === null) return {}
  if (typeof node !== 'object' || Array.isArray(node)) authorError(path + ' must be an object')
  const schema = {}
  if (node.type !== undefined) {
    if (typeof node.type !== 'string') authorError(path + '.type must be a string')
    schema.type = node.type
  }
  if (node.description !== undefined) schema.description = String(node.description)
  if (node.items !== undefined) schema.items = compileNode(node.items, path + '.items')
  if (node.properties !== undefined) {
    const { properties, required } = compilePropertyMap(node.properties, path + '.properties')
    schema.properties = properties
    if (required !== undefined) schema.required = required
  }
  if (node.additionalProperties !== undefined) schema.additionalProperties = Boolean(node.additionalProperties)
  if (Array.isArray(node.enum)) schema.enum = [...node.enum]
  if (node.default !== undefined) schema.default = node.default
  return schema
}

/** 编译一组字段：required: true 提升为父级 required 数组。 */
export function compilePropertyMap(map, path = 'parameters') {
  if (map === undefined || map === null) return { properties: {} }
  if (typeof map !== 'object' || Array.isArray(map)) authorError(path + ' must be an object')
  const properties = {}
  const required = []
  for (const [key, node] of Object.entries(map)) {
    properties[key] = compileNode(node, path + '.' + key)
    if (node !== null && typeof node === 'object' && node.required === true) required.push(key)
  }
  return { properties, ...(required.length > 0 ? { required } : {}) }
}

export function compileParameters(parameters) {
  const { properties, required } = compilePropertyMap(parameters ?? {})
  return { type: 'object', properties, ...(required !== undefined ? { required } : {}) }
}

export function compileOutputSchema(schema) {
  return compileNode(schema ?? {}, 'schema')
}

function describeType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function validateValue(schema, value, path, violations) {
  if (schema === null || schema === undefined || typeof schema !== 'object') return
  const type = schema.type
  if (type === 'object') {
    if (describeType(value) !== 'object') {
      violations.push((path || 'value') + ' must be an object')
      return
    }
    const required = Array.isArray(schema.required) ? schema.required : []
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        violations.push('missing required property "' + key + '"')
      }
    }
    const properties = schema.properties ?? {}
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined) {
        validateValue(childSchema, value[key], path === '' ? key : path + '.' + key, violations)
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) violations.push('unexpected property "' + key + '"')
      }
    }
    return
  }
  if (type === 'array') {
    if (!Array.isArray(value)) {
      violations.push((path || 'value') + ' must be an array')
      return
    }
    if (schema.items) value.forEach((item, index) => validateValue(schema.items, item, (path || 'value') + '[' + index + ']', violations))
    return
  }
  if (type !== undefined) {
    const actual = Array.isArray(value) ? 'array' : (value === null ? 'null' : typeof value)
    if (actual !== type) violations.push((path || 'value') + ' must be a ' + type)
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) violations.push((path || 'value') + ' must be one of ' + JSON.stringify(schema.enum))
  }
}

/** 执行前参数校验，语义对齐宿主 defineTool 的 ToolArgsError。 */
export function validateArgs(parametersSchema, args) {
  const violations = []
  validateValue(parametersSchema, args ?? {}, '', violations)
  return violations
}

/** 本地兜底 defineTool：产出与宿主一致的 registry-ready 定义。 */
export function localDefineTool(options) {
  if (options === null || typeof options !== 'object') throw new Error('defineTool: options must be an object')
  if (typeof options.name !== 'string' || options.name === '') throw new Error('defineTool: name is required')
  const parameters = compileParameters(options.parameters)
  const outputSchema = compileOutputSchema(options.output?.schema)
  const validate = (args) => validateArgs(parameters, args)
  const userExecute = options.execute
  const tool = {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render: (args, value) => options.output.render(args, value),
    },
    async execute(args, exec) {
      const violations = validate(args)
      if (violations.length > 0) {
        const error = new Error('invalid arguments: ' + violations.join('; '))
        error.name = 'ToolArgsError'
        error.code = 'INVALID_ARGS'
        error.violations = violations
        throw error
      }
      return userExecute(args, exec)
    },
  }
  if (typeof options.presentCall === 'function') {
    tool.presentCall = (args) => (validate(args).length > 0 ? undefined : options.presentCall(args))
  }
  if (typeof options.presentResult === 'function') {
    tool.presentResult = (args, result) => (validate(args).length > 0 ? undefined : options.presentResult(args, result))
  }
  if (typeof options.isConcurrencySafe === 'function') {
    tool.isConcurrencySafe = (args) => (validate(args).length > 0 ? false : options.isConcurrencySafe(args))
  }
  return tool
}
