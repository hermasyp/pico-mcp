import { McpServer, fromJsonSchema, type ServerContext } from '@modelcontextprotocol/server'
import { AGENT_INSTRUCTIONS, AGENT_PROMPTS, AGENT_TOOLS, formatGuide, type AgentPromptDef, type AgentToolDef } from '../catalog'
import { formatPairing, pairingLink, type ToolError } from '../protocol'
import type { Config } from './config'
import type { Hub } from './hub'

/*
 * The MCP server an agent talks to, made from the shared catalog: the same tool
 * names, descriptions and schemas that the Pico tab was tested against. Two tools
 * are answered here (the pairing code and the format guide); every other call is
 * handed to the tab through the hub and its answer is given back as text.
 */

export interface ServerDeps {
  hub: Hub
  config: Pick<Config, 'picoUrl'>
  version: string
  /** Told about the server once it exists, so the hub can name the agent in its handshake. */
  onServer?: (server: McpServer) => void
  /** How often the agent is told, while a change waits for the person to approve it. */
  progressMs?: number
}

/** A change that waits for the person can take minutes; an agent that asked for progress notices hears every so often that it is alive. */
const PROGRESS_MS = 10_000
const WAITING = 'Waiting for the person to approve this change in Pico.'

/** Progress notices for one call, started when the tab says the call waits for the person. Nothing is sent to an agent that did not ask for them. */
function progressNotices(context: ServerContext, every: number): { start(): void; stop(): void } {
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

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: true }

const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] })

function failure(error: ToolError): ToolResult {
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

function success(tool: AgentToolDef, answer: unknown): ToolResult {
  const reply = (answer !== null && typeof answer === 'object' ? answer : { data: answer }) as TabAnswer
  const warnings = Array.isArray(reply.warnings) ? reply.warnings.filter((item): item is string => typeof item === 'string') : []
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

function connectTool(hub: Hub, config: Pick<Config, 'picoUrl'>): ToolResult {
  const connected = hub.state === 'connected'
  return text(
    JSON.stringify({
      connected,
      pairingCode: formatPairing(hub.pairing),
      link: pairingLink(config.picoUrl, hub.pairing),
      next: connected
        ? 'Pico is already connected to this session. Use the other pico_ tools.'
        : 'Show the user the pairing code and the link. They paste the code in Pico (Settings, Agent connection, then Connect) or open the link in the browser, which fills the code in for them to confirm with Connect. Then call pico_status to check.',
    }),
  )
}

function promptSchema(prompt: AgentPromptDef): Record<string, unknown> | undefined {
  if (prompt.args.length === 0) return undefined
  return {
    type: 'object',
    properties: Object.fromEntries(prompt.args.map((arg) => [arg.name, { type: 'string', description: arg.description }])),
    required: prompt.args.filter((arg) => arg.required).map((arg) => arg.name),
    additionalProperties: false,
  }
}

export function buildServer({ hub, config, version, onServer, progressMs = PROGRESS_MS }: ServerDeps): McpServer {
  const server = new McpServer({ name: 'pico-mcp', version }, { instructions: AGENT_INSTRUCTIONS, capabilities: { tools: {}, prompts: {} } })

  for (const tool of AGENT_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: fromJsonSchema(tool.inputSchema),
        annotations: { title: tool.title, readOnlyHint: tool.access === 'read', destructiveHint: tool.access === 'destructive', openWorldHint: false },
      },
      async (args: unknown, context: ServerContext): Promise<ToolResult> => {
        if (tool.name === 'pico_connect') return connectTool(hub, config)
        if (tool.name === 'pico_format_guide') return text(formatGuide())
        // Imports and big batches take the tab longer than a read does.
        const slow = tool.name === 'pico_import_document' || tool.name === 'pico_add_endpoints' || tool.name === 'pico_apply_ops'
        const notices = progressNotices(context, progressMs)
        try {
          const answer = await hub.call(tool.name, args ?? {}, slow ? hub.callMs * 2 : hub.callMs, { signal: context.mcpReq.signal, onAwaiting: notices.start })
          return answer.ok ? success(tool, answer.data) : failure(answer.error)
        } finally {
          notices.stop()
        }
      },
    )
  }

  for (const prompt of AGENT_PROMPTS) {
    const schema = promptSchema(prompt)
    const message = (args: Record<string, string | undefined>) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text: prompt.text(args) } }] })
    if (schema) {
      server.registerPrompt(
        prompt.name,
        { title: prompt.title, description: prompt.description, argsSchema: fromJsonSchema(schema) },
        async (args: unknown) => message((args ?? {}) as Record<string, string | undefined>),
      )
    } else {
      server.registerPrompt(prompt.name, { title: prompt.title, description: prompt.description }, async () => message({}))
    }
  }

  onServer?.(server)
  return server
}
