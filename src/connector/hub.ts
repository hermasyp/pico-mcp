import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import {
  AGENT_PROTOCOL,
  CLOSE,
  FrameTooLargeError,
  LIMITS,
  PORT_SPAN,
  TIMING,
  encodeFrame,
  parseBrowserFrame,
  proofInput,
  type BrowserFrame,
  type ConnectorFrame,
  type Pairing,
  type ToolError,
} from '../protocol'
import { makeNonce, signProof, verifyProof } from './auth'

/*
 * The WebSocket the Pico tab connects to. It listens on 127.0.0.1 only and
 * refuses an upgrade unless the Host is this machine and the Origin is a page
 * that was allowed. A socket then has to prove it knows the one-time token
 * (and see the connector prove it too) before anything is sent through it; at
 * most one authenticated tab is served at a time. The MCP side asks it to
 * `call` a tool in the tab and gets the answer, or a reason there is none.
 */

export interface HubOptions {
  host?: string
  /** The port to try first; if it is taken the next few are tried. 0 means any free port. */
  port: number
  /** Every Origin a page may connect from. */
  origins: readonly string[]
  token: string
  serverVersion: string
  /** The agent on the other side of MCP, when it has said who it is. */
  getClient?: () => { name: string; version: string } | null
  handshakeMs?: number
  heartbeatMs?: number
  callMs?: number
  /** How many sockets may be in the middle of the handshake at once. */
  maxUnfinished?: number
  log?: (message: string) => void
}

export type HubResult = { ok: true; data: unknown } | { ok: false; error: ToolError }

type Phase = 'hello' | 'auth' | 'ready'

interface Session {
  ws: WebSocket
  phase: Phase
  clientNonce: string
  serverNonce: string
  appVersion: string
  alive: boolean
  handshake: ReturnType<typeof setTimeout> | null
  heartbeat: ReturnType<typeof setInterval> | null
}

interface Pending {
  resolve: (result: HubResult) => void
  timer: ReturnType<typeof setTimeout>
}

const LOOPBACK = '127.0.0.1'

export class Hub {
  readonly host: string
  #options: HubOptions
  #origins: ReadonlySet<string>
  #server: Server | null = null
  #port = 0
  readonly #sockets = new WebSocketServer({ noServer: true, maxPayload: LIMITS.frameBytes })
  readonly #sessions = new Set<Session>()
  #current: Session | null = null
  readonly #pending = new Map<number, Pending>()
  #nextId = 1
  #closing = false
  readonly #listeners = new Set<() => void>()

  constructor(options: HubOptions) {
    this.#options = options
    this.host = options.host ?? LOOPBACK
    this.#origins = new Set(options.origins)
  }

  get port(): number {
    return this.#port
  }

  /** How long a call waits for the tab by default. */
  get callMs(): number {
    return this.#options.callMs ?? TIMING.callMs
  }

  get pairing(): Pairing {
    return { port: this.#port, token: this.#options.token }
  }

  get state(): 'waiting' | 'connected' {
    return this.#current ? 'connected' : 'waiting'
  }

  /** The version of Pico in the tab that is connected. */
  get peerVersion(): string | null {
    return this.#current?.appVersion ?? null
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  async listen(): Promise<void> {
    const first = this.#options.port
    const attempts = first === 0 ? 1 : PORT_SPAN
    for (let index = 0; index < attempts; index += 1) {
      const port = first === 0 ? 0 : first + index
      if (port > 65535) break
      const server = createServer((request, response) => this.#plain(request, response))
      server.on('upgrade', (request, socket, head) => this.#upgrade(request, socket, head))
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(port, this.host, () => {
            server.off('error', reject)
            resolve()
          })
        })
      } catch (error) {
        server.close()
        if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') continue
        throw error
      }
      this.#server = server
      this.#port = (server.address() as AddressInfo).port
      this.#log(`listening on ${this.host}:${this.#port}`)
      return
    }
    throw new Error(`No free port from ${first} to ${first + attempts - 1}. Close the other Pico connector or pass --port.`)
  }

  /** Ask the tab to run a tool. Never throws: a missing tab, a timeout or a dropped connection is an error result. */
  call(tool: string, args: unknown, timeoutMs: number = this.#options.callMs ?? TIMING.callMs): Promise<HubResult> {
    const session = this.#current
    if (!session) {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'not-connected',
          message: 'Pico is not connected.',
          hint: 'Call pico_connect, show the user the pairing code, and ask them to paste it in Pico (Settings, Agent connection).',
        },
      })
    }
    const id = this.#nextId++
    let text: string
    try {
      text = encodeFrame({ type: 'call', id, tool, args })
    } catch (error) {
      // Only this call is at fault. The connection, and the calls already waiting on it, are fine.
      return Promise.resolve({
        ok: false,
        error:
          error instanceof FrameTooLargeError
            ? { code: 'too-large', message: 'That call is too large to send to Pico.', hint: 'Send less in one call: fewer endpoints, or a smaller document.' }
            : { code: 'internal', message: 'That call could not be written.' },
      })
    }
    return new Promise<HubResult>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        resolve({
          ok: false,
          error: {
            code: 'timeout',
            message: `Pico did not answer within ${Math.round(timeoutMs / 1000)} seconds.`,
            hint: 'Is the Pico tab open and awake? A browser can freeze a tab that is in the background. Ask the person to bring it to the front, then try again.',
          },
        })
      }, timeoutMs)
      this.#pending.set(id, { resolve, timer })
      if (!this.#sendText(session, text)) this.#failPending('The connection to Pico was lost.')
    })
  }

  async close(): Promise<void> {
    if (this.#closing) return
    this.#closing = true
    const current = this.#current
    if (current) this.#send(current, { type: 'bye', reason: 'The agent closed this connection.' })
    for (const session of [...this.#sessions]) this.#drop(session, CLOSE.bye, 'The agent closed this connection.')
    this.#failPending('The agent closed the connection.')
    const server = this.#server
    this.#server = null
    await new Promise<void>((resolve) => {
      if (!server) return resolve()
      server.close(() => resolve())
      server.closeAllConnections()
    })
    this.#sockets.close()
  }

  // -------------------------------------------------------------------------

  #log(message: string): void {
    this.#options.log?.(message)
  }

  #emit(): void {
    for (const listener of this.#listeners) listener()
  }

  /** Anything that is not a WebSocket upgrade gets a plain refusal, with no hint of what is here. */
  #plain(_request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(404, { 'Content-Type': 'text/plain', Connection: 'close' })
    response.end('Not found')
  }

  #upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const refuse = (status: number, text: string): void => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      socket.destroy()
    }
    const host = request.headers.host ?? ''
    if (host !== `${LOOPBACK}:${this.#port}` && host !== `localhost:${this.#port}`) return refuse(403, 'Forbidden')
    const origin = request.headers.origin
    if (typeof origin !== 'string' || !this.#origins.has(origin)) {
      this.#log(`refused a page from ${typeof origin === 'string' ? origin : '(no origin)'}`)
      return refuse(403, 'Forbidden')
    }
    if (this.#closing) return refuse(503, 'Service Unavailable')
    const unfinished = [...this.#sessions].filter((session) => session.phase !== 'ready').length
    if (unfinished >= (this.#options.maxUnfinished ?? 8)) return refuse(503, 'Service Unavailable')
    this.#sockets.handleUpgrade(request, socket, head, (ws) => this.#accept(ws))
  }

  #accept(ws: WebSocket): void {
    const session: Session = { ws, phase: 'hello', clientNonce: '', serverNonce: '', appVersion: '', alive: true, handshake: null, heartbeat: null }
    session.handshake = setTimeout(() => this.#drop(session, CLOSE.handshakeTimeout, 'The handshake took too long.'), this.#options.handshakeMs ?? TIMING.handshakeMs)
    this.#sessions.add(session)
    ws.on('message', (data, isBinary) => this.#message(session, data, isBinary))
    ws.on('pong', () => {
      session.alive = true
    })
    ws.on('error', () => {})
    ws.on('close', () => this.#closed(session))
  }

  #send(session: Session, frame: ConnectorFrame): boolean {
    try {
      return this.#sendText(session, encodeFrame(frame))
    } catch {
      return false
    }
  }

  #sendText(session: Session, text: string): boolean {
    try {
      session.ws.send(text)
      return true
    } catch {
      return false
    }
  }

  #drop(session: Session, code: number, reason: string): void {
    try {
      session.ws.close(code, reason.slice(0, 100))
    } catch {
      session.ws.terminate()
    }
    setTimeout(() => session.ws.terminate(), 1_000).unref()
  }

  #message(session: Session, data: RawData, isBinary: boolean): void {
    if (isBinary) return this.#drop(session, CLOSE.badRequest, 'Text frames only.')
    const frame = parseBrowserFrame(data.toString())
    if (!frame) return this.#drop(session, CLOSE.badRequest, 'That was not a frame I understand.')
    if (session.phase === 'hello' && frame.type === 'hello') return this.#hello(session, frame)
    if (session.phase === 'auth' && frame.type === 'auth') return this.#auth(session, frame)
    if (session.phase === 'ready' && frame.type === 'result') return this.#result(session, frame)
    return this.#drop(session, CLOSE.badRequest, 'That frame came at the wrong time.')
  }

  #hello(session: Session, frame: Extract<BrowserFrame, { type: 'hello' }>): void {
    if (frame.v !== AGENT_PROTOCOL) {
      this.#send(session, { type: 'bye', reason: `This connector speaks protocol ${AGENT_PROTOCOL} and Pico speaks ${frame.v}. Update whichever is older.` })
      return this.#drop(session, CLOSE.version, 'Different protocol versions.')
    }
    session.clientNonce = frame.nonce
    session.serverNonce = makeNonce()
    session.appVersion = frame.appVersion
    session.phase = 'auth'
    this.#send(session, {
      type: 'challenge',
      v: AGENT_PROTOCOL,
      server: 'pico-mcp',
      serverVersion: this.#options.serverVersion,
      client: this.#options.getClient?.() ?? null,
      nonce: session.serverNonce,
      proof: signProof(this.#options.token, proofInput('server', session.clientNonce, session.serverNonce)),
    })
  }

  #auth(session: Session, frame: Extract<BrowserFrame, { type: 'auth' }>): void {
    // A wrong proof closes that socket and nothing else. Guessing a 128-bit token is out of the question, and a
    // lockout would hand any program on this machine a way to keep the real tab out.
    if (!verifyProof(this.#options.token, proofInput('client', session.clientNonce, session.serverNonce), frame.proof)) {
      return this.#drop(session, CLOSE.badProof, 'The proof did not match.')
    }
    if (this.#current) {
      this.#send(session, { type: 'bye', reason: 'Another Pico tab is already connected to this agent.' })
      return this.#drop(session, CLOSE.busy, 'Another tab is already connected.')
    }
    if (session.handshake) clearTimeout(session.handshake)
    session.handshake = null
    session.phase = 'ready'
    this.#current = session
    const interval = this.#options.heartbeatMs ?? TIMING.heartbeatMs
    session.heartbeat = setInterval(() => {
      if (!session.alive) {
        session.ws.terminate()
        return
      }
      session.alive = false
      try {
        session.ws.ping()
      } catch {
        session.ws.terminate()
      }
    }, interval)
    session.heartbeat.unref()
    this.#send(session, { type: 'ready' })
    this.#log(`Pico ${session.appVersion} connected`)
    this.#emit()
  }

  #result(session: Session, frame: Extract<BrowserFrame, { type: 'result' }>): void {
    const entry = this.#pending.get(frame.id)
    if (!entry) {
      // An answer to a call that timed out is ignored; an answer to a call never made is not allowed.
      if (frame.id >= this.#nextId) this.#drop(session, CLOSE.badRequest, 'No such call.')
      return
    }
    clearTimeout(entry.timer)
    this.#pending.delete(frame.id)
    entry.resolve(frame.ok ? { ok: true, data: frame.data } : { ok: false, error: frame.error })
  }

  #closed(session: Session): void {
    if (session.handshake) clearTimeout(session.handshake)
    if (session.heartbeat) clearInterval(session.heartbeat)
    this.#sessions.delete(session)
    if (this.#current === session) {
      this.#current = null
      this.#failPending('The Pico tab disconnected.')
      this.#log('Pico disconnected')
      this.#emit()
    }
  }

  #failPending(message: string): void {
    for (const [id, entry] of [...this.#pending]) {
      clearTimeout(entry.timer)
      this.#pending.delete(id)
      entry.resolve({
        ok: false,
        error: { code: 'disconnected', message, hint: 'Ask the person to reconnect Pico (call pico_connect for a new code if the connector was restarted).' },
      })
    }
  }
}
