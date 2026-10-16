import type { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { makeToken } from './auth'
import { buildServer } from './build-server'
import { ConfigError, USAGE, parseConfig } from './config'
import { resolveRoot } from './files'
import { Hub } from './hub'

/*
 * The connector. An AI agent starts it and talks MCP to it over stdio; it
 * listens on 127.0.0.1 for the Pico tab. stdout belongs to MCP, so everything
 * meant for a person goes to stderr.
 */

declare const __PICO_MCP_VERSION__: string | undefined
const VERSION = typeof __PICO_MCP_VERSION__ === 'string' ? __PICO_MCP_VERSION__ : '0.0.0-dev'

const say = (message: string): void => void process.stderr.write(`pico-mcp: ${message}\n`)

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE)
    return
  }
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`${VERSION}\n`)
    return
  }

  let config: ReturnType<typeof parseConfig>
  try {
    config = parseConfig(args, process.env)
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    say(error.message)
    process.exit(2)
  }

  // Before anything listens: a folder that is wrong should stop the start, not surface at the first picture.
  let root: string | null = null
  if (config.root !== null) {
    try {
      root = await resolveRoot(config.root)
    } catch (error) {
      say(error instanceof Error ? error.message : String(error))
      process.exit(2)
    }
  }

  const holder: { server: McpServer | null } = { server: null }
  const hub = new Hub({
    port: config.port,
    origins: config.origins,
    token: makeToken(),
    serverVersion: VERSION,
    getClient: () => {
      const client = holder.server?.server.getClientVersion()
      return client ? { name: client.name, version: client.version } : null
    },
    ...(config.verbose ? { log: say } : {}),
  })
  await hub.listen()
  say(`ready on 127.0.0.1:${hub.port}. Ask your agent to call pico_connect.`)
  say(root === null ? 'files: off. Start with --root <folder> to let the agent hand over pictures and recorded traffic from one folder.' : `files: the agent may hand over pictures and recorded traffic from ${root} and nothing else.`)

  const handle = serveStdio(() => buildServer({ hub, config, root, version: VERSION, onServer: (server) => void (holder.server = server) }))

  let stopping = false
  const stop = (): void => {
    if (stopping) return
    stopping = true
    void Promise.allSettled([hub.close(), handle.close()]).then(() => process.exit(0))
  }
  process.stdin.once('end', stop)
  process.stdin.once('close', stop)
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

main().catch((error: unknown) => {
  say(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
