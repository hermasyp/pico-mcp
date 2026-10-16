import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENT_PROMPTS, AGENT_TOOLS } from '../src/catalog'
import { DEFAULT_ORIGINS, USAGE } from '../src/connector/config'
import { CLOSE, DEFAULT_PORT, ERROR_CODES, FEATURES, LIMITS, TIMING } from '../src/protocol'

/*
 * docs/REFERENCE.md is what a person reads to set the connection up and what an agent's owner reads
 * to trust it. It must keep saying what the code does: every tool, prompt, option, error code, limit
 * and default is looked for in it, so adding one without writing it down fails here.
 */

const root = path.resolve(__dirname, '..')
const read = (file: string) => readFileSync(path.join(root, file), 'utf8')
const reference = read('docs/REFERENCE.md')

describe('docs/REFERENCE.md', () => {
  it('describes every tool', () => {
    for (const tool of AGENT_TOOLS) expect(reference, tool.name).toContain(`\`${tool.name}\``)
  })

  it('describes every prompt', () => {
    for (const prompt of AGENT_PROMPTS) expect(reference, prompt.name).toContain(`\`${prompt.name}\``)
  })

  it('describes every option and environment variable of the connector', () => {
    const options = [...USAGE.matchAll(/^\s{2}(--[a-z]+)/gm)].map((match) => match[1])
    expect(options.length).toBeGreaterThanOrEqual(4)
    for (const option of options) expect(reference, option).toContain(`\`${option}`)
    for (const variable of ['PICO_MCP_PORT', 'PICO_URL', 'PICO_MCP_ORIGINS']) expect(reference, variable).toContain(variable)
  })

  it('names the default port and the origins a tab may connect from', () => {
    expect(reference).toContain(String(DEFAULT_PORT))
    for (const origin of DEFAULT_ORIGINS) expect(reference, origin).toContain(origin)
  })

  it('lists every error an agent can be given', () => {
    for (const code of ERROR_CODES) expect(reference, code).toContain(`\`${code}\``)
  })

  it('states the limits the code enforces', () => {
    const limits = [LIMITS.endpointsPerCall, LIMITS.opsPerCall, LIMITS.responsesPerEndpoint, LIMITS.fieldsPerCall, LIMITS.fieldDepth, LIMITS.textChars, LIMITS.nameChars, LIMITS.resultChars]
    for (const value of limits) expect(reference, String(value)).toMatch(new RegExp(`\\b${value.toLocaleString('en-US').replace(/,/g, ',?')}\\b`))
    expect(reference).toContain(`${LIMITS.frameBytes / (1024 * 1024)} MiB`)
    for (const [name, code] of Object.entries(CLOSE)) if (name !== 'bye') expect(reference, `${name} ${code}`).toContain(String(code))
  })

  it('describes how a change waits for the person: the modes, the abilities, the two frames and the time they have', () => {
    for (const word of ['Ask me first', 'Can edit', 'Read only', 'awaiting-user', '`cancel`', '`features`']) expect(reference, word).toContain(word)
    for (const feature of FEATURES) expect(reference, feature).toContain(`\`${feature}\``)
    expect(reference).toContain(`${TIMING.askMs / 60_000} minutes`)
    expect(reference).toContain(`${TIMING.askGraceMs / 1000} seconds`)
    // The two codes are sent now, not reserved.
    expect(reference).not.toContain('Reserved for a later way')
    expect(reference).not.toContain('never sends them')
  })

  it('is what the README sends people to', () => {
    expect(read('README.md')).toContain('docs/REFERENCE.md')
  })

  it('has the README say that each change can wait for the person', () => {
    expect(read('README.md')).toContain('Ask me first')
  })
})

/*
 * The settings for an agent are copied out of the README into the agent's own file, so what is written there has to
 * be a setting that agent can read: a block that does not parse is a connector that never starts.
 */
describe('README.md, the settings for each agent', () => {
  const readme = read('README.md')
  const block = (language: string, mentioning: string): string => {
    const found = [...readme.matchAll(new RegExp('```' + language + '\\n([\\s\\S]*?)```', 'g'))].map((match) => match[1] as string).find((text) => text.includes(mentioning))
    if (found === undefined) throw new Error(`no ${language} block that mentions ${mentioning}`)
    return found
  }

  it('names the five agents it has settings for', () => {
    for (const agent of ['Claude Code', 'Claude Desktop', 'Cursor', 'Codex', 'OpenCode']) expect(readme, agent).toContain(agent)
  })

  it('gives Codex the command that adds the connector, and the table that command writes', () => {
    expect(block('bash', 'codex mcp add')).toContain('codex mcp add pico -- node /absolute/path/to/pico-mcp.mjs')
    const table = block('toml', 'mcp_servers')
    expect(table).toMatch(/^\[mcp_servers\.pico\]$/m)
    expect(table).toMatch(/^command = "node"$/m)
    expect(table).toMatch(/^args = \["\/absolute\/path\/to\/pico-mcp\.mjs"[,\]]/m)
  })

  it('gives OpenCode a file it can read: a local server whose command is one list, program first', () => {
    const config = JSON.parse(block('json', '"mcp"')) as { mcp: { pico: { type: string; command: string[]; enabled: boolean } } }
    expect(config.mcp.pico.type).toBe('local')
    expect(config.mcp.pico.command).toEqual(['node', '/absolute/path/to/pico-mcp.mjs'])
    expect(config.mcp.pico.enabled).toBe(true)
  })

  it('gives Claude Desktop and Cursor the file they read', () => {
    const config = JSON.parse(block('json', 'mcpServers')) as { mcpServers: { pico: { command: string; args: string[] } } }
    expect(config.mcpServers.pico).toEqual({ command: 'node', args: ['/absolute/path/to/pico-mcp.mjs'] })
  })

  it('says in the reference what each agent does differently, and the README sends people there', () => {
    expect(reference).toContain('## Using it with each agent')
    for (const word of ['`tool_timeout_sec`', '`opencode mcp list`', '`codex mcp list`']) expect(reference, word).toContain(word)
    expect(readme).toContain('docs/REFERENCE.md#using-it-with-each-agent')
  })
})
