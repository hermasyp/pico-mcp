// A scripted stand-in for the model behind an agent. It speaks the OpenAI Responses API (what Codex sends) or the
// Chat Completions API (what OpenCode sends), on loopback only. A request that carries the connector's tools gets the
// next step of a script (call this tool, or say this); any other request (a title, a summary) gets a short text.
import { createServer } from 'node:http'

const MODEL = 'host-check-model'
const USAGE_RESPONSES = { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 }
const USAGE_CHAT = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }

/** The tools of a request as { name, namespace? }. Codex groups the tools of an MCP server in a namespace; OpenCode lists them flat. */
export function toolsOf(request) {
  const found = []
  for (const tool of request?.tools ?? []) {
    if (tool.type === 'namespace') for (const inner of tool.tools ?? []) found.push({ name: inner.name, namespace: tool.name })
    else found.push({ name: tool.name ?? tool.function?.name })
  }
  return found.filter((tool) => typeof tool.name === 'string')
}

/** The tool a script step means. An agent may put the name of the server in front of the tool's own (pico_pico_connect). */
export function findTool(tools, wanted) {
  return tools.find((tool) => tool.name === wanted || tool.name.endsWith(`_${wanted}`))
}

/** What the tools answered so far, oldest first, as the agent handed it back to the model. */
function outputsOf(flavor, request) {
  if (flavor === 'responses') return (request.input ?? []).filter((item) => item.type === 'function_call_output').map((item) => item.output)
  return (request.messages ?? []).filter((message) => message.role === 'tool').map((message) => message.content)
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

function respondResponses(res, step, number) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  const id = `resp_${number}`
  const item = step.tool
    ? { type: 'function_call', id: `fc_${number}`, call_id: `call_${number}`, name: step.tool.name, ...(step.tool.namespace ? { namespace: step.tool.namespace } : {}), arguments: JSON.stringify(step.args ?? {}) }
    : { type: 'message', id: `msg_${number}`, role: 'assistant', content: [{ type: 'output_text', text: step.say }] }
  send('response.created', { response: { id } })
  send('response.output_item.added', { output_index: 0, item })
  send('response.output_item.done', { output_index: 0, item })
  send('response.completed', { response: { id, usage: USAGE_RESPONSES } })
  res.end()
}

function respondChat(res, step, request, number) {
  const base = { id: `chatcmpl_${number}`, object: 'chat.completion.chunk', created: 0, model: MODEL }
  if (request?.stream === false) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: step.say ?? 'ok' }, finish_reason: 'stop' }], usage: USAGE_CHAT }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`)
  if (step.tool) {
    const call = { index: 0, id: `call_${number}`, type: 'function', function: { name: step.tool.name, arguments: JSON.stringify(step.args ?? {}) } }
    send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [call] }, finish_reason: null }] })
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: USAGE_CHAT })
  } else {
    send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: step.say }, finish_reason: null }] })
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: USAGE_CHAT })
  }
  res.write('data: [DONE]\n\n')
  res.end()
}

/**
 * Starts the model. `flavor` is 'responses' or 'chat'. `next({ tools, outputs })` is asked once for every request that
 * carries the connector's tools and answers { tool: 'pico_status', args } or { say: 'text' }; it may be async, and the
 * model waits for it. Resolves to { port, requests, close }.
 */
export function startModel({ flavor, next }) {
  const requests = []
  const server = createServer(async (req, res) => {
    try {
      await answer(req, res)
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end(String(error))
    }
  })
  const answer = async (req, res) => {
    const body = await readBody(req)
    let request = null
    try {
      request = JSON.parse(body)
    } catch {
      // not JSON: a probe of some kind
    }
    requests.push({ method: req.method, url: req.url ?? '' })
    if (req.method !== 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model' }] }))
      return
    }
    const tools = toolsOf(request)
    let step = { say: 'ok' }
    if (findTool(tools, 'pico_connect')) {
      step = await next({ tools, outputs: outputsOf(flavor, request) })
      if (step.tool) {
        const tool = findTool(tools, step.tool)
        step = tool ? { ...step, tool } : { say: `The model has no tool ${step.tool}; it has ${tools.map((t) => t.name).join(', ')}.` }
      }
    }
    if (flavor === 'responses') respondResponses(res, step, requests.length)
    else respondChat(res, step, request, requests.length)
  }
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, requests, close: () => server.close() })))
}
