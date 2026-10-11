import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AGENT_TOOLS } from '../src/catalog'
import { parsePairing } from '../src/protocol'
import { buildConnector } from '../scripts/build.mjs'
import { ORIGIN, pairTab } from './helpers/fake-tab'

const run = promisify(execFile)

let dir = ''
let bundle = ''

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'pico-mcp-'))
  bundle = await buildConnector({ outfile: path.join(dir, 'pico-mcp.mjs') })
}, 60_000)

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('the built connector', () => {
  it('is one file that starts with a shebang and carries its dependencies', async () => {
    const text = await readFile(bundle, 'utf8')
    expect(text.startsWith('#!/usr/bin/env node\n')).toBe(true)
    expect(text).toContain('pico-mcp')
    expect(text).not.toContain("from '@modelcontextprotocol")
    expect(text).not.toContain("from 'ws'")
  })

  it('talks MCP on stdio, pairs with a tab on loopback, and exits when the agent hangs up', async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [bundle, '--port', '0', '--origin', ORIGIN], stderr: 'pipe' })
    const stderr: string[] = []
    transport.stderr?.on('data', (chunk) => stderr.push(String(chunk)))
    const client = new Client({ name: 'process-test', version: '1.0.0' })
    await client.connect(transport)
    const pid = transport.pid as number
    expect(alive(pid)).toBe(true)

    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toEqual(AGENT_TOOLS.map((tool) => tool.name))
    expect(client.getInstructions()).toContain('pico_format_guide')

    const connect = await client.callTool({ name: 'pico_connect', arguments: {} })
    const info = JSON.parse((connect.content as Array<{ text: string }>)[0].text)
    const pairing = parsePairing(info.pairingCode)
    expect(pairing).not.toBeNull()
    expect(info.connected).toBe(false)

    const tab = await pairTab(pairing!.port, pairing!.token)
    const pending = client.callTool({ name: 'pico_status', arguments: {} })
    const call = await tab.nextCall()
    expect(call.tool).toBe('pico_status')
    tab.reply(call.id, { data: { open: null }, warnings: [] })
    const result = await pending
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual({ result: { open: null } })

    const after = JSON.parse(((await client.callTool({ name: 'pico_connect', arguments: {} })).content as Array<{ text: string }>)[0].text)
    expect(after.connected).toBe(true)

    await client.close()
    const deadline = Date.now() + 5_000
    while (alive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
    expect(alive(pid)).toBe(false)
    await tab.closed
    expect(stderr.join('')).toContain('ready on 127.0.0.1')
    expect(stderr.join('')).not.toContain(pairing!.token)
  }, 30_000)

  it('keeps stdout for MCP: asking for help prints the usage there and nothing starts', async () => {
    const { stdout } = await run(process.execPath, [bundle, '--help'])
    expect(stdout).toContain('--port')
    expect(stdout).toContain('--origin')
  })

  it('prints its version on stdout, which is what a bug report needs, and starts nothing', async () => {
    const version = JSON.parse(await readFile(path.join(__dirname, '..', 'package.json'), 'utf8')).version
    for (const flag of ['--version', '-v']) {
      const { stdout } = await run(process.execPath, [bundle, flag])
      expect(stdout.trim(), flag).toBe(version)
    }
  })

  it('stops at once with a message on stderr, and a status of 2, when it was given something wrong', async () => {
    const error = await run(process.execPath, [bundle, '--port', 'abc']).catch((failure: { code: number; stdout: string; stderr: string }) => failure)
    expect((error as { code: number }).code).toBe(2)
    expect((error as { stdout: string }).stdout).toBe('')
    expect((error as { stderr: string }).stderr).toContain('not a port number')
  })
})
