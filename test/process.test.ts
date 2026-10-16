import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
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
import { png } from './helpers/pictures'

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

  it('stops at once, with a status of 2 and before it listens, when --root is not a folder it can use', async () => {
    const file = path.join(dir, 'a-file.txt')
    await writeFile(file, 'not a folder')
    for (const [root, message] of [
      [path.join(dir, 'does-not-exist'), 'does not exist'],
      [file, 'is not a folder'],
      ['relative/folder', 'absolute path'],
    ] as const) {
      const error = await run(process.execPath, [bundle, '--port', '0', '--root', root]).catch((failure: { code: number; stdout: string; stderr: string }) => failure)
      expect((error as { code: number }).code, root).toBe(2)
      expect((error as { stdout: string }).stdout, root).toBe('')
      expect((error as { stderr: string }).stderr, root).toContain(message)
      expect((error as { stderr: string }).stderr, root).not.toContain('ready on')
    }
  })
})

describe('the built connector and the files it may read', () => {
  const textOf = (result: unknown): string => ((result as { content: Array<{ text: string }> }).content[0] as { text: string }).text

  async function start(args: string[]) {
    const transport = new StdioClientTransport({ command: process.execPath, args: [bundle, '--port', '0', '--origin', ORIGIN, ...args], stderr: 'pipe' })
    const stderr: string[] = []
    transport.stderr?.on('data', (chunk) => stderr.push(String(chunk)))
    const client = new Client({ name: 'process-test', version: '1.0.0' })
    await client.connect(transport)
    const info = JSON.parse(textOf(await client.callTool({ name: 'pico_connect', arguments: {} })))
    const pairing = parsePairing(info.pairingCode)!
    const tab = await pairTab(pairing.port, pairing.token)
    return { client, tab, stderr, token: pairing.token }
  }

  it('hands a picture and a recording from the folder it was started with to the tab, and reads nothing outside it', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'pico-mcp-root-'))
    try {
      await mkdir(path.join(base, 'design'))
      await mkdir(path.join(base, 'elsewhere'))
      const root = await realpath(path.join(base, 'design'))
      const bytes = Buffer.concat([png(640, 480), Buffer.from('rest-of-the-picture')])
      await writeFile(path.join(root, 'login.png'), bytes)
      await writeFile(path.join(base, 'elsewhere', 'other.png'), png(8, 8))
      await writeFile(path.join(root, 'shop.har'), JSON.stringify({ log: { entries: [{ _resourceType: 'xhr', request: { method: 'GET', url: 'https://api.shop.test/v1/users/7', headers: [{ name: 'Authorization', value: 'Bearer abcdefghijklmnop1234' }] }, response: { status: 200, content: { mimeType: 'application/json', text: '{"id":7,"name":"Ann"}' } } }] } }))

      const { client, tab, stderr, token } = await start(['--root', root])
      expect(stderr.join('')).toContain(`files: the agent may hand over pictures and recorded traffic from ${root}`)

      const picture = client.callTool({ name: 'pico_attach_image', arguments: { endpointId: 'e1', path: 'login.png', alt: 'Sign in' } })
      const attach = await tab.nextCall()
      expect(attach.tool).toBe('pico_attach_image')
      expect(attach.args).toEqual({ endpointId: 'e1', alt: 'Sign in', image: { name: 'login.png', mime: 'image/png', data: bytes.toString('base64') } })
      tab.reply(attach.id, { data: { attached: true }, warnings: [] })
      expect(JSON.parse(textOf(await picture)).warnings[0]).toContain('Read login.png (image/png, 640 by 480 pixels')

      const recording = client.callTool({ name: 'pico_import_har', arguments: { format: 'har', path: path.join(root, 'shop.har') } })
      const add = await tab.nextCall()
      expect(add.tool).toBe('pico_add_endpoints')
      expect(JSON.stringify(add.args)).toContain('/v1/users/{userId}')
      expect(JSON.stringify(add.args)).not.toContain('abcdefghijklmnop1234')
      tab.reply(add.id, { data: { added: 1 }, warnings: [] })
      expect((await recording).isError).toBeFalsy()

      const outside = await client.callTool({ name: 'pico_attach_image', arguments: { endpointId: 'e1', path: '../elsewhere/other.png' } })
      expect(outside.isError).toBe(true)
      expect(textOf(outside)).toContain('not-found')
      expect(stderr.join('')).not.toContain(token)

      await client.close()
      tab.close()
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  }, 30_000)

  it('reads no file at all when it was started without --root, and says what to do', async () => {
    const { client, tab, stderr } = await start([])
    expect(stderr.join('')).toContain('files: off')
    const result = await client.callTool({ name: 'pico_attach_image', arguments: { endpointId: 'e1', path: '/etc/hostname' } })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('not-enabled')
    expect(textOf(result)).toContain('--root')
    const har = await client.callTool({ name: 'pico_import_har', arguments: { format: 'har', path: 'x.har' } })
    expect(textOf(har)).toContain('not-enabled')
    expect(tab.received).toHaveLength(0)
    await client.close()
    tab.close()
  }, 30_000)
})
