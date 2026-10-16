import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fromJsonSchema } from '@modelcontextprotocol/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { toolByName } from '../src/catalog'
import { resolveRoot } from '../src/connector/files'
import { LIMITS } from '../src/protocol'
import type { FakeTab } from './helpers/fake-tab'
import { png } from './helpers/pictures'
import { closeRigs, rig, textOf, type Rig, type RigOptions } from './helpers/rig'

/*
 * The two tools that read a file, as an agent meets them: through the MCP client, with a stand-in for the Pico tab
 * on a real WebSocket. What matters here is what crosses each border: nothing is read without --root or without a
 * tab, a picture reaches the tab as the bytes of the file and nothing else, a recording reaches it as tools the tab
 * already has, and no secret of a recording is in anything the tab or the agent is given.
 */

const SECRET = {
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  password: 'hunter2-planted-password',
  cookie: 'planted-cookie-value-9f8e7d6c',
  stripe: ['sk', 'live', 'PLANTEDPLANTED0123456789'].join('_'),
  basic: 'cGxhbnRlZDpwbGFudGVk',
}

const header = (name: string, value: string) => ({ name, value })
const api = (suffix: string) => `https://api.shop.test/v1${suffix}`

function entry(method: string, url: string, status: number, over: { reqHeaders?: Array<{ name: string; value: string }>; reqBody?: string; resBody?: string; type?: string } = {}) {
  return {
    _resourceType: over.type ?? 'xhr',
    request: {
      method,
      url,
      headers: [header('Accept', 'application/json'), ...(over.reqHeaders ?? [])],
      ...(over.reqBody ? { postData: { mimeType: 'application/json', text: over.reqBody } } : {}),
    },
    response: { status, statusText: '', headers: [], content: { mimeType: 'application/json', ...(over.resBody ? { text: over.resBody } : {}) } },
  }
}

/** A short recording of a shop's API with a secret planted in every place a secret turns up. */
function recording(): string {
  const auth = [header('Authorization', `Bearer ${SECRET.jwt}`), header('Cookie', `session=${SECRET.cookie}`)]
  return JSON.stringify({
    log: {
      version: '1.2',
      entries: [
        entry('GET', api(`/users?page=1&api_key=${SECRET.stripe}`), 200, { reqHeaders: auth, resBody: JSON.stringify({ items: [{ id: 1, name: 'Ann', email: 'ann@example.com', token: SECRET.stripe }], total: 1 }) }),
        entry('POST', api('/users'), 201, { reqHeaders: auth, reqBody: JSON.stringify({ name: 'Bob', password: SECRET.password }), resBody: JSON.stringify({ id: 2, name: 'Bob' }) }),
        entry('GET', api('/users/41'), 200, { reqHeaders: auth, resBody: JSON.stringify({ id: 41, name: 'Cy', note: `Basic ${SECRET.basic}` }) }),
        entry('GET', api('/users/42'), 200, { reqHeaders: auth, resBody: JSON.stringify({ id: 42, name: 'Di' }) }),
        entry('GET', 'https://cdn.shop.test/app.js', 200, { type: 'script' }),
      ],
    },
  })
}

let base = ''
let root = ''

beforeEach(async () => {
  base = mkdtempSync(path.join(tmpdir(), 'pico-mcp-tools-'))
  mkdirSync(path.join(base, 'root', 'sub'), { recursive: true })
  mkdirSync(path.join(base, 'outside'))
  root = await resolveRoot(path.join(base, 'root'))
})

afterEach(async () => {
  await closeRigs()
  rmSync(base, { recursive: true, force: true })
})

const put = (name: string, content: string | Buffer, where = root) => {
  writeFileSync(path.join(where, name), content)
  return path.join(where, name)
}

async function connected(over: RigOptions = { root }): Promise<{ rig: Rig; tab: FakeTab }> {
  const made = await rig(over)
  return { rig: made, tab: await made.pair() }
}

const run = (r: Rig, name: string, args: Record<string, unknown>, options?: Parameters<Rig['client']['callTool']>[1]) => r.client.callTool({ name, arguments: args }, options)

/** Everything the tab has been sent, as one string. */
const everything = (tab: FakeTab): string => JSON.stringify(tab.received)

/** The arguments of a call must pass the schema the catalog gives that tool, which is what the tab checks them against. */
async function expectValid(tool: string, args: unknown): Promise<void> {
  const schema = fromJsonSchema(toolByName(tool)!.inputSchema)
  const result = await schema['~standard'].validate(args)
  expect('issues' in result && result.issues, `${tool} ${JSON.stringify(args).slice(0, 300)}`).toBeFalsy()
}

describe('pico_attach_image', () => {
  const asked = { endpointId: 'e1', path: 'shot.png', alt: 'The sign-in screen' }

  it('hands the picture to the tab as the bytes of the file, without its path, and tells the agent what was read', async () => {
    const bytes = Buffer.concat([png(320, 200), Buffer.from('more-picture-bytes')])
    put('shot.png', bytes)
    const { rig: r, tab } = await connected()
    const pending = run(r, 'pico_attach_image', { projectId: 'p1', ...asked })
    const call = await tab.nextCall()
    expect(call.tool).toBe('pico_attach_image')
    expect(call.args).toEqual({ projectId: 'p1', endpointId: 'e1', alt: 'The sign-in screen', image: { name: 'shot.png', mime: 'image/png', data: bytes.toString('base64') } })
    expect(JSON.stringify(call)).not.toContain(root)
    tab.reply(call.id, { data: { attached: 'img1' }, summary: 'Added the picture to “Sign in”.', warnings: ['The picture was shrunk.'] })
    const result = await pending
    expect(result.isError).toBeFalsy()
    const answer = JSON.parse(textOf(result as never))
    expect(answer.result).toEqual({ attached: 'img1' })
    expect(answer.summary).toBe('Added the picture to “Sign in”.')
    expect(answer.warnings).toHaveLength(2)
    expect(answer.warnings[0]).toMatch(new RegExp(`^Read shot\\.png \\(image/png, 320 by 200 pixels, ${bytes.length} bytes\\)`))
    expect(answer.warnings[1]).toBe('The picture was shrunk.')
    expect(textOf(result as never)).not.toContain(bytes.toString('base64').slice(0, 40))
  })

  it('names the picture by its file, not by where it is, and leaves out what was not given', async () => {
    put('sub/Design v2.png', png(10, 10))
    const { rig: r, tab } = await connected()
    const pending = run(r, 'pico_attach_image', { endpointId: 'e1', path: 'sub/Design v2.png' })
    const call = await tab.nextCall()
    expect(call.args).toMatchObject({ endpointId: 'e1', image: { name: 'Design v2.png', mime: 'image/png' } })
    expect(Object.keys(call.args as object).sort()).toEqual(['endpointId', 'image'])
    tab.reply(call.id, { data: {}, warnings: [] })
    expect((await pending).isError).toBeFalsy()
  })

  it('cuts a very long file name where the tab will not mind', async () => {
    const long = `${'a'.repeat(240)}.png`
    put(long, png(10, 10))
    const { rig: r, tab } = await connected()
    const pending = run(r, 'pico_attach_image', { endpointId: 'e1', path: long })
    const call = await tab.nextCall()
    expect((call.args as { image: { name: string } }).image.name).toHaveLength(200)
    tab.reply(call.id, { data: {}, warnings: [] })
    expect((await pending).isError).toBeFalsy()
  })

  it('stops telling the agent that Pico waits once the answer has come', async () => {
    put('shot.png', png(10, 10))
    const { rig: r, tab } = await connected({ root, progressMs: 30 })
    const notices: unknown[] = []
    const stray: unknown[] = []
    // A notice for a call that is over is one for a token the client no longer knows: it reports it.
    r.client.onerror = (error) => void stray.push(error)
    const pending = run(r, 'pico_attach_image', asked, { onprogress: (progress) => void notices.push(progress) })
    const call = await tab.nextCall()
    tab.awaiting(call.id)
    await new Promise((resolve) => setTimeout(resolve, 100))
    tab.reply(call.id, { data: {}, warnings: [] })
    await pending
    const seen = notices.length
    expect(seen).toBeGreaterThanOrEqual(1)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(notices.length).toBe(seen)
    expect(stray, 'no notice is sent after the call is over').toEqual([])
  })

  it('answers not-enabled, without asking the tab, when the connector was started without --root', async () => {
    put('shot.png', png(10, 10))
    const { rig: r, tab } = await connected({ root: null })
    const result = await run(r, 'pico_attach_image', asked)
    expect(result.isError).toBe(true)
    expect(textOf(result as never)).toContain('Error (not-enabled)')
    expect(textOf(result as never)).toContain('--root')
    expect(tab.received).toHaveLength(0)
  })

  it('checks that a tab is there before it reads anything', async () => {
    const r = await rig({ root })
    const result = await run(r, 'pico_attach_image', { endpointId: 'e1', path: 'no-such-file.png' })
    expect(result.isError).toBe(true)
    expect(textOf(result as never)).toContain('Pico is not connected')
    expect(textOf(result as never)).not.toContain('not-found')
  })

  it('gives one answer for a file that is missing, outside the folder or reached through a link, and no byte of it', async () => {
    put('secret.png', png(10, 10), path.join(base, 'outside'))
    symlinkSync(path.join(base, 'outside', 'secret.png'), path.join(root, 'link.png'))
    symlinkSync(path.join(base, 'outside'), path.join(root, 'dir-link'))
    const { rig: r, tab } = await connected()
    const texts = new Set<string>()
    for (const wanted of ['missing.png', '../outside/secret.png', path.join(base, 'outside', 'secret.png'), 'link.png', 'dir-link/secret.png', '/etc/passwd']) {
      const result = await run(r, 'pico_attach_image', { endpointId: 'e1', path: wanted })
      expect(result.isError, wanted).toBe(true)
      texts.add(textOf(result as never))
    }
    expect([...texts], 'the agent learns nothing about the rest of the disk').toHaveLength(1)
    expect([...texts][0]).toContain('not-found')
    // Inside the folder it was told about, a folder is a folder.
    const folder = await run(r, 'pico_attach_image', { endpointId: 'e1', path: 'sub' })
    expect(textOf(folder as never)).toContain('not a regular file')
    expect(tab.received).toHaveLength(0)
  })

  it('refuses what is not a picture, whatever its name, and what is too big, before the tab is asked', async () => {
    put('notes.png', 'Dear diary, the password is hunter2.')
    put('huge.png', Buffer.concat([png(10, 10), Buffer.alloc(LIMITS.imageBytes)]))
    put('wide.png', png(LIMITS.imageSide + 1, 10))
    const { rig: r, tab } = await connected()
    for (const name of ['notes.png', 'huge.png', 'wide.png']) {
      const result = await run(r, 'pico_attach_image', { endpointId: 'e1', path: name })
      expect(result.isError, name).toBe(true)
      expect(textOf(result as never), name).not.toContain('hunter2')
    }
    expect(tab.received).toHaveLength(0)
  })

  it('stays under the size of one message to the tab, with the largest picture it accepts', async () => {
    const biggest = Buffer.concat([png(1000, 1000), Buffer.alloc(LIMITS.imageBytes - png(1000, 1000).length, 7)])
    expect(biggest.length).toBe(LIMITS.imageBytes)
    put('biggest.png', biggest)
    const { rig: r, tab } = await connected()
    const pending = run(r, 'pico_attach_image', { endpointId: 'e1', path: 'biggest.png', alt: 'x'.repeat(300) })
    const call = await tab.nextCall()
    expect((call.args as { image: { data: string } }).image.data.length).toBe(Math.ceil(LIMITS.imageBytes / 3) * 4)
    tab.reply(call.id, { data: {}, warnings: [] })
    expect((await pending).isError).toBeFalsy()
  })

  it('passes the tab’s refusals on as they are, and says what to do about a Pico that cannot take pictures', async () => {
    put('shot.png', png(10, 10))
    const { rig: r, tab } = await connected()
    const first = run(r, 'pico_attach_image', asked)
    const call = await tab.nextCall()
    tab.fail(call.id, { code: 'not-found', message: 'There is no endpoint with id “e1”.', hint: 'Endpoints you can use: “Sign in” (e7).', path: 'endpointId' })
    const missing = await first
    expect(missing.isError).toBe(true)
    expect(textOf(missing as never)).toContain('There is no endpoint with id “e1”.')
    expect(textOf(missing as never)).toContain('Endpoints you can use')

    const second = run(r, 'pico_attach_image', asked)
    const again = await tab.nextCall()
    tab.fail(again.id, { code: 'unknown-tool', message: 'There is no tool named “pico_attach_image”.' })
    const old = await second
    expect(old.isError).toBe(true)
    expect(textOf(old as never)).toContain('Error (unknown-tool)')
    expect(textOf(old as never)).toContain('cannot take a picture')
    expect(textOf(old as never)).toContain('reload Pico')
  })

  it('lets the person decide, and tells the agent that Pico is waiting, like any other change', async () => {
    put('shot.png', png(10, 10))
    const { rig: r, tab } = await connected({ root, progressMs: 30 })
    const notices: Array<{ message?: string }> = []
    const pending = run(r, 'pico_attach_image', asked, { onprogress: (progress) => void notices.push(progress) })
    const call = await tab.nextCall()
    tab.awaiting(call.id)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(notices.length).toBeGreaterThanOrEqual(2)
    expect(notices[0].message).toContain('approve')
    tab.fail(call.id, { code: 'declined', message: 'The person declined this change. Nothing was changed.' })
    const result = await pending
    expect(textOf(result as never)).toContain('Error (declined)')
  })

  it('tells the tab to drop the call when the agent stops waiting', async () => {
    put('shot.png', png(10, 10))
    const { rig: r, tab } = await connected()
    const controller = new AbortController()
    const pending = run(r, 'pico_attach_image', asked, { signal: controller.signal })
    const call = await tab.nextCall()
    tab.awaiting(call.id)
    controller.abort()
    await expect(pending).rejects.toBeDefined()
    expect(await tab.next()).toEqual({ type: 'cancel', id: call.id })
  })

  it('refuses arguments that break the schema before anything is read', async () => {
    put('shot.png', png(10, 10))
    const { rig: r, tab } = await connected()
    for (const args of [{ path: 'shot.png' }, { endpointId: 'e1' }, { endpointId: 'e1', path: 'shot.png', surprise: true }, { endpointId: 'e1', path: 'x'.repeat(5_000) }, { endpointId: 'e1', path: 'shot.png', alt: 'a'.repeat(301) }]) {
      expect((await run(r, 'pico_attach_image', args)).isError, JSON.stringify(args).slice(0, 80)).toBe(true)
    }
    expect(tab.received).toHaveLength(0)
  })
})

describe('pico_import_har', () => {
  async function importing(args: Record<string, unknown>, replies: { create?: unknown; add?: unknown } = {}, over: RigOptions = { root }) {
    const { rig: r, tab } = await connected(over)
    const pending = run(r, 'pico_import_har', args)
    const calls: Array<Awaited<ReturnType<FakeTab['nextCall']>>> = []
    if (args.newProject !== undefined) {
      const create = await tab.nextCall()
      calls.push(create)
      tab.reply(create.id, replies.create ?? { data: { projectId: 'p9' }, summary: 'Created.' })
    }
    const add = await tab.nextCall()
    calls.push(add)
    tab.reply(add.id, replies.add ?? { data: { added: 4, skipped: 0 }, summary: 'Added 4 endpoints.', warnings: ['One path looks like a duplicate.'] })
    return { result: await pending, calls, tab, rig: r }
  }

  it('turns a HAR file into a new project and endpoints, through the two tools the tab already has', async () => {
    put('shop.har', recording())
    const { result, calls, tab } = await importing({ format: 'har', path: 'shop.har', newProject: 'Shop' })
    expect(result.isError).toBeFalsy()
    expect(calls.map((call) => call.tool)).toEqual(['pico_create_project', 'pico_add_endpoints'])
    expect(calls[0].args).toMatchObject({ name: 'Shop' })
    const add = calls[1].args as { projectId: string; endpoints: Array<{ method: string; path: string; name: string }> }
    expect(add.projectId).toBe('p9')
    const routes = add.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`)
    expect(routes).toEqual(expect.arrayContaining(['GET /v1/users', 'POST /v1/users', 'GET /v1/users/{userId}']))
    expect(routes.some((route) => route.includes('app.js'))).toBe(false)
    for (const call of calls) await expectValid(call.tool, call.args)

    const answer = JSON.parse(textOf(result as never))
    expect(answer.result).toMatchObject({ imported: add.endpoints.length, host: 'api.shop.test', projectId: 'p9' })
    expect(answer.result.endpoints).toEqual(expect.arrayContaining(['GET /v1/users/{userId}']))
    expect(answer.summary).toBe('Added 4 endpoints.')
    expect(answer.warnings).toContain('One path looks like a duplicate.')
    expect(answer.result.redactions).toBeGreaterThan(0)

    // The point of the redaction: none of it reaches the tab, the agent or the text of any note.
    const seen = `${everything(tab)}${textOf(result as never)}`
    for (const [name, value] of Object.entries(SECRET)) expect(seen, name).not.toContain(value)
    expect(seen).not.toContain(root)
  })

  it('shares the headers every call had as the new project’s common headers, and only then', async () => {
    put('shop.har', recording())
    const fresh = await importing({ format: 'har', path: 'shop.har', newProject: 'Shop' })
    // Accept and the like say nothing about the API; Authorization is what every call carries, and its value is not kept.
    expect((fresh.calls[0].args as { commonHeaders?: unknown }).commonHeaders).toEqual([{ name: 'Authorization', type: 'string', example: '<redacted>' }])
    const shared = (fresh.calls[1].args as { endpoints: Array<{ headers?: Array<{ name: string }> }> }).endpoints
    expect(shared.some((endpoint) => endpoint.headers?.some((item) => item.name === 'Authorization'))).toBe(false)
    // Into a project that exists, nothing is moved out of the endpoints: its common headers are the person’s.
    const existing = await importing({ format: 'har', path: 'shop.har', projectId: 'p1' })
    expect(existing.calls.map((call) => call.tool)).toEqual(['pico_add_endpoints'])
    expect(existing.calls[0].args).toMatchObject({ projectId: 'p1' })
    const endpoints = (existing.calls[0].args as { endpoints: Array<{ headers?: Array<{ name: string }> }> }).endpoints
    expect(endpoints.some((endpoint) => endpoint.headers?.some((item) => item.name === 'Authorization'))).toBe(true)
  })

  it('adds to the open project when no project is named, and passes onDuplicate on', async () => {
    put('shop.har', recording())
    const { calls } = await importing({ format: 'har', path: 'shop.har', onDuplicate: 'replace' })
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toMatchObject({ onDuplicate: 'replace' })
    expect(Object.keys(calls[0].args as object)).not.toContain('projectId')
    await expectValid('pico_add_endpoints', calls[0].args)
  })

  it('reads curl commands given as text, which needs no folder and no file', async () => {
    const curl = `curl -X POST 'https://api.shop.test/v1/orders' -H 'Authorization: Bearer ${SECRET.jwt}' -H 'Content-Type: application/json' -d '{"sku":"A1","qty":2,"coupon":"${SECRET.stripe}"}'\ncurl 'https://api.shop.test/v1/orders/17' -u planted:${SECRET.password}`
    const { result, calls, tab } = await importing({ format: 'curl', content: curl }, {}, { root: null })
    expect(result.isError).toBeFalsy()
    const routes = (calls[0].args as { endpoints: Array<{ method: string; path: string }> }).endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`)
    expect(routes).toEqual(['POST /v1/orders', 'GET /v1/orders/{orderId}'])
    await expectValid('pico_add_endpoints', calls[0].args)
    const seen = `${everything(tab)}${textOf(result as never)}`
    for (const value of [SECRET.jwt, SECRET.stripe, SECRET.password]) expect(seen).not.toContain(value)
  })

  it('does not let the agent keep the secrets of a recording: there is no way to ask for it, and nothing in the answer or the calls carries them', async () => {
    const curl = `curl 'https://api.shop.test/v1/orders' -H 'X-Request-Note: ${SECRET.cookie}' -H 'Authorization: Bearer ${SECRET.jwt}' -d '{"password":"${SECRET.password}","note":"plain words"}'`
    const { rig: r, tab } = await connected({ root: null })
    for (const redact of ['none', 'off', 'false', '', 'NONE']) {
      const refused = await run(r, 'pico_import_har', { format: 'curl', content: curl, redact })
      expect(refused.isError, redact).toBe(true)
    }
    expect(tab.received).toHaveLength(0)
    const kept = await importing({ format: 'curl', content: curl }, {}, { root: null })
    expect(JSON.stringify(kept.calls[0].args)).not.toContain(SECRET.password)
    expect(JSON.stringify(kept.calls[0].args)).not.toContain(SECRET.jwt)
    expect(JSON.stringify(kept.calls[0].args)).toContain('plain words')
    const none = await importing({ format: 'curl', content: curl, redact: 'all-examples' }, {}, { root: null })
    expect(JSON.stringify(none.calls[0].args)).not.toContain('plain words')
    expect(JSON.parse(textOf(none.result as never)).warnings.join(' ')).toContain('all-examples')
  })

  it('imports only the host that was asked for', async () => {
    const mixed = JSON.stringify({ log: { entries: [entry('GET', 'https://a.test/x', 200, { resBody: '{"a":1}' }), entry('GET', 'https://b.test/y', 200, { resBody: '{"b":1}' }), entry('GET', 'https://b.test/z', 200, { resBody: '{"b":1}' })] } })
    put('mixed.har', mixed)
    const first = await importing({ format: 'har', path: 'mixed.har' })
    expect((first.calls[0].args as { endpoints: Array<{ path: string }> }).endpoints.map((endpoint) => endpoint.path).sort()).toEqual(['/y', '/z'])
    expect(JSON.parse(textOf(first.result as never)).result.otherHosts).toEqual(['a.test'])
    const second = await importing({ format: 'har', path: 'mixed.har', hosts: ['a.test'] })
    expect((second.calls[0].args as { endpoints: Array<{ path: string }> }).endpoints.map((endpoint) => endpoint.path)).toEqual(['/x'])
  })

  it('reads a file that begins with a byte order mark, as some tools write them', async () => {
    writeFileSync(path.join(root, 'bom.har'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(recording())]))
    const { result } = await importing({ format: 'har', path: 'bom.har' })
    expect(result.isError).toBeFalsy()
    expect(JSON.parse(textOf(result as never)).result.imported).toBeGreaterThan(0)
  })

  it('lists the first sixty routes and counts the rest, so that a long recording does not make a long answer', async () => {
    const many = JSON.stringify({ log: { entries: Array.from({ length: 70 }, (_, index) => entry('GET', `https://api.shop.test/v1/thing${index}`, 200, { resBody: '{"ok":true}' })) } })
    put('many.har', many)
    const { result } = await importing({ format: 'har', path: 'many.har' })
    const answer = JSON.parse(textOf(result as never))
    expect(answer.result.imported).toBe(70)
    expect(answer.result.endpoints).toHaveLength(60)
    expect(answer.result.moreEndpoints).toBe(10)
  })

  it('stops telling the agent that Pico waits once the answers have come', async () => {
    put('shop.har', recording())
    const { rig: r, tab } = await connected({ root, progressMs: 30 })
    const notices: unknown[] = []
    const stray: unknown[] = []
    r.client.onerror = (error) => void stray.push(error)
    const pending = run(r, 'pico_import_har', { format: 'har', path: 'shop.har', projectId: 'p1' }, { onprogress: (progress) => void notices.push(progress) })
    const call = await tab.nextCall()
    tab.awaiting(call.id)
    await new Promise((resolve) => setTimeout(resolve, 100))
    tab.reply(call.id, { data: { added: 3 }, warnings: [] })
    await pending
    const seen = notices.length
    expect(seen).toBeGreaterThanOrEqual(1)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(notices.length).toBe(seen)
    expect(stray, 'no notice is sent after the call is over').toEqual([])
  })

  it('answers with counts and notes, never with a body or a value from the recording', async () => {
    put('shop.har', recording())
    const { result } = await importing({ format: 'har', path: 'shop.har' })
    const answer = JSON.parse(textOf(result as never))
    expect(Object.keys(answer.result).sort()).toEqual(['endpoints', 'entries', 'host', 'imported', 'otherHosts', 'pico', 'redactions', 'skipped', 'used'])
    expect(textOf(result as never)).not.toContain('ann@example.com')
    expect(textOf(result as never).length).toBeLessThan(4_000)
  })

  it('has nothing to add for a recording that holds no API call, and does not call the tab', async () => {
    put('assets.har', JSON.stringify({ log: { entries: [entry('GET', 'https://cdn.test/app.js', 200, { type: 'script' }), entry('GET', 'https://cdn.test/logo.png', 200, { type: 'image' })] } }))
    const { rig: r, tab } = await connected()
    const result = await run(r, 'pico_import_har', { format: 'har', path: 'assets.har' })
    expect(result.isError).toBeFalsy()
    expect(JSON.parse(textOf(result as never)).result.imported).toBe(0)
    expect(JSON.parse(textOf(result as never)).summary).toMatch(/Nothing to import/)
    expect(tab.received).toHaveLength(0)
  })

  it('stops with a clear answer, and no call, when the arguments cannot be followed', async () => {
    put('shop.har', recording())
    const { rig: r, tab } = await connected()
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ format: 'har' }, /exactly one of path and content/],
      [{ format: 'har', path: 'shop.har', content: '{}' }, /exactly one of path and content/],
      [{ format: 'har', path: 'shop.har', projectId: 'p1', newProject: 'X' }, /not both/],
      [{ format: 'curl', content: 'echo hello' }, /curl/i],
      [{ format: 'har', content: '{"log":{"entries":[]}' }, /./],
    ]
    for (const [args, pattern] of cases) {
      const result = await run(r, 'pico_import_har', args)
      expect(result.isError, JSON.stringify(args)).toBe(true)
      expect(textOf(result as never), JSON.stringify(args)).toMatch(pattern)
    }
    expect(tab.received).toHaveLength(0)
  })

  it('does not quote a file that is not a recording', async () => {
    put('diary.har', `{"diary": "the password is ${SECRET.password}"`)
    put('diary.txt', `Dear diary, ${SECRET.password}`)
    const { rig: r, tab } = await connected()
    for (const name of ['diary.har', 'diary.txt']) {
      const result = await run(r, 'pico_import_har', { format: 'har', path: name })
      expect(result.isError, name).toBe(true)
      expect(textOf(result as never), name).not.toContain(SECRET.password)
    }
    expect(tab.received).toHaveLength(0)
  })

  it('answers not-enabled for a file without --root, but still takes the text itself', async () => {
    put('shop.har', recording())
    const { rig: r, tab } = await connected({ root: null })
    const result = await run(r, 'pico_import_har', { format: 'har', path: 'shop.har' })
    expect(result.isError).toBe(true)
    expect(textOf(result as never)).toContain('Error (not-enabled)')
    expect(tab.received).toHaveLength(0)
  })

  it('keeps to the folder: outside, through a link and missing all give the same answer', async () => {
    put('shop.har', recording(), path.join(base, 'outside'))
    symlinkSync(path.join(base, 'outside', 'shop.har'), path.join(root, 'link.har'))
    const { rig: r, tab } = await connected()
    const texts = new Set<string>()
    for (const wanted of ['../outside/shop.har', 'link.har', 'missing.har', path.join(base, 'outside', 'shop.har')]) {
      const result = await run(r, 'pico_import_har', { format: 'har', path: wanted })
      expect(result.isError, wanted).toBe(true)
      texts.add(textOf(result as never))
    }
    expect([...texts]).toHaveLength(1)
    expect(tab.received).toHaveLength(0)
  })

  it('checks that a tab is there before it reads or parses anything', async () => {
    const r = await rig({ root })
    const result = await run(r, 'pico_import_har', { format: 'har', path: 'missing.har' })
    expect(textOf(result as never)).toContain('Pico is not connected')
  })

  it('stops after a refusal while making the project, and says what was made when adding fails', async () => {
    put('shop.har', recording())
    const { rig: r, tab } = await connected()
    const first = run(r, 'pico_import_har', { format: 'har', path: 'shop.har', newProject: 'Shop' })
    const create = await tab.nextCall()
    tab.fail(create.id, { code: 'read-only', message: 'Pico is set to Read only.' })
    const stopped = await first
    expect(stopped.isError).toBe(true)
    expect(textOf(stopped as never)).toContain('read-only')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(tab.received, 'no second call after a refusal').toHaveLength(0)

    const second = run(r, 'pico_import_har', { format: 'har', path: 'shop.har', newProject: 'Shop' })
    const made = await tab.nextCall()
    tab.reply(made.id, { data: { projectId: 'p5' }, summary: 'Created.' })
    const add = await tab.nextCall()
    tab.fail(add.id, { code: 'declined', message: 'The person declined this change. Nothing was changed.' })
    const half = await second
    expect(half.isError).toBe(true)
    expect(textOf(half as never)).toContain('Error (declined)')
    expect(textOf(half as never)).toContain('The project “Shop” was made, but adding the endpoints failed')
  })

  it('does not go on when Pico does not say which project it made', async () => {
    put('shop.har', recording())
    const { rig: r, tab } = await connected()
    const pending = run(r, 'pico_import_har', { format: 'har', path: 'shop.har', newProject: 'Shop' })
    const made = await tab.nextCall()
    tab.reply(made.id, { data: {}, summary: 'Created.' })
    const result = await pending
    expect(result.isError).toBe(true)
    expect(textOf(result as never)).toContain('did not say which one')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(tab.received).toHaveLength(0)
  })

  it('tells the agent that Pico waits for the person, and lets go of the call when the agent stops waiting', async () => {
    put('shop.har', recording())
    const { rig: r, tab } = await connected({ root, progressMs: 30 })
    const notices: unknown[] = []
    const controller = new AbortController()
    const pending = run(r, 'pico_import_har', { format: 'har', path: 'shop.har', newProject: 'Shop' }, { signal: controller.signal, onprogress: (progress) => void notices.push(progress) })
    const create = await tab.nextCall()
    tab.awaiting(create.id)
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(notices.length).toBeGreaterThanOrEqual(2)
    controller.abort()
    await expect(pending).rejects.toBeDefined()
    expect(await tab.next()).toEqual({ type: 'cancel', id: create.id })
  })

  it('refuses arguments that break the schema before anything is read', async () => {
    put('shop.har', recording())
    const { rig: r, tab } = await connected()
    for (const args of [{}, { format: 'xml', path: 'shop.har' }, { format: 'har', path: 'shop.har', redact: 'some' }, { format: 'har', path: 'shop.har', hosts: Array.from({ length: 11 }, (_, index) => `h${index}.test`) }, { format: 'curl', content: 'x'.repeat(LIMITS.textChars + 1) }, { format: 'har', path: 'shop.har', surprise: 1 }]) {
      expect((await run(r, 'pico_import_har', args)).isError, JSON.stringify(args).slice(0, 80)).toBe(true)
    }
    expect(tab.received).toHaveLength(0)
  })
})
