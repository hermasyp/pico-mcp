import { LIMITS } from '../protocol'
import type { BODY_TYPES, FIELD_TYPES, HTTP_METHODS } from '../vocabulary'

/*
 * Recorded traffic (a HAR file, or curl commands) turned into endpoints, in the shape pico_add_endpoints takes.
 * Pure: it gets text and gives back data. It never runs a command, never follows a file named in one and never
 * fetches an address. Scans are linear, names taken from the input are only ever keys of a Map, and everything that
 * can be large (entries, bodies, fields, depth) has a ceiling, because the input is whatever somebody recorded.
 *
 * Secrets: by default (`redact: 'secrets'`) a value that is under a name that says secret, or that has the shape of
 * a token, is replaced by <redacted> wherever it would have gone. That is a heuristic: it cannot know a secret that
 * has an innocent name and an ordinary shape. `all-examples` keeps no example values at all.
 */

export type RedactMode = 'secrets' | 'all-examples' | 'none'
type Method = (typeof HTTP_METHODS)[number]
type FieldType = (typeof FIELD_TYPES)[number]
type BodyType = (typeof BODY_TYPES)[number]

export interface FieldInput {
  name: string
  type?: FieldType
  required?: boolean
  nullable?: boolean
  example?: string
  children?: FieldInput[]
}
export interface ResponseInput {
  status: string
  description?: string
  fields?: FieldInput[]
}
export interface EndpointInput {
  name: string
  method: Method
  path: string
  description: string
  headers?: FieldInput[]
  query?: FieldInput[]
  body?: { type: BodyType; fields?: FieldInput[]; raw?: string }
  responses?: ResponseInput[]
}

export interface TrafficEntry {
  method: string
  url: string
  requestHeaders: Array<[string, string]>
  requestBody: { mime: string; text: string } | null
  requestForm: Array<{ name: string; value: string; file?: true }> | null
  status: number | null
  statusText: string
  responseBody: { mime: string; text: string } | null
  resourceType: string | null
}

export interface Parsed {
  entries: TrafficEntry[]
  notes: string[]
}
export interface ParseError {
  error: string
}

const MARK = '<redacted>'
const METHODS: readonly string[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
const MAX_ENDPOINT_FIELDS = 200
const MAX_DEPTH = 6
const MAX_ITEMS = 50
const EXAMPLE_CHARS = 80

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const mimeOf = (type: string): string => type.split(';')[0]?.trim().toLowerCase() ?? ''
const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

const SECRET_WORDS = new Set(['password', 'passwd', 'pwd', 'passcode', 'passphrase', 'secret', 'secrets', 'token', 'tokens', 'apikey', 'authorization', 'auth', 'bearer', 'cookie', 'cookies', 'session', 'sessionid', 'sid', 'jwt', 'credential', 'credentials', 'signature', 'sig', 'otp', 'pin', 'cvv', 'cvc', 'ssn', 'csrf', 'xsrf', 'privatekey', 'accesskey', 'secretkey'])
const KEY_PREFIX = new Set(['api', 'private', 'access', 'secret', 'signing', 'encryption', 'license', 'master', 'client'])

/** Whether a name (a header, a query parameter, a JSON key) says that what it holds is secret. */
export function secretName(name: string): boolean {
  const words = name
    .slice(0, 300)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  return words.some((word, index) => SECRET_WORDS.has(word) || SECRET_WORDS.has(word + (words[index + 1] ?? '')) || (word === 'key' && index > 0 && KEY_PREFIX.has(words[index - 1] as string)))
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TOKEN_SHAPES: readonly RegExp[] = [
  /^eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*$/,
  /^(?:sk|pk|rk)[-_][A-Za-z0-9_-]{12,}$/,
  /^(?:ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abprs]|npm|pypi|AKIA|ASIA|AIza|ya29)[-_.A-Za-z0-9]{8,}$/,
  /^(?:Bearer|Basic|Token|Digest)\s+\S{6,}$/i,
  /^[A-Fa-f0-9]{32,}$/,
  /^(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{32,}={0,2}$/,
]

function luhn(digits: string): boolean {
  let sum = 0
  let double = false
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48
    if (double) digit = digit > 4 ? digit * 2 - 9 : digit * 2
    sum += digit
    double = !double
  }
  return sum % 10 === 0
}

/** Whether a value has the shape of a token, a key or a card number, whatever it is called. */
export function looksLikeSecret(value: string): boolean {
  const text = value.trim().slice(0, 4_096)
  if (text.length < 8 || UUID.test(text)) return false
  if (/^\d{13,19}$/.test(text) && luhn(text)) return true
  return TOKEN_SHAPES.some((shape) => shape.test(text))
}

/** Tokens inside a longer text (a raw body), found by their shape. */
function scrubText(text: string): { text: string; count: number } {
  let count = 0
  const swap = (): string => {
    count += 1
    return MARK
  }
  const cleaned = text
    .replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, swap)
    .replace(/\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{12,}/g, swap)
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abprs]|AKIA|ASIA|AIza|ya29)[-_.A-Za-z0-9]{8,}/g, swap)
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/g, swap)
    .replace(/(\b[a-z][a-z0-9+.-]{1,20}:\/\/)[^\s/:@]{1,100}:[^\s/@]{1,200}@/gi, (_, lead: string) => `${lead}${swap()}@`)
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, swap)
    .replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g, swap)
    .replace(/((?:^|[?&\s{,"'])[\w.-]{0,60}(?:pass(?:word|wd)?|secret|token|api[-_]?key|auth|session|credential)[\w.-]{0,30}["']?\s*[:=]\s*["']?)[^&\s"',}]+/gi, (_, lead: string) => `${lead}${swap()}`)
  return { text: cleaned, count }
}

interface Redactor {
  count: number
  example(name: string, value: string): string | undefined
  raw(text: string): string | undefined
  /** A name taken from the input (a JSON key, a parameter): one that is itself a token, as in a map keyed by tokens, becomes <key>. */
  name(name: string): string
}

function makeRedactor(mode: RedactMode): Redactor {
  const redactor: Redactor = {
    count: 0,
    example(name, value) {
      if (mode === 'all-examples' || value === '') return undefined
      let shown = value
      if (mode === 'secrets') {
        if (secretName(name) || looksLikeSecret(value)) {
          redactor.count += 1
          return MARK
        }
        // A secret inside a longer text (a comment, an address in a value) is found by its shape and taken out of it.
        const scrubbed = scrubText(value.slice(0, 2_000))
        redactor.count += scrubbed.count
        shown = scrubbed.text
      }
      return shown.length > EXAMPLE_CHARS ? `${shown.slice(0, EXAMPLE_CHARS - 3)}...` : shown
    },
    name(name) {
      if (mode === 'none' || !(looksLikeSecret(name) || scrubText(name.slice(0, 300)).count > 0)) return name
      redactor.count += 1
      return '<key>'
    },
    raw(text) {
      if (mode === 'all-examples' || text === '') return undefined
      let out = text.slice(0, 2_000)
      if (mode === 'secrets') {
        const scrubbed = scrubText(out)
        redactor.count += scrubbed.count
        out = scrubbed.text
      }
      return out.length > 200 ? `${out.slice(0, 197)}...` : out
    },
  }
  return redactor
}

// ---------------------------------------------------------------------------
// HAR
// ---------------------------------------------------------------------------

function headerPairs(value: unknown): Array<[string, string]> {
  if (!Array.isArray(value)) return []
  const out: Array<[string, string]> = []
  for (const item of value.slice(0, 500)) {
    if (isObject(item) && typeof item.name === 'string' && typeof item.value === 'string') out.push([item.name.slice(0, 300), item.value.slice(0, 4_000)])
  }
  return out
}

/** A base64 body as text; one that is not valid base64 is no body. No Node-only API, so that this file stays plain. */
function fromBase64(value: string): string {
  try {
    const binary = atob(value.replace(/\s+/g, ''))
    return new TextDecoder('utf-8').decode(Uint8Array.from(binary, (letter) => letter.charCodeAt(0)))
  } catch {
    return ''
  }
}

export function parseHar(text: string): Parsed | ParseError {
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch {
    return { error: 'That is not valid JSON, so it cannot be a HAR file.' }
  }
  const log = isObject(root) && isObject(root.log) ? root.log : null
  if (!log || !Array.isArray(log.entries)) return { error: 'That is not a HAR file: there is no log.entries list in it.' }
  if (log.entries.length > LIMITS.trafficEntries) return { error: `That HAR file has ${log.entries.length.toLocaleString('en-US')} entries; the limit is ${LIMITS.trafficEntries.toLocaleString('en-US')}. Record a shorter session.` }

  const entries: TrafficEntry[] = []
  let broken = 0
  let tooLong = 0
  for (const raw of log.entries) {
    const request = isObject(raw) && isObject(raw.request) ? raw.request : null
    if (!request || typeof request.method !== 'string' || typeof request.url !== 'string') {
      broken += 1
      continue
    }
    const response = isObject((raw as Record<string, unknown>).response) ? ((raw as Record<string, unknown>).response as Record<string, unknown>) : {}
    const post = isObject(request.postData) ? request.postData : null
    const content = isObject(response.content) ? response.content : null

    let requestBody: TrafficEntry['requestBody'] = null
    let requestForm: TrafficEntry['requestForm'] = null
    if (post) {
      const mime = typeof post.mimeType === 'string' ? post.mimeType : ''
      if (typeof post.text === 'string' && post.text !== '') {
        if (post.text.length > LIMITS.trafficBodyChars) tooLong += 1
        else requestBody = { mime, text: post.text }
      }
      if (!requestBody && Array.isArray(post.params)) {
        requestForm = []
        for (const param of post.params.slice(0, 500)) {
          if (!isObject(param) || typeof param.name !== 'string') continue
          const file = typeof param.fileName === 'string'
          requestForm.push({ name: param.name.slice(0, 300), value: file || typeof param.value !== 'string' ? '' : param.value.slice(0, 4_000), ...(file ? { file: true as const } : {}) })
        }
        if (requestForm.length === 0) requestForm = null
      }
    }

    let responseBody: TrafficEntry['responseBody'] = null
    if (content && typeof content.text === 'string' && content.text !== '') {
      const mime = typeof content.mimeType === 'string' ? content.mimeType : ''
      let bodyText = content.text
      if (content.encoding === 'base64') bodyText = /json|xml|text/i.test(mime) && bodyText.length <= LIMITS.trafficBodyChars * 1.4 ? fromBase64(bodyText) : ''
      if (bodyText.length > LIMITS.trafficBodyChars) tooLong += 1
      else if (bodyText !== '') responseBody = { mime, text: bodyText }
    }

    entries.push({
      method: request.method.toUpperCase(),
      url: request.url,
      requestHeaders: headerPairs(request.headers),
      requestBody,
      requestForm,
      status: typeof response.status === 'number' ? response.status : null,
      statusText: typeof response.statusText === 'string' ? response.statusText.slice(0, 100) : '',
      responseBody,
      resourceType: typeof (raw as Record<string, unknown>)._resourceType === 'string' ? ((raw as Record<string, unknown>)._resourceType as string).toLowerCase() : null,
    })
  }
  const notes: string[] = []
  if (broken > 0) notes.push(`Skipped ${plural(broken, 'entry', 'entries')} that ${broken === 1 ? 'was' : 'were'} not a request.`)
  if (tooLong > 0) notes.push(`${plural(tooLong, 'body was', 'bodies were')} too long (over ${LIMITS.trafficBodyChars.toLocaleString('en-US')} characters) and left out.`)
  return { entries, notes }
}

// ---------------------------------------------------------------------------
// curl
// ---------------------------------------------------------------------------

/** Words of a shell command line, with `null` between commands. Nothing is expanded or run: `$HOME` and `$(x)` stay as they were written. */
function tokenize(input: string): Array<string | null> {
  const tokens: Array<string | null> = []
  let word: string | null = null
  let skipNext = false
  const end = (): void => {
    if (word !== null) {
      if (skipNext) skipNext = false
      else tokens.push(word)
      word = null
    }
  }
  const separate = (): void => {
    end()
    if (tokens.length > 0 && tokens[tokens.length - 1] !== null) tokens.push(null)
  }
  const add = (text: string): void => {
    word = (word ?? '') + text
  }
  let index = 0
  while (index < input.length && tokens.length < 100_000) {
    const char = input[index] as string
    if (char === ' ' || char === '\t' || char === '\r') {
      end()
      index += 1
    } else if (char === '\n') {
      separate()
      index += 1
    } else if (char === '\\') {
      const next = input[index + 1]
      if (next === '\n') index += 2
      else if (next === '\r' && input[index + 2] === '\n') index += 3
      else {
        add(next ?? '\\')
        index += 2
      }
    } else if (char === "'") {
      const close = input.indexOf("'", index + 1)
      add(input.slice(index + 1, close === -1 ? input.length : close))
      index = close === -1 ? input.length : close + 1
    } else if (char === '"') {
      let at = index + 1
      let text = ''
      while (at < input.length && input[at] !== '"') {
        if (input[at] === '\\' && '"\\$`\n'.includes(input[at + 1] ?? '\0')) {
          if (input[at + 1] !== '\n') text += input[at + 1]
          at += 2
        } else {
          text += input[at]
          at += 1
        }
      }
      add(text)
      index = at + 1
    } else if (char === '$' && input[index + 1] === "'") {
      let at = index + 2
      let text = ''
      while (at < input.length && input[at] !== "'") {
        if (input[at] !== '\\') {
          text += input[at]
          at += 1
          continue
        }
        const next = input[at + 1] ?? ''
        const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' }
        if (next in simple) {
          text += simple[next]
          at += 2
        } else if (next === 'x' || next === 'u' || next === 'U') {
          const max = next === 'x' ? 2 : next === 'u' ? 4 : 8
          const digits = /^[0-9a-fA-F]*/.exec(input.slice(at + 2, at + 2 + max))?.[0] ?? ''
          const code = digits === '' ? NaN : parseInt(digits, 16)
          text += Number.isNaN(code) || code > 0x10ffff ? `\\${next}${digits}` : String.fromCodePoint(code)
          at += 2 + digits.length
        } else if (/[0-7]/.test(next)) {
          const digits = /^[0-7]{1,3}/.exec(input.slice(at + 1, at + 4))?.[0] ?? ''
          text += String.fromCharCode(parseInt(digits, 8))
          at += 1 + digits.length
        } else {
          text += `\\${next}`
          at += 2
        }
      }
      add(text)
      index = at + 1
    } else if (char === ';' || char === '|' || char === '&') {
      separate()
      while (input[index] === char) index += 1
    } else if ((char === '>' || char === '<') && true) {
      // A redirection: what it names is not an argument. A number just before it (2>) goes too.
      if (word !== null && /^\d+$/.test(word)) word = null
      end()
      skipNext = true
      while (input[index] === '>' || input[index] === '<' || input[index] === '&') index += 1
    } else if (char === '#' && word === null) {
      const newline = input.indexOf('\n', index)
      index = newline === -1 ? input.length : newline
    } else {
      add(char)
      index += 1
    }
  }
  end()
  return tokens
}

const SHORT_WITH_VALUE = new Set(['X', 'H', 'd', 'F', 'u', 'b', 'A', 'e', 'x', 'o', 'm', 'w', 'c', 'K', 'T', 'r', 'y', 'Y', 'z', 'E', 'U', 'C', 'D', 'P', 'Q', 't'])
const LONG_WITH_VALUE = new Set([
  'request', 'header', 'data', 'data-raw', 'data-ascii', 'data-binary', 'data-urlencode', 'form', 'form-string', 'user', 'cookie', 'cookie-jar', 'user-agent', 'referer', 'proxy', 'output', 'max-time', 'connect-timeout', 'retry', 'write-out', 'config', 'upload-file', 'range', 'url', 'json',
  'oauth2-bearer', 'request-target', 'resolve', 'cacert', 'cert', 'key', 'interface', 'limit-rate', 'max-redirs', 'retry-delay', 'retry-max-time', 'proxy-user', 'dump-header', 'connect-to', 'unix-socket', 'aws-sigv4', 'cert-type', 'key-type', 'capath', 'ciphers', 'curves', 'dns-servers', 'doh-url', 'hostpubmd5', 'krb', 'local-port', 'login-options', 'mail-from', 'mail-rcpt', 'netrc-file', 'noproxy', 'pass', 'pinnedpubkey', 'proto', 'proxy-header', 'quote', 'sasl-authzid', 'service-name', 'speed-limit', 'speed-time', 'time-cond', 'tls-max', 'tlsuser', 'trace', 'trace-ascii', 'variable', 'write-out',
])

function addressOf(candidate: string): string | null {
  if (/^https?:\/\//i.test(candidate)) return candidate
  // curl takes a bare host as http://.
  return /^(?:localhost|[\w-]+(?:\.[\w-]+)+)(?::\d+)?(?:[/?#]|$)/i.test(candidate) ? `http://${candidate}` : null
}

const encode = (text: string): string => encodeURIComponent(text)

function curlCommand(words: string[], notes: string[]): TrafficEntry | null {
  let method: string | null = null
  let url: string | null = null
  const positional: string[] = []
  const headers: Array<[string, string]> = []
  const data: string[] = []
  const form: NonNullable<TrafficEntry['requestForm']> = []
  let get = false
  let head = false
  let json = false
  let fileData = false
  let fileForm = false

  const take = (name: string, value: string): void => {
    switch (name) {
      case 'X':
      case 'request':
        method = value.toUpperCase()
        break
      case 'H':
      case 'header': {
        const colon = value.indexOf(':')
        if (colon > 0 && value.slice(colon + 1).trim() !== '') headers.push([value.slice(0, colon).trim().slice(0, 300), value.slice(colon + 1).trim().slice(0, 4_000)])
        break
      }
      case 'd':
      case 'data':
      case 'data-raw':
      case 'data-ascii':
      case 'data-binary':
        if (value.startsWith('@') && name !== 'data-raw') fileData = true
        else data.push(value)
        break
      case 'data-urlencode': {
        const equals = value.indexOf('=')
        if (value.startsWith('@') || (equals === -1 && value.includes('@')) || (equals > 0 && value.slice(equals + 1).startsWith('@'))) fileData = true
        else data.push(equals === -1 ? encode(value) : equals === 0 ? encode(value.slice(1)) : `${value.slice(0, equals)}=${encode(value.slice(equals + 1))}`)
        break
      }
      case 'json':
        json = true
        if (value.startsWith('@')) fileData = true
        else data.push(value)
        break
      case 'F':
      case 'form':
      case 'form-string': {
        const equals = value.indexOf('=')
        if (equals > 0) {
          const field = value.slice(0, equals).slice(0, 300)
          const content = value.slice(equals + 1)
          if (name !== 'form-string' && (content.startsWith('@') || content.startsWith('<'))) {
            fileForm = true
            form.push({ name: field, value: '', file: true })
          } else form.push({ name: field, value: content.replace(/;type=.*$/, '').slice(0, 4_000) })
        }
        break
      }
      case 'u':
      case 'user':
        headers.push(['Authorization', `Basic ${MARK}`])
        break
      case 'oauth2-bearer':
        headers.push(['Authorization', `Bearer ${value}`])
        break
      case 'url':
        url ??= value
        break
      default:
        break
    }
  }

  for (let index = 1; index < words.length; index += 1) {
    const word = words[index] as string
    if (word.startsWith('--') && word.length > 2) {
      const equals = word.indexOf('=')
      const name = equals === -1 ? word.slice(2) : word.slice(2, equals)
      if (name === 'get') get = true
      else if (name === 'head') head = true
      else if (LONG_WITH_VALUE.has(name)) {
        const value = equals === -1 ? (words[(index += 1)] ?? '') : word.slice(equals + 1)
        take(name, value)
      }
    } else if (word.startsWith('-') && word.length > 1) {
      for (let at = 1; at < word.length; at += 1) {
        const flag = word[at] as string
        if (flag === 'G') get = true
        else if (flag === 'I') head = true
        else if (SHORT_WITH_VALUE.has(flag)) {
          const rest = word.slice(at + 1)
          take(flag, rest !== '' ? rest : (words[(index += 1)] ?? ''))
          break
        }
      }
    } else positional.push(word)
  }

  url ??= positional.map(addressOf).find((candidate): candidate is string => candidate !== null) ?? null
  if (url === null) return null
  if (fileData) notes.push('A curl command read its data from a file (@file); the file was not followed, so that body is not in the result.')
  if (fileForm) notes.push('A curl command sent a file in a form; the file was not read, only the field is in the result.')

  let finalUrl = url
  const bodyText = data.join('&')
  if (get && bodyText !== '') finalUrl += `${finalUrl.includes('?') ? '&' : '?'}${bodyText}`
  const hasBody = !get && (data.length > 0 || fileData || form.length > 0)
  const chosen: string = method ?? (head ? 'HEAD' : hasBody ? 'POST' : 'GET')

  let requestBody: TrafficEntry['requestBody'] = null
  if (!get && data.length > 0) {
    const declared = headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1]
    const sniffed = /^\s*[{[]/.test(bodyText) ? 'application/json' : 'application/x-www-form-urlencoded'
    const mime = declared ?? (json ? 'application/json' : sniffed)
    requestBody = { mime: mime, text: bodyText.slice(0, LIMITS.trafficBodyChars) }
  }
  return {
    method: chosen,
    url: finalUrl,
    requestHeaders: headers,
    requestBody,
    requestForm: form.length > 0 ? form : null,
    status: null,
    statusText: '',
    responseBody: null,
    resourceType: null,
  }
}

export function parseCurl(text: string): Parsed | ParseError {
  const tokens = tokenize(text.slice(0, LIMITS.trafficBytes))
  const entries: TrafficEntry[] = []
  const notes: string[] = []
  let ignored = 0
  let withoutAddress = 0
  let words: string[] = []
  const finish = (): void => {
    if (words.length === 0) return
    if (!/(?:^|\/)curl(?:\.exe)?$/i.test(words[0] as string)) ignored += 1
    else {
      const entry = curlCommand(words, notes)
      if (entry) entries.push(entry)
      else withoutAddress += 1
    }
    words = []
  }
  for (const token of tokens) {
    if (token === null) finish()
    else words.push(token)
  }
  finish()
  if (ignored > 0) notes.push(`Ignored ${plural(ignored, 'command that was', 'commands that were')} not curl.`)
  if (withoutAddress > 0) notes.push(`Ignored ${plural(withoutAddress, 'curl command', 'curl commands')} with no web address.`)
  if (entries.length === 0) return { error: 'No curl command with a web address was found in that text.' }
  return { entries, notes: [...new Set(notes)] }
}

// ---------------------------------------------------------------------------
// Which requests are the API
// ---------------------------------------------------------------------------

interface Prepared {
  entry: TrafficEntry
  url: URL
  method: string
}

const STATIC_MIME = /^(?:image|font|audio|video)\/|^text\/css|javascript|ecmascript|^application\/(?:wasm|pdf|zip|octet-stream|x-font)/i
const API_MIME = /json|xml|ndjson|graphql|x-www-form-urlencoded|multipart\/form-data|^text\/plain/i

const STATIC_PATH = /\.(?:js|mjs|css|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|otf|map|html?)$/i

/**
 * `yes`: the request is an API call. `maybe`: it could be (an error page that came back for a call), and counts only
 * where the same method and path already had a clear API call. `no`: a page, a file, a preflight, another method.
 */
function classify(prepared: Prepared): 'yes' | 'maybe' | 'no' {
  const { entry } = prepared
  if (!METHODS.includes(prepared.method)) return 'no'
  const answer = mimeOf(entry.responseBody?.mime ?? '')
  if (STATIC_MIME.test(answer)) return 'no'
  // A curl command has no answer to look at: whoever pasted it meant it as a call.
  if (entry.status === null) return STATIC_PATH.test(prepared.url.pathname) ? 'no' : 'yes'
  if (entry.resourceType !== null) return entry.resourceType === 'xhr' || entry.resourceType === 'fetch' ? 'yes' : 'no'
  if (API_MIME.test(answer)) return 'yes'
  const sent = mimeOf(entry.requestBody?.mime ?? '')
  if (entry.requestBody !== null || entry.requestForm !== null) return API_MIME.test(sent) || sent === '' ? 'yes' : 'maybe'
  return answer === 'text/html' || answer === '' ? 'maybe' : 'no'
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const NUMERIC = /^\d+$/
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/i
const HEX = /^[0-9a-f]{16,}$/i
const OPAQUE = /^[A-Za-z0-9_-]{24,}$/
const MIXED = /^(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{12,}$/

function isValue(segment: string): boolean {
  let text = segment
  try {
    text = decodeURIComponent(segment)
  } catch {
    // keep it as written
  }
  return NUMERIC.test(text) || UUID.test(text) || ULID.test(text) || HEX.test(text) || OPAQUE.test(text) || MIXED.test(text) || looksLikeSecret(text) || scrubText(text.slice(0, 500)).count > 0
}

const words = (segment: string): string[] => segment.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

function singular(word: string): string {
  if (word.length > 3 && word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (/(?:sses|xes|ches|shes|zes)$/.test(word)) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

const camel = (parts: string[]): string => parts.map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1))).join('')

/** `/users/42/orders/7` as `/users/{userId}/orders/{orderId}`, and how many parameters that made. */
function templatePath(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean).slice(0, 40)
  const used = new Map<string, number>()
  let previous: string | null = null
  const out = segments.map((segment) => {
    if (!isValue(segment)) {
      previous = segment
      return segment
    }
    const parts = previous === null ? [] : words(previous)
    const base = parts.length > 0 ? `${camel([...parts.slice(0, -1), singular(parts[parts.length - 1] as string)])}Id` : 'id'
    const seen = (used.get(base) ?? 0) + 1
    used.set(base, seen)
    previous = null
    return `{${seen === 1 ? base : `${base}${seen}`}}`
  })
  return `/${out.join('/')}`
}

const SKIPPED_PREFIX = /^(?:api|rest|v\d+)$/i

function nameOf(method: string, templated: string): string {
  const segments = templated.split('/').filter(Boolean)
  const named = segments.filter((segment) => !SKIPPED_PREFIX.test(segment))
  const last = named[named.length - 1]
  const fallback = `${method} ${templated}`
  if (last === undefined) return fallback
  const phrase = (segment: string, one: boolean): string => {
    const parts = words(segment)
    if (one && parts.length > 0) parts[parts.length - 1] = singular(parts[parts.length - 1] as string)
    return parts.join(' ')
  }
  if (last.startsWith('{')) {
    const noun = named[named.length - 2]
    if (noun === undefined || noun.startsWith('{')) return fallback
    const item = phrase(noun, true)
    if (method === 'GET') return `Get ${item}`
    if (method === 'PUT' || method === 'PATCH') return `Update ${item}`
    if (method === 'DELETE') return `Delete ${item}`
    return fallback
  }
  const collection = /s$/i.test(last) && !/ss$/i.test(last)
  if (method === 'GET') return collection ? `List ${phrase(last, false)}` : `Get ${phrase(last, false)}`
  if (method === 'POST' && collection) return `Create ${phrase(last, true)}`
  return fallback
}

// ---------------------------------------------------------------------------
// Samples into fields
// ---------------------------------------------------------------------------

type Kind = 'string' | 'int' | 'number' | 'boolean' | 'object' | 'array'

class Shape {
  seen = 0
  nulls = 0
  readonly kinds = new Set<Kind>()
  example: string | undefined
  readonly props = new Map<string, Shape>()
  item: Shape | null = null
  emptyList = false
  objects = 0
  cut = false
  wide = false
}

function addValue(shape: Shape, value: unknown, depth: number, rename: (key: string) => string): void {
  shape.seen += 1
  if (value === null || value === undefined) {
    shape.nulls += 1
  } else if (typeof value === 'boolean') {
    shape.kinds.add('boolean')
    shape.example ??= String(value)
  } else if (typeof value === 'number') {
    shape.kinds.add(Number.isInteger(value) ? 'int' : 'number')
    shape.example ??= String(value)
  } else if (typeof value === 'string') {
    shape.kinds.add('string')
    shape.example ??= value
  } else if (Array.isArray(value)) {
    shape.kinds.add('array')
    if (value.length === 0) shape.emptyList = true
    if (depth >= MAX_DEPTH) {
      shape.cut = true
      return
    }
    shape.item ??= new Shape()
    for (const element of value.slice(0, MAX_ITEMS)) addValue(shape.item, element, depth + 1, rename)
  } else if (isObject(value)) {
    shape.kinds.add('object')
    shape.objects += 1
    if (depth >= MAX_DEPTH) {
      shape.cut = true
      return
    }
    const keys = Object.keys(value)
    if (keys.length > MAX_ENDPOINT_FIELDS) shape.wide = true
    for (const key of keys.slice(0, MAX_ENDPOINT_FIELDS)) {
      const name = rename(key)
      let child = shape.props.get(name)
      if (!child) {
        child = new Shape()
        shape.props.set(name, child)
      }
      addValue(child, value[key], depth + 1, rename)
    }
  }
}

interface Context {
  where: string
  redactor: Redactor
  notes: string[]
  fields: { left: number }
}

function scalarType(kinds: Set<Kind>, context: Context, name: string): FieldType {
  const present = [...kinds]
  if (present.length === 0) return 'string'
  if (present.length === 1) return present[0] as 'string' | 'int' | 'number' | 'boolean'
  if (present.length === 2 && kinds.has('int') && kinds.has('number')) return 'number'
  context.notes.push(`${context.where}: field ${name} had ${present.join(' and ')} values; used string.`)
  return 'string'
}

function fieldOf(name: string, shape: Shape, parentObjects: number, context: Context): FieldInput {
  context.fields.left -= 1
  const field: FieldInput = { name }
  const kinds = new Set(shape.kinds)
  if (kinds.has('object') && kinds.has('array')) {
    context.notes.push(`${context.where}: field ${name} was both an object and a list; used string.`)
    kinds.clear()
    kinds.add('string')
  }
  if (kinds.has('object') && kinds.size > 1) {
    context.notes.push(`${context.where}: field ${name} was an object and something else; used string.`)
    kinds.clear()
    kinds.add('string')
  }
  if (kinds.has('object')) {
    field.type = 'object'
    if (shape.cut) context.notes.push(`${context.where}: the sample is nested deeper than ${MAX_DEPTH} levels; the rest was left out.`)
    else field.children = fieldsOf(shape, context)
  } else if (kinds.has('array')) {
    const item = shape.item
    const itemKinds = item ? new Set(item.kinds) : new Set<Kind>()
    if (shape.cut) context.notes.push(`${context.where}: the sample is nested deeper than ${MAX_DEPTH} levels; the rest was left out.`)
    if (itemKinds.has('object') && itemKinds.size === 1 && item) {
      field.type = 'list<object>'
      if (item.cut) context.notes.push(`${context.where}: the sample is nested deeper than ${MAX_DEPTH} levels; the rest was left out.`)
      else field.children = fieldsOf(item, context)
    } else if (itemKinds.size === 1 && !itemKinds.has('array')) {
      field.type = `list<${[...itemKinds][0] as 'string' | 'int' | 'number' | 'boolean'}>`
    } else if (itemKinds.size === 2 && itemKinds.has('int') && itemKinds.has('number')) {
      field.type = 'list<number>'
    } else {
      field.type = 'list<string>'
      context.notes.push(`${context.where}: the items of ${name} ${itemKinds.size === 0 ? 'were never seen (an empty list)' : 'were of mixed kinds'}; used a list of strings.`)
    }
  } else {
    field.type = scalarType(kinds, context, name)
  }
  if (parentObjects >= 2 && shape.seen === parentObjects) field.required = true
  if (shape.nulls > 0) field.nullable = true
  const sample = field.type?.startsWith('list<') ? shape.item?.example : shape.example
  if (sample !== undefined && !field.children) {
    const example = context.redactor.example(name, sample)
    if (example !== undefined) field.example = example
  }
  return field
}

function fieldsOf(shape: Shape, context: Context): FieldInput[] {
  const out: FieldInput[] = []
  if (shape.wide) context.notes.push(`${context.where}: there are more than ${MAX_ENDPOINT_FIELDS} fields at one level; the rest were left out.`)
  for (const [name, child] of shape.props) {
    if (context.fields.left <= 0) {
      context.notes.push(`${context.where}: there are more than ${MAX_ENDPOINT_FIELDS} fields; the rest were left out.`)
      break
    }
    out.push(fieldOf(name, child, shape.objects, context))
  }
  return out
}

/** The fields of the JSON in these bodies, or null if none of them is JSON. `list` is true when the top of the JSON was a list. */
function jsonFields(texts: string[], context: Context): { fields: FieldInput[]; list: boolean } | null {
  const root = new Shape()
  const rename = (key: string): string => context.redactor.name(key)
  let any = false
  let list = false
  for (const text of texts) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      continue
    }
    if (Array.isArray(parsed)) {
      list = true
      for (const element of parsed.slice(0, MAX_ITEMS)) {
        if (isObject(element)) {
          addValue(root, element, 0, rename)
          any = true
        }
      }
    } else if (isObject(parsed)) {
      addValue(root, parsed, 0, rename)
      any = true
    }
  }
  if (!any) return null
  return { fields: fieldsOf(root, context), list }
}

// ---------------------------------------------------------------------------
// Query, form and header fields
// ---------------------------------------------------------------------------

function scalarKind(value: string): 'int' | 'number' | 'boolean' | 'string' {
  if (/^-?\d{1,15}$/.test(value)) return 'int'
  if (/^-?\d{0,15}\.\d{1,15}$/.test(value)) return 'number'
  if (value === 'true' || value === 'false') return 'boolean'
  return 'string'
}

/** Name/value pairs from several samples as flat fields: typed from the values, required when every sample had them (and there were two or more). */
function flatFields(samples: Array<Array<{ name: string; value: string; file?: boolean }>>, context: Context, header = false): FieldInput[] {
  const merged = new Map<string, { name: string; count: number; kinds: Set<string>; example: string | undefined; file: boolean }>()
  for (const sample of samples) {
    const inThisSample = new Set<string>()
    for (const pair of sample) {
      const shown = context.redactor.name(pair.name)
      const key = header ? shown.toLowerCase() : shown
      let slot = merged.get(key)
      if (!slot) {
        slot = { name: shown, count: 0, kinds: new Set(), example: undefined, file: false }
        merged.set(key, slot)
      }
      if (!inThisSample.has(key)) slot.count += 1
      inThisSample.add(key)
      if (pair.file) slot.file = true
      else {
        slot.kinds.add(scalarKind(pair.value))
        slot.example ??= pair.value
      }
    }
  }
  const out: FieldInput[] = []
  for (const slot of [...merged.values()].slice(0, MAX_ENDPOINT_FIELDS)) {
    const field: FieldInput = { name: slot.name, type: 'string' }
    if (slot.file) field.type = 'file'
    else if (slot.kinds.size === 1 && !slot.kinds.has('string')) field.type = [...slot.kinds][0] as 'int' | 'number' | 'boolean'
    else if (slot.kinds.size === 2 && slot.kinds.has('int') && slot.kinds.has('number')) field.type = 'number'
    if (samples.length >= 2 && slot.count === samples.length) field.required = true
    const example = slot.example === undefined ? undefined : context.redactor.example(slot.name, slot.example)
    if (example !== undefined) field.example = example
    out.push(field)
  }
  return out
}

const DROPPED_HEADERS = /^(?:host|connection|content-length|content-type|content-encoding|accept|accept-encoding|accept-language|user-agent|origin|referer|cookie|set-cookie|cache-control|pragma|upgrade-insecure-requests|dnt|te|expect|via|forwarded|if-none-match|if-modified-since|if-match|if-unmodified-since|range|date|priority|purpose|traceparent|tracestate|baggage|x-requested-with|x-forwarded-.*|sec-.*|:.*|(?:x-)?(?:request|correlation|trace|span)-?id)$/i

// ---------------------------------------------------------------------------
// Putting it together
// ---------------------------------------------------------------------------

export interface BuildOptions {
  redact: RedactMode
  /** Hosts to take (a host, or a host with its port). Default: the one with most calls. */
  hosts?: string[]
  /** Move the headers every endpoint has into `commonHeaders`. */
  shareHeaders: boolean
}

export interface BuildResult {
  /** The host the endpoints come from, or null. */
  host: string | null
  /** Every host that had API calls, busiest first. */
  hosts: string[]
  endpoints: EndpointInput[]
  commonHeaders: FieldInput[]
  notes: string[]
  stats: { entries: number; used: number; skipped: number; endpoints: number; redactions: number }
}

interface Group {
  method: string
  path: string
  samples: Prepared[]
  order: number
}

const STATUS_TEXT: Record<number, string> = { 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 422: 'Unprocessable Entity', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable' }

export function buildEndpoints(entries: TrafficEntry[], options: BuildOptions): BuildResult {
  const redactor = makeRedactor(options.redact)
  const notes: string[] = []
  const prepared: Prepared[] = []
  for (const entry of entries) {
    let url: URL
    try {
      url = new URL(entry.url)
    } catch {
      continue
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
    prepared.push({ entry, url, method: entry.method.toUpperCase() })
  }
  const calls = prepared.filter((item) => classify(item) === 'yes')
  const maybes = prepared.filter((item) => classify(item) === 'maybe')

  const counts = new Map<string, number>()
  for (const call of calls) counts.set(call.url.host.toLowerCase(), (counts.get(call.url.host.toLowerCase()) ?? 0) + 1)
  const hosts = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([host]) => host)

  let chosen: string[]
  if (options.hosts && options.hosts.length > 0) {
    const wanted = options.hosts.map((host) => host.toLowerCase())
    chosen = hosts.filter((host) => wanted.includes(host) || wanted.includes(host.replace(/:\d+$/, '')))
    if (chosen.length === 0) notes.push(`None of the hosts you named (${wanted.join(', ')}) has API calls in the recording. It has: ${hosts.join(', ') || 'none'}.`)
  } else chosen = hosts.slice(0, 1)
  const others = hosts.filter((host) => !chosen.includes(host))
  if (others.length > 0 && chosen.length > 0) notes.push(`Other hosts in the recording were left out: ${others.map((host) => `${host} (${plural(counts.get(host) ?? 0, 'call', 'calls')})`).join(', ')}. Name them in hosts to include them.`)

  const groups = new Map<string, Group>()
  for (const call of calls) {
    if (!chosen.includes(call.url.host.toLowerCase())) continue
    const path = templatePath(call.url.pathname)
    const key = `${call.method} ${path}`
    let group = groups.get(key)
    if (!group) {
      group = { method: call.method, path, samples: [], order: groups.size }
      groups.set(key, group)
    }
    group.samples.push(call)
  }
  for (const maybe of maybes) {
    if (!chosen.includes(maybe.url.host.toLowerCase())) continue
    groups.get(`${maybe.method} ${templatePath(maybe.url.pathname)}`)?.samples.push(maybe)
  }
  let kept = [...groups.values()]
  if (kept.length > LIMITS.endpointsPerCall) {
    notes.push(`${plural(kept.length - LIMITS.endpointsPerCall, 'endpoint', 'endpoints')} did not fit in one call (the limit is ${LIMITS.endpointsPerCall}) and ${kept.length - LIMITS.endpointsPerCall === 1 ? 'was' : 'were'} left out, the least often called first.`)
    kept = kept.sort((a, b) => b.samples.length - a.samples.length || a.order - b.order).slice(0, LIMITS.endpointsPerCall).sort((a, b) => a.order - b.order)
  }

  const graphql = new Set<string>()
  const endpoints: EndpointInput[] = kept.map((group) => {
    const where = `${group.method} ${group.path}`
    const context: Context = { where, redactor, notes, fields: { left: LIMITS.fieldsPerCall / 4 } }
    const samples = group.samples
    if (/graphql/i.test(group.path)) graphql.add(where)
    const endpoint: EndpointInput = {
      name: nameOf(group.method, group.path),
      method: group.method as Method,
      path: group.path,
      description: `Inferred from recorded traffic (${plural(samples.length, 'sample', 'samples')}): confirm.`,
    }

    // headers and query
    const headers = flatFields(
      samples.map((sample) => sample.entry.requestHeaders.filter(([name]) => !DROPPED_HEADERS.test(name)).map(([name, value]) => ({ name, value }))),
      context,
      true,
    )
    if (headers.length > 0) endpoint.headers = headers
    const query = flatFields(samples.map((sample) => [...sample.url.searchParams].map(([name, value]) => ({ name, value }))), context)
    if (query.length > 0) endpoint.query = query

    // the request body
    const bodies = samples.filter((sample) => sample.entry.requestBody || sample.entry.requestForm)
    if (bodies.length > 0) {
      const first = bodies[0]?.entry as TrafficEntry
      const sent = mimeOf(first.requestBody?.mime ?? (first.requestForm ? 'multipart/form-data' : ''))
      if (sent.includes('json') || (sent === '' && /^\s*[{[]/.test(first.requestBody?.text ?? ''))) {
        const found = jsonFields(bodies.map((sample) => sample.entry.requestBody?.text ?? ''), context)
        endpoint.body = { type: 'json', ...(found ? { fields: found.fields } : {}) }
        if (found?.list) endpoint.description += ' The body is a list; the fields are those of its items.'
      } else if (sent.includes('x-www-form-urlencoded')) {
        const forms = bodies.map((sample) => [...new URLSearchParams(sample.entry.requestBody?.text ?? '')].map(([name, value]) => ({ name, value })))
        endpoint.body = { type: 'urlencoded', fields: flatFields(forms, context) }
      } else if (sent.includes('multipart') || first.requestForm) {
        const forms = bodies.map((sample) => sample.entry.requestForm ?? [])
        endpoint.body = { type: 'form-data', fields: flatFields(forms, context) }
      } else {
        const raw = redactor.raw(first.requestBody?.text ?? '')
        endpoint.body = { type: 'raw', ...(raw !== undefined ? { raw } : {}) }
      }
    }

    // the responses, by status
    const byStatus = new Map<number, Prepared[]>()
    for (const sample of samples) {
      const status = sample.entry.status
      if (status === null || status < 100 || status > 599) continue
      byStatus.set(status, [...(byStatus.get(status) ?? []), sample])
    }
    if (byStatus.size > 0) {
      endpoint.responses = [...byStatus.entries()]
        .sort((a, b) => a[0] - b[0])
        .slice(0, LIMITS.responsesPerEndpoint)
        .map(([status, list]) => {
          const said = list.find((sample) => sample.entry.statusText)?.entry.statusText ?? ''
          const text = (said ? redactor.raw(said) : undefined) || STATUS_TEXT[status] || ''
          const response: ResponseInput = { status: String(status) }
          const bodiesOf = list.filter((sample) => sample.entry.responseBody && /json/i.test(sample.entry.responseBody.mime || 'json')).map((sample) => sample.entry.responseBody?.text ?? '')
          const found = bodiesOf.length > 0 ? jsonFields(bodiesOf, { ...context, where: `${where} (${status})` }) : null
          if (found) response.fields = found.fields
          const description = found?.list ? `${text ? `${text}. ` : ''}The response is a list; each item has these fields.` : text
          if (description) response.description = description
          return response
        })
    }
    return endpoint
  })

  for (const where of graphql) notes.push(`${where} looks like GraphQL: every operation goes through this one endpoint, so its fields are a mix. Review it.`)

  // headers that every endpoint has can live in the project's common headers instead
  const commonHeaders: FieldInput[] = []
  if (options.shareHeaders && endpoints.length >= 2) {
    const first = endpoints[0]?.headers ?? []
    for (const header of first) {
      const name = header.name.toLowerCase()
      if (endpoints.every((endpoint) => endpoint.headers?.some((other) => other.name.toLowerCase() === name))) commonHeaders.push(header)
    }
    if (commonHeaders.length > 0) {
      const shared = new Set(commonHeaders.map((header) => header.name.toLowerCase()))
      for (const endpoint of endpoints) {
        const rest = (endpoint.headers ?? []).filter((header) => !shared.has(header.name.toLowerCase()))
        if (rest.length > 0) endpoint.headers = rest
        else delete endpoint.headers
      }
    }
  }

  const used = kept.reduce((total, group) => total + group.samples.length, 0)
  return {
    host: chosen[0] ?? null,
    hosts,
    endpoints,
    commonHeaders,
    notes: [...new Set(notes)].slice(0, 60),
    stats: { entries: entries.length, used, skipped: entries.length - used, endpoints: endpoints.length, redactions: redactor.count },
  }
}
