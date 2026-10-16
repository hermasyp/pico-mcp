import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { buildServer } from '../../src/connector/build-server'
import { Hub } from '../../src/connector/hub'
import { ORIGIN, pairTab, type FakeTab } from './fake-tab'

/*
 * The connector as an agent sees it, in memory: a real hub on a loopback port, the real MCP server built from the
 * catalog, the official MCP client in front, and stand-ins for the Pico tab that pair over a real WebSocket.
 */

export const TOKEN = '0123456789ABCDEFGHJKMNPQRS'
export const PICO_URL = 'https://pico.example/'

export interface Rig {
  client: Client
  hub: Hub
  pair(): Promise<FakeTab>
}

export interface RigOptions {
  progressMs?: number
  /** The real path of the folder the connector may read from; none (the default) is a connector started without --root. */
  root?: string | null
  callMs?: number
}

const closers: Array<() => Promise<void>> = []

export async function rig({ callMs = 1_000, ...over }: RigOptions = {}): Promise<Rig> {
  const hub = new Hub({ port: 0, origins: [ORIGIN], token: TOKEN, serverVersion: '2.1.0', callMs, getClient: () => ({ name: 'test-agent', version: '1.0.0' }) })
  await hub.listen()
  const server = buildServer({ hub, config: { picoUrl: PICO_URL }, version: '2.1.0', ...over })
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

/** Call from `afterEach`. */
export async function closeRigs(): Promise<void> {
  await Promise.all(closers.splice(0).map((close) => close()))
}

export const textOf = (result: { content: Array<{ type: string; text?: string }> }, index = 0): string => result.content[index].text as string
