import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { imageInfo, readUnderRoot, resolveRoot } from '../src/connector/files'
import { LIMITS } from '../src/protocol'
import { gif, jpeg, png, webpExtended, webpLossless, webpLossy } from './helpers/pictures'

/*
 * The connector reads a file only when the person started it with --root, and then only a picture or a traffic
 * file that really is one, as a regular file whose real path lies inside that folder. Everything an agent could try
 * to read anything else with is in this matrix.
 */

describe('imageInfo', () => {
  it('reads the kind and the size of the four kinds of picture from their first bytes', () => {
    expect(imageInfo(png(640, 480))).toEqual({ mime: 'image/png', width: 640, height: 480 })
    expect(imageInfo(gif(32, 16))).toEqual({ mime: 'image/gif', width: 32, height: 16 })
    expect(imageInfo(jpeg(1024, 768))).toEqual({ mime: 'image/jpeg', width: 1024, height: 768 })
    expect(imageInfo(webpLossy(300, 200))).toEqual({ mime: 'image/webp', width: 300, height: 200 })
    expect(imageInfo(webpLossless(301, 201))).toEqual({ mime: 'image/webp', width: 301, height: 201 })
    expect(imageInfo(webpExtended(4000, 3000))).toEqual({ mime: 'image/webp', width: 4000, height: 3000 })
  })

  it('says nothing for what is not a picture, is cut short, or has a size that makes no sense', () => {
    expect(imageInfo(Buffer.from('hello'))).toBeNull()
    expect(imageInfo(Buffer.alloc(0))).toBeNull()
    expect(imageInfo(png(10, 10).subarray(0, 20))).toBeNull()
    expect(imageInfo(gif(10, 10).subarray(0, 8))).toBeNull()
    expect(imageInfo(jpeg(10, 10).subarray(0, 12))).toBeNull()
    expect(imageInfo(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBeNull()
    expect(imageInfo(png(0, 10))).toBeNull()
    expect(imageInfo(webpLossy(0, 0))).toBeNull()
    expect(imageInfo(Buffer.from('RIFF....WEBPXXXX'))).toBeNull()
  })

  it('does not loop on a JPEG whose segments claim to be longer than the file', () => {
    const bad = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xe1, 0xff, 0xff]), Buffer.alloc(8)])
    expect(imageInfo(bad)).toBeNull()
    const zero = Buffer.concat([Buffer.from([0xff, 0xd8]), ...Array.from({ length: 50 }, () => Buffer.from([0xff, 0xe1, 0x00, 0x00]))])
    expect(imageInfo(zero)).toBeNull()
  })
})

// ---- a folder to read from ----

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function sandbox(): { root: string; outside: string; write: (name: string, data: Buffer | string) => string } {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'pico-mcp-files-')))
  made.push(base)
  const root = path.join(base, 'root')
  const outside = path.join(base, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
  return {
    root,
    outside,
    write: (name, data) => {
      const target = path.isAbsolute(name) ? name : path.join(root, name)
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, data)
      return target
    },
  }
}

const IMAGE = { kind: 'image', maxBytes: LIMITS.imageBytes } as const
const TRAFFIC = { kind: 'traffic', maxBytes: LIMITS.trafficBytes } as const

describe('resolveRoot', () => {
  it('wants an absolute folder that exists, and gives back its real path', async () => {
    const box = sandbox()
    expect(await resolveRoot(box.root)).toBe(box.root)
    await expect(resolveRoot('relative/folder')).rejects.toThrow('absolute')
    await expect(resolveRoot(path.join(box.root, 'missing'))).rejects.toThrow('does not exist')
    const file = box.write('a.txt', 'x')
    await expect(resolveRoot(file)).rejects.toThrow('not a folder')
    const link = path.join(box.outside, 'link')
    symlinkSync(box.root, link)
    expect(await resolveRoot(link)).toBe(box.root)
  })
})

describe('readUnderRoot', () => {
  it('answers not-enabled when the connector was started without a root, whatever is asked', async () => {
    const box = sandbox()
    const file = box.write('a.png', png(10, 10))
    for (const asked of [file, 'a.png', '/etc/passwd', '']) {
      expect(await readUnderRoot(null, asked, IMAGE)).toMatchObject({ ok: false, error: { code: 'not-enabled' } })
    }
  })

  it('reads a picture by a path relative to the root or by its absolute path, and says what it is', async () => {
    const box = sandbox()
    const file = box.write('design/screen.png', png(640, 480))
    for (const asked of ['design/screen.png', './design/../design/screen.png', file]) {
      const read = await readUnderRoot(box.root, asked, IMAGE)
      expect(read).toMatchObject({ ok: true, mime: 'image/png', width: 640, height: 480 })
      if (read.ok) expect(read.bytes.equals(png(640, 480))).toBe(true)
    }
  })

  it('decides by what the file is, not by its name', async () => {
    const box = sandbox()
    box.write('looks-like.png', 'this is only text')
    box.write('no-extension', jpeg(20, 20))
    expect(await readUnderRoot(box.root, 'looks-like.png', IMAGE)).toMatchObject({ ok: false, error: { code: 'invalid-arguments', message: expect.stringContaining('picture') } })
    expect(await readUnderRoot(box.root, 'no-extension', IMAGE)).toMatchObject({ ok: true, mime: 'image/jpeg' })
  })

  it('does not tell a file outside the root from one that is missing', async () => {
    const box = sandbox()
    const secret = box.write(path.join(box.outside, 'secret.png'), png(10, 10))
    const missing = await readUnderRoot(box.root, 'nothing-here.png', IMAGE)
    expect(missing).toMatchObject({ ok: false, error: { code: 'not-found' } })
    for (const asked of [secret, '../outside/secret.png', '/etc/passwd', path.join(box.root, '..', 'outside', 'secret.png')]) {
      const read = await readUnderRoot(box.root, asked, IMAGE)
      expect(read).toEqual(await readUnderRoot(box.root, asked.replace(/secret\.png$/, 'absent.png'), IMAGE))
      expect(read.ok ? '' : read.error.code).toBe('not-found')
      expect(JSON.stringify(read)).not.toContain('secret')
    }
  })

  it('refuses a link that leads out of the root, and follows one that stays inside', async () => {
    const box = sandbox()
    const secret = box.write(path.join(box.outside, 'secret.png'), png(10, 10))
    symlinkSync(secret, path.join(box.root, 'escape.png'))
    symlinkSync(box.outside, path.join(box.root, 'escape-dir'))
    box.write('real.png', png(12, 12))
    symlinkSync(path.join(box.root, 'real.png'), path.join(box.root, 'inside.png'))
    expect(await readUnderRoot(box.root, 'escape.png', IMAGE)).toMatchObject({ ok: false, error: { code: 'not-found' } })
    expect(await readUnderRoot(box.root, 'escape-dir/secret.png', IMAGE)).toMatchObject({ ok: false, error: { code: 'not-found' } })
    expect(await readUnderRoot(box.root, 'inside.png', IMAGE)).toMatchObject({ ok: true, width: 12 })
  })

  it('reads only regular files: not a folder, and a named pipe is turned away at once instead of waited for', async () => {
    const box = sandbox()
    mkdirSync(path.join(box.root, 'folder.png'))
    expect(await readUnderRoot(box.root, 'folder.png', IMAGE)).toMatchObject({ ok: false, error: { code: 'invalid-arguments', message: expect.stringContaining('regular file') } })
    expect(await readUnderRoot(box.root, '.', IMAGE)).toMatchObject({ ok: false, error: { code: 'invalid-arguments' } })
    const pipe = path.join(box.root, 'pipe.png')
    try {
      execFileSync('mkfifo', [pipe])
    } catch {
      return // no mkfifo here (Windows): nothing to try
    }
    const started = Date.now()
    expect(await readUnderRoot(box.root, 'pipe.png', IMAGE)).toMatchObject({ ok: false, error: { code: 'invalid-arguments' } })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('refuses a file over the size it was asked to stay under, without reading it', async () => {
    const box = sandbox()
    const big = path.join(box.root, 'big.png')
    writeFileSync(big, png(10, 10))
    truncateSync(big, LIMITS.imageBytes + 1)
    expect(await readUnderRoot(box.root, 'big.png', IMAGE)).toMatchObject({ ok: false, error: { code: 'too-large' } })
    box.write('small.txt', 'x'.repeat(2_000))
    expect(await readUnderRoot(box.root, 'small.txt', { kind: 'traffic', maxBytes: 1_000 })).toMatchObject({ ok: false, error: { code: 'too-large' } })
  })

  it('refuses a picture whose size would freeze the page that has to draw it', async () => {
    const box = sandbox()
    box.write('bomb.png', png(30_000, 30_000))
    box.write('wide.gif', gif(60_000, 10))
    box.write('big.png', png(8_000, 8_000))
    expect(await readUnderRoot(box.root, 'bomb.png', IMAGE)).toMatchObject({ ok: false, error: { code: 'too-large', message: expect.stringContaining('pixels') } })
    expect(await readUnderRoot(box.root, 'wide.gif', IMAGE)).toMatchObject({ ok: false, error: { code: 'too-large' } })
    expect(await readUnderRoot(box.root, 'big.png', IMAGE)).toMatchObject({ ok: false, error: { code: 'too-large' } })
  })

  it('reads a traffic file only if it is text, and hands the bytes over', async () => {
    const box = sandbox()
    box.write('traffic.har', '{"log":{"entries":[]}}')
    box.write('binary.har', Buffer.from([0x7b, 0x00, 0x01, 0x02]))
    const ok = await readUnderRoot(box.root, 'traffic.har', TRAFFIC)
    expect(ok.ok && ok.bytes.toString()).toBe('{"log":{"entries":[]}}')
    expect(await readUnderRoot(box.root, 'binary.har', TRAFFIC)).toMatchObject({ ok: false, error: { code: 'invalid-arguments', message: expect.stringContaining('text') } })
  })

  it('refuses a path that is not a usable string', async () => {
    const box = sandbox()
    for (const asked of ['', 'a\0b.png', 'x'.repeat(5_000), 42, null, undefined, {}]) {
      expect(await readUnderRoot(box.root, asked, IMAGE)).toMatchObject({ ok: false, error: { code: 'invalid-arguments', path: 'path' } })
    }
  })

  it('never puts what a file holds, or what the system says about it, into a message', async () => {
    const box = sandbox()
    box.write('notes.har', '{"log": {"entries": [ {"secret": "hunter2"} ')
    const read = await readUnderRoot(box.root, 'notes.har', TRAFFIC)
    expect(JSON.stringify(read)).not.toContain('hunter2')
    const gone = await readUnderRoot(box.root, 'gone.png', IMAGE)
    expect(JSON.stringify(gone)).not.toMatch(/ENOENT|errno|syscall/)
  })
})
