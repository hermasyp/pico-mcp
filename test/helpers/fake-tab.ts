import { createHmac, randomBytes } from 'node:crypto'
import { expect } from 'vitest'
import WebSocket from 'ws'
import {
  AGENT_PROTOCOL,
  encodeFrame,
  parseConnectorFrame,
  proofInput,
  type BrowserFrame,
  type ConnectorFrame,
} from '../../src/protocol'

/*
 * A stand-in for the Pico tab, for testing the connector from the outside: it
 * opens a real WebSocket, says hello the way the tab does, checks the
 * connector's proof, answers the challenge, and then answers calls.
 */

export const sign = (token: string, input: string): string => createHmac('sha256', token).update(input).digest('hex')

export interface TabOptions {
  /** `null` sends no Origin header at all. */
  origin?: string | null
  host?: string
  autoPong?: boolean
}

export const ORIGIN = 'http://localhost:5173'

function open(port: number, options: TabOptions): WebSocket {
  const headers: Record<string, string> = {}
  if (options.origin !== null) headers.Origin = options.origin ?? ORIGIN
  if (options.host) headers.Host = options.host
  return new WebSocket(`ws://127.0.0.1:${port}`, { headers, autoPong: options.autoPong ?? true })
}

export class FakeTab {
  readonly socket: WebSocket
  readonly received: ConnectorFrame[] = []
  readonly closed: Promise<{ code: number; reason: string }>
  private waiting: Array<(frame: ConnectorFrame) => void> = []

  constructor(socket: WebSocket) {
    this.socket = socket
    socket.on('message', (data, isBinary) => {
      if (isBinary) return
      const frame = parseConnectorFrame(data.toString())
      if (!frame) return
      const waiter = this.waiting.shift()
      if (waiter) waiter(frame)
      else this.received.push(frame)
    })
    this.closed = new Promise((resolve) => socket.on('close', (code, reason) => resolve({ code, reason: reason.toString() })))
  }

  send(frame: BrowserFrame | Record<string, unknown>): void {
    this.socket.send(typeof frame === 'string' ? frame : JSON.stringify(frame))
  }

  /** The next frame from the connector, waiting for it if it has not come yet. */
  next(): Promise<ConnectorFrame> {
    const queued = this.received.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve) => this.waiting.push(resolve))
  }

  async nextCall(): Promise<Extract<ConnectorFrame, { type: 'call' }>> {
    const frame = await this.next()
    expect(frame.type).toBe('call')
    return frame as Extract<ConnectorFrame, { type: 'call' }>
  }

  /** Answer a call with data. */
  reply(id: number, data: unknown): void {
    this.send({ type: 'result', id, ok: true, data })
  }

  fail(id: number, error: { code: string; message: string; hint?: string; path?: string }): void {
    this.send({ type: 'result', id, ok: false, error })
  }

  /** Say that the call is waiting for the person to decide. */
  awaiting(id: number): void {
    this.send({ type: 'awaiting-user', id })
  }

  close(): void {
    this.socket.close()
  }
}

/** Connect without saying anything. */
export function connectTab(port: number, options: TabOptions = {}): Promise<FakeTab> {
  const socket = open(port, options)
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(new FakeTab(socket)))
    socket.once('error', reject)
    socket.once('unexpected-response', (_request, response) => reject(Object.assign(new Error(`HTTP ${response.statusCode}`), { statusCode: response.statusCode })))
  })
}

/** The status code of a refused upgrade. */
export async function refusedWith(port: number, options: TabOptions = {}): Promise<number> {
  try {
    const tab = await connectTab(port, options)
    tab.close()
    return 101
  } catch (error) {
    return (error as { statusCode?: number }).statusCode ?? 0
  }
}

/** Connect and go through the whole handshake with the right token. */
export async function pairTab(port: number, token: string, options: TabOptions = {}): Promise<FakeTab> {
  const tab = await connectTab(port, options)
  const clientNonce = randomBytes(16).toString('hex')
  tab.send({ type: 'hello', v: AGENT_PROTOCOL, app: 'pico', appVersion: '2.1.0', nonce: clientNonce })
  const challenge = await tab.next()
  expect(challenge.type).toBe('challenge')
  if (challenge.type !== 'challenge') throw new Error('no challenge')
  // The tab checks the connector's proof before it answers.
  expect(challenge.proof).toBe(sign(token, proofInput('server', clientNonce, challenge.nonce)))
  tab.send({ type: 'auth', proof: sign(token, proofInput('client', clientNonce, challenge.nonce)) })
  const ready = await tab.next()
  expect(ready.type).toBe('ready')
  return tab
}

/** Say hello and read the challenge, without answering it. */
export async function helloOnly(
  port: number,
  options: TabOptions = {},
): Promise<{ tab: FakeTab; clientNonce: string; serverNonce: string; challenge: Extract<ConnectorFrame, { type: 'challenge' }> }> {
  const tab = await connectTab(port, options)
  const clientNonce = randomBytes(16).toString('hex')
  tab.send({ type: 'hello', v: AGENT_PROTOCOL, app: 'pico', appVersion: '2.1.0', nonce: clientNonce })
  const challenge = await tab.next()
  if (challenge.type !== 'challenge') throw new Error('no challenge')
  return { tab, clientNonce, serverNonce: challenge.nonce, challenge }
}

export { encodeFrame }
