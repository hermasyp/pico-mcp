import { describe, expect, it } from 'vitest'
import { DEFAULT_PORT, formatPairing, isNonce, isProof, parsePairing, proofInput, TOKEN_LENGTH } from '../src/protocol'
import { makeNonce, makeToken, signProof, verifyProof } from '../src/connector/auth'

const TOKEN = '0123456789ABCDEFGHJKMNPQRS'

describe('proofs', () => {
  it('are HMAC-SHA256 over the proof input, the same as the page computes with WebCrypto', async () => {
    const clientNonce = 'a'.repeat(32)
    const serverNonce = 'b'.repeat(32)
    for (const role of ['server', 'client'] as const) {
      const input = proofInput(role, clientNonce, serverNonce)
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      const expected = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input))).toString('hex')
      expect(signProof(TOKEN, input)).toBe(expected)
      expect(isProof(signProof(TOKEN, input))).toBe(true)
    }
  })

  it('verify only the right proof for the right token and input', () => {
    const input = proofInput('client', 'a'.repeat(32), 'b'.repeat(32))
    const proof = signProof(TOKEN, input)
    expect(verifyProof(TOKEN, input, proof)).toBe(true)
    expect(verifyProof(TOKEN, input, proof.replace(/.$/, proof.endsWith('0') ? '1' : '0'))).toBe(false)
    expect(verifyProof('Z'.repeat(26), input, proof)).toBe(false)
    expect(verifyProof(TOKEN, proofInput('server', 'a'.repeat(32), 'b'.repeat(32)), proof)).toBe(false)
    expect(verifyProof(TOKEN, input, 'short')).toBe(false)
    expect(verifyProof(TOKEN, input, '')).toBe(false)
  })
})

describe('what is random', () => {
  it('makes nonces of the shape the protocol wants, never the same twice', () => {
    const seen = new Set<string>()
    for (let index = 0; index < 50; index += 1) {
      const nonce = makeNonce()
      expect(isNonce(nonce)).toBe(true)
      seen.add(nonce)
    }
    expect(seen.size).toBe(50)
  })

  it('makes tokens that can go into a pairing code and come back out of one', () => {
    const token = makeToken()
    expect(token).toHaveLength(TOKEN_LENGTH)
    expect(parsePairing(formatPairing({ port: DEFAULT_PORT, token }))).toEqual({ port: DEFAULT_PORT, token })
    expect(makeToken()).not.toBe(token)
  })
})
