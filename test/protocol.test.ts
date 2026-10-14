import { describe, expect, it } from 'vitest'
import {
  AGENT_PROTOCOL,
  DEFAULT_PORT,
  LIMITS,
  PORT_SPAN,
  FEATURES,
  TIMING,
  encodeFrame,
  formatPairing,
  isNonce,
  isProof,
  pairingFromHash,
  pairingLink,
  parseBrowserFrame,
  parseConnectorFrame,
  parsePairing,
  proofInput,
  tokenFromBytes,
  utf8Length,
} from '../src/protocol'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** An independent way to write the token: the 128 bits as one number, padded to 130, five bits at a time. */
function reference(bytes: number[]): string {
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  value <<= 2n
  let text = ''
  for (let index = 0; index < 26; index += 1) {
    text = ALPHABET[Number(value & 31n)] + text
    value >>= 5n
  }
  return text
}

function pseudoRandomBytes(seed: number): number[] {
  let state = seed
  return Array.from({ length: 16 }, () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return (state >> 8) & 255
  })
}

describe('tokens', () => {
  it('writes 16 bytes as 26 characters of the Crockford alphabet', () => {
    const token = tokenFromBytes(new Uint8Array(16))
    expect(token).toBe('0'.repeat(26))
    expect(tokenFromBytes(new Uint8Array(16).fill(255))).toBe(reference(new Array(16).fill(255)))
  })

  it('agrees with an independent encoder on many inputs', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const bytes = pseudoRandomBytes(seed)
      const token = tokenFromBytes(Uint8Array.from(bytes))
      expect(token).toBe(reference(bytes))
      expect(token).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    }
  })

  it('refuses anything but 16 bytes', () => {
    expect(() => tokenFromBytes(new Uint8Array(15))).toThrow()
    expect(() => tokenFromBytes(new Uint8Array(17))).toThrow()
  })
})

describe('pairing codes', () => {
  const token = tokenFromBytes(Uint8Array.from(pseudoRandomBytes(7)))
  const pairing = { port: DEFAULT_PORT, token }

  it('are written in groups so they can be read aloud, and read back', () => {
    const code = formatPairing(pairing)
    expect(code).toMatch(/^pico:47631:[0-9A-Z]{4}(-[0-9A-Z]{4}){5}-[0-9A-Z]{2}$/)
    expect(parsePairing(code)).toEqual(pairing)
  })

  it('forgive case, spaces, quotes and brackets around the code', () => {
    const code = formatPairing(pairing)
    expect(parsePairing(`  ${code.toLowerCase()}  `)).toEqual(pairing)
    expect(parsePairing(`\`${code}\``)).toEqual(pairing)
    expect(parsePairing(`<${code}>`)).toEqual(pairing)
    expect(parsePairing(`"${code}"`)).toEqual(pairing)
    expect(parsePairing(`“${code}”`)).toEqual(pairing)
    expect(parsePairing(`‘${code}’`)).toEqual(pairing)
    expect(parsePairing(code.replaceAll('-', ''))).toEqual(pairing)
    expect(parsePairing(code.replaceAll('-', ' '))).toEqual(pairing)
  })

  it('read the letters people mix up the way Crockford says', () => {
    const mixed = '0123456789ABCDEFGHJKMNPQRS'
    const expected = { port: DEFAULT_PORT, token: mixed }
    expect(parsePairing(`pico:47631:${mixed.replaceAll('0', 'o').replaceAll('1', 'l')}`)).toEqual(expected)
    expect(parsePairing(`pico:47631:${mixed.replaceAll('1', 'I')}`)).toEqual(expected)
    expect(parsePairing(`pico:47631:${mixed.replaceAll('0', 'O')}`)).toEqual(expected)
  })

  it('are found inside a link and inside a hash', () => {
    const link = pairingLink('https://pico.hermasyp.space/', pairing)
    expect(link.startsWith('https://pico.hermasyp.space/#agent=')).toBe(true)
    expect(parsePairing(link)).toEqual(pairing)
    expect(pairingFromHash(new URL(link).hash)).toEqual(pairing)
    expect(pairingFromHash('#other=1')).toBeNull()
    expect(pairingFromHash('')).toBeNull()
  })

  it('replace whatever hash the base address already had', () => {
    const link = pairingLink('https://pico.example/app?x=1#old', pairing)
    expect(new URL(link).search).toBe('?x=1')
    expect(pairingFromHash(new URL(link).hash)).toEqual(pairing)
    expect(link.includes('#old')).toBe(false)
  })

  it('are refused when anything is off', () => {
    const code = formatPairing(pairing)
    expect(parsePairing('')).toBeNull()
    expect(parsePairing('hello')).toBeNull()
    expect(parsePairing(code.replace('pico:', 'pica:'))).toBeNull()
    expect(parsePairing(`pico:47631`)).toBeNull()
    expect(parsePairing(`pico:80:${token}`)).toBeNull()
    expect(parsePairing(`pico:1023:${token}`)).toBeNull()
    expect(parsePairing(`pico:65536:${token}`)).toBeNull()
    expect(parsePairing(`pico:47631.5:${token}`)).toBeNull()
    expect(parsePairing(`pico:47631:${token.slice(1)}`)).toBeNull()
    expect(parsePairing(`pico:47631:${token}0`)).toBeNull()
    expect(parsePairing(`pico:47631:${token.slice(1)}U`)).toBeNull()
    expect(parsePairing(`pico:47631:${'-'.repeat(26)}`)).toBeNull()
  })

  it('are refused at once when the text is far longer than any code or link, however it is padded', () => {
    // A long run of quotes, dots or spaces between two words took seconds to trim: it grew with the square of its length.
    for (const filler of ['"', '.', ' ', ')']) {
      const long = `x${filler.repeat(60_000)}x`
      const started = performance.now()
      expect(parsePairing(long)).toBeNull()
      expect(performance.now() - started, JSON.stringify(filler)).toBeLessThan(250)
    }
    expect(parsePairing(`  ${formatPairing(pairing)}  `.padEnd(1_001, ' ') + 'x')).toBeNull()
    const link = pairingLink('https://pico.hermasyp.space/', pairing)
    expect(link.length).toBeLessThan(200)
    expect(parsePairing(link)).toEqual(pairing)
  })

  it('stay inside the span of ports the page and the connector agree on', () => {
    expect(PORT_SPAN).toBeGreaterThanOrEqual(5)
    expect(DEFAULT_PORT + PORT_SPAN).toBeLessThan(65536)
  })
})

describe('proof input', () => {
  it('names the role, so a proof for one side is useless for the other', () => {
    const nonceA = 'a'.repeat(32)
    const nonceB = 'b'.repeat(32)
    expect(proofInput('server', nonceA, nonceB)).not.toBe(proofInput('client', nonceA, nonceB))
    expect(proofInput('server', nonceA, nonceB)).toContain(String(AGENT_PROTOCOL))
    expect(proofInput('server', nonceA, nonceB)).not.toBe(proofInput('server', nonceB, nonceA))
  })

  it('recognises nonces and proofs', () => {
    expect(isNonce('0123456789abcdef0123456789abcdef')).toBe(true)
    expect(isNonce('0123456789ABCDEF0123456789ABCDEF')).toBe(false)
    expect(isNonce('abc')).toBe(false)
    expect(isNonce(5)).toBe(false)
    expect(isProof('f'.repeat(64))).toBe(true)
    expect(isProof('f'.repeat(63))).toBe(false)
    expect(isProof('g'.repeat(64))).toBe(false)
  })
})

describe('frames from the page', () => {
  const nonce = '0123456789abcdef0123456789abcdef'
  const proof = 'ab'.repeat(32)

  it('accepts the four things a page says', () => {
    expect(parseBrowserFrame(JSON.stringify({ type: 'hello', v: 1, app: 'pico', appVersion: '2.1.0', nonce }))).toEqual({
      type: 'hello',
      v: 1,
      app: 'pico',
      appVersion: '2.1.0',
      nonce,
    })
    expect(parseBrowserFrame(JSON.stringify({ type: 'auth', proof }))).toEqual({ type: 'auth', proof })
    expect(parseBrowserFrame(JSON.stringify({ type: 'result', id: 3, ok: true, data: { a: 1 } }))).toEqual({
      type: 'result',
      id: 3,
      ok: true,
      data: { a: 1 },
    })
    expect(
      parseBrowserFrame(JSON.stringify({ type: 'result', id: 4, ok: false, error: { code: 'not-found', message: 'No such endpoint', hint: 'Try pico_status', path: 'endpointId' } })),
    ).toEqual({ type: 'result', id: 4, ok: false, error: { code: 'not-found', message: 'No such endpoint', hint: 'Try pico_status', path: 'endpointId' } })
  })

  it('refuses what is malformed, one way or another', () => {
    const bad = [
      '',
      'not json',
      '[]',
      'null',
      '7',
      JSON.stringify({}),
      JSON.stringify({ type: 'mystery' }),
      JSON.stringify({ type: 'hello', v: 1, app: 'pico', appVersion: '2.1.0', nonce: 'short' }),
      JSON.stringify({ type: 'hello', v: 'one', app: 'pico', appVersion: '2.1.0', nonce }),
      JSON.stringify({ type: 'hello', v: 1, app: 'other', appVersion: '2.1.0', nonce }),
      JSON.stringify({ type: 'hello', v: 1, app: 'pico', nonce }),
      JSON.stringify({ type: 'auth', proof: 'nope' }),
      JSON.stringify({ type: 'auth' }),
      JSON.stringify({ type: 'result', id: 0, ok: true, data: 1 }),
      JSON.stringify({ type: 'result', id: 1.5, ok: true, data: 1 }),
      JSON.stringify({ type: 'result', id: -1, ok: true, data: 1 }),
      JSON.stringify({ type: 'result', id: '2', ok: true, data: 1 }),
      JSON.stringify({ type: 'result', id: 2, ok: 'yes', data: 1 }),
      JSON.stringify({ type: 'result', id: 2, ok: false }),
      JSON.stringify({ type: 'result', id: 2, ok: false, error: { code: 'nonsense', message: 'x' } }),
      JSON.stringify({ type: 'result', id: 2, ok: false, error: { code: 'not-found' } }),
      JSON.stringify({ type: 'result', id: 2, ok: false, error: { code: 'not-found', message: 'x', hint: 4 } }),
    ]
    for (const text of bad) expect(parseBrowserFrame(text), text).toBeNull()
  })

  it('accepts a page saying it is waiting for the person to answer a call', () => {
    expect(parseBrowserFrame(JSON.stringify({ type: 'awaiting-user', id: 7 }))).toEqual({ type: 'awaiting-user', id: 7 })
    const bad = [{ type: 'awaiting-user' }, { type: 'awaiting-user', id: 0 }, { type: 'awaiting-user', id: 1.5 }, { type: 'awaiting-user', id: '3' }, { type: 'awaiting-user', id: -2 }]
    for (const frame of bad) expect(parseBrowserFrame(JSON.stringify(frame)), JSON.stringify(frame)).toBeNull()
  })

  it('refuses a frame bigger than the limit without reading it', () => {
    const huge = JSON.stringify({ type: 'result', id: 1, ok: true, data: 'x'.repeat(LIMITS.frameBytes) })
    expect(parseBrowserFrame(huge)).toBeNull()
  })

  it('measures the limit in bytes, the way the wire does, not in characters', () => {
    // 1.5 million characters of three bytes each: under the limit as a count of characters, over it on the wire.
    const text = JSON.stringify({ type: 'result', id: 1, ok: true, data: '界'.repeat(1_500_000) })
    expect(text.length).toBeLessThan(LIMITS.frameBytes)
    expect(utf8Length(text)).toBeGreaterThan(LIMITS.frameBytes)
    expect(parseBrowserFrame(text)).toBeNull()
    const nearly = JSON.stringify({ type: 'result', id: 1, ok: true, data: '界'.repeat(1_300_000) })
    expect(utf8Length(nearly)).toBeLessThan(LIMITS.frameBytes)
    expect(parseBrowserFrame(nearly)).not.toBeNull()
  })
})

describe('frames from the connector', () => {
  const nonce = 'fedcba9876543210fedcba9876543210'
  const proof = 'cd'.repeat(32)

  it('accepts the four things a connector says', () => {
    const challenge = {
      type: 'challenge',
      v: 1,
      server: 'pico-mcp',
      serverVersion: '2.1.0',
      client: { name: 'claude-code', version: '1.2.3' },
      nonce,
      proof,
    }
    expect(parseConnectorFrame(JSON.stringify(challenge))).toEqual(challenge)
    expect(parseConnectorFrame(JSON.stringify({ ...challenge, client: null }))).toEqual({ ...challenge, client: null })
    expect(parseConnectorFrame(JSON.stringify({ type: 'ready' }))).toEqual({ type: 'ready' })
    expect(parseConnectorFrame(JSON.stringify({ type: 'call', id: 9, tool: 'pico_status', args: { a: [1, 2] } }))).toEqual({
      type: 'call',
      id: 9,
      tool: 'pico_status',
      args: { a: [1, 2] },
    })
    expect(parseConnectorFrame(JSON.stringify({ type: 'call', id: 9, tool: 'pico_status' }))).toEqual({ type: 'call', id: 9, tool: 'pico_status', args: {} })
    expect(parseConnectorFrame(JSON.stringify({ type: 'bye', reason: 'The agent closed.' }))).toEqual({ type: 'bye', reason: 'The agent closed.' })
  })

  it('accepts a connector telling the page that a call is no longer wanted', () => {
    expect(parseConnectorFrame(JSON.stringify({ type: 'cancel', id: 12 }))).toEqual({ type: 'cancel', id: 12 })
    for (const frame of [{ type: 'cancel' }, { type: 'cancel', id: 0 }, { type: 'cancel', id: 'x' }, { type: 'cancel', id: 2.5 }]) {
      expect(parseConnectorFrame(JSON.stringify(frame)), JSON.stringify(frame)).toBeNull()
    }
  })

  describe('the abilities a connector announces in its challenge', () => {
    const challenge = { type: 'challenge', v: 1, server: 'pico-mcp', serverVersion: '1.2.0', client: null, nonce, proof }

    it('are read, and left out of the frame when there are none', () => {
      expect(parseConnectorFrame(JSON.stringify({ ...challenge, features: ['ask'] }))).toEqual({ ...challenge, features: ['ask'] })
      expect(parseConnectorFrame(JSON.stringify(challenge))).toEqual(challenge)
      expect(FEATURES).toContain('ask')
    })

    it('never make a connector unusable: a list that makes no sense is ignored, the challenge is still taken', () => {
      for (const features of ['ask', 7, null, { ask: true }, [], [1, 2], ['UPPER'], ['has space'], ['x'.repeat(40)], [''], [['ask']]]) {
        const parsed = parseConnectorFrame(JSON.stringify({ ...challenge, features }))
        expect(parsed, JSON.stringify(features)).toEqual(challenge)
      }
    })

    it('keep the names that are well formed, including ones this version does not know, and at most eight', () => {
      expect(parseConnectorFrame(JSON.stringify({ ...challenge, features: ['ask', 'Bad Name', 'future-thing', 3] }))).toEqual({ ...challenge, features: ['ask', 'future-thing'] })
      const many = Array.from({ length: 12 }, (_, index) => `ability-${index}`)
      const parsed = parseConnectorFrame(JSON.stringify({ ...challenge, features: many })) as { features: string[] }
      expect(parsed.features).toEqual(many.slice(0, 8))
    })
  })

  it('refuses what is malformed', () => {
    const bad = [
      'x',
      '[]',
      JSON.stringify({ type: 'call', id: 1, tool: '' }),
      JSON.stringify({ type: 'call', id: 1, tool: 'x'.repeat(100) }),
      JSON.stringify({ type: 'call', id: 'one', tool: 'pico_status' }),
      JSON.stringify({ type: 'call', tool: 'pico_status' }),
      JSON.stringify({ type: 'bye' }),
      JSON.stringify({ type: 'challenge', v: 1, server: 'pico-mcp', serverVersion: '1', client: 7, nonce, proof }),
      JSON.stringify({ type: 'challenge', v: 1, server: 'pico-mcp', serverVersion: '1', client: null, nonce: 'x', proof }),
      JSON.stringify({ type: 'challenge', v: 1, server: 'someone-else', serverVersion: '1', client: null, nonce, proof }),
      JSON.stringify({ type: 'challenge', v: 1, server: 'pico-mcp', serverVersion: '1', client: null, nonce, proof: 'x' }),
    ]
    for (const text of bad) expect(parseConnectorFrame(text), text).toBeNull()
  })

  it('does not take a frame meant for the other side', () => {
    expect(parseConnectorFrame(JSON.stringify({ type: 'auth', proof }))).toBeNull()
    expect(parseBrowserFrame(JSON.stringify({ type: 'ready' }))).toBeNull()
  })
})

describe('the time the person has', () => {
  it('is five minutes to answer a change that waits for them, and a little longer before the connector gives up on a tab that went quiet', () => {
    expect(TIMING.askMs).toBe(5 * 60_000)
    expect(TIMING.askGraceMs).toBeGreaterThan(0)
    expect(TIMING.askGraceMs).toBeLessThan(TIMING.askMs)
    expect(TIMING.askMs).toBeGreaterThan(TIMING.callMs)
  })
})

describe('counting bytes', () => {
  it('counts what UTF-8 would write, as the platform does', () => {
    const samples = ['', 'abc', 'é', '界', '😀', 'a😀b界é', '\ud800', 'x\udc00y', '\ud83d', '😀\ud83d', 'line\nbreak\t"quoted"', '𝒳'.repeat(50)]
    for (const sample of samples) expect(utf8Length(sample), JSON.stringify(sample)).toBe(Buffer.byteLength(sample, 'utf8'))
  })
})

describe('writing frames', () => {
  it('refuses to write a frame that is over the limit in bytes', () => {
    const frame = { type: 'result', id: 1, ok: true, data: '界'.repeat(1_500_000) } as const
    expect(() => encodeFrame(frame)).toThrow('too large')
    expect(() => encodeFrame({ ...frame, data: '界'.repeat(1_300_000) })).not.toThrow()
  })

  it('round-trips through the parsers', () => {
    const frame = { type: 'call', id: 1, tool: 'pico_status', args: {} } as const
    expect(parseConnectorFrame(encodeFrame(frame))).toEqual(frame)
    const result = { type: 'result', id: 1, ok: true, data: { a: 1 } } as const
    expect(parseBrowserFrame(encodeFrame(result))).toEqual(result)
  })
})
