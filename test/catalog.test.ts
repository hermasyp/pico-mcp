import { describe, expect, it } from 'vitest'
import {
  AGENT_INSTRUCTIONS,
  AGENT_PROMPTS,
  AGENT_TOOLS,
  GUIDE_EXAMPLE,
  TOOL_LIST_BUDGET,
  formatGuide,
  toolByName,
  type AgentToolDef,
} from '../src/catalog'
import { LIMITS } from '../src/protocol'
import { BODY_TYPES, FIELD_TYPES, HTTP_METHODS } from '../src/vocabulary'

const NAMES = [
  'pico_connect',
  'pico_format_guide',
  'pico_status',
  'pico_get_project',
  'pico_get_examples',
  'pico_export',
  'pico_review_contract',
  'pico_diff_with_openapi',
  'pico_create_project',
  'pico_add_endpoints',
  'pico_update_endpoint',
  'pico_delete_endpoints',
  'pico_import_document',
  'pico_apply_ops',
  'pico_undo_last_edit',
  'pico_focus',
]

type Schema = Record<string, unknown>

/** Visit every schema node below `schema` (properties, items), with its depth. */
function walk(schema: Schema, visit: (node: Schema, depth: number) => void, depth = 0): void {
  visit(schema, depth)
  const properties = schema.properties as Record<string, Schema> | undefined
  for (const child of Object.values(properties ?? {})) walk(child, visit, depth + 1)
  if (schema.items && typeof schema.items === 'object') walk(schema.items as Schema, visit, depth + 1)
}

describe('the tool catalog', () => {
  it('lists the sixteen tools of this release once each, in a stable order', () => {
    expect(AGENT_TOOLS.map((tool) => tool.name)).toEqual(NAMES)
    expect(new Set(AGENT_TOOLS.map((tool) => tool.name)).size).toBe(NAMES.length)
    expect(toolByName('pico_status')?.title).toBeTruthy()
    expect(toolByName('nothing')).toBeUndefined()
  })

  it('says where each tool is carried out', () => {
    const home = (name: string) => toolByName(name)?.home
    expect(home('pico_connect')).toBe('connector')
    expect(home('pico_format_guide')).toBe('connector')
    expect(home('pico_undo_last_edit')).toBe('bridge')
    for (const name of NAMES.filter((item) => !['pico_connect', 'pico_format_guide', 'pico_undo_last_edit'].includes(item))) {
      expect(home(name), name).toBe('executor')
    }
  })

  it('marks what each tool does to the workspace', () => {
    const access = (name: string) => toolByName(name)?.access
    for (const name of ['pico_connect', 'pico_format_guide', 'pico_status', 'pico_get_project', 'pico_get_examples', 'pico_export', 'pico_review_contract', 'pico_diff_with_openapi']) {
      expect(access(name), name).toBe('read')
    }
    expect(access('pico_focus')).toBe('navigate')
    for (const name of ['pico_create_project', 'pico_add_endpoints', 'pico_update_endpoint', 'pico_import_document', 'pico_undo_last_edit']) {
      expect(access(name), name).toBe('write')
    }
    for (const name of ['pico_delete_endpoints', 'pico_apply_ops']) expect(access(name), name).toBe('destructive')
  })

  it('names tools in snake_case behind the pico_ prefix and describes each in a few sentences', () => {
    for (const tool of AGENT_TOOLS) {
      expect(tool.name, tool.name).toMatch(/^pico_[a-z]+(_[a-z]+)*$/)
      expect(tool.title.length, tool.name).toBeGreaterThan(3)
      expect(tool.description.length, tool.name).toBeGreaterThan(60)
      expect(tool.description.length, tool.name).toBeLessThan(900)
    }
  })

  it('gives each tool an object schema that turns unknown keys away', () => {
    for (const tool of AGENT_TOOLS) {
      expect(tool.inputSchema.type, tool.name).toBe('object')
      walk(tool.inputSchema, (node) => {
        if (node.properties) expect(node.additionalProperties, `${tool.name} ${JSON.stringify(Object.keys(node.properties))}`).toBe(false)
      })
    }
  })

  it('requires only keys that exist, and explains every top-level key', () => {
    for (const tool of AGENT_TOOLS) {
      const properties = (tool.inputSchema.properties ?? {}) as Record<string, Schema>
      for (const key of (tool.inputSchema.required ?? []) as string[]) expect(Object.keys(properties), `${tool.name}.${key}`).toContain(key)
      for (const [key, schema] of Object.entries(properties)) {
        expect(typeof schema.description, `${tool.name}.${key}`).toBe('string')
      }
    }
  })

  it('stays clear of $ref and of union types, which not every agent understands', () => {
    for (const tool of AGENT_TOOLS) {
      const text = JSON.stringify(tool.inputSchema)
      expect(text, tool.name).not.toContain('$ref')
      expect(text, tool.name).not.toContain('"oneOf"')
      expect(text, tool.name).not.toContain('"anyOf"')
      walk(tool.inputSchema, (node) => expect(Array.isArray(node.type), tool.name).toBe(false))
    }
  })

  it('offers the real field types, methods and body types', () => {
    const add = toolByName('pico_add_endpoints') as AgentToolDef
    const text = JSON.stringify(add.inputSchema)
    for (const type of FIELD_TYPES) expect(text).toContain(`"${type}"`)
    for (const method of HTTP_METHODS) expect(text).toContain(`"${method}"`)
    for (const type of BODY_TYPES) expect(text).toContain(`"${type}"`)
    expect((add.inputSchema.properties as Record<string, Schema>).endpoints.maxItems).toBe(LIMITS.endpointsPerCall)
  })

  it('offers a review that takes a project and some endpoints, and a comparison that needs the document', () => {
    const review = toolByName('pico_review_contract') as AgentToolDef
    expect(Object.keys(review.inputSchema.properties as Record<string, Schema>)).toEqual(['projectId', 'endpointIds'])
    expect(review.inputSchema.required).toBeUndefined()
    const diff = toolByName('pico_diff_with_openapi') as AgentToolDef
    expect(Object.keys(diff.inputSchema.properties as Record<string, Schema>)).toEqual(['projectId', 'openapi'])
    expect(diff.inputSchema.required).toEqual(['openapi'])
  })

  it('spells out patch_endpoints: which endpoints, what to change, and a dry run', () => {
    const ops = toolByName('pico_apply_ops') as AgentToolDef
    const item = ((ops.inputSchema.properties as Record<string, Schema>).ops.items as Schema).properties as Record<string, Schema>
    expect((item.op.enum as string[]).includes('patch_endpoints')).toBe(true)
    expect(Object.keys(item.where.properties as object)).toEqual(['endpointIds', 'folder', 'method', 'pathPrefix'])
    expect(Object.keys(item.patch.properties as object)).toEqual(['addResponses', 'addHeaders', 'removeHeaders', 'appendDescription', 'renameField', 'useCommonHeaders'])
    expect(item.dryRun.type).toBe('boolean')
    const rename = (item.patch.properties as Record<string, Schema>).renameField
    expect(rename.required).toEqual(['from', 'to'])
    expect(((rename.properties as Record<string, Schema>).in.enum as string[]).sort()).toEqual(['body', 'headers', 'query', 'responses'])
    const methods = (item.where.properties as Record<string, Schema>).method.enum as string[]
    expect(methods).toEqual([...HTTP_METHODS])
    // The same response shape as pico_add_endpoints takes, so an agent does not learn two.
    const added = ((item.patch.properties as Record<string, Schema>).addResponses.items as Schema).properties as Record<string, Schema>
    expect(Object.keys(added)).toEqual(['status', 'description', 'fields', 'example'])
  })

  it('keeps the whole tool list small enough to sit in an agent’s context', () => {
    const size = JSON.stringify(AGENT_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))).length
    expect(size).toBeLessThanOrEqual(TOOL_LIST_BUDGET)
    // The budget is a ceiling to notice growth, not a target: it sits close above the real size.
    expect(size).toBeGreaterThan(TOOL_LIST_BUDGET * 0.6)
  })
})

describe('the prompts', () => {
  it('are the nine recipes', () => {
    expect(AGENT_PROMPTS.map((prompt) => prompt.name)).toEqual([
      'contract_from_design',
      'contract_from_code',
      'sync_contract_with_code',
      'review_contract',
      'document_endpoints',
      'contract_test_loop',
      'migrate_from_postman',
      'generate_client_types',
      'explain_contract',
    ])
  })

  it('tell the agent what to do and only name tools that exist', () => {
    const known = new Set(NAMES)
    for (const prompt of AGENT_PROMPTS) {
      expect(prompt.title.length, prompt.name).toBeGreaterThan(3)
      expect(prompt.description.length, prompt.name).toBeGreaterThan(20)
      const text = prompt.text({ path: 'collection.json', language: 'TypeScript', projectName: 'Payments' })
      expect(text.length, prompt.name).toBeGreaterThan(300)
      const mentioned = text.match(/pico_[a-z_]+/g) ?? []
      expect(mentioned.length, prompt.name).toBeGreaterThan(0)
      for (const tool of mentioned) expect(known.has(tool), `${prompt.name} mentions ${tool}`).toBe(true)
    }
  })

  it('use the arguments they declare, and work without the optional ones', () => {
    const design = AGENT_PROMPTS.find((prompt) => prompt.name === 'contract_from_design')!
    expect(design.text({ projectName: 'Payments API' })).toContain('Payments API')
    expect(design.text({})).not.toContain('undefined')
    const migrate = AGENT_PROMPTS.find((prompt) => prompt.name === 'migrate_from_postman')!
    expect(migrate.args.find((arg) => arg.name === 'path')?.required).toBe(true)
    expect(migrate.text({ path: 'my.postman_collection.json' })).toContain('my.postman_collection.json')
    const types = AGENT_PROMPTS.find((prompt) => prompt.name === 'generate_client_types')!
    expect(types.text({ language: 'Kotlin' })).toContain('Kotlin')
    for (const prompt of AGENT_PROMPTS) {
      expect(prompt.text({}), prompt.name).not.toContain('undefined')
      for (const arg of prompt.args) expect(arg.description.length, `${prompt.name}.${arg.name}`).toBeGreaterThan(5)
    }
  })
})

describe('the prompts that review and sync', () => {
  const text = (name: string) => (AGENT_PROMPTS.find((prompt) => prompt.name === name) as (typeof AGENT_PROMPTS)[number]).text({})

  it('review_contract starts from pico_review_contract and applies repeated fixes in bulk', () => {
    const review = text('review_contract')
    expect(review).toContain('pico_review_contract')
    expect(review).toContain('patch_endpoints')
    expect(review).toContain('dryRun')
  })

  it('sync_contract_with_code compares with an OpenAPI document when the code can make one, and by hand when not', () => {
    const sync = text('sync_contract_with_code')
    expect(sync).toContain('pico_diff_with_openapi')
    expect(sync).toMatch(/If there is no document/)
    expect(sync).toContain('wait for my go-ahead')
  })
})

describe('the instructions and the guide', () => {
  it('fit in fifteen lines and carry the rules that matter', () => {
    const lines = AGENT_INSTRUCTIONS.split('\n').filter((line) => line.trim() !== '')
    expect(lines.length).toBeLessThanOrEqual(15)
    expect(AGENT_INSTRUCTIONS).toContain('pico_format_guide')
    expect(AGENT_INSTRUCTIONS).toContain('pico_connect')
    expect(AGENT_INSTRUCTIONS.toLowerCase()).toContain('data')
    expect(AGENT_INSTRUCTIONS).toContain('Inferred')
  })

  it('tells an agent what to do when the person approves each change: say what is coming, wait, and do not repeat a refusal', () => {
    expect(AGENT_INSTRUCTIONS).toContain('Ask me first')
    expect(AGENT_INSTRUCTIONS).toContain('declined')
    expect(AGENT_INSTRUCTIONS).toContain('no-answer')
    expect(AGENT_INSTRUCTIONS.toLowerCase()).toContain('do not send the same change again')
    const guide = formatGuide()
    expect(guide).toContain('Ask me first')
    expect(guide).toContain('Read only')
    expect(guide).toContain('declined')
  })

  it('names every field type, method and body type, and says what the limits are', () => {
    const guide = formatGuide()
    for (const type of FIELD_TYPES) expect(guide).toContain(type)
    for (const method of HTTP_METHODS) expect(guide).toContain(method)
    for (const type of BODY_TYPES) expect(guide).toContain(type)
    expect(guide).toContain(String(LIMITS.endpointsPerCall))
    expect(guide).toContain('{id}')
    expect(guide.toLowerCase()).toContain('enum')
  })

  it('carries a worked example that is the same one the tests run through the tool', () => {
    const guide = formatGuide()
    expect(guide).toContain(JSON.stringify(GUIDE_EXAMPLE, null, 2))
    expect(GUIDE_EXAMPLE.endpoints.length).toBeGreaterThanOrEqual(2)
  })

  it('teaches the review, the comparison and the bulk edit, in the guide and in the instructions', () => {
    const guide = formatGuide()
    for (const name of ['pico_review_contract', 'pico_diff_with_openapi', 'patch_endpoints', 'dryRun']) expect(guide, name).toContain(name)
    for (const key of ['endpointIds', 'folder', 'method', 'pathPrefix', 'addResponses', 'addHeaders', 'removeHeaders', 'appendDescription', 'renameField', 'useCommonHeaders']) expect(guide, key).toContain(key)
    expect(AGENT_INSTRUCTIONS).toContain('pico_review_contract')
    expect(AGENT_INSTRUCTIONS).toContain('patch_endpoints')
  })

  it('never mentions a tool that does not exist', () => {
    const known = new Set(NAMES)
    for (const text of [formatGuide(), AGENT_INSTRUCTIONS, ...AGENT_TOOLS.map((tool) => tool.description)]) {
      for (const tool of text.match(/pico_[a-z_]+/g) ?? []) expect(known.has(tool), tool).toBe(true)
    }
  })
})
