import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { tokenFromBytes } from '../protocol'

/*
 * The connector's side of the proof of the token. The token is never sent: each
 * side signs a line that names its role and both fresh nonces (see `proofInput`),
 * and the other side checks the signature. The page computes the same HMAC with
 * WebCrypto.
 */

/** 128 random bits as a 26-character token. */
export const makeToken = (): string => tokenFromBytes(randomBytes(16))

export const makeNonce = (): string => randomBytes(16).toString('hex')

export const signProof = (token: string, input: string): string => createHmac('sha256', token).update(input).digest('hex')

/** Whether `proof` is what `token` signs for `input`, compared in constant time. */
export function verifyProof(token: string, input: string, proof: string): boolean {
  if (typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof)) return false
  return timingSafeEqual(Buffer.from(signProof(token, input), 'hex'), Buffer.from(proof, 'hex'))
}
