import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildLibrary } from '../scripts/build.mjs'

/*
 * What Pico's web app imports is not the TypeScript in src/ but the library this builds: plain ES modules
 * with no dependencies, and declarations beside them. They have to work as files, outside this project.
 */

let dir = ''
let lib = ''

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'pico-mcp-lib-'))
  lib = await buildLibrary({ outdir: path.join(dir, 'lib') })
}, 60_000)

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

const load = (name: string): Promise<Record<string, unknown>> => import(/* @vite-ignore */ pathToFileURL(path.join(lib, `${name}.js`)).href)

describe('the library', () => {
  it('is plain ES modules that Node can import', async () => {
    const protocol = await load('protocol')
    const catalog = await load('catalog')
    const vocabulary = await load('vocabulary')
    expect(protocol.AGENT_PROTOCOL).toBe(1)
    expect(typeof protocol.parseBrowserFrame).toBe('function')
    expect((catalog.AGENT_TOOLS as unknown[]).length).toBe(16)
    expect(vocabulary.HTTP_METHODS).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
  })

  it('has declarations beside each module', () => {
    for (const name of ['protocol', 'catalog', 'vocabulary']) expect(existsSync(path.join(lib, `${name}.d.ts`)), name).toBe(true)
  })
})
