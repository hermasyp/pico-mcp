import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * The package has two halves with different rules. The library (protocol, catalog, vocabulary) is
 * imported by Pico's web app, so it must stay pure: no Node modules, no browser globals, nothing from
 * the connector. The connector is a Node program that may use the library and its own files. These
 * checks read the sources, so a stray import fails here and not in somebody's browser.
 */

const root = path.resolve(__dirname, '..')
const LIBRARY = ['src/protocol.ts', 'src/catalog.ts', 'src/vocabulary.ts']

function files(dir: string): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.join(dir, entry.name))
}

const source = (file: string) => readFileSync(path.join(root, file), 'utf8')

function importsOf(file: string): string[] {
  const text = source(file)
  return [...text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"\n]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1] ?? match[2] ?? match[3])
}

const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

describe('the library that Pico imports', () => {
  it('is the three files the package exports', () => {
    expect(files('src').map((file) => path.basename(file)).sort()).toEqual(['catalog.ts', 'protocol.ts', 'vocabulary.ts'])
  })

  it('needs nothing but its own files', () => {
    for (const file of LIBRARY) {
      for (const specifier of importsOf(file)) {
        expect(['./protocol', './vocabulary'].includes(specifier), `${file} imports ${specifier}`).toBe(true)
      }
    }
  })

  it('uses neither Node nor the browser', () => {
    for (const file of LIBRARY) {
      const code = withoutComments(source(file))
      expect(code, file).not.toMatch(/\b(?:process|Buffer|require|__dirname|__filename)\b/)
      // A property read on the browser's globals (prose such as "the document." has a space after the dot).
      expect(code, file).not.toMatch(/\b(?:window|document|navigator)\.[A-Za-z_]|\b(?:localStorage|sessionStorage|indexedDB)\b/)
    }
  })
})

describe('the connector', () => {
  const sources = files('src/connector')

  it('has sources to look at', () => {
    expect(sources.length).toBeGreaterThanOrEqual(5)
  })

  it('takes from this package only the library, and from outside only its dependencies', () => {
    for (const file of sources) {
      for (const specifier of importsOf(file)) {
        if (!specifier.startsWith('.')) continue
        const ok = specifier.startsWith('./') || specifier === '../protocol' || specifier === '../catalog'
        expect(ok, `${file} imports ${specifier}`).toBe(true)
      }
    }
  })

  it('is not imported by the library', () => {
    for (const file of LIBRARY) {
      for (const specifier of importsOf(file)) expect(specifier.includes('connector'), `${file} imports ${specifier}`).toBe(false)
    }
  })
})
