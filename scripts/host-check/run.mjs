// Starts the built connector from a real agent program (Codex or OpenCode) and reports what the agent does with it.
//
//   npm run host-check -- codex                       (builds first)
//   npm run host-check -- opencode --ask-wait-s 75
//
// The agent is the real one (from your PATH or --bin), run in an empty temporary directory with settings of its own;
// your own settings are not read. The model behind it is a script (model.mjs) that asks for five calls, pico_connect,
// pico_status, pico_add_endpoints, then pico_attach_image and pico_import_har on files in a folder the connector is
// started with (--root), and the Pico tab is a stand-in (tab.mjs), so no model, account or browser is needed.
// This is not part of `npm test`: it needs the agent installed and says something about that one version.
import { spawn, execFileSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { startModel, findTool } from './model.mjs'
import { startTab } from './tab.mjs'

const here = path.dirname(new URL(import.meta.url).pathname)
const root = path.resolve(here, '../..')

export const USAGE = `Usage: node scripts/host-check/run.mjs <codex|opencode> [options]

  --bin <path>             the agent's command (default: codex or opencode on the PATH)
  --ask-wait-s <n>         the stand-in tab keeps the third call waiting for "the person" this long (default 0)
  --tool-timeout-sec <n>   the agent's own limit for a call: Codex tool_timeout_sec, OpenCode timeout (in seconds)
  --sigint-after-s <n>     interrupt the agent this long after the third call began
  --linger-s <n>           hold the model's last answer this long, to see what the agent does after a time-out
  --timeout-s <n>          give up on the whole run (default: 120 seconds more than --ask-wait-s, at least 240)
  --verbose                print what each call gave back to the agent
  --keep                   keep the temporary directory (settings, logs) and say where it is
  --help                   print this`

const NUMBERS = { '--ask-wait-s': 'askWaitS', '--tool-timeout-sec': 'toolTimeoutSec', '--sigint-after-s': 'sigintAfterS', '--linger-s': 'lingerS', '--timeout-s': 'timeoutS' }

/** The options of a run, from the command line. Throws an Error whose message says what to change. */
export function parseArgs(argv) {
  const options = { host: '', bin: null, askWaitS: 0, toolTimeoutSec: null, sigintAfterS: 0, lingerS: 0, timeoutS: null, keep: false, verbose: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help') options.help = true
    else if (arg === '--keep') options.keep = true
    else if (arg === '--verbose') options.verbose = true
    else if (arg === '--bin') {
      options.bin = argv[(index += 1)]
      if (!options.bin) throw new Error('--bin needs the path of the agent.')
    } else if (arg in NUMBERS) {
      const value = Number(argv[(index += 1)])
      if (!Number.isFinite(value) || value < 0) throw new Error(`${arg} needs a number of seconds.`)
      options[NUMBERS[arg]] = value
    } else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}.`)
    else if (!options.host) options.host = arg
    else throw new Error(`Unexpected ${arg}.`)
  }
  if (!options.help && !['codex', 'opencode'].includes(options.host)) throw new Error('Say which agent to run: codex or opencode.')
  options.timeoutS ??= Math.max(240, options.askWaitS + 120)
  return options
}

/**
 * What crossed the connector's stdio, from the log that tee.mjs wrote (already parsed): who the agent said it was, what it
 * asked for, whether it asked for progress notices, and whether it cancelled a call before it was answered.
 */
export function summarizeLog(entries) {
  const summary = { client: null, protocolVersion: null, toolsListed: false, promptsListed: false, calls: [], progressNotices: 0, cancelled: [], environment: null, ended: null }
  const answered = new Set()
  for (const entry of entries) {
    if (entry.dir === 'env') summary.environment = JSON.parse(entry.text)
    else if (entry.dir === 'signal') summary.ended = `the agent sent it ${entry.text}`
    else if (entry.dir === 'stdin-end') summary.ended ??= 'the agent closed its input'
    else if (entry.dir === 'in' || entry.dir === 'out') {
      let message
      try {
        message = JSON.parse(entry.text)
      } catch {
        continue
      }
      if (entry.dir === 'in') {
        if (message.method === 'initialize') {
          summary.client = message.params?.clientInfo ?? null
          summary.protocolVersion = message.params?.protocolVersion ?? null
        } else if (message.method === 'tools/list') summary.toolsListed = true
        else if (message.method === 'prompts/list') summary.promptsListed = true
        else if (message.method === 'tools/call') summary.calls.push({ id: message.id, name: message.params?.name, progress: message.params?._meta?.progressToken !== undefined })
        else if (message.method === 'notifications/cancelled') summary.cancelled.push({ requestId: message.params?.requestId, afterAnswer: answered.has(message.params?.requestId) })
      } else if (message.method === 'notifications/progress') summary.progressNotices += 1
      else if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) answered.add(message.id)
    }
  }
  return summary
}

function onPath(name) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // not here
    }
  }
  return null
}

const text = (value) => (typeof value === 'string' ? value : JSON.stringify(value))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const FAILED = /tool call error|timed out|MCP error|Error \([\w-]+\)/i

/** The few words of a failed call's output that say why: how Codex and OpenCode word a time-out, how the connector words its errors, or the start of either. */
export function whyFailed(output) {
  const found = [/timed out awaiting[^\\"\n]{0,80}/i, /MCP error[^\\"\n]{0,110}/i, /Error \([\w-]+\)[^\\"\n]{0,110}/i, /tool call error[^\\"\n]{0,110}/i].map((pattern) => output.match(pattern)?.[0]).find(Boolean)
  return found?.trim() ?? ''
}
const PAIRING = /pico:\d+:[^\s"'`\\]+/
/** The calls of the script, in order. The last two read a file and need the connector's --root. */
const CALLS = ['pico_connect', 'pico_status', 'pico_add_endpoints', 'pico_attach_image', 'pico_import_har']

/** A picture the size of one point, as small as a PNG gets, for the run to hand to the connector. */
export const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

/** A recording of three calls to one address, enough to be turned into endpoints. */
export const TINY_HAR = JSON.stringify({
  log: {
    version: '1.2',
    entries: [
      { _resourceType: 'xhr', request: { method: 'GET', url: 'https://api.example.test/v1/users', headers: [{ name: 'Accept', value: 'application/json' }] }, response: { status: 200, content: { mimeType: 'application/json', text: '{"items":[],"total":0}' } } },
      { _resourceType: 'xhr', request: { method: 'GET', url: 'https://api.example.test/v1/users/7', headers: [] }, response: { status: 200, content: { mimeType: 'application/json', text: '{"id":7}' } } },
      { _resourceType: 'xhr', request: { method: 'POST', url: 'https://api.example.test/v1/users', headers: [], postData: { mimeType: 'application/json', text: '{"name":"Ann"}' } }, response: { status: 201, content: { mimeType: 'application/json', text: '{"id":8}' } } },
    ],
  },
})
const PACKAGES = { codex: '@openai/codex', opencode: 'opencode-ai' }

function writeSettings({ host, dir, work, modelUrl, command, toolTimeoutSec }) {
  const env = { HOME: path.join(dir, 'home'), PICO_HOST_CHECK_PROBE: '1', PICO_HOST_CHECK_KEY: 'x' }
  mkdirSync(env.HOME, { recursive: true })
  if (host === 'codex') {
    const home = path.join(dir, 'codex-home')
    mkdirSync(home, { recursive: true })
    const toml = [
      'model = "host-check-model"',
      'model_provider = "host_check"',
      'approval_policy = "never"',
      'sandbox_mode = "read-only"',
      '',
      '[model_providers.host_check]',
      'name = "Host check"',
      `base_url = "${modelUrl}"`,
      'env_key = "PICO_HOST_CHECK_KEY"',
      'wire_api = "responses"',
      'request_max_retries = 0',
      'stream_max_retries = 0',
      '',
      '[mcp_servers.pico]',
      `command = ${JSON.stringify(command[0])}`,
      `args = ${JSON.stringify(command.slice(1))}`,
      ...(toolTimeoutSec === null ? [] : [`tool_timeout_sec = ${toolTimeoutSec}`]),
      '',
    ].join('\n')
    writeFileSync(path.join(home, 'config.toml'), toml)
    return { args: ['exec', '--skip-git-repo-check', '-C', work, 'Connect to Pico and add an endpoint.'], env: { ...env, CODEX_HOME: home } }
  }
  const config = {
    $schema: 'https://opencode.ai/config.json',
    model: 'host_check/host-check-model',
    provider: {
      host_check: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Host check',
        options: { baseURL: modelUrl, apiKey: 'x' },
        models: { 'host-check-model': { name: 'Host check model', tool_call: true } },
      },
    },
    mcp: { pico: { type: 'local', command, enabled: true, ...(toolTimeoutSec === null ? {} : { timeout: toolTimeoutSec * 1000 }) } },
    permission: { '*': 'allow' },
    autoupdate: false,
  }
  writeFileSync(path.join(work, 'opencode.json'), JSON.stringify(config, null, 2))
  const xdg = ['config', 'data', 'cache', 'state'].map((name) => path.join(dir, 'xdg', name))
  for (const folder of xdg) mkdirSync(folder, { recursive: true })
  return {
    args: ['run', '--print-logs', '--log-level', 'INFO', '--dir', work, '-m', 'host_check/host-check-model', 'Connect to Pico and add an endpoint.'],
    // OpenCode takes its directory from PWD, not from the one it was started in.
    env: { ...env, XDG_CONFIG_HOME: xdg[0], XDG_DATA_HOME: xdg[1], XDG_CACHE_HOME: xdg[2], XDG_STATE_HOME: xdg[3], PWD: work },
  }
}

async function main(argv) {
  const options = parseArgs(argv)
  if (options.help) return console.log(USAGE)
  const built = ['dist/pico-mcp.mjs', 'dist/lib/protocol.js', 'dist/lib/catalog.js'].map((file) => path.join(root, file))
  if (!built.every((file) => existsSync(file))) throw new Error('The connector is not built. Run `npm run build` (or start this with `npm run host-check -- <agent>`).')
  const bin = options.bin ?? onPath(options.host)
  if (!bin) throw new Error(`Could not find the \`${options.host}\` command. Put it on your PATH, or install it (for example \`npm install --prefix ~/.cache/pico-mcp-host-check ${PACKAGES[options.host]}\`) and pass its path with --bin.`)
  const protocol = await import(pathToFileURL(built[1]).href)
  const catalog = await import(pathToFileURL(built[2]).href)

  let version = 'unknown'
  try {
    version = execFileSync(bin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 }).trim().split('\n')[0]
  } catch {
    // the version is only for the report
  }

  const dir = mkdtempSync(path.join(tmpdir(), 'pico-mcp-host-check-'))
  const work = path.join(dir, 'work')
  mkdirSync(work, { recursive: true })
  const log = path.join(dir, 'tee.jsonl')
  const files = path.join(dir, 'files')
  mkdirSync(files, { recursive: true })
  writeFileSync(path.join(files, 'login.png'), TINY_PNG)
  writeFileSync(path.join(files, 'shop.har'), TINY_HAR)
  const started = Date.now()
  const say = (line) => console.error(`[${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s] ${line}`)

  const experiment = options.toolTimeoutSec !== null || options.sigintAfterS > 0
  const steps = []
  const problems = []
  let tab = null
  let child = null
  let count = 0
  let sentAt = 0
  let offered = 0
  const model = await startModel({
    flavor: options.host === 'codex' ? 'responses' : 'chat',
    async next({ tools, outputs }) {
      const index = count++
      const last = outputs.length ? text(outputs[outputs.length - 1]) : ''
      const call = CALLS[index - 1]
      if (call) steps.push({ call, ms: Date.now() - sentAt, output: last, failed: FAILED.test(last) })
      let step = { say: 'Done.' }
      if (index === 0) {
        offered = catalog.AGENT_TOOLS.filter((tool) => findTool(tools, tool.name)).length
        step = { tool: 'pico_connect', args: {} }
      } else if (index === 1) {
        const pairing = protocol.parsePairing(last.match(PAIRING)?.[0] ?? '')
        if (!pairing) problems.push(`pico_connect gave no pairing code: ${last.slice(0, 160)}`)
        else {
          try {
            tab = await startTab({ ...pairing, protocol, askWaitMs: options.askWaitS * 1000, expectPicture: TINY_PNG, log: (line) => say(`tab ${line}`) })
            step = { tool: 'pico_status', args: {} }
          } catch (error) {
            problems.push(`the stand-in tab could not connect: ${error.message}`)
          }
        }
      } else if (index === 2) {
        step = { tool: 'pico_add_endpoints', args: { endpoints: [{ name: 'List users', method: 'GET', path: '/users' }] } }
        if (options.sigintAfterS) setTimeout(() => (say('interrupting the agent'), child.kill('SIGINT')), options.sigintAfterS * 1000)
      } else if (index === 3 && !experiment) {
        step = { tool: 'pico_attach_image', args: { endpointId: 'e1', path: 'login.png', alt: 'Sign in screen' } }
      } else if (index === 4 && !experiment) {
        step = { tool: 'pico_import_har', args: { format: 'har', path: 'shop.har', redact: 'secrets' } }
      } else if (options.lingerS) await sleep(options.lingerS * 1000)
      sentAt = Date.now()
      say(step.tool ? `the model asks for ${step.tool}` : 'the model gives its last answer')
      return step
    },
  })

  const command = ['node', path.join(here, 'tee.mjs'), log, built[0], '--root', files]
  const settings = writeSettings({ host: options.host, dir, work, modelUrl: `http://127.0.0.1:${model.port}/v1`, command, toolTimeoutSec: options.toolTimeoutSec })
  say(`starting ${options.host} ${version}`)
  child = spawn(bin, settings.args, { cwd: work, env: { ...process.env, ...settings.env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (output += chunk))
  let timedOut = false
  const killer = setTimeout(() => ((timedOut = true), child.kill('SIGKILL')), options.timeoutS * 1000)
  const status = await new Promise((resolve) => {
    child.on('error', (error) => resolve(`an error (${error.message})`))
    child.on('exit', (code, signal) => resolve(signal ?? code))
  })
  clearTimeout(killer)
  await sleep(300)
  tab?.close()
  model.close()

  const entries = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
  const seen = summarizeLog(entries)
  const calls = seen.calls.length
  const lines = [
    ['Agent', `${options.host} ${version}`],
    ['Connector', seen.client ? `started; the agent calls itself ${seen.client.name} ${seen.client.version}, MCP ${seen.protocolVersion}` : 'was not started by the agent'],
    ['Tools', `${offered} of ${catalog.AGENT_TOOLS.length} were offered to the model`],
    ...steps.map((step, index) => [index === 0 ? 'Calls' : '', `${step.call}: ${step.failed ? 'FAILED' : 'ok'} after ${step.ms} ms${step.failed ? ` (${whyFailed(step.output)})` : ''}`]),
    ['Progress', `the agent asked for notices on ${seen.calls.filter((call) => call.progress).length} of ${calls} calls; the connector sent ${seen.progressNotices}`],
    ['Cancelled', seen.cancelled.length === 0 ? 'the agent sent no notifications/cancelled' : [...new Set(seen.cancelled.map((c) => `request ${c.requestId} ${c.afterAnswer ? 'after it was answered' : 'BEFORE it was answered'}`))].join('; ')],
    ['Prompts', seen.promptsListed ? 'the agent asked for the prompts' : 'the agent did not ask for the prompts'],
    ['Environment', seen.environment ? `a variable set for the agent ${seen.environment.probe ? 'reached' : 'did NOT reach'} the connector (${seen.environment.variables} variables there)` : 'unknown'],
    ['Ended', `${timedOut ? 'killed after the time limit of this run; ' : ''}the agent exited with ${status}; the connector ${seen.ended ? `was ended: ${seen.ended}` : 'was still running when the agent exited'}`],
  ]
  const picture = (tab?.events ?? []).find((event) => event.picture !== undefined)?.picture
  if (!experiment) {
    lines.push(['Picture', picture ? `${picture.bytes} bytes as ${picture.mime} named ${picture.name} reached the tab ${picture.same ? 'the same as the file' : 'DIFFERENT from the file'}; the call carried ${picture.keys.join(', ')}` : 'no picture reached the tab'])
    // The third call of the script is the first pico_add_endpoints; any other is the connector adding what the recording made.
    const imported = Math.max(0, (tab?.events ?? []).filter((event) => event.call === 'pico_add_endpoints').length - 1)
    lines.push(['Recording', imported > 0 ? `the connector asked the tab to add its endpoints ${imported === 1 ? 'once' : `${imported} times`}` : 'the connector did not ask the tab to add any endpoint'])
    if (imported === 0) problems.push('the recording was not turned into a call of pico_add_endpoints')
  }
  const tabEvents = (tab?.events ?? []).filter((event) => event.cancel !== undefined || event.droppedReply !== undefined)
  if (tabEvents.length) lines.push(['Tab', tabEvents.map((event) => (event.cancel !== undefined ? `was told to cancel call ${event.cancel}` : `dropped a reply for call ${event.id}`)).join('; ')])
  if (options.verbose) for (const step of steps) lines.push([step.call, `gave back: ${step.output.replace(/\s+/g, ' ').slice(0, 400)}`])
  const width = Math.max(...lines.map(([label]) => label.length))
  console.log(lines.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join('\n'))

  const needed = steps.slice(0, experiment ? 2 : CALLS.length)
  if (!seen.client) problems.push('the agent did not start the connector')
  if (offered < catalog.AGENT_TOOLS.length) problems.push(`only ${offered} of ${catalog.AGENT_TOOLS.length} tools were offered`)
  if (needed.length < (experiment ? 2 : CALLS.length) || needed.some((step) => step.failed)) problems.push('a call did not come back ok')
  if (!experiment && picture && !picture.same) problems.push('the picture that reached the tab was not the file')
  if (timedOut) problems.push('the run took longer than --timeout-s')
  if (options.keep) console.log(`\nSettings and logs are in ${dir}`)
  else rmSync(dir, { recursive: true, force: true })
  if (problems.length) {
    console.log(`\nFAILED: ${problems.join('; ')}.`)
    if (!options.keep) console.log('Run again with --keep to look at the settings and the log.')
    if (output) console.log(`\nWhat the agent printed (the end of it):\n${output.slice(-1500)}`)
    process.exitCode = 1
  } else console.log(experiment ? '\nDone (with these options the third call may fail on purpose).' : '\nOK.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exitCode = 2
  })
}
