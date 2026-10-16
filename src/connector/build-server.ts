import { McpServer, fromJsonSchema, type ServerContext } from '@modelcontextprotocol/server'
import { AGENT_INSTRUCTIONS, AGENT_PROMPTS, AGENT_TOOLS, formatGuide, type AgentPromptDef } from '../catalog'
import { formatPairing, pairingLink } from '../protocol'
import type { Config } from './config'
import { attachImage, importTraffic } from './file-tools'
import type { Hub } from './hub'
import { PROGRESS_MS, failure, progressNotices, success, text, type ToolResult } from './results'

/*
 * The MCP server an agent talks to, made from the shared catalog: the same tool
 * names, descriptions and schemas that the Pico tab was tested against. Two tools
 * are answered here (the pairing code and the format guide); every other call is
 * handed to the tab through the hub and its answer is given back as text.
 */

export interface ServerDeps {
  hub: Hub
  config: Pick<Config, 'picoUrl'>
  /** The real path of the folder the connector may read pictures and traffic files from, or null: it then reads none. */
  root?: string | null
  version: string
  /** Told about the server once it exists, so the hub can name the agent in its handshake. */
  onServer?: (server: McpServer) => void
  /** How often the agent is told, while a change waits for the person to approve it. */
  progressMs?: number
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

export function buildServer({ hub, config, root = null, version, onServer, progressMs = PROGRESS_MS }: ServerDeps): McpServer {
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
        if (tool.name === 'pico_import_har') return importTraffic(tool, args, context, { hub, root, progressMs })
        if (tool.name === 'pico_attach_image') return attachImage(tool, args, context, { hub, root, progressMs })
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
