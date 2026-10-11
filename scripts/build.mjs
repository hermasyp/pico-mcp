// Builds the package.
//
//   npm run build
//
// dist/pico-mcp.mjs       The connector in one file an agent can run: node dist/pico-mcp.mjs. Everything it
//                         needs (the MCP SDK, ws, the protocol and the catalog) is inside, so it can be copied
//                         anywhere there is Node 20 or newer. The two optional native add-ons of `ws` are left
//                         out on purpose: `ws` works without them.
// dist/THIRD_PARTY_LICENSES.txt
//                         The licences of the packages bundled into that file.
// dist/lib/*.js, *.d.ts   The library that Pico's web app imports: protocol, catalog and vocabulary, as plain
//                         ES modules with no dependencies.
import { execFile } from 'node:child_process'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'

const run = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const DEFAULT_OUTFILE = path.join(root, 'dist', 'pico-mcp.mjs')

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'))

/** The licence text of every package that ended up inside the bundle, found from esbuild's list of inputs. */
async function thirdPartyLicenses(metafile) {
  const seen = new Map()
  for (const input of Object.keys(metafile.inputs)) {
    const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input)
    if (!match || seen.has(match[1])) continue
    const dir = path.join(root, input.slice(0, input.indexOf(match[0]) + match[0].length))
    seen.set(match[1], dir)
  }
  const blocks = []
  for (const [name, dir] of [...seen].sort(([a], [b]) => a.localeCompare(b))) {
    const manifest = await readJson(path.join(dir, 'package.json'))
    let text = ''
    for (const candidate of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'License']) {
      try {
        text = (await readFile(path.join(dir, candidate), 'utf8')).trim()
        break
      } catch {
        // try the next name
      }
    }
    const licence = typeof manifest.license === 'string' ? manifest.license : JSON.stringify(manifest.license ?? 'unknown')
    blocks.push(`${name}@${manifest.version} (${licence})\n${'-'.repeat(60)}\n${text || '(this package ships no licence file; see its repository)'}\n`)
  }
  return `Pico MCP bundles the following packages in dist/pico-mcp.mjs.\n\n${blocks.join('\n')}`
}

export async function buildConnector({ outfile = DEFAULT_OUTFILE, minify = false } = {}) {
  const pkg = await readJson(path.join(root, 'package.json'))
  await mkdir(path.dirname(outfile), { recursive: true })
  const result = await build({
    entryPoints: [path.join(root, 'src', 'connector', 'server.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    minify,
    legalComments: 'none',
    logLevel: 'warning',
    metafile: true,
    external: ['bufferutil', 'utf-8-validate'],
    define: { __PICO_MCP_VERSION__: JSON.stringify(pkg.version) },
    // Some bundled packages are CommonJS and call require() for Node's own modules.
    banner: { js: "#!/usr/bin/env node\nimport { createRequire as __picoCreateRequire } from 'node:module'\nconst require = __picoCreateRequire(import.meta.url)" },
  })
  await chmod(outfile, 0o755)
  await writeFile(path.join(path.dirname(outfile), 'THIRD_PARTY_LICENSES.txt'), await thirdPartyLicenses(result.metafile))
  return outfile
}

export async function buildLibrary({ outdir = path.join(root, 'dist', 'lib') } = {}) {
  await rm(outdir, { recursive: true, force: true })
  await build({
    entryPoints: ['protocol', 'catalog', 'vocabulary'].map((name) => path.join(root, 'src', `${name}.ts`)),
    outdir,
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'warning',
  })
  // The declarations, so that TypeScript users of the library see the same types.
  await run(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(root, 'tsconfig.build.json'), '--outDir', outdir], { cwd: root })
  return outdir
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const outfile = await buildConnector()
  const outdir = await buildLibrary()
  console.log(`Built ${path.relative(root, outfile)} and ${path.relative(root, outdir)}/`)
}
