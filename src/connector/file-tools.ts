import { basename } from 'node:path'
import type { ServerContext } from '@modelcontextprotocol/server'
import type { AgentToolDef } from '../catalog'
import { FrameTooLargeError, LIMITS, encodeFrame } from '../protocol'
import { readUnderRoot } from './files'
import { NOT_CONNECTED, type Hub, type HubResult } from './hub'
import { failure, progressNotices, success, text, type ToolResult } from './results'
import { buildEndpoints, parseCurl, parseHar, type RedactMode } from './traffic'

/*
 * The two tools that read a file. The connector reads it (only under --root, see files.ts) and then talks to the tab
 * in tools the tab already has: a recorded session becomes pico_create_project and pico_add_endpoints, and a picture
 * is handed to the tab as bytes, which the model never sees. Nothing is read before it is known that a tab is there
 * to take the result.
 */

export interface FileToolDeps {
  hub: Hub
  root: string | null
  progressMs: number
}

interface ImportArgs {
  format: 'har' | 'curl'
  path?: string
  content?: string
  hosts?: string[]
  redact?: RedactMode
  projectId?: string
  newProject?: string
  onDuplicate?: string
}

/** The id of a project from the tab's answer to pico_create_project. */
function projectIdOf(answer: unknown): string | null {
  const data = (answer as { data?: { projectId?: unknown } } | null)?.data
  return typeof data?.projectId === 'string' ? data.projectId : null
}

const quoted = (name: string): string => `\u201c${name}\u201d`

export async function importTraffic(tool: AgentToolDef, input: unknown, context: ServerContext, deps: FileToolDeps): Promise<ToolResult> {
  const args = (input ?? {}) as ImportArgs
  const { hub } = deps
  if (hub.state !== 'connected') return failure(NOT_CONNECTED)
  if ((args.path === undefined) === (args.content === undefined)) return failure({ code: 'invalid-arguments', message: 'Give exactly one of path and content.' })
  if (args.newProject !== undefined && args.projectId !== undefined) return failure({ code: 'invalid-arguments', message: 'Give projectId or newProject, not both.' })

  let source: string
  if (args.path !== undefined) {
    const read = await readUnderRoot(deps.root, args.path, { kind: 'traffic', maxBytes: LIMITS.trafficBytes })
    if (!read.ok) return failure(read.error)
    source = new TextDecoder('utf-8').decode(read.bytes).replace(/^\uFEFF/, '')
  } else source = args.content as string

  const parsed = args.format === 'har' ? parseHar(source) : parseCurl(source)
  if ('error' in parsed) return failure({ code: 'invalid-arguments', message: parsed.error, path: args.path !== undefined ? 'path' : 'content' })
  const built = buildEndpoints(parsed.entries, { redact: args.redact ?? 'secrets', ...(args.hosts ? { hosts: args.hosts } : {}), shareHeaders: args.newProject !== undefined })
  const redactNote = args.redact === 'none' ? ['You asked for redact: none, so the examples keep the values of the recording, secrets included.'] : args.redact === 'all-examples' ? ['No example values were kept (redact: all-examples): the fields have names and types only.'] : []
  const notes = [...redactNote, ...parsed.notes, ...built.notes].slice(0, 20)
  const counts = { entries: built.stats.entries, used: built.stats.used, skipped: built.stats.skipped, redactions: built.stats.redactions, host: built.host, otherHosts: built.hosts.filter((host) => host !== built.host) }
  if (built.endpoints.length === 0) {
    return success(tool, { data: { imported: 0, ...counts }, summary: 'Nothing to import: no API calls were found in the recording.' }, notes)
  }

  const notices = progressNotices(context, deps.progressMs)
  const call = (name: string, params: unknown): Promise<HubResult> => hub.call(name, params, hub.callMs * 2, { signal: context.mcpReq.signal, onAwaiting: notices.start })
  try {
    let projectId = args.projectId
    if (args.newProject !== undefined) {
      const made = await call('pico_create_project', { name: args.newProject, ...(built.commonHeaders.length > 0 ? { commonHeaders: built.commonHeaders } : {}) })
      if (!made.ok) return failure(made.error)
      projectId = projectIdOf(made.data) ?? undefined
      if (projectId === undefined) return failure({ code: 'internal', message: `Pico made the project ${quoted(args.newProject)} but did not say which one, so nothing was added.` })
    }
    const added = await call('pico_add_endpoints', { ...(projectId ? { projectId } : {}), endpoints: built.endpoints, ...(args.onDuplicate ? { onDuplicate: args.onDuplicate } : {}) })
    if (!added.ok) {
      const error = args.newProject === undefined ? added.error : { ...added.error, message: `The project ${quoted(args.newProject)} was made, but adding the endpoints failed: ${added.error.message}` }
      return failure(error)
    }
    const reply = (added.data !== null && typeof added.data === 'object' ? added.data : {}) as { data?: unknown; summary?: unknown; warnings?: unknown }
    const list = built.endpoints.slice(0, 60).map((endpoint) => `${endpoint.method} ${endpoint.path}`)
    return success(
      tool,
      {
        data: { imported: built.endpoints.length, ...counts, ...(projectId ? { projectId } : {}), endpoints: list, ...(built.endpoints.length > list.length ? { moreEndpoints: built.endpoints.length - list.length } : {}), pico: reply.data ?? null },
        summary: typeof reply.summary === 'string' ? reply.summary : `Imported ${built.endpoints.length} endpoints from ${built.host ?? 'the recording'}.`,
        warnings: reply.warnings,
      },
      notes,
    )
  } finally {
    notices.stop()
  }
}

export async function attachImage(tool: AgentToolDef, input: unknown, context: ServerContext, deps: FileToolDeps): Promise<ToolResult> {
  const args = (input ?? {}) as { projectId?: string; endpointId: string; path: string; alt?: string }
  const { hub } = deps
  if (hub.state !== 'connected') return failure(NOT_CONNECTED)
  const read = await readUnderRoot(deps.root, args.path, { kind: 'image', maxBytes: LIMITS.imageBytes })
  if (!read.ok) return failure(read.error)

  const name = basename(args.path).slice(0, 200)
  const wire = { ...(args.projectId ? { projectId: args.projectId } : {}), endpointId: args.endpointId, ...(args.alt ? { alt: args.alt } : {}), image: { name, mime: read.mime, data: read.bytes.toString('base64') } }
  try {
    encodeFrame({ type: 'call', id: 1, tool: tool.name, args: wire })
  } catch (error) {
    if (error instanceof FrameTooLargeError) return failure({ code: 'too-large', message: 'That picture is too large to send to Pico.', path: 'path', hint: `Use a picture under ${LIMITS.imageBytes / 1_000_000} MB.` })
    return failure({ code: 'internal', message: 'That picture could not be sent.' })
  }

  const notices = progressNotices(context, deps.progressMs)
  try {
    const answer = await hub.call(tool.name, wire, hub.callMs * 2, { signal: context.mcpReq.signal, onAwaiting: notices.start })
    if (!answer.ok) {
      // A Pico from before pictures existed has no such tool. Say what to do rather than "no such tool".
      if (answer.error.code === 'unknown-tool') {
        return failure({ code: 'unknown-tool', message: `The Pico in the connected tab (${hub.peerVersion ?? 'an older version'}) cannot take a picture from an agent.`, hint: 'Ask the person to reload Pico to get the newest version, then try again.' })
      }
      return failure(answer.error)
    }
    const about = `Read ${name} (${read.mime}, ${read.width} by ${read.height} pixels, ${read.bytes.length.toLocaleString('en-US')} bytes) from the folder the connector may read.`
    return success(tool, answer.data, [about])
  } finally {
    notices.stop()
  }
}

export { text }
