import path from 'node:path'
import { DEFAULT_PORT } from '../protocol'

/*
 * The connector's settings, from its command line and its environment. It is
 * started by an agent, so there is nobody to ask: everything has a default that
 * works with the hosted Pico and with a local dev server, and a mistake in what
 * was given stops it at once with a message that says what to change.
 */

export class ConfigError extends Error {}

export const DEFAULT_PICO_URL = 'https://pico.hermasyp.space/'

/** Where a Pico tab may connect from: the hosted site and the usual local servers. */
export const DEFAULT_ORIGINS: readonly string[] = [
  'https://pico.hermasyp.space',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
]

export interface Config {
  /** The port to try first (the next few are tried if it is taken); 0 means any free port. */
  port: number
  /** The address of Pico, for the link that pairs it. */
  picoUrl: string
  /** Every Origin a page may connect from. */
  origins: string[]
  /** The folder the connector may read pictures and traffic files from (an absolute path), or null: it then reads no files. */
  root: string | null
  verbose: boolean
}

export const USAGE = `pico-mcp: the connector between an AI agent (over MCP, on stdio) and the Pico tab in your browser.

Options
  --port <n>      Port to listen on, on 127.0.0.1 (default ${DEFAULT_PORT}; the next few are tried if it is taken; 0 = any free port). Env PICO_MCP_PORT.
  --url <address> Address of Pico, used for the pairing link (default ${DEFAULT_PICO_URL}). Env PICO_URL.
  --origin <addr> A page address that may connect, besides the hosted Pico and local dev servers. Repeatable. Env PICO_MCP_ORIGINS (comma-separated).
  --root <folder> An absolute folder the connector may read pictures and traffic files from, and nothing outside it. Without it the connector reads no files. Env PICO_MCP_ROOT.
  --verbose       Log what happens to stderr.
  --version       Print the version.
  --help          This text.
`

function toOrigin(text: string, what: string): string {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new ConfigError(`${what} “${text}” is not an address.`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ConfigError(`${what} “${text}” must start with http:// or https://.`)
  return url.origin
}

function toPort(text: string, what: string): number {
  if (!/^\d{1,5}$/.test(text)) throw new ConfigError(`${what} “${text}” is not a port number.`)
  const port = Number(text)
  if (port !== 0 && (port < 1024 || port > 65535)) throw new ConfigError(`${what} must be 0 (any free port) or between 1024 and 65535.`)
  return port
}

function toRoot(text: string, what: string): string {
  if (!path.isAbsolute(text)) throw new ConfigError(`${what} “${text}” must be an absolute path, such as /Users/you/project.`)
  return text
}

function toUrl(text: string, what: string): string {
  toOrigin(text, what)
  return text
}

export function parseConfig(argv: readonly string[], env: Record<string, string | undefined>): Config {
  let port: number = DEFAULT_PORT
  let picoUrl = DEFAULT_PICO_URL
  let verbose = false
  let root: string | null = null
  const given: string[] = []

  if (env.PICO_MCP_PORT) port = toPort(env.PICO_MCP_PORT, 'PICO_MCP_PORT')
  if (env.PICO_URL) picoUrl = toUrl(env.PICO_URL, 'PICO_URL')
  if (env.PICO_MCP_ROOT) root = toRoot(env.PICO_MCP_ROOT, 'PICO_MCP_ROOT')
  for (const item of (env.PICO_MCP_ORIGINS ?? '').split(',')) {
    if (item.trim()) given.push(toOrigin(item.trim(), 'PICO_MCP_ORIGINS'))
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const equals = arg.indexOf('=')
    const name = arg.startsWith('--') && equals !== -1 ? arg.slice(0, equals) : arg
    const inline = arg.startsWith('--') && equals !== -1 ? arg.slice(equals + 1) : undefined
    const value = (): string => {
      if (inline !== undefined) return inline
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) throw new ConfigError(`${name} needs a value.\n\n${USAGE}`)
      index += 1
      return next
    }
    switch (name) {
      case '--port':
        port = toPort(value(), '--port')
        break
      case '--url':
        picoUrl = toUrl(value(), '--url')
        break
      case '--origin':
        given.push(toOrigin(value(), '--origin'))
        break
      case '--root':
        root = toRoot(value(), '--root')
        break
      case '--verbose':
        verbose = true
        break
      default:
        throw new ConfigError(`I do not know the option ${arg}.\n\n${USAGE}`)
    }
  }

  const origins = [...new Set([...DEFAULT_ORIGINS, toOrigin(picoUrl, 'The Pico address'), ...given])]
  return { port, picoUrl, origins, root, verbose }
}
