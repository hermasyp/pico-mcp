import type { ServerContext } from '@modelcontextprotocol/server'
import type { AgentToolDef } from '../catalog'
import type { ToolError } from '../protocol'

/*
 * What a tool gives back to the agent, and the progress notices that tell an agent a change is waiting for the
 * person. Shared by the server (which forwards most tools to the tab) and the tools that read a file first.
 */

/** A change that waits for the person can take minutes; an agent that asked for progress notices hears every so often that it is alive. */
export const PROGRESS_MS = 10_000
const WAITING = 'Waiting for the person to approve this change in Pico.'

/** Progress notices for one call, started when the tab says the call waits for the person. Nothing is sent to an agent that did not ask for them. */
export function progressNotices(context: ServerContext, every: number): { start(): void; stop(): void } {
  const token = context.mcpReq._meta?.progressToken
  let timer: ReturnType<typeof setInterval> | null = null
  let count = 0
  const send = (progressToken: string | number): void => {
    count += 1
    context.mcpReq.notify({ method: 'notifications/progress', params: { progressToken, progress: count, message: WAITING } }).catch(() => {})
  }
  return {
    start() {
      if (token === undefined || timer !== null) return
      send(token)
      timer = setInterval(() => send(token), every)
      timer.unref()
    },
    stop() {
      if (timer !== null) clearInterval(timer)
      timer = null
    },
  }
}

export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: true }

export const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] })

export function failure(error: ToolError): ToolResult {
  const lines = [`Error (${error.code}): ${error.message}`]
  if (error.hint) lines.push(`Hint: ${error.hint}`)
  return { content: [{ type: 'text', text: lines.join('\n') }], isError: true }
}

/** What the tab sends back for a tool: its data, and notes and a summary where there are any. */
interface TabAnswer {
  data?: unknown
  warnings?: unknown
  summary?: unknown
}

/** The tab's answer as the agent sees it. `notes` are the connector's own, put in front of the tab's warnings. */
export function success(tool: AgentToolDef, answer: unknown, notes: readonly string[] = []): ToolResult {
  const reply = (answer !== null && typeof answer === 'object' ? answer : { data: answer }) as TabAnswer
  const warnings = [...notes, ...(Array.isArray(reply.warnings) ? reply.warnings.filter((item): item is string => typeof item === 'string') : [])]
  const summary = typeof reply.summary === 'string' ? reply.summary : undefined
  const extra = { ...(summary ? { summary } : {}), ...(warnings.length > 0 ? { warnings } : {}) }

  // An export is a file: give its text as it is, not squeezed into a JSON string.
  const data = reply.data as Record<string, unknown> | undefined
  if (tool.name === 'pico_export' && data && typeof data.text === 'string') {
    const { text: file, ...about } = data
    return { content: [{ type: 'text', text: JSON.stringify({ result: about, ...extra }) }, { type: 'text', text: file }] }
  }
  return text(JSON.stringify({ result: reply.data ?? null, ...extra }))
}
