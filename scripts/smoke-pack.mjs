// Installs the packed tarball into an empty project and uses it the way a consumer would: imports the
// library through the `exports` map and runs the `pico-mcp` command.
//
//   npm pack && node scripts/smoke-pack.mjs pico-mcp-1.0.0.tgz
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const tarball = process.argv[2]
if (!tarball) {
  console.error('Usage: node scripts/smoke-pack.mjs <tarball>')
  process.exit(2)
}
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
const dir = mkdtempSync(path.join(tmpdir(), 'pico-mcp-smoke-'))
try {
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'smoke', private: true, type: 'module' }))
  execFileSync('npm', ['install', '--no-audit', '--no-fund', path.resolve(tarball)], { cwd: dir, stdio: 'inherit' })
  const script = `
    const protocol = await import('pico-mcp/protocol')
    const catalog = await import('pico-mcp/catalog')
    const vocabulary = await import('pico-mcp/vocabulary')
    if (protocol.AGENT_PROTOCOL !== 1) throw new Error('protocol')
    if (catalog.AGENT_TOOLS.length < 14) throw new Error('catalog')
    if (!vocabulary.FIELD_TYPES.includes('string')) throw new Error('vocabulary')
    console.log('library ok')
  `
  console.log(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, encoding: 'utf8' }).trim())
  const printed = execFileSync(path.join(dir, 'node_modules', '.bin', 'pico-mcp'), ['--version'], { cwd: dir, encoding: 'utf8' }).trim()
  if (printed !== version) throw new Error(`pico-mcp --version printed ${printed}, expected ${version}`)
  console.log(`command ok (${printed})`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
