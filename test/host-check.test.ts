import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_PROTOCOL, proofInput } from '../src/protocol'
import { Hub } from '../src/connector/hub'
import { imageInfo } from '../src/connector/files'
import { buildEndpoints, parseHar } from '../src/connector/traffic'
import { ORIGIN } from './helpers/fake-tab'
// @ts-expect-error plain JavaScript: the scripts are run by Node, they are not part of the program
import { findTool, startModel, toolsOf } from '../scripts/host-check/model.mjs'
// @ts-expect-error plain JavaScript
import { startTab } from '../scripts/host-check/tab.mjs'
// @ts-expect-error plain JavaScript
import { TINY_HAR, TINY_PNG, parseArgs, summarizeLog, whyFailed } from '../scripts/host-check/run.mjs'

/*
 * scripts/host-check starts the built connector from a real agent (Codex, OpenCode) with a scripted model and a stand-in
 * tab. The agents are not here, so these tests cover the parts that can be: what the scripted model says on each of
 * the two wires, that the stand-in tab really gets through the connector's hub, the logger between the agent and the
 * connector, and the reading of its log.
 */

const TOKEN = '0123456789ABCDEFGHJKMNPQRS'
const toolNamed = (name: string, namespace?: string) => ({ ...(namespace ? {} : { type: 'function' }), name, parameters: { type: 'object' } })

const closers: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

const post = (port: number, route: string, body: unknown) => fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('the scripted model', () => {
  it('finds the tools of Codex (grouped in a namespace) and of OpenCode (flat, with the name of the server in front)', () => {
    const codex = { tools: [{ type: 'function', name: 'exec_command' }, { type: 'namespace', name: 'mcp__pico', tools: [toolNamed('pico_connect'), toolNamed('pico_status')] }] }
    expect(toolsOf(codex)).toEqual([{ name: 'exec_command' }, { name: 'pico_connect', namespace: 'mcp__pico' }, { name: 'pico_status', namespace: 'mcp__pico' }])
    const opencode = { tools: [{ type: 'function', function: { name: 'pico_pico_connect' } }, { type: 'function', function: { name: 'bash' } }] }
    expect(toolsOf(opencode).map((tool: { name: string }) => tool.name)).toEqual(['pico_pico_connect', 'bash'])
    expect(findTool(toolsOf(opencode), 'pico_connect')).toEqual({ name: 'pico_pico_connect' })
    expect(findTool(toolsOf(codex), 'pico_status')).toEqual({ name: 'pico_status', namespace: 'mcp__pico' })
    expect(findTool(toolsOf(codex), 'pico_export')).toBeUndefined()
    expect(toolsOf(null)).toEqual([])
  })

  it('answers Codex on the Responses wire with a call in the namespace of the tool, then with a message', async () => {
    const seen: unknown[] = []
    const steps = [{ tool: 'pico_status', args: { a: 1 } }, { say: 'All done.' }]
    const model = await startModel({ flavor: 'responses', next: async (context: unknown) => (seen.push(context), steps.shift()) })
    closers.push(() => model.close())
    const tools = [{ type: 'namespace', name: 'mcp__pico', tools: [toolNamed('pico_connect'), toolNamed('pico_status')] }]

    const first = await (await post(model.port, '/v1/responses', { tools, input: [] })).text()
    const events = first.split('\n\n').filter(Boolean).map((block) => ({ type: /^event: (.*)$/m.exec(block)?.[1], data: JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? 'null') }))
    expect(events.map((event) => event.type)).toEqual(['response.created', 'response.output_item.added', 'response.output_item.done', 'response.completed'])
    expect(events[2]?.data.item).toMatchObject({ type: 'function_call', name: 'pico_status', namespace: 'mcp__pico', arguments: '{"a":1}' })

    const input = [{ type: 'function_call_output', call_id: 'call_1', output: 'the answer' }]
    const second = await (await post(model.port, '/v1/responses', { tools, input })).text()
    expect(second).toContain('"output_text"')
    expect(second).toContain('All done.')
    expect((seen[1] as { outputs: string[] }).outputs).toEqual(['the answer'])
  })

  it('answers OpenCode on the Chat Completions wire with a call to the tool by the name it has there, then with text', async () => {
    const steps = [{ tool: 'pico_connect', args: {} }, { say: 'Fine.' }]
    const model = await startModel({ flavor: 'chat', next: async () => steps.shift() })
    closers.push(() => model.close())
    const tools = [{ type: 'function', function: { name: 'pico_pico_connect' } }]

    const call = await (await post(model.port, '/v1/chat/completions', { stream: true, tools, messages: [] })).text()
    expect(call).toContain('"name":"pico_pico_connect"')
    expect(call).toContain('"finish_reason":"tool_calls"')
    expect(call.trim().endsWith('data: [DONE]')).toBe(true)

    const text = await (await post(model.port, '/v1/chat/completions', { stream: true, tools, messages: [{ role: 'tool', tool_call_id: 'call_1', content: 'back' }] })).text()
    expect(text).toContain('Fine.')
    expect(text).toContain('"finish_reason":"stop"')
  })

  it('leaves the script alone for a request that does not carry the connector tools, and answers a request that is not streamed with plain JSON', async () => {
    let asked = 0
    const model = await startModel({ flavor: 'chat', next: async () => (asked += 1, { say: 'never' }) })
    closers.push(() => model.close())
    const title = await (await post(model.port, '/v1/chat/completions', { stream: false, messages: [{ role: 'user', content: 'a title, please' }] })).json()
    expect(title.choices[0].message.content).toBe('ok')
    expect(asked).toBe(0)
    const list = await (await fetch(`http://127.0.0.1:${model.port}/v1/models`)).json()
    expect(list.object).toBe('list')
  })

  it('names the tools it has when the script asks for one it does not, instead of failing', async () => {
    const model = await startModel({ flavor: 'chat', next: async () => ({ tool: 'pico_export', args: {} }) })
    closers.push(() => model.close())
    const text = await (await post(model.port, '/v1/chat/completions', { stream: true, tools: [{ type: 'function', function: { name: 'pico_pico_connect' } }], messages: [] })).text()
    expect(text).toContain('has no tool pico_export')
    expect(text).toContain('pico_pico_connect')
  })
})

describe('the stand-in tab', () => {
  async function startHub(): Promise<Hub> {
    const hub = new Hub({ port: 0, origins: [ORIGIN], token: TOKEN, serverVersion: '1.2.0', getClient: () => null })
    closers.push(() => hub.close())
    await hub.listen()
    return hub
  }

  it('pairs with the hub and answers a call', async () => {
    const hub = await startHub()
    const tab = await startTab({ port: hub.port, token: TOKEN, protocol: { AGENT_PROTOCOL, proofInput } })
    closers.push(() => tab.close())
    expect(hub.state).toBe('connected')
    const result = await hub.call('pico_status', {})
    expect(result).toMatchObject({ ok: true, data: { data: { mode: 'ask', editable: true } } })
  })

  it('keeps a change waiting for the person when it is told to, and says so first', async () => {
    const hub = await startHub()
    const tab = await startTab({ port: hub.port, token: TOKEN, protocol: { AGENT_PROTOCOL, proofInput }, askWaitMs: 150 })
    closers.push(() => tab.close())
    let awaiting = 0
    const started = Date.now()
    const result = await hub.call('pico_add_endpoints', { endpoints: [] }, 5_000, { onAwaiting: () => (awaiting += 1) })
    expect(awaiting).toBe(1)
    expect(Date.now() - started).toBeGreaterThanOrEqual(140)
    expect(result).toMatchObject({ ok: true, data: { summary: 'Added 1 endpoint.' } })
  })

  it('compares a picture that reaches it with the file, byte for byte, and says whether it was the same', async () => {
    const hub = await startHub()
    const tab = await startTab({ port: hub.port, token: TOKEN, protocol: { AGENT_PROTOCOL, proofInput }, expectPicture: TINY_PNG })
    closers.push(() => tab.close())
    const same = await hub.call('pico_attach_image', { endpointId: 'e1', image: { name: 'login.png', mime: 'image/png', data: TINY_PNG.toString('base64') } })
    expect(same).toMatchObject({ ok: true, data: { data: { attached: true } } })
    const other = await hub.call('pico_attach_image', { endpointId: 'e1', image: { name: 'login.png', mime: 'image/png', data: Buffer.concat([TINY_PNG, Buffer.from([0])]).toString('base64') } })
    expect(other).toMatchObject({ ok: true, data: { data: { attached: false } } })
    const seen = tab.events.filter((event: { picture?: unknown }) => event.picture !== undefined).map((event: { picture: unknown }) => event.picture)
    expect(seen).toEqual([
      { name: 'login.png', mime: 'image/png', bytes: TINY_PNG.length, same: true, keys: ['endpointId', 'image'] },
      { name: 'login.png', mime: 'image/png', bytes: TINY_PNG.length + 1, same: false, keys: ['endpointId', 'image'] },
    ])
  })

  it('makes only the first change wait for the person, so that the recording a run imports later does not wait again', async () => {
    const hub = await startHub()
    const tab = await startTab({ port: hub.port, token: TOKEN, protocol: { AGENT_PROTOCOL, proofInput }, askWaitMs: 200 })
    closers.push(() => tab.close())
    let awaiting = 0
    const first = await hub.call('pico_add_endpoints', { endpoints: [] }, 5_000, { onAwaiting: () => (awaiting += 1) })
    expect(first.ok).toBe(true)
    const started = Date.now()
    const second = await hub.call('pico_add_endpoints', { endpoints: [] }, 5_000, { onAwaiting: () => (awaiting += 1) })
    expect(second.ok).toBe(true)
    expect(awaiting).toBe(1)
    expect(Date.now() - started).toBeLessThan(150)
  })

  it('does not answer a call that was cancelled while it waited', async () => {
    const hub = await startHub()
    const tab = await startTab({ port: hub.port, token: TOKEN, protocol: { AGENT_PROTOCOL, proofInput }, askWaitMs: 300 })
    closers.push(() => tab.close())
    const stop = new AbortController()
    const pending = hub.call('pico_add_endpoints', { endpoints: [] }, 5_000, { signal: stop.signal, onAwaiting: () => stop.abort() })
    expect(await pending).toMatchObject({ ok: false, error: { code: 'no-answer' } })
    await new Promise((resolve) => setTimeout(resolve, 450))
    expect(tab.events.some((event: { cancel?: number }) => event.cancel !== undefined)).toBe(true)
    expect(tab.events.some((event: { droppedReply?: string }) => event.droppedReply === 'pico_add_endpoints')).toBe(true)
  })
})

describe('the files a run hands to the connector', () => {
  it('are a picture and a recording that the connector accepts as such', () => {
    expect(imageInfo(TINY_PNG)).toEqual({ mime: 'image/png', width: 1, height: 1 })
    const parsed = parseHar(TINY_HAR)
    if (!('entries' in parsed)) throw new Error(parsed.error)
    const built = buildEndpoints(parsed.entries, { redact: 'secrets', shareHeaders: false })
    expect(built.endpoints.map((endpoint: { method: string; path: string }) => `${endpoint.method} ${endpoint.path}`).sort()).toEqual(['GET /v1/users', 'GET /v1/users/{userId}', 'POST /v1/users'])
  })
})

describe('the logger between an agent and the connector', () => {
  it('passes lines both ways, writes each to the log, and ends when the connector does', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pico-mcp-tee-test-'))
    closers.push(() => rmSync(dir, { recursive: true, force: true }))
    const connector = path.join(dir, 'echo.mjs')
    writeFileSync(connector, "process.stdin.on('data', (d) => process.stdout.write(`echo: ${d}`)); process.stdin.on('end', () => process.exit(3)); console.error('ready')\n")
    const log = path.join(dir, 'tee.jsonl')
    const tee = spawn(process.execPath, [path.resolve(__dirname, '../scripts/host-check/tee.mjs'), log, connector, '--port', '1'], { env: { ...process.env, PICO_HOST_CHECK_PROBE: '1' } })
    let out = ''
    tee.stdout.on('data', (chunk) => (out += chunk))
    tee.stdin.write('hello\nsecond line\n')
    await new Promise((resolve) => setTimeout(resolve, 300))
    tee.stdin.end()
    const code = await new Promise((resolve) => tee.on('exit', resolve))
    expect(code).toBe(3)
    expect(out).toContain('echo: hello')
    const entries = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { dir: string; text: string })
    expect(entries.filter((entry) => entry.dir === 'in').map((entry) => entry.text)).toEqual(['hello', 'second line'])
    expect(entries.some((entry) => entry.dir === 'out' && entry.text.includes('echo: hello'))).toBe(true)
    expect(entries.some((entry) => entry.dir === 'err' && entry.text === 'ready')).toBe(true)
    expect(JSON.parse(entries.find((entry) => entry.dir === 'env')?.text ?? '{}').probe).toBe('1')
    expect(entries.map((entry) => entry.dir)).toContain('stdin-end')
    expect(JSON.parse(entries.find((entry) => entry.dir === 'start')?.text ?? '{}').options).toEqual(['--port', '1'])
  })
})

describe('the command line and the reading of the log', () => {
  it('takes an agent and numbers, and says what is wrong when it cannot', () => {
    expect(parseArgs(['codex'])).toMatchObject({ host: 'codex', askWaitS: 0, toolTimeoutSec: null, timeoutS: 240, keep: false })
    expect(parseArgs(['opencode', '--ask-wait-s', '330', '--tool-timeout-sec', '20', '--keep'])).toMatchObject({ host: 'opencode', askWaitS: 330, toolTimeoutSec: 20, timeoutS: 450, keep: true })
    expect(parseArgs(['--help']).help).toBe(true)
    expect(() => parseArgs([])).toThrow('codex or opencode')
    expect(() => parseArgs(['gemini'])).toThrow('codex or opencode')
    expect(() => parseArgs(['codex', '--ask-wait-s'])).toThrow('--ask-wait-s needs a number')
    expect(() => parseArgs(['codex', '--ask-wait-s', '-3'])).toThrow('needs a number')
    expect(() => parseArgs(['codex', '--nope'])).toThrow('Unknown option --nope')
    expect(() => parseArgs(['codex', 'opencode'])).toThrow('Unexpected opencode')
    expect(() => parseArgs(['codex', '--bin'])).toThrow('--bin needs')
  })

  it('picks the words that say why a call failed out of what each agent hands back', () => {
    const codex = JSON.stringify([{ type: 'input_text', text: 'Wall time: 20.0 seconds\nOutput:' }, { type: 'input_text', text: 'tool call error: tool call failed for `pico/pico_add_endpoints`\n\nCaused by:\n    timed out awaiting tools/call after 20s\n\nStack backtrace:' }])
    expect(whyFailed(codex)).toBe('timed out awaiting tools/call after 20s')
    expect(whyFailed('Error (timeout): Pico did not hear from the person within 5 minutes, so the change was dropped.\nHint: Nothing was changed.')).toBe('Error (timeout): Pico did not hear from the person within 5 minutes, so the change was dropped.')
    expect(whyFailed('MCP error -32001: Request timed out')).toBe('MCP error -32001: Request timed out')
    expect(whyFailed('tool call error: it broke')).toBe('tool call error: it broke')
    expect(whyFailed('{"result":null}')).toBe('')
  })

  const line = (dir: string, message: unknown, t = 0) => ({ t, dir, text: typeof message === 'string' ? message : JSON.stringify(message) })

  it('reads who the agent is, what it asked for, the progress it asked for and got, and how the connector ended', () => {
    const summary = summarizeLog([
      line('env', { probe: null, variables: 11 }),
      line('in', { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'codex-mcp-client', version: '0.163.0' } } }),
      line('in', { jsonrpc: '2.0', method: 'notifications/initialized' }),
      line('in', { jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      line('in', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'pico_status', _meta: { progressToken: 2 } } }),
      line('in', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'pico_add_endpoints' } }),
      line('out', { jsonrpc: '2.0', id: 2, result: {} }),
      line('out', { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 3, progress: 1 } }),
      line('out', { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 3, progress: 2 } }),
      line('err', 'not json at all'),
      line('signal', 'SIGTERM'),
      line('stdin-end', ''),
    ])
    expect(summary).toMatchObject({
      client: { name: 'codex-mcp-client', version: '0.163.0' },
      protocolVersion: '2025-06-18',
      toolsListed: true,
      promptsListed: false,
      progressNotices: 2,
      environment: { probe: null, variables: 11 },
      ended: 'the agent sent it SIGTERM',
    })
    expect(summary.calls).toEqual([
      { id: 2, name: 'pico_status', progress: true },
      { id: 3, name: 'pico_add_endpoints', progress: false },
    ])
  })

  it('tells a cancellation that came after the answer (harmless) from one that came before it (a call given up)', () => {
    const summary = summarizeLog([
      line('in', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'pico_status' } }),
      line('out', { jsonrpc: '2.0', id: 2, result: {} }),
      line('in', { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } }),
      line('in', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'pico_add_endpoints' } }),
      line('in', { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } }),
      line('out', { jsonrpc: '2.0', id: 3, error: { code: -32001 } }),
      line('stdin-end', ''),
    ])
    expect(summary.cancelled).toEqual([
      { requestId: 2, afterAnswer: true },
      { requestId: 3, afterAnswer: false },
    ])
    expect(summary.ended).toBe('the agent closed its input')
  })
})
