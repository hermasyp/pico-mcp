import { describe, expect, it } from 'vitest'
import { buildEndpoints, looksLikeSecret, parseCurl, parseHar, secretName } from '../src/connector/traffic'
import { LIMITS } from '../src/protocol'

/*
 * What matters most about reading somebody's recorded traffic: a secret in it must not end up in a contract. These
 * tests plant secrets in every place a request or a response has (headers, cookies, query, path, address, JSON, forms,
 * raw text) and look for them in everything that comes out. They also feed it input meant to hurt: names that poison
 * objects, enormous values, strings made to make a regular expression run for ever.
 */

// ---- a seeded generator, so that a failure can be repeated ----

function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const LOWER = 'abcdefghijklmnopqrstuvwxyz'
const DIGITS = '0123456789'
const B64 = `${LOWER}${LOWER.toUpperCase()}${DIGITS}`

function pick(next: () => number, alphabet: string, length: number): string {
  let out = ''
  for (let index = 0; index < length; index += 1) out += alphabet[Math.floor(next() * alphabet.length)]
  return out
}

/** A string of this alphabet that has at least one digit and one letter, which is what the shape of a token needs. */
function mixed(next: () => number, length: number): string {
  return `${pick(next, B64, length - 2)}${pick(next, DIGITS, 1)}${pick(next, LOWER, 1)}`
}

function luhnCard(next: () => number): string {
  const digits = pick(next, DIGITS, 15).split('').map(Number)
  let sum = 0
  digits.forEach((digit, index) => {
    let value = digit
    if (index % 2 === 0) {
      value *= 2
      if (value > 9) value -= 9
    }
    sum += value
  })
  return `${digits.join('')}${(10 - (sum % 10)) % 10}`
}

interface Plant {
  jwt: string
  sk: string
  gh: string
  hex: string
  opaque: string
  aws: string
  card: string
  /** short values that only their name gives away */
  short: string[]
}

function plant(next: () => number): Plant {
  return {
    jwt: `eyJ${mixed(next, 14)}.${mixed(next, 26)}.${mixed(next, 22)}`,
    sk: `sk-live_${mixed(next, 26)}`,
    gh: `ghp_${mixed(next, 36)}`,
    hex: pick(next, '0123456789abcdef', 40),
    opaque: mixed(next, 44),
    aws: `AKIA${pick(next, `${LOWER.toUpperCase()}${DIGITS}`, 16)}`,
    card: luhnCard(next),
    short: [`hunter${Math.floor(next() * 1e6)}`, `pw${Math.floor(next() * 1e6)}`, `s3${Math.floor(next() * 1e6)}x`],
  }
}

const everything = (p: Plant): string[] => [p.jwt, p.sk, p.gh, p.hex, p.opaque, p.aws, p.card, ...p.short]

interface RawEntry {
  method: string
  url: string
  headers: Record<string, string>
  mime?: string
  text?: string
  params?: Array<{ name: string; value: string }>
  status: number
  response?: string
  resourceType?: string
}

function harText(entries: RawEntry[]): string {
  return JSON.stringify({
    log: {
      entries: entries.map((e) => ({
        _resourceType: e.resourceType ?? 'xhr',
        request: {
          method: e.method,
          url: e.url,
          headers: Object.entries(e.headers).map(([name, value]) => ({ name, value })),
          ...(e.text !== undefined || e.params ? { postData: { mimeType: e.mime ?? 'application/json', ...(e.text !== undefined ? { text: e.text } : {}), ...(e.params ? { params: e.params } : {}) } } : {}),
        },
        response: { status: e.status, statusText: 'OK', headers: [{ name: 'Set-Cookie', value: `sid=${'x'.repeat(5)}` }], content: { mimeType: 'application/json', text: e.response ?? '{}' } },
      })),
    },
  })
}

function sampleEntries(p: Plant, host: string): RawEntry[] {
  return [
    {
      method: 'POST',
      url: `https://alice:${p.short[0]}@${host}/login?access_token=${p.opaque}&page=2&ref=${p.jwt}`,
      headers: { Authorization: `Bearer ${p.jwt}`, 'X-API-Key': p.sk, 'X-Custom': p.gh, Cookie: `session=${p.hex}; other=${p.opaque}` },
      text: JSON.stringify({ username: 'bob', password: p.short[1], profile: { refreshToken: p.opaque, clientSecret: p.short[2], note: p.jwt, tokens: [p.gh] }, items: [{ apiKey: p.sk, card: p.card }], comment: `use ${p.aws} please` }),
      status: 200,
      response: JSON.stringify({ access_token: p.jwt, refresh_token: p.opaque, user: { id: 1, session: p.hex, aws: p.aws, memo: p.sk } }),
    },
    { method: 'POST', url: `https://${host}/token`, headers: {}, mime: 'application/x-www-form-urlencoded', text: `username=bob&password=${p.short[0]}&token=${p.opaque}&other=${p.gh}`, status: 200, response: JSON.stringify({ token: p.hex }) },
    { method: 'POST', url: `https://${host}/upload`, headers: {}, mime: 'multipart/form-data; boundary=x', params: [{ name: 'api_key', value: p.sk }, { name: 'title', value: p.jwt }], status: 201 },
    { method: 'GET', url: `https://${host}/reset/${p.jwt}/confirm/${p.hex}/verify/${p.opaque}`, headers: {}, status: 200 },
    { method: 'PUT', url: `https://${host}/raw/1`, headers: {}, mime: 'text/plain', text: `grant_type=password&client_secret=${p.hex}&password=${p.short[1]} Authorization: Bearer ${p.jwt} key=${p.gh}`, status: 200 },
    { method: 'POST', url: `https://${host}/graphql`, headers: {}, text: JSON.stringify({ query: 'mutation { login }', variables: { password: p.short[2], otp: p.card } }), status: 200 },
  ]
}

const OPTIONS = { shareHeaders: false } as const

describe('secrets in a HAR file', () => {
  it('never reach the result when secrets are redacted, wherever they were put', () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const next = random(seed)
      const p = plant(next)
      const parsed = parseHar(harText(sampleEntries(p, 'api.example.com')))
      if (!('entries' in parsed)) throw new Error(parsed.error)
      for (const mode of ['secrets', 'all-examples'] as const) {
        const built = buildEndpoints(parsed.entries, { redact: mode, ...OPTIONS })
        expect(built.endpoints.length, `seed ${seed}`).toBeGreaterThanOrEqual(5)
        const text = JSON.stringify(built)
        for (const secret of everything(p)) expect(text.includes(secret), `seed ${seed}, ${mode}: ${secret}`).toBe(false)
        expect(text.includes('alice'), `seed ${seed}: the user of an address`).toBe(false)
      }
    }
  })

  it('does show them when the person asked to keep the values, so the test above is really looking', () => {
    const p = plant(random(7))
    const parsed = parseHar(harText(sampleEntries(p, 'api.example.com')))
    if (!('entries' in parsed)) throw new Error(parsed.error)
    const text = JSON.stringify(buildEndpoints(parsed.entries, { redact: 'none', ...OPTIONS }))
    const shown = everything(p).filter((secret) => text.includes(secret))
    expect(shown.length).toBeGreaterThanOrEqual(5)
  })

  it('count what they hid, and keep the names and the shape of the contract', () => {
    const p = plant(random(3))
    const parsed = parseHar(harText(sampleEntries(p, 'api.example.com')))
    if (!('entries' in parsed)) throw new Error(parsed.error)
    const built = buildEndpoints(parsed.entries, { redact: 'secrets', ...OPTIONS })
    expect(built.stats.redactions).toBeGreaterThan(10)
    const login = built.endpoints.find((e) => e.path === '/login')
    expect(login?.headers?.find((h) => h.name === 'Authorization')?.example).toBe('<redacted>')
    expect(login?.body?.fields?.map((f) => f.name)).toEqual(expect.arrayContaining(['username', 'password', 'profile']))
    expect(login?.query?.map((f) => f.name)).toEqual(expect.arrayContaining(['access_token', 'page']))
    expect(login?.query?.find((f) => f.name === 'access_token')?.example).toBe('<redacted>')
    expect(login?.query?.find((f) => f.name === 'page')?.example).toBe('2')
  })

  it('keep an example that is not a secret', () => {
    const parsed = parseHar(harText([{ method: 'POST', url: 'https://api.example.com/orders', headers: { 'X-Api-Version': '3' }, text: JSON.stringify({ sku: 'chair-01', qty: 2 }), status: 200, response: '{}' }]))
    if (!('entries' in parsed)) throw new Error(parsed.error)
    const [endpoint] = buildEndpoints(parsed.entries, { redact: 'secrets', ...OPTIONS }).endpoints
    expect(endpoint?.headers?.[0]?.example).toBe('3')
    expect(endpoint?.body?.fields?.find((f) => f.name === 'sku')?.example).toBe('chair-01')
  })
})

describe('secrets in curl commands', () => {
  it('never reach the result either', () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const next = random(1_000 + seed)
      const p = plant(next)
      const text = [
        `curl 'https://alice:${p.short[0]}@api.example.com/login?access_token=${p.opaque}&ref=${p.jwt}' -H 'Authorization: Bearer ${p.jwt}' -H "X-API-Key: ${p.sk}" -H 'X-Custom: ${p.gh}' -b 'session=${p.hex}' --data-raw '{"password":"${p.short[1]}","profile":{"refreshToken":"${p.opaque}","note":"${p.jwt}"}}' -H 'Content-Type: application/json'`,
        `curl -u bob:${p.short[2]} https://api.example.com/me --oauth2-bearer ${p.jwt}`,
        `curl https://api.example.com/reset/${p.jwt}/confirm/${p.hex} -d 'password=${p.short[0]}&token=${p.opaque}'`,
        `curl -F 'api_key=${p.sk}' -F 'title=${p.gh}' https://api.example.com/upload`,
      ].join('\n')
      const parsed = parseCurl(text)
      if (!('entries' in parsed)) throw new Error(parsed.error)
      for (const mode of ['secrets', 'all-examples'] as const) {
        const built = buildEndpoints(parsed.entries, { redact: mode, ...OPTIONS })
        expect(built.endpoints.length, `seed ${seed}`).toBeGreaterThanOrEqual(3)
        const result = JSON.stringify(built)
        for (const secret of everything(p)) expect(result.includes(secret), `seed ${seed}, ${mode}: ${secret}`).toBe(false)
        expect(result.includes('alice') || result.includes('bob:'), `seed ${seed}: a user name`).toBe(false)
      }
    }
  })
})

describe('what is taken for a secret', () => {
  it('goes by the name, split into words, and by the shape of the value', () => {
    for (const name of ['password', 'Password', 'user_password', 'accessToken', 'refresh-token', 'client_secret', 'X-API-Key', 'apiKey', 'api_key', 'Authorization', 'Proxy-Authorization', 'sessionId', 'csrfToken', 'private-key', 'jwt', 'otp', 'Set-Cookie']) expect(secretName(name), name).toBe(true)
    for (const name of ['author', 'authorId', 'keyboard', 'monkey', 'sortKey', 'page', 'tokenizer_type_is_fine'.slice(0, 0) || 'name', 'passenger', 'signal', 'pinned', 'description']) expect(secretName(name), name).toBe(false)
    const p = plant(random(11))
    for (const value of [p.jwt, p.sk, p.gh, p.hex, p.opaque, p.aws, p.card, 'Bearer abcdef123456', 'Basic dXNlcjpwYXNz']) expect(looksLikeSecret(value), value).toBe(true)
    for (const value of ['hello', 'chair-01', '2026-10-16', '3fa85f64-5717-4562-b3fc-2c963f66afa6', 'a-very-long-article-title-with-only-words-in-it', '1234', 'Mozilla/5.0', '4111111111111112']) expect(looksLikeSecret(value), value).toBe(false)
  })
})

describe('input meant to hurt', () => {
  const API = 'https://api.example.com'

  it('does not let a name poison an object: __proto__, constructor and the rest are only names', () => {
    const body = '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"toString":1,"a":{"__proto__":2}}'
    const parsed = parseHar(
      harText([{ method: 'POST', url: `${API}/p?__proto__=1&constructor=2&toString=3`, headers: { __proto__: 'x', constructor: 'y', 'X-Real': 'z' }, text: body, status: 200, response: body }, { method: 'POST', url: `${API}/p?a=1`, headers: {}, mime: 'application/x-www-form-urlencoded', text: '__proto__=1&constructor=2', status: 200 }]),
    )
    if (!('entries' in parsed)) throw new Error(parsed.error)
    const built = buildEndpoints(parsed.entries, { redact: 'secrets', ...OPTIONS })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.prototype).not.toHaveProperty('polluted')
    const names = JSON.stringify(built.endpoints)
    expect(names).toContain('__proto__')
    expect(names).toContain('constructor')
    expect(JSON.parse(JSON.stringify(built))).toEqual(built)
  })

  it('does not let a secret through as a name either, as in a map keyed by tokens, and takes the login out of an address inside a value', () => {
    const p = plant(random(21))
    const body = JSON.stringify({ users: { [p.jwt]: { id: 1 }, [p.sk]: { id: 2 }, [p.hex]: { id: 3 } }, callback: `https://carol:${p.short[0]}@hooks.example.com/in?x=1`, [p.gh]: true })
    const parsed = parseHar(harText([{ method: 'POST', url: `${API}/map?${p.opaque}=1`, headers: { [p.gh]: 'x' }, text: body, status: 200, response: body, }]))
    if (!('entries' in parsed)) throw new Error(parsed.error)
    for (const mode of ['secrets', 'all-examples'] as const) {
      const built = buildEndpoints(parsed.entries, { redact: mode, ...OPTIONS })
      const text = JSON.stringify(built)
      for (const secret of [p.jwt, p.sk, p.hex, p.gh, p.opaque, p.short[0] as string, 'carol']) expect(text.includes(secret), `${mode}: ${secret}`).toBe(false)
      expect(text).toContain('<key>')
    }
    expect(JSON.stringify(buildEndpoints(parsed.entries, { redact: 'none', ...OPTIONS }))).toContain(p.jwt)
  })

  it('does not fall over a sample nested a hundred thousand levels deep, nor one with ten thousand keys', () => {
    const deep = '['.repeat(100_000) + ']'.repeat(100_000)
    const wide = JSON.stringify(Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [`k${index}`, index])))
    const parsed = parseHar(harText([{ method: 'POST', url: `${API}/d`, headers: {}, text: deep, status: 200, response: deep }, { method: 'POST', url: `${API}/w`, headers: {}, text: wide, status: 200, response: wide }]))
    if (!('entries' in parsed)) throw new Error(parsed.error)
    const built = buildEndpoints(parsed.entries, { redact: 'secrets', ...OPTIONS })
    const wideEndpoint = built.endpoints.find((e) => e.path === '/w')
    expect(wideEndpoint?.body?.fields?.length).toBeLessThanOrEqual(200)
    expect(built.notes.join(' ')).toMatch(/more than 200 fields/)
  })

  it('takes its time only in proportion to what it was given: huge values and strings made to make patterns backtrack', () => {
    const huge = 'a'.repeat(1_000_000)
    const bait = `${'a'.repeat(50_000)}!`
    const mixedBait = `${'1a'.repeat(40_000)}!`
    const started = Date.now()
    const parsed = parseHar(
      harText([
        { method: 'POST', url: `${API}/${bait}/x?q=${huge.slice(0, 100_000)}&r=${mixedBait}`, headers: { 'X-Huge': huge.slice(0, 4_000), 'X-Bait': mixedBait.slice(0, 4_000) }, text: JSON.stringify({ [bait.slice(0, 250)]: mixedBait, value: huge }), status: 200, response: JSON.stringify({ a: bait }) },
        { method: 'PUT', url: `${API}/raw`, headers: {}, mime: 'text/plain', text: `${mixedBait}${'password='.repeat(5_000)}${bait}`, status: 200 },
      ]),
    )
    if (!('entries' in parsed)) throw new Error(parsed.error)
    const built = buildEndpoints(parsed.entries, { redact: 'secrets', ...OPTIONS })
    expect(built.endpoints.length).toBeGreaterThan(0)
    expect(Date.now() - started).toBeLessThan(4_000)
  })

  it('does the same for curl: an unterminated quote, a million characters, thousands of options', () => {
    const started = Date.now()
    for (const text of [`curl 'https://api.example.com/a -H "x`, `curl https://api.example.com/${'a'.repeat(1_000_000)}`, `curl ${'-s '.repeat(50_000)} https://api.example.com/a`, `curl ${'-H "a: b" '.repeat(20_000)} https://api.example.com/a`, "curl $'\\x\\u\\U\\777\\c' https://api.example.com/a"]) {
      const parsed = parseCurl(text)
      if ('entries' in parsed) buildEndpoints(parsed.entries, { redact: 'secrets', ...OPTIONS })
    }
    expect(Date.now() - started).toBeLessThan(4_000)
  })

  it('handles as many entries as it will accept', () => {
    const entries = Array.from({ length: 5_000 }, (_, index) => ({ method: index % 2 ? 'GET' : 'POST', url: `${API}/items/${index}/parts/${index * 7}?page=${index}`, headers: { 'X-Index': String(index) }, text: index % 2 ? undefined : JSON.stringify({ n: index }), status: 200, response: JSON.stringify({ id: index }) }))
    const started = Date.now()
    const parsed = parseHar(harText(entries))
    if (!('entries' in parsed)) throw new Error(parsed.error)
    const built = buildEndpoints(parsed.entries, { redact: 'secrets', ...OPTIONS })
    expect(built.endpoints.map((e) => `${e.method} ${e.path}`).sort()).toEqual(['GET /items/{itemId}/parts/{partId}', 'POST /items/{itemId}/parts/{partId}'])
    expect(built.stats.used).toBe(5_000)
    expect(Date.now() - started).toBeLessThan(4_000)
    expect(LIMITS.trafficEntries).toBeGreaterThanOrEqual(5_000)
  })
})
