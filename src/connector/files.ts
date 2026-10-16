import { constants } from 'node:fs'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { LIMITS, type ToolError } from '../protocol'

/*
 * The only place where the connector reads a file. It does so only when the person started it with --root, and then
 * only a picture or a traffic file that the agent names, as a regular file whose real path lies inside that folder.
 * Everything else, a missing file, one outside the folder and one that a link leads out to, gets the same answer, so
 * the agent learns nothing about the rest of the disk, and no message holds a byte of what a file contains.
 */

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
export type FileKind = 'image' | 'traffic'

export interface ImageInfo {
  mime: ImageMime
  width: number
  height: number
}

export type FileRead = ({ ok: true; bytes: Buffer } & Partial<ImageInfo>) | { ok: false; error: ToolError }

const fail = (code: ToolError['code'], message: string, extra: Partial<ToolError> = {}): { ok: false; error: ToolError } => ({ ok: false, error: { code, message, ...extra } })

const NOT_THERE = fail('not-found', 'No such file under the folder this connector may read.', { hint: 'Give a path inside the folder the connector was started with (--root), as a relative path or an absolute one.' })

// ---------------------------------------------------------------------------
// Pictures: what they are and how big, from the first bytes
// ---------------------------------------------------------------------------

const ascii = (bytes: Uint8Array, at: number, text: string): boolean => text.length + at <= bytes.length && [...text].every((letter, index) => bytes[at + index] === letter.charCodeAt(0))
const be16 = (bytes: Uint8Array, at: number): number => (bytes[at] << 8) | bytes[at + 1]
const be32 = (bytes: Uint8Array, at: number): number => ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0
const le16 = (bytes: Uint8Array, at: number): number => bytes[at] | (bytes[at + 1] << 8)
const le24 = (bytes: Uint8Array, at: number): number => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)
const le32 = (bytes: Uint8Array, at: number): number => (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0

function png(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 24 || !ascii(bytes, 1, 'PNG\r\n\x1a\n') || bytes[0] !== 0x89 || !ascii(bytes, 12, 'IHDR')) return null
  return { mime: 'image/png', width: be32(bytes, 16), height: be32(bytes, 20) }
}

function gif(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 10 || !(ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a'))) return null
  return { mime: 'image/gif', width: le16(bytes, 6), height: le16(bytes, 8) }
}

/** The size is in the first start-of-frame segment; the segments before it are skipped by their lengths, a bounded number of them. */
function jpeg(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let at = 2
  for (let step = 0; step < 64 && at + 4 <= bytes.length; step += 1) {
    if (bytes[at] !== 0xff) return null
    const marker = bytes[at + 1]
    if (marker === 0xff) {
      at += 1
      continue
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2
      continue
    }
    const length = be16(bytes, at + 2)
    if (length < 2) return null
    const frame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (frame) {
      if (at + 9 > bytes.length) return null
      return { mime: 'image/jpeg', width: be16(bytes, at + 7), height: be16(bytes, at + 5) }
    }
    if (marker === 0xda) return null
    at += 2 + length
  }
  return null
}

function webp(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 25 || !ascii(bytes, 0, 'RIFF') || !ascii(bytes, 8, 'WEBP')) return null
  if (ascii(bytes, 12, 'VP8 ') && bytes.length >= 30) {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null
    return { mime: 'image/webp', width: le16(bytes, 26) & 0x3fff, height: le16(bytes, 28) & 0x3fff }
  }
  if (ascii(bytes, 12, 'VP8L')) {
    if (bytes[20] !== 0x2f) return null
    const bits = le32(bytes, 21)
    return { mime: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (ascii(bytes, 12, 'VP8X') && bytes.length >= 30) return { mime: 'image/webp', width: le24(bytes, 24) + 1, height: le24(bytes, 27) + 1 }
  return null
}

/** What a picture is and how big, from its first bytes; null when it is none of the four kinds, is cut short, or says it has no size. */
export function imageInfo(bytes: Uint8Array): ImageInfo | null {
  const info = png(bytes) ?? gif(bytes) ?? jpeg(bytes) ?? webp(bytes)
  return info && info.width > 0 && info.height > 0 ? info : null
}

// ---------------------------------------------------------------------------
// The folder
// ---------------------------------------------------------------------------

/** The real path of the folder the connector may read from. Throws an Error whose message says what to change. */
export async function resolveRoot(root: string): Promise<string> {
  if (!path.isAbsolute(root)) throw new Error(`--root “${root}” must be an absolute path, such as /Users/you/project.`)
  let real: string
  try {
    real = await realpath(root)
  } catch {
    throw new Error(`--root “${root}” does not exist.`)
  }
  if (!(await stat(real)).isDirectory()) throw new Error(`--root “${root}” is not a folder.`)
  return real
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/**
 * Reads the file `requested` names, if the connector may. `root` is the real path from `resolveRoot`, or null when the
 * connector was started without --root.
 */
export async function readUnderRoot(root: string | null, requested: unknown, options: { kind: FileKind; maxBytes: number }): Promise<FileRead> {
  if (root === null) {
    return fail('not-enabled', 'This connector was not started with --root, so it reads no files.', {
      hint: 'Ask the person to restart the connector with --root <folder> (in the agent’s settings for pico-mcp), and to put the file in that folder.',
    })
  }
  if (typeof requested !== 'string' || requested === '' || requested.length > 4_096 || requested.includes('\0')) {
    return fail('invalid-arguments', 'path must be the path of a file inside the folder the connector may read.', { path: 'path' })
  }

  const wanted = path.resolve(root, requested)
  if (!inside(root, wanted)) return NOT_THERE
  let real: string
  try {
    real = await realpath(wanted)
  } catch {
    return NOT_THERE
  }
  if (!inside(root, real)) return NOT_THERE

  // O_NONBLOCK so that a named pipe is opened (and then refused) instead of waited for.
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0))
  } catch {
    return NOT_THERE
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) return fail('invalid-arguments', 'That is not a regular file.', { path: 'path' })
    if (info.size > options.maxBytes) {
      return fail('too-large', `That file is larger than ${options.maxBytes.toLocaleString('en-US')} bytes.`, { path: 'path', hint: options.kind === 'image' ? 'Use a smaller picture.' : 'Record less traffic, or cut the file down.' })
    }
    // One byte more than the size says, to notice a file that grows while it is read.
    const buffer = Buffer.alloc(info.size + 1)
    let total = 0
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    if (total > info.size) return fail('too-large', 'That file changed while it was read.', { path: 'path' })
    // A link swapped in between the checks and the open would show here: the path must still lead to the file that was opened.
    const [again, now] = await Promise.all([realpath(wanted).catch(() => null), lstat(real).catch(() => null)])
    if (again !== real || !now || now.ino !== info.ino || now.dev !== info.dev) return NOT_THERE
    const bytes = buffer.subarray(0, total)

    if (options.kind === 'image') {
      const picture = imageInfo(bytes)
      if (!picture) return fail('invalid-arguments', 'That file is not a PNG, JPEG, GIF or WebP picture.', { path: 'path' })
      if (picture.width > LIMITS.imageSide || picture.height > LIMITS.imageSide || picture.width * picture.height > LIMITS.imagePixels) {
        return fail('too-large', `That picture is ${picture.width} by ${picture.height} pixels; the limit is ${LIMITS.imageSide} on a side and ${LIMITS.imagePixels.toLocaleString('en-US')} pixels in all.`, { path: 'path', hint: 'Use a smaller picture.' })
      }
      return { ok: true, bytes, ...picture }
    }
    if (bytes.subarray(0, 8_192).includes(0)) return fail('invalid-arguments', 'That file is not text.', { path: 'path' })
    return { ok: true, bytes }
  } catch {
    return NOT_THERE
  } finally {
    await handle.close().catch(() => {})
  }
}
