import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_PROTOCOL, CLOSE, DEFAULT_PORT, LIMITS, PORT_SPAN } from '../src/protocol'
import { Hub, type HubOptions } from '../src/connector/hub'
import { ORIGIN, connectTab, helloOnly, pairTab, refusedWith, sign } from './helpers/fake-tab'
import { proofInput } from '../src/protocol'

const TOKEN = '0123456789ABCDEFGHJKMNPQRS'

const hubs: Hub[] = []
const servers: Server[] = []

async function startHub(over: Partial<HubOptions> = {}): Promise<Hub> {
  const hub = new Hub({ port: 0, origins: [ORIGIN], token: TOKEN, serverVersion: '2.1.0', getClient: () => ({ name: 'claude-code', version: '9.9.9' }), ...over })
  hubs.push(hub)
  await hub.listen()
  return hub
}

/** Wait until something becomes true (the two ends of a closing socket notice at slightly different moments). */
async function until(condition: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
  expect(condition()).toBe(true)
}

afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.close()))
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
})

describe('the way in', () => {
  it('listens on loopback only, on the port it reports', async () => {
    const hub = await startHub()
    expect(hub.port).toBeGreaterThan(1023)
    expect(hub.state).toBe('waiting')
    expect(hub.host).toBe('127.0.0.1')
    expect(hub.pairing).toEqual({ port: hub.port, token: TOKEN })
  })

  it('takes the next port when the first is taken, within the span, and says which it got', async () => {
    const blocker = createServer()
    servers.push(blocker)
    const taken = await new Promise<number>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve((blocker.address() as { port: number }).port)))
    const hub = await startHub({ port: taken })
    expect(hub.port).toBeGreaterThan(taken)
    expect(hub.port).toBeLessThan(taken + PORT_SPAN)
    expect(DEFAULT_PORT).toBeGreaterThan(1023)
  })

  it('does not answer ordinary web requests with anything but a refusal', async () => {
    const hub = await startHub()
    const response = await fetch(`http://127.0.0.1:${hub.port}/`)
    expect(response.status).toBe(404)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(await response.text()).not.toContain(TOKEN)
  })

  it('refuses a web page from an origin it was not told about, and a request with no origin', async () => {
    const hub = await startHub()
    expect(await refusedWith(hub.port, { origin: 'https://evil.example' })).toBe(403)
    expect(await refusedWith(hub.port, { origin: 'http://localhost:5174' })).toBe(403)
    expect(await refusedWith(hub.port, { origin: 'null' })).toBe(403)
    expect(await refusedWith(hub.port, { origin: null })).toBe(403)
    expect(await refusedWith(hub.port, { origin: ORIGIN })).toBe(101)
  })

  it('refuses a request meant for another name (a rebinding attempt)', async () => {
    const hub = await startHub()
    expect(await refusedWith(hub.port, { host: 'evil.example' })).toBe(403)
    expect(await refusedWith(hub.port, { host: `evil.example:${hub.port}` })).toBe(403)
    expect(await refusedWith(hub.port, { host: `localhost:${hub.port}` })).toBe(101)
    expect(await refusedWith(hub.port, { host: `127.0.0.1:${hub.port}` })).toBe(101)
  })
})

describe('the handshake', () => {
  it('lets a tab that knows the token in, after both sides have proved it', async () => {
    const hub = await startHub()
    const tab = await pairTab(hub.port, TOKEN)
    expect(hub.state).toBe('connected')
    expect(hub.peerVersion).toBe('2.1.0')
    tab.close()
    await tab.closed
  })

  it('includes the agent’s name and the connector’s version in its challenge', async () => {
    const hub = await startHub()
    const tab = await connectTab(hub.port)
    tab.send({ type: 'hello', v: AGENT_PROTOCOL, app: 'pico', appVersion: '2.1.0', nonce: 'c'.repeat(32) })
    const challenge = await tab.next()
    expect(challenge).toMatchObject({ type: 'challenge', v: AGENT_PROTOCOL, server: 'pico-mcp', serverVersion: '2.1.0', client: { name: 'claude-code', version: '9.9.9' } })
    tab.close()
  })

  it('closes on a wrong proof, and never says whether the token was nearly right', async () => {
    const hub = await startHub()
    const { tab, clientNonce, serverNonce } = await helloOnly(hub.port)
    tab.send({ type: 'auth', proof: sign('W'.repeat(26), proofInput('client', clientNonce, serverNonce)) })
    const closed = await tab.closed
    expect(closed.code).toBe(CLOSE.badProof)
    expect(hub.state).toBe('waiting')
  })

  it('does not take the connector’s own proof for the tab’s', async () => {
    const hub = await startHub()
    const { tab, clientNonce, serverNonce } = await helloOnly(hub.port)
    tab.send({ type: 'auth', proof: sign(TOKEN, proofInput('server', clientNonce, serverNonce)) })
    expect((await tab.closed).code).toBe(CLOSE.badProof)
  })

  it('closes only the socket that gave a wrong proof, however many do, so no one can keep the real tab out', async () => {
    const hub = await startHub()
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const { tab, clientNonce, serverNonce } = await helloOnly(hub.port)
      tab.send({ type: 'auth', proof: sign('W'.repeat(26), proofInput('client', clientNonce, serverNonce)) })
      expect((await tab.closed).code).toBe(CLOSE.badProof)
    }
    const tab = await pairTab(hub.port, TOKEN)
    expect(hub.state).toBe('connected')
    tab.close()
  })

  it('closes a socket that does not finish the handshake in time', async () => {
    const hub = await startHub({ handshakeMs: 150 })
    const silent = await connectTab(hub.port)
    expect((await silent.closed).code).toBe(CLOSE.handshakeTimeout)
    const { tab } = await helloOnly(hub.port)
    expect((await tab.closed).code).toBe(CLOSE.handshakeTimeout)
  })

  it('closes on anything that is not the next frame it expects', async () => {
    const hub = await startHub()
    const early = await connectTab(hub.port)
    early.send({ type: 'auth', proof: 'f'.repeat(64) })
    expect((await early.closed).code).toBe(CLOSE.badRequest)
    const nonsense = await connectTab(hub.port)
    nonsense.send('not json')
    expect((await nonsense.closed).code).toBe(CLOSE.badRequest)
    const binary = await connectTab(hub.port)
    binary.socket.send(Buffer.from([1, 2, 3]))
    expect((await binary.closed).code).toBe(CLOSE.badRequest)
    const twice = await helloOnly(hub.port)
    twice.tab.send({ type: 'hello', v: AGENT_PROTOCOL, app: 'pico', appVersion: '2.1.0', nonce: 'd'.repeat(32) })
    expect((await twice.tab.closed).code).toBe(CLOSE.badRequest)
  })

  it('turns away a tab that speaks another version of the protocol, saying so first', async () => {
    const hub = await startHub()
    const tab = await connectTab(hub.port)
    tab.send({ type: 'hello', v: AGENT_PROTOCOL + 1, app: 'pico', appVersion: '9.0.0', nonce: 'e'.repeat(32) })
    const bye = await tab.next()
    expect(bye.type).toBe('bye')
    expect((await tab.closed).code).toBe(CLOSE.version)
  })

  it('closes a frame that is bigger than the limit', async () => {
    const hub = await startHub()
    const tab = await connectTab(hub.port)
    tab.socket.send('x'.repeat(LIMITS.frameBytes + 10))
    const closed = await tab.closed
    expect(closed.code).toBe(1009)
  })

  it('lets one tab at a time in, and keeps the first', async () => {
    const hub = await startHub()
    const first = await pairTab(hub.port, TOKEN)
    const { tab, clientNonce, serverNonce } = await helloOnly(hub.port)
    tab.send({ type: 'auth', proof: sign(TOKEN, proofInput('client', clientNonce, serverNonce)) })
    expect(await tab.next()).toMatchObject({ type: 'bye' })
    expect((await tab.closed).code).toBe(CLOSE.busy)
    expect(hub.state).toBe('connected')
    const pending = hub.call('pico_status', {})
    const call = await first.nextCall()
    first.reply(call.id, 1)
    expect(await pending).toEqual({ ok: true, data: 1 })
    first.close()
  })

  it('does not pile up unfinished handshakes', async () => {
    const hub = await startHub({ handshakeMs: 5_000 })
    const open: Awaited<ReturnType<typeof connectTab>>[] = []
    let refused = 0
    for (let index = 0; index < 20; index += 1) {
      try {
        open.push(await connectTab(hub.port))
      } catch (error) {
        refused += (error as { statusCode?: number }).statusCode === 503 ? 1 : 0
      }
    }
    expect(refused).toBeGreaterThan(0)
    for (const tab of open) tab.close()
  })
})

describe('calls', () => {
  it('goes to the tab and comes back with its answer', async () => {
    const hub = await startHub()
    const tab = await pairTab(hub.port, TOKEN)
    const pending = hub.call('pico_status', { a: 1 })
    const call = await tab.nextCall()
    expect(call).toMatchObject({ tool: 'pico_status', args: { a: 1 } })
    tab.reply(call.id, { open: null })
    expect(await pending).toEqual({ ok: true, data: { open: null } })
    tab.close()
  })

  it('answers too-large for a call that cannot be sent, and leaves the connection and the other calls alone', async () => {
    const hub = await startHub()
    const tab = await pairTab(hub.port, TOKEN)
    const waiting = hub.call('pico_status', {})
    const first = await tab.nextCall()
    // 1.5 million characters of three bytes each: more than a frame may hold.
    const huge = await hub.call('pico_import_document', { content: '界'.repeat(1_500_000) })
    expect(huge).toMatchObject({ ok: false, error: { code: 'too-large' } })
    expect(hub.state).toBe('connected')
    tab.reply(first.id, 'still here')
    expect(await waiting).toEqual({ ok: true, data: 'still here' })
    const after = hub.call('pico_status', {})
    const next = await tab.nextCall()
    tab.reply(next.id, 1)
    expect(await after).toEqual({ ok: true, data: 1 })
    tab.close()
  })

  it('carries an error the tab gives, whole', async () => {
    const hub = await startHub()
    const tab = await pairTab(hub.port, TOKEN)
    const pending = hub.call('pico_get_project', {})
    const call = await tab.nextCall()
    tab.fail(call.id, { code: 'not-found', message: 'No such project', hint: 'Try pico_status', path: 'projectId' })
    expect(await pending).toEqual({ ok: false, error: { code: 'not-found', message: 'No such project', hint: 'Try pico_status', path: 'projectId' } })
    tab.close()
  })

  it('keeps several calls apart by their ids, even when the answers come in another order', async () => {
    const hub = await startHub()
    const tab = await pairTab(hub.port, TOKEN)
    const one = hub.call('pico_status', { n: 1 })
    const two = hub.call('pico_status', { n: 2 })
    const first = await tab.nextCall()
    const second = await tab.nextCall()
    expect(first.id).not.toBe(second.id)
    tab.reply(second.id, 'two')
    tab.reply(first.id, 'one')
    expect(await one).toEqual({ ok: true, data: 'one' })
    expect(await two).toEqual({ ok: true, data: 'two' })
    tab.close()
  })

  it('says so when no tab is connected', async () => {
    const hub = await startHub()
    const outcome = await hub.call('pico_status', {})
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.code).toBe('not-connected')
      expect(outcome.error.message).toContain('not connected')
      expect(outcome.error.hint).toContain('pico_connect')
    }
  })

  it('gives up when the tab does not answer, and ignores the answer if it comes late', async () => {
    const hub = await startHub({ callMs: 120 })
    const tab = await pairTab(hub.port, TOKEN)
    const pending = hub.call('pico_status', {})
    const call = await tab.nextCall()
    const outcome = await pending
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.code).toBe('timeout')
    tab.reply(call.id, 'late')
    const next = hub.call('pico_status', {})
    const nextCall = await tab.nextCall()
    tab.reply(nextCall.id, 'on time')
    expect(await next).toEqual({ ok: true, data: 'on time' })
    tab.close()
  })

  it('takes a longer wait for a call that asks for one', async () => {
    const hub = await startHub({ callMs: 50 })
    const tab = await pairTab(hub.port, TOKEN)
    const pending = hub.call('pico_status', {}, 2_000)
    const call = await tab.nextCall()
    await new Promise((resolve) => setTimeout(resolve, 150))
    tab.reply(call.id, 'slow but fine')
    expect(await pending).toEqual({ ok: true, data: 'slow but fine' })
    tab.close()
  })

  it('fails every call that is waiting when the tab goes away', async () => {
    const hub = await startHub()
    const tab = await pairTab(hub.port, TOKEN)
    const one = hub.call('pico_status', {})
    const two = hub.call('pico_get_project', {})
    await tab.nextCall()
    await tab.nextCall()
    tab.close()
    for (const outcome of await Promise.all([one, two])) {
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.error.code).toBe('disconnected')
    }
    await tab.closed
    await until(() => hub.state === 'waiting')
  })

  it('closes a tab that answers a call that was never made, or in a way that makes no sense', async () => {
    const hub = await startHub()
    const stray = await pairTab(hub.port, TOKEN)
    stray.reply(999, 'nobody asked')
    expect((await stray.closed).code).toBe(CLOSE.badRequest)
    const odd = await pairTab(hub.port, TOKEN)
    odd.send({ type: 'hello', v: 1, app: 'pico', appVersion: '1', nonce: 'a'.repeat(32) })
    expect((await odd.closed).code).toBe(CLOSE.badRequest)
  })
})

describe('staying alive and leaving', () => {
  it('lets go of a tab that stops answering pings', async () => {
    const hub = await startHub({ heartbeatMs: 80 })
    const tab = await pairTab(hub.port, TOKEN, { autoPong: false })
    const closed = await tab.closed
    expect(closed.code).toBeGreaterThan(0)
    await until(() => hub.state === 'waiting')
  })

  it('keeps a tab that does answer', async () => {
    const hub = await startHub({ heartbeatMs: 80 })
    const tab = await pairTab(hub.port, TOKEN)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(hub.state).toBe('connected')
    tab.close()
  })

  it('says goodbye to the tab when it closes', async () => {
    const hub = await startHub()
    const tab = await pairTab(hub.port, TOKEN)
    const goodbye = tab.next()
    await hub.close()
    expect(await goodbye).toMatchObject({ type: 'bye' })
    expect((await tab.closed).code).toBe(CLOSE.bye)
  })

  it('tells whoever listens when a tab comes or goes', async () => {
    const hub = await startHub()
    const states: string[] = []
    const stop = hub.onChange(() => states.push(hub.state))
    const tab = await pairTab(hub.port, TOKEN)
    tab.close()
    await tab.closed
    await new Promise((resolve) => setTimeout(resolve, 50))
    stop()
    expect(states).toEqual(['connected', 'waiting'])
  })
})
