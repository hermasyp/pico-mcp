/*
 * The wire between a Pico tab and the connector (`mcp/`) that an agent talks to.
 * Pure: no DOM, no Svelte, no Node. Both sides import it, so they cannot drift
 * apart on what a pairing code, a limit or a frame looks like.
 *
 * The tab connects out to the connector's WebSocket on 127.0.0.1. They prove to
 * each other that they know the one-time token without ever sending it (see
 * `proofInput`), then the connector sends `call` frames and the tab answers with
 * `result` frames. Every frame is a JSON text message, parsed strictly.
 */

export const AGENT_PROTOCOL = 1

/** The connector tries this port first, then the next ones; the pairing code says which it got. */
export const DEFAULT_PORT = 47631
export const PORT_SPAN = 10

export const LIMITS = {
  /** The largest frame either side accepts. */
  frameBytes: 4 * 1024 * 1024,
  endpointsPerCall: 200,
  opsPerCall: 50,
  /** A status code each, so this is generous. */
  responsesPerEndpoint: 100,
  /** Fields in one call, nested ones included. */
  fieldsPerCall: 20_000,
  fieldDepth: 12,
  /** Any one piece of text an agent sends (a description, a raw body). */
  textChars: 200_000,
  /** Names of projects, endpoints, folders and fields. */
  nameChars: 300,
  /** The text of one tool result. A bigger answer is refused with a hint to ask for less. */
  resultChars: 400_000,
} as const

export const TIMING = {
  /** An unauthenticated socket is closed after this long. */
  handshakeMs: 5_000,
  /** How long the connector waits for the tab to answer a call. */
  callMs: 30_000,
  heartbeatMs: 15_000,
} as const

/** WebSocket close codes (the 4000 range is ours). */
export const CLOSE = {
  bye: 4000,
  badRequest: 4400,
  badProof: 4401,
  handshakeTimeout: 4408,
  busy: 4409,
  tooLarge: 4413,
  version: 4426,
} as const

// ---------------------------------------------------------------------------
// Errors an agent can be given
// ---------------------------------------------------------------------------

export const ERROR_CODES = [
  'invalid-arguments',
  'not-found',
  'not-editable',
  'read-only',
  'conflict',
  'too-large',
  'unknown-tool',
  'declined',
  'no-answer',
  'internal',
  'disconnected',
  'timeout',
  'not-connected',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export interface ToolError {
  code: ErrorCode
  message: string
  /** Where in the arguments the problem is, such as `endpoints[2].method`. */
  path?: string
  /** What to do next. */
  hint?: string
}

// ---------------------------------------------------------------------------
// Pairing codes
// ---------------------------------------------------------------------------

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const TOKEN_LENGTH = 26

export interface Pairing {
  port: number
  /** 26 characters of the Crockford alphabet, upper case, no dashes. */
  token: string
}

/** 16 random bytes as 26 characters (128 bits, five bits each, padded with zeros). */
export function tokenFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error('A token is made from exactly 16 bytes.')
  let text = ''
  let accumulator = 0
  let bits = 0
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte
    bits += 8
    while (bits >= 5) {
      text += ALPHABET[(accumulator >> (bits - 5)) & 31]
      bits -= 5
    }
    accumulator &= (1 << bits) - 1
  }
  if (bits > 0) text += ALPHABET[(accumulator << (5 - bits)) & 31]
  return text
}

/** `pico:47631:ABCD-EFGH-…`: grouped so it can be read out and typed. */
export function formatPairing(pairing: Pairing): string {
  const groups = pairing.token.match(/.{1,4}/g) ?? []
  return `pico:${pairing.port}:${groups.join('-')}`
}

function normalizeToken(raw: string): string | null {
  const cleaned = raw
    .toUpperCase()
    .replace(/[-\s]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(cleaned) ? cleaned : null
}

const LINK_KEY = '#agent='

/** A code is 40 characters and a link around it about 120; anything much longer is not one. */
const MAX_PAIRING_TEXT = 1_000

/**
 * Read a pairing code from what a person pasted: the code itself, with or
 * without dashes, quotes or brackets around it, or a Pico link that carries it
 * in its hash. Returns `null` for anything else.
 */
export function parsePairing(text: string): Pairing | null {
  // Trimming the edges below is slow on a long run of quotes or spaces, so a pasted wall of text is turned away first.
  if (typeof text !== 'string' || text.length > MAX_PAIRING_TEXT) return null
  let value = text.trim()
  const marker = value.indexOf(LINK_KEY)
  if (marker !== -1) {
    value = value.slice(marker + LINK_KEY.length).split('&')[0]
    try {
      value = decodeURIComponent(value)
    } catch {
      return null
    }
  }
  value = value.replace(/^[\s`'"“‘<([{]+|[\s`'"”’>)\]}.,;]+$/g, '')
  const match = /^pico:(\d{1,5}):([0-9a-z\- ]+)$/i.exec(value)
  if (!match) return null
  const port = Number(match[1])
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null
  const token = normalizeToken(match[2])
  return token ? { port, token } : null
}

/** A link that opens Pico with the code filled in, for the person to confirm. The hash never reaches a server. */
export function pairingLink(baseUrl: string, pairing: Pairing): string {
  const url = new URL(baseUrl)
  url.hash = `agent=${encodeURIComponent(formatPairing(pairing))}`
  return url.toString()
}

/** The pairing in `location.hash`, when it starts with `#agent=`. */
export function pairingFromHash(hash: string): Pairing | null {
  return hash.startsWith(LINK_KEY) ? parsePairing(hash) : null
}

// ---------------------------------------------------------------------------
// Proofs
// ---------------------------------------------------------------------------

/**
 * What each side signs (HMAC-SHA256 with the token as the key) to show it knows
 * the token. The role is part of it, so a proof made for one side is of no use
 * to the other, and both nonces are fresh for every connection.
 */
export function proofInput(role: 'server' | 'client', clientNonce: string, serverNonce: string): string {
  return `pico-agent/${AGENT_PROTOCOL}|${role}|${clientNonce}|${serverNonce}`
}

export function isNonce(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value)
}

export function isProof(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

export type BrowserFrame =
  | { type: 'hello'; v: number; app: 'pico'; appVersion: string; nonce: string }
  | { type: 'auth'; proof: string }
  | { type: 'result'; id: number; ok: true; data: unknown }
  | { type: 'result'; id: number; ok: false; error: ToolError }

export type ConnectorFrame =
  | {
      type: 'challenge'
      v: number
      server: 'pico-mcp'
      serverVersion: string
      client: { name: string; version: string } | null
      nonce: string
      proof: string
    }
  | { type: 'ready' }
  | { type: 'call'; id: number; tool: string; args: unknown }
  | { type: 'bye'; reason: string }

/** How many bytes `text` takes once written as UTF-8, which is what a WebSocket message is measured in. */
export function utf8Length(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index)
    if (unit < 0x80) bytes += 1
    else if (unit < 0x800) bytes += 2
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      // A surrogate pair is one character of four bytes.
      bytes += 4
      index += 1
    } else bytes += 3
  }
  return bytes
}

/** Over the limit on the wire. A character is at least one byte and a code unit at most three, so only the middle needs counting. */
function overFrameLimit(text: string): boolean {
  if (text.length > LIMITS.frameBytes) return true
  return text.length * 3 > LIMITS.frameBytes && utf8Length(text) > LIMITS.frameBytes
}

function parseObject(text: string): Record<string, unknown> | null {
  if (typeof text !== 'string' || overFrameLimit(text)) return null
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

const isText = (value: unknown, max = 2_000): value is string => typeof value === 'string' && value.length <= max
const isCallId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

function parseError(value: unknown): ToolError | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (!(ERROR_CODES as readonly unknown[]).includes(raw.code) || !isText(raw.message, 20_000)) return null
  if (raw.hint !== undefined && !isText(raw.hint, 20_000)) return null
  if (raw.path !== undefined && !isText(raw.path)) return null
  return {
    code: raw.code as ErrorCode,
    message: raw.message,
    ...(raw.path !== undefined ? { path: raw.path as string } : {}),
    ...(raw.hint !== undefined ? { hint: raw.hint as string } : {}),
  }
}

/** A frame sent by the Pico tab, or `null` when it is not one. */
export function parseBrowserFrame(text: string): BrowserFrame | null {
  const value = parseObject(text)
  if (!value) return null
  switch (value.type) {
    case 'hello':
      if (Number.isInteger(value.v) && value.app === 'pico' && isText(value.appVersion, 50) && isNonce(value.nonce)) {
        return { type: 'hello', v: value.v as number, app: 'pico', appVersion: value.appVersion, nonce: value.nonce }
      }
      return null
    case 'auth':
      return isProof(value.proof) ? { type: 'auth', proof: value.proof } : null
    case 'result': {
      if (!isCallId(value.id)) return null
      if (value.ok === true) return { type: 'result', id: value.id, ok: true, data: value.data ?? null }
      if (value.ok === false) {
        const error = parseError(value.error)
        return error ? { type: 'result', id: value.id, ok: false, error } : null
      }
      return null
    }
    default:
      return null
  }
}

/** A frame sent by the connector, or `null` when it is not one. */
export function parseConnectorFrame(text: string): ConnectorFrame | null {
  const value = parseObject(text)
  if (!value) return null
  switch (value.type) {
    case 'challenge': {
      if (!Number.isInteger(value.v) || value.server !== 'pico-mcp' || !isText(value.serverVersion, 50)) return null
      if (!isNonce(value.nonce) || !isProof(value.proof)) return null
      let client: { name: string; version: string } | null = null
      if (value.client !== null) {
        const raw = value.client as Record<string, unknown> | undefined
        if (raw === undefined || typeof raw !== 'object' || Array.isArray(raw) || !isText(raw.name, 200) || !isText(raw.version, 100)) return null
        client = { name: raw.name, version: raw.version }
      }
      return {
        type: 'challenge',
        v: value.v as number,
        server: 'pico-mcp',
        serverVersion: value.serverVersion,
        client,
        nonce: value.nonce,
        proof: value.proof,
      }
    }
    case 'ready':
      return { type: 'ready' }
    case 'call':
      if (!isCallId(value.id) || typeof value.tool !== 'string' || value.tool.length === 0 || value.tool.length > 64) return null
      return { type: 'call', id: value.id, tool: value.tool, args: value.args ?? {} }
    case 'bye':
      return isText(value.reason, 2_000) ? { type: 'bye', reason: value.reason } : null
    default:
      return null
  }
}

/** A frame that would be over the limit once written. */
export class FrameTooLargeError extends Error {
  constructor() {
    super('That message is too large to send.')
    this.name = 'FrameTooLargeError'
  }
}

/** The text to send for a frame. Throws `FrameTooLargeError` when it would not fit. */
export function encodeFrame(frame: BrowserFrame | ConnectorFrame): string {
  const text = JSON.stringify(frame)
  if (overFrameLimit(text)) throw new FrameTooLargeError()
  return text
}
