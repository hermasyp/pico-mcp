import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_INSTRUCTIONS, AGENT_PROMPTS, AGENT_TOOLS, formatGuide } from '../src/catalog'
import { formatPairing, parsePairing, pairingFromHash } from '../src/protocol'
import { buildServer } from '../src/connector/build-server'
import { Hub } from '../src/connector/hub'
import { ORIGIN, pairTab, type FakeTab } from './helpers/fake-tab'

const TOKEN = '0123456789ABCDEFGHJKMNPQRS'
const PICO_URL = 'https://pico.example/'

interface Rig {
  client: Client
  hub: Hub
  pair(): Promise<FakeTab>
}

const closers: Array<() => Promise<void>> = []

async function rig(): Promise<Rig> {
  const hub = new Hub({ port: 0, origins: [ORIGIN], token: TOKEN, serverVersion: '2.1.0', callMs: 1_000, getClient: () => ({ name: 'test-agent', version: '1.0.0' }) })
  await hub.listen()
  const server = buildServer({ hub, config: { picoUrl: PICO_URL }, version: '2.1.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'test-agent', version: '1.0.0' })
  await client.connect(clientTransport)
  const tabs: FakeTab[] = []
  closers.push(async () => {
    for (const tab of tabs) tab.close()
    await client.close()
    await hub.close()
  })
  return {
    client,
    hub,
    pair: async () => {
      const tab = await pairTab(hub.port, TOKEN)
      tabs.push(tab)
      return tab
    },
  }
}

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()))
})

const textOf = (result: { content: Array<{ type: string; text?: string }> }, index = 0): string => result.content[index].text as string

describe('what an agent sees of the connector', () => {
  it('lists exactly the tools of the catalog, with their schemas, titles and hints', async () => {
    const { client } = await rig()
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toEqual(AGENT_TOOLS.map((tool) => tool.name))
    for (const tool of tools) {
      const def = AGENT_TOOLS.find((item) => item.name === tool.name)!
      expect(tool.description, tool.name).toBe(def.description)
      expect(tool.inputSchema, tool.name).toEqual(def.inputSchema)
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(def.access === 'read')
      expect(tool.annotations?.destructiveHint, tool.name).toBe(def.access === 'destructive')
      expect(tool.annotations?.openWorldHint, tool.name).toBe(false)
    }
  })

  it('gives its instructions, and the nine recipes as prompts', async () => {
    const { client } = await rig()
    expect(client.getInstructions()).toBe(AGENT_INSTRUCTIONS)
    const { prompts } = await client.listPrompts()
    expect(prompts.map((prompt) => prompt.name)).toEqual(AGENT_PROMPTS.map((prompt) => prompt.name))
    const design = await client.getPrompt({ name: 'contract_from_design', arguments: { projectName: 'Payments API' } })
    expect(design.messages).toHaveLength(1)
    expect(design.messages[0].role).toBe('user')
    expect((design.messages[0].content as { text: string }).text).toContain('Payments API')
    const sync = await client.getPrompt({ name: 'sync_contract_with_code' })
    expect((sync.messages[0].content as { text: string }).text).toContain('pico_get_project')
    const migrate = prompts.find((prompt) => prompt.name === 'migrate_from_postman')
    expect(migrate?.arguments?.find((arg) => arg.name === 'path')?.required).toBe(true)
  })
})

describe('the tools the connector answers by itself', () => {
  it('shows the format guide without a tab', async () => {
    const { client } = await rig()
    const result = await client.callTool({ name: 'pico_format_guide', arguments: {} })
    expect(result.isError).toBeFalsy()
    expect(textOf(result as never)).toBe(formatGuide())
  })

  it('gives a pairing code and a link, and says whether a tab is already connected', async () => {
    const { client, hub, pair } = await rig()
    const first = JSON.parse(textOf((await client.callTool({ name: 'pico_connect', arguments: {} })) as never))
    expect(first.connected).toBe(false)
    expect(parsePairing(first.pairingCode)).toEqual(hub.pairing)
    expect(first.pairingCode).toBe(formatPairing(hub.pairing))
    expect(first.link.startsWith(PICO_URL)).toBe(true)
    expect(pairingFromHash(new URL(first.link).hash)).toEqual(hub.pairing)
    expect(first.next).toContain('pairing code')
    await pair()
    const second = JSON.parse(textOf((await client.callTool({ name: 'pico_connect', arguments: {} })) as never))
    expect(second.connected).toBe(true)
    expect(second.next).toContain('already connected')
  })
})

describe('the tools that go to the tab', () => {
  it('says plainly what to do when no tab is connected', async () => {
    const { client } = await rig()
    const result = await client.callTool({ name: 'pico_status', arguments: {} })
    expect(result.isError).toBe(true)
    expect(textOf(result as never)).toContain('Pico is not connected')
    expect(textOf(result as never)).toContain('pico_connect')
  })

  it('passes the arguments to the tab and the answer back, as JSON', async () => {
    const { client, pair } = await rig()
    const tab = await pair()
    const pending = client.callTool({ name: 'pico_get_project', arguments: { view: 'full' } })
    const call = await tab.nextCall()
    expect(call).toMatchObject({ tool: 'pico_get_project', args: { view: 'full' } })
    tab.reply(call.id, { data: { project: 'x' }, warnings: ['careful'], summary: 'Read it' })
    const result = await pending
    expect(result.isError).toBeFalsy()
    expect(JSON.parse(textOf(result as never))).toEqual({ result: { project: 'x' }, summary: 'Read it', warnings: ['careful'] })
  })

  it('leaves out warnings and summary when there are none', async () => {
    const { client, pair } = await rig()
    const tab = await pair()
    const pending = client.callTool({ name: 'pico_status', arguments: {} })
    const call = await tab.nextCall()
    tab.reply(call.id, { data: { open: null }, warnings: [] })
    expect(JSON.parse(textOf((await pending) as never))).toEqual({ result: { open: null } })
  })

  it('gives an export as the text itself, after a line about it', async () => {
    const { client, pair } = await rig()
    const tab = await pair()
    const pending = client.callTool({ name: 'pico_export', arguments: { format: 'openapi' } })
    const call = await tab.nextCall()
    tab.reply(call.id, { data: { format: 'openapi', fileName: 'api.openapi.yaml', mime: 'application/yaml', endpoints: 2, text: 'openapi: 3.0.3\npaths: {}\n' }, warnings: ['note'] })
    const result = await pending
    expect(result.content).toHaveLength(2)
    expect(JSON.parse(textOf(result as never, 0))).toEqual({ result: { format: 'openapi', fileName: 'api.openapi.yaml', mime: 'application/yaml', endpoints: 2 }, warnings: ['note'] })
    expect(textOf(result as never, 1)).toBe('openapi: 3.0.3\npaths: {}\n')
  })

  it('turns an error from the tab into an error the agent can act on', async () => {
    const { client, pair } = await rig()
    const tab = await pair()
    const pending = client.callTool({ name: 'pico_get_project', arguments: { projectId: 'nope' } })
    const call = await tab.nextCall()
    tab.fail(call.id, { code: 'not-found', message: 'There is no project with id “nope”.', hint: 'Projects you can use: “Payments API” (p1).', path: 'projectId' })
    const result = await pending
    expect(result.isError).toBe(true)
    const text = textOf(result as never)
    expect(text).toContain('not-found')
    expect(text).toContain('There is no project with id “nope”.')
    expect(text).toContain('Projects you can use')
  })

  it('refuses arguments that break the schema before the tab is asked', async () => {
    const { client, pair } = await rig()
    const tab = await pair()
    const result = await client.callTool({ name: 'pico_add_endpoints', arguments: { endpoints: [{ name: 'X', method: 'FETCH', path: '/x' }] } })
    expect(result.isError).toBe(true)
    const result2 = await client.callTool({ name: 'pico_get_project', arguments: { surprise: true } })
    expect(result2.isError).toBe(true)
    expect(tab.received).toHaveLength(0)
  })

  it('forwards every tool of the catalog that is not answered by the connector', async () => {
    const { client, pair } = await rig()
    const tab = await pair()
    for (const tool of AGENT_TOOLS.filter((item) => item.home !== 'connector')) {
      const args = tool.name === 'pico_get_examples' ? { endpointId: 'e1' } : tool.name === 'pico_export' ? { format: 'markdown' } : tool.name === 'pico_create_project' ? { name: 'P' } : tool.name === 'pico_delete_endpoints' ? { endpointIds: ['e1'] } : tool.name === 'pico_import_document' ? { content: 'x' } : tool.name === 'pico_update_endpoint' ? { endpointId: 'e1', set: { name: 'n' } } : tool.name === 'pico_apply_ops' ? { ops: [{ op: 'create_folder', name: 'F' }] } : tool.name === 'pico_add_endpoints' ? { endpoints: [{ name: 'A', method: 'GET', path: '/a' }] } : {}
      const pending = client.callTool({ name: tool.name, arguments: args })
      const call = await tab.nextCall()
      expect(call.tool).toBe(tool.name)
      tab.reply(call.id, { data: 'ok', warnings: [] })
      expect((await pending).isError, tool.name).toBeFalsy()
    }
  })

  it('gives a slow write more time than a read', async () => {
    const { client, pair } = await rig()
    const tab = await pair()
    const pending = client.callTool({ name: 'pico_import_document', arguments: { content: 'x' } })
    const call = await tab.nextCall()
    await new Promise((resolve) => setTimeout(resolve, 1_300))
    tab.reply(call.id, { data: { projectId: 'p' }, warnings: [] })
    expect((await pending).isError).toBeFalsy()
  })
})
