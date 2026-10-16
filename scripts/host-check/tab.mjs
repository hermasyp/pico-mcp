// A stand-in for the Pico tab, in plain JavaScript: it opens the WebSocket, says hello the way the tab does, checks
// the connector's proof, answers the challenge and then answers the calls it is given. `pico_add_endpoints` can be made
// to wait for "the person" (it says awaiting-user, then answers after `askWaitMs`), which is what Ask me first does.
import { createHmac, randomBytes } from 'node:crypto'
import WebSocket from 'ws'

const sign = (token, input) => createHmac('sha256', token).update(input).digest('hex')

/**
 * `protocol` is `{ AGENT_PROTOCOL, proofInput }` from the connector's library (src/protocol.ts, or dist/lib/protocol.js
 * once built). Resolves to { ws, events, challenge, close } when the connector says ready.
 */
export function startTab({ port, token, protocol, askWaitMs = 0, appVersion = '2.3.0', log = () => {} }) {
  return new Promise((resolve, reject) => {
    const events = []
    const note = (event) => {
      events.push({ t: Date.now(), ...event })
      log(JSON.stringify(event))
    }
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Origin: 'http://localhost:5173' } })
    const nonce = randomBytes(16).toString('hex')
    const cancelled = new Set()
    let challenge = null

    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', v: protocol.AGENT_PROTOCOL, app: 'pico', appVersion, nonce })))
    ws.on('error', reject)
    ws.on('close', (code) => note({ closed: code }))
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString())
      if (frame.type === 'challenge') {
        challenge = frame
        ws.send(JSON.stringify({ type: 'auth', proof: sign(token, protocol.proofInput('client', nonce, frame.nonce)) }))
      } else if (frame.type === 'ready') {
        resolve({ ws, events, challenge, close: () => ws.close() })
      } else if (frame.type === 'call') {
        note({ call: frame.tool, id: frame.id })
        const reply = (data) => {
          if (cancelled.has(frame.id)) return note({ droppedReply: frame.tool, id: frame.id })
          ws.send(JSON.stringify({ type: 'result', id: frame.id, ok: true, data }))
          note({ replied: frame.tool, id: frame.id })
        }
        if (frame.tool === 'pico_status') return reply({ data: { version: appVersion, mode: 'ask', editable: true }, summary: 'Status.' })
        if (frame.tool === 'pico_add_endpoints' && askWaitMs > 0) {
          ws.send(JSON.stringify({ type: 'awaiting-user', id: frame.id }))
          note({ awaiting: frame.id })
          setTimeout(() => reply({ data: { added: 1 }, summary: 'Added 1 endpoint.' }), askWaitMs)
          return
        }
        return reply({ data: {}, summary: `Done: ${frame.tool}.` })
      } else if (frame.type === 'cancel') {
        cancelled.add(frame.id)
        note({ cancel: frame.id })
      } else if (frame.type === 'bye') {
        note({ bye: frame.reason })
      }
    })
  })
}
