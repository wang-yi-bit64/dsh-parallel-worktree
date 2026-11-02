import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { compileOutputSchema, compileParameters, localDefineTool } from '../lib/schema.js'
import { defineTool, defineToolSource } from '../lib/tools.js'

async function loadHostDefineTool() {
  const candidates = []
  const resources = process.resourcesPath
  if (typeof resources === 'string' && resources !== '') {
    candidates.push(path.join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
    candidates.push(path.join(resources, 'app', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
  }
  candidates.push('D:/Program Files/Deepseek-harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js')
  for (const candidate of candidates) {
    try {
      const mod = await import(pathToFileURL(candidate).href)
      if (typeof mod?.defineTool === 'function') return mod.defineTool
    } catch {
      // 继续尝试下一个位置
    }
  }
  return null
}

const SAMPLE = {
  name: 'sample',
  description: 'sample tool',
  parameters: {
    name: { type: 'string', required: true, description: 'n' },
    count: { type: 'number', description: 'c' },
    flag: { type: 'boolean' },
    mode: { type: 'string', enum: ['a', 'b'] },
    tags: { type: 'array', items: { type: 'string' } },
    options: {
      type: 'object',
      additionalProperties: false,
      properties: {
        deep: { type: 'string', required: true },
        list: { type: 'array', items: { type: 'number' } },
      },
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', required: true },
        items: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              note: { type: 'string' },
            },
          },
        },
      },
    },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  },
  async execute() { return { ok: true, items: [] } },
  presentCall: (args) => ({ card: 'generic', title: 'Sample', kind: 'other', rawInput: args }),
}

test('本地编译器：参数与输出 schema 与宿主一致', async (t) => {
  const host = await loadHostDefineTool()
  if (host === null) return t.skip('宿主 dsh-tools 不可用（非桌面版环境）')
  const real = host(SAMPLE)
  const local = localDefineTool(SAMPLE)
  assert.deepEqual(local.parameters, real.parameters)
  assert.deepEqual(local.output.schema, real.output.schema)
  assert.equal(typeof local.output.render, 'function')
  assert.equal(typeof local.execute, 'function')
})

test('本地编译器：参数校验语义与宿主一致', async (t) => {
  const host = await loadHostDefineTool()
  if (host === null) return t.skip('宿主 dsh-tools 不可用（非桌面版环境）')
  const real = host(SAMPLE)
  const local = localDefineTool(SAMPLE)
  const cases = [
    [{}, 'missing required property'],
    [{ name: 42 }, 'must be a string'],
    [{ name: 'x', count: 'no' }, 'must be a number'],
    [{ name: 'x', mode: 'z' }, 'must be one of'],
    [{ name: 'x', tags: 'no' }, 'must be an array'],
  ]
  for (const [args, fragment] of cases) {
    const realError = await real.execute(args, {}).catch((error) => error)
    const localError = await local.execute(args, {}).catch((error) => error)
    assert.equal(localError.name, realError.name, 'name for ' + JSON.stringify(args))
    assert.equal(localError.code, realError.code, 'code for ' + JSON.stringify(args))
    assert.ok(String(localError.message).includes(fragment), 'local message for ' + JSON.stringify(args) + ' was ' + localError.message)
    assert.ok(String(realError.message).includes(fragment), 'real message was ' + realError.message)
  }
  // 非法参数时 presentCall 软失败
  assert.equal(real.presentCall({}), undefined)
  assert.equal(local.presentCall({}), undefined)
  assert.deepEqual(real.presentCall({ name: 'x' }), local.presentCall({ name: 'x' }))
})

test('compileParameters/compileOutputSchema：required 提升与 additionalProperties 保留', () => {
  const parameters = compileParameters(SAMPLE.parameters)
  assert.deepEqual(parameters.required, ['name'])
  assert.equal(parameters.additionalProperties, undefined)
  assert.equal(parameters.properties.name.type, 'string')
  assert.equal(parameters.properties.name.required, undefined)
  assert.deepEqual(parameters.properties.tags.items, { type: 'string' })
  assert.deepEqual(parameters.properties.options.required, ['deep'])

  const output = compileOutputSchema(SAMPLE.output.schema)
  assert.deepEqual(output.required, ['ok', 'items'])
  assert.equal(output.additionalProperties, false)
  assert.deepEqual(output.properties.items.items.required, ['id'])
})

test('tools.js：解析到的 defineTool 可用（宿主或本地）', () => {
  assert.equal(typeof defineTool, 'function')
  assert.ok(['local', ...[]].includes(defineToolSource) || typeof defineToolSource === 'string')
  const tool = defineTool(SAMPLE)
  assert.equal(tool.name, 'sample')
  assert.equal(typeof tool.execute, 'function')
})
