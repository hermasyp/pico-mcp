import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENT_PROMPTS, AGENT_TOOLS } from '../src/catalog'
import { DEFAULT_ORIGINS, USAGE } from '../src/connector/config'
import { CLOSE, DEFAULT_PORT, ERROR_CODES, LIMITS } from '../src/protocol'

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

  it('is what the README sends people to', () => {
    expect(read('README.md')).toContain('docs/REFERENCE.md')
  })
})
