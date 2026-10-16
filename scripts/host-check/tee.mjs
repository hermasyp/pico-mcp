// Sits between an agent and the connector, passes everything through and writes each line of it to a log, so that a
// run can say what the agent really sent (who it is, whether it asked for progress notices, whether it cancelled).
//
//   node tee.mjs <log file> <connector.mjs> [connector options...]
//
// Every log line is JSON: { t, dir, text }, where dir is `in` (agent to connector), `out` (connector to agent), `err`
// (the connector's stderr), or a note of its own (start, env, signal, stdin-end, exit).
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'

const [log, connector, ...options] = process.argv.slice(2)
if (!log || !connector) {
  console.error('Usage: node tee.mjs <log file> <connector.mjs> [connector options...]')
  process.exit(2)
}

const note = (dir, text) => appendFileSync(log, `${JSON.stringify({ t: Date.now(), dir, text })}\n`)

/** A function that takes chunks and notes each complete line. */
function lines(dir) {
  let pending = ''
  return (chunk) => {
    pending += chunk.toString()
    let end
    while ((end = pending.indexOf('\n')) >= 0) {
      note(dir, pending.slice(0, end))
      pending = pending.slice(end + 1)
    }
  }
}

const child = spawn(process.execPath, [connector, ...options], { stdio: ['pipe', 'pipe', 'pipe'] })
const fromAgent = lines('in')
const fromConnector = lines('out')
const fromConnectorErrors = lines('err')

note('start', JSON.stringify({ cwd: process.cwd(), options }))
// What the agent passes on of its own environment: the probe is set by the run, the count is the size of the rest.
note('env', JSON.stringify({ probe: process.env.PICO_HOST_CHECK_PROBE ?? null, variables: Object.keys(process.env).length }))

process.stdin.on('data', (chunk) => {
  fromAgent(chunk)
  child.stdin.write(chunk)
})
process.stdin.on('end', () => {
  note('stdin-end', '')
  child.stdin.end()
})
child.stdout.on('data', (chunk) => {
  fromConnector(chunk)
  process.stdout.write(chunk)
})
child.stderr.on('data', (chunk) => {
  fromConnectorErrors(chunk)
  process.stderr.write(chunk)
})
child.on('exit', (code, signal) => {
  note('exit', `${code} ${signal}`)
  process.exit(code ?? 0)
})
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    note('signal', signal)
    child.kill(signal)
  })
}
