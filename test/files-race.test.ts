import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIMITS } from '../src/protocol'
import { png } from './helpers/pictures'

/*
 * What can go wrong between looking at a file and having read it: it grows, or a link is put where the file was. They
 * cannot be made to happen on cue with a real disk, so the calls that look at the file are played by hand, here and
 * nowhere else, and the rest is the real thing.
 */

const tweak = vi.hoisted(() => ({
  /** What the open file says its size is, instead of what it is. */
  size: null as number | null,
  /** The path that the second look at the file's real path finds. */
  realpathAfter: null as string | null,
  /** The file number that the second look at the file finds. */
  inoAfter: null as number | null,
  realpathCalls: 0,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    realpath: async (target: string) => {
      tweak.realpathCalls += 1
      const found = await real.realpath(target)
      return tweak.realpathCalls === 2 && tweak.realpathAfter !== null ? tweak.realpathAfter : found
    },
    lstat: async (target: string) => {
      const found = await real.lstat(target)
      return tweak.inoAfter === null ? found : Object.assign(Object.create(Object.getPrototypeOf(found)), found, { ino: tweak.inoAfter })
    },
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args)
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'stat') {
            return async () => {
              const found = await target.stat()
              return tweak.size === null ? found : { isFile: () => found.isFile(), size: tweak.size, ino: found.ino, dev: found.dev }
            }
          }
          const value = Reflect.get(target, property)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
  }
})

const { readUnderRoot } = await import('../src/connector/files')

const made: string[] = []
let root = ''

beforeEach(() => {
  tweak.size = null
  tweak.realpathAfter = null
  tweak.inoAfter = null
  tweak.realpathCalls = 0
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'pico-mcp-race-')))
  made.push(base)
  root = path.join(base, 'root')
  mkdirSync(root)
  mkdirSync(path.join(base, 'outside'))
  writeFileSync(path.join(root, 'shot.png'), Buffer.concat([png(10, 10), Buffer.alloc(100, 7)]))
  writeFileSync(path.join(base, 'outside', 'secret.png'), png(5, 5))
})

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const IMAGE = { kind: 'image', maxBytes: LIMITS.imageBytes } as const

describe('a file that changes while it is read', () => {
  it('is read as it is when nothing changes (the hand-played calls only pass things on)', async () => {
    expect(await readUnderRoot(root, 'shot.png', IMAGE)).toMatchObject({ ok: true, mime: 'image/png' })
  })

  it('is refused when it has grown since its size was looked at', async () => {
    tweak.size = 50
    const read = await readUnderRoot(root, 'shot.png', IMAGE)
    expect(read).toMatchObject({ ok: false, error: { code: 'too-large', message: expect.stringContaining('changed while it was read') } })
  })

  it('is not read past the size that was looked at, so a file that grows cannot be made to fill memory', async () => {
    tweak.size = 3
    const read = await readUnderRoot(root, 'shot.png', IMAGE)
    expect(read.ok).toBe(false)
  })

  it('is refused when the path leads somewhere else by the time it has been read', async () => {
    tweak.realpathAfter = path.join(path.dirname(root), 'outside', 'secret.png')
    expect(await readUnderRoot(root, 'shot.png', IMAGE)).toMatchObject({ ok: false, error: { code: 'not-found' } })
  })

  it('is refused when what stands at the path is no longer the file that was opened', async () => {
    tweak.inoAfter = 1
    expect(await readUnderRoot(root, 'shot.png', IMAGE)).toMatchObject({ ok: false, error: { code: 'not-found' } })
  })
})
