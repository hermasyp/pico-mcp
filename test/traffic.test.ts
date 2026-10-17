import { describe, expect, it } from 'vitest'
import { buildEndpoints, parseCurl, parseHar, type TrafficEntry } from '../src/connector/traffic'
import { LIMITS } from '../src/protocol'

/*
 * Recorded traffic (a HAR file, or curl commands) becomes endpoints in the shape pico_add_endpoints takes. The module
 * is pure: it gets text, it gives back data, and it never runs, fetches or opens anything.
 */

// ---- a small HAR builder ----

interface Call {
  method?: string
  url: string
  type?: string
  requestHeaders?: Record<string, string>
  requestMime?: string
  requestText?: string
  requestParams?: Array<{ name: string; value: string; fileName?: string }>
  status?: number
  statusText?: string
  responseMime?: string
  responseText?: string
  base64?: boolean
}

const pairs = (headers: Record<string, string> = {}) => Object.entries(headers).map(([name, value]) => ({ name, value }))

function entry(call: Call) {
  const url = new URL(call.url)
  return {
    ...(call.type ? { _resourceType: call.type } : {}),
    request: {
      method: call.method ?? 'GET',
      url: call.url,
      headers: pairs(call.requestHeaders),
      queryString: [...url.searchParams].map(([name, value]) => ({ name, value })),
      ...(call.requestText !== undefined || call.requestParams ? { postData: { mimeType: call.requestMime ?? 'application/json', ...(call.requestText !== undefined ? { text: call.requestText } : {}), ...(call.requestParams ? { params: call.requestParams } : {}) } } : {}),
    },
    response: {
      status: call.status ?? 200,
      statusText: call.statusText ?? 'OK',
      headers: [],
      content: { mimeType: call.responseMime ?? 'application/json', ...(call.responseText !== undefined ? { text: call.responseText, ...(call.base64 ? { encoding: 'base64' } : {}) } : {}) },
    },
  }
}

const har = (...calls: Call[]) => JSON.stringify({ log: { version: '1.2', entries: calls.map(entry) } })

function entriesOf(...calls: Call[]): TrafficEntry[] {
  const parsed = parseHar(har(...calls))
  if ('error' in parsed) throw new Error(parsed.error)
  return parsed.entries
}

const build = (calls: Call[], options: { redact?: 'secrets' | 'all-examples'; hosts?: string[]; shareHeaders?: boolean } = {}) => buildEndpoints(entriesOf(...calls), { redact: options.redact ?? 'secrets', ...(options.hosts ? { hosts: options.hosts } : {}), shareHeaders: options.shareHeaders ?? false })

const API = 'https://api.example.com'
const json = (value: unknown) => JSON.stringify(value)

describe('parseHar', () => {
  it('reads the requests and responses of a HAR file', () => {
    const parsed = parseHar(har({ method: 'POST', url: `${API}/orders?x=1`, requestHeaders: { 'X-Trace': 'a' }, requestText: json({ a: 1 }), status: 201, statusText: 'Created', responseText: json({ id: 7 }), type: 'xhr' }))
    expect('entries' in parsed && parsed.entries).toHaveLength(1)
    const [first] = 'entries' in parsed ? parsed.entries : []
    expect(first).toMatchObject({ method: 'POST', url: `${API}/orders?x=1`, status: 201, resourceType: 'xhr', requestBody: { mime: 'application/json', text: '{"a":1}' }, responseBody: { mime: 'application/json', text: '{"id":7}' } })
    expect(first?.requestHeaders).toEqual([['X-Trace', 'a']])
  })

  it('says what is wrong without quoting the file', () => {
    for (const bad of ['not json at all {"secret":"hunter2"', '[]', '{"log":{}}', '{"log":{"entries":"no"}}', '']) {
      const parsed = parseHar(bad)
      expect(parsed).toHaveProperty('error')
      expect(JSON.stringify(parsed)).not.toContain('hunter2')
    }
    const many = JSON.stringify({ log: { entries: Array.from({ length: LIMITS.trafficEntries + 1 }, () => ({})) } })
    expect(parseHar(many)).toMatchObject({ error: expect.stringContaining('entries') })
  })

  it('leaves out an entry that is not one, and a body that is too long, with a note each', () => {
    const text = JSON.stringify({ log: { entries: [{ request: 5 }, null, entry({ url: `${API}/a`, responseText: 'x'.repeat(LIMITS.trafficBodyChars + 1) })] } })
    const parsed = parseHar(text)
    expect('entries' in parsed && parsed.entries).toHaveLength(1)
    expect('notes' in parsed && parsed.notes.join(' ')).toMatch(/2 entries/)
    expect('notes' in parsed && parsed.notes.join(' ')).toMatch(/too long/)
    expect('entries' in parsed && parsed.entries[0]?.responseBody).toBeNull()
  })

  it('decodes a base64 body, and reads form parameters', () => {
    const parsed = parseHar(har({ url: `${API}/a`, responseText: Buffer.from('{"ok":true}').toString('base64'), base64: true }, { method: 'POST', url: `${API}/b`, requestMime: 'multipart/form-data', requestParams: [{ name: 'title', value: 'x' }, { name: 'avatar', value: '', fileName: 'me.png' }] }))
    if (!('entries' in parsed)) throw new Error(parsed.error)
    expect(parsed.entries[0]?.responseBody?.text).toBe('{"ok":true}')
    expect(parsed.entries[1]?.requestForm).toEqual([{ name: 'title', value: 'x' }, { name: 'avatar', value: '', file: true }])
  })

  it('reads UTF-8 in a base64 body, and treats text that is not base64 as no body', () => {
    const text = '{"name":"Zo\u00eb \u2603"}'
    const fine = parseHar(har({ url: `${API}/a`, responseText: Buffer.from(text, 'utf8').toString('base64'), base64: true }))
    if (!('entries' in fine)) throw new Error(fine.error)
    expect(fine.entries[0]?.responseBody?.text).toBe(text)
    const broken = parseHar(har({ url: `${API}/a`, responseText: '%%% not base64 %%%', base64: true }))
    if (!('entries' in broken)) throw new Error(broken.error)
    expect(broken.entries).toHaveLength(1)
    expect(broken.entries[0]?.responseBody).toBeNull()
  })
})

describe('what is an API call', () => {
  it('drops static files, pages, preflights, other methods and other schemes, and keeps what scripts fetch', () => {
    const built = build([
      { url: `${API}/users`, type: 'xhr', responseText: json([]) },
      { url: `${API}/app.js`, type: 'script', responseMime: 'application/javascript' },
      { url: `${API}/style.css`, responseMime: 'text/css' },
      { url: `${API}/logo.png`, responseMime: 'image/png' },
      { url: `${API}/index.html`, type: 'document', responseMime: 'text/html' },
      { method: 'OPTIONS', url: `${API}/users`, type: 'preflight' },
      { method: 'HEAD', url: `${API}/users` },
      { url: 'data:text/plain;base64,AAAA', responseMime: 'text/plain' },
      { url: 'wss://api.example.com/socket', type: 'websocket' },
    ])
    expect(built.endpoints.map((e) => `${e.method} ${e.path}`)).toEqual(['GET /users'])
    expect(built.stats).toMatchObject({ entries: 9, used: 1, endpoints: 1 })
  })

  it('guesses from the content type when the file does not say what kind of request it was', () => {
    const built = build([
      { url: `${API}/a`, responseMime: 'application/json; charset=utf-8', responseText: json({ a: 1 }) },
      { url: `${API}/b`, responseMime: 'text/html', responseText: '<html>' },
      { method: 'POST', url: `${API}/c`, requestMime: 'application/x-www-form-urlencoded', requestText: 'a=1', responseMime: 'text/plain' },
    ])
    expect(built.endpoints.map((e) => e.path).sort()).toEqual(['/a', '/c'])
  })
})

describe('which host', () => {
  const calls: Call[] = [
    { url: 'https://api.example.com/users', type: 'xhr' },
    { url: 'https://api.example.com/orders', type: 'xhr' },
    { url: 'https://api.example.com/items', type: 'xhr' },
    { url: 'https://analytics.example.net/collect', type: 'xhr', method: 'POST' },
  ]

  it('takes the host with the most calls, and names the others', () => {
    const built = build(calls)
    expect(built.host).toBe('api.example.com')
    expect(built.endpoints).toHaveLength(3)
    expect(built.notes.join(' ')).toContain('analytics.example.net')
    expect(built.hosts).toEqual(['api.example.com', 'analytics.example.net'])
  })

  it('takes the hosts it is told to, and says when none of them is in the file', () => {
    expect(build(calls, { hosts: ['analytics.example.net'] }).endpoints.map((e) => e.path)).toEqual(['/collect'])
    expect(build(calls, { hosts: ['api.example.com', 'analytics.example.net'] }).endpoints).toHaveLength(4)
    const none = build(calls, { hosts: ['nowhere.example'] })
    expect(none.endpoints).toEqual([])
    expect(none.notes.join(' ')).toContain('nowhere.example')
  })
})

describe('paths', () => {
  const paths = (...urls: string[]) => build(urls.map((url) => ({ url, type: 'xhr' }))).endpoints.map((e) => e.path)

  it('turns the parts that are values into parameters named after what they belong to, and joins the calls that differ only there', () => {
    expect(paths(`${API}/users/123`, `${API}/users/456`)).toEqual(['/users/{userId}'])
    expect(paths(`${API}/users/1/orders/9`)).toEqual(['/users/{userId}/orders/{orderId}'])
    expect(paths(`${API}/categories/3`)).toEqual(['/categories/{categoryId}'])
    expect(paths(`${API}/addresses/3`)).toEqual(['/addresses/{addressId}'])
    expect(paths(`${API}/order-items/5`)).toEqual(['/order-items/{orderItemId}'])
    expect(paths(`${API}/order_items/5`)).toEqual(['/order_items/{orderItemId}'])
    expect(paths(`${API}/5`)).toEqual(['/{id}'])
    expect(paths(`${API}/a/1/1`)).toEqual(['/a/{aId}/{id}'])
  })

  it('knows the usual shapes of an id: UUID, ULID, ObjectId, a long hex string, a long mixed token', () => {
    expect(paths(`${API}/files/3fa85f64-5717-4562-b3fc-2c963f66afa6`)).toEqual(['/files/{fileId}'])
    expect(paths(`${API}/files/01ARZ3NDEKTSV4RRFFQ69G5FAV`)).toEqual(['/files/{fileId}'])
    expect(paths(`${API}/files/507f1f77bcf86cd799439011`)).toEqual(['/files/{fileId}'])
    expect(paths(`${API}/files/9f86d081884c7d659a2feaa0c55ad015`)).toEqual(['/files/{fileId}'])
    expect(paths(`${API}/files/Ab3dE5gH7jK9`)).toEqual(['/files/{fileId}'])
  })

  it('keeps the parts that are words, drops the query and a trailing slash, and names two parameters of one path apart', () => {
    expect(paths(`${API}/users/me/settings/`)).toEqual(['/users/me/settings'])
    expect(paths(`${API}/search?q=cats&page=2`)).toEqual(['/search'])
    expect(paths(`${API}/`)).toEqual(['/'])
    expect(paths(`${API}/v2/feed`)).toEqual(['/v2/feed'])
    expect(paths(`${API}/1/2`)).toEqual(['/{id}/{id2}'])
  })
})

describe('names', () => {
  it('say what the endpoint does, from its method and path', () => {
    const names = (method: string, url: string) => build([{ method, url, type: 'xhr', requestText: method === 'GET' || method === 'DELETE' ? undefined : '{}' }]).endpoints[0]?.name
    expect(names('GET', `${API}/users`)).toBe('List users')
    expect(names('GET', `${API}/users/1`)).toBe('Get user')
    expect(names('POST', `${API}/users`)).toBe('Create user')
    expect(names('PUT', `${API}/users/1`)).toBe('Update user')
    expect(names('PATCH', `${API}/users/1`)).toBe('Update user')
    expect(names('DELETE', `${API}/users/1`)).toBe('Delete user')
    expect(names('GET', `${API}/order-items`)).toBe('List order items')
    expect(names('POST', `${API}/users/1/reset-password`)).toBe('POST /users/{userId}/reset-password')
    expect(names('GET', `${API}/`)).toBe('GET /')
  })
})

describe('query strings', () => {
  it('become fields, typed from their values and required when every call had them', () => {
    const [endpoint] = build([
      { url: `${API}/items?page=1&limit=10&active=true&q=a&ratio=0.5`, type: 'xhr' },
      { url: `${API}/items?page=2&limit=10&active=false&sort=name&ratio=1.5`, type: 'xhr' },
    ]).endpoints
    const byName = Object.fromEntries((endpoint?.query ?? []).map((field) => [field.name, field]))
    expect(byName.page).toMatchObject({ type: 'int', required: true })
    expect(byName.active).toMatchObject({ type: 'boolean', required: true })
    expect(byName.ratio).toMatchObject({ type: 'number', required: true })
    expect(byName.q).toMatchObject({ type: 'string' })
    expect(byName.q?.required).toBeUndefined()
    expect(byName.sort?.required).toBeUndefined()
  })
})

describe('bodies', () => {
  it('turn JSON samples into fields: types, nesting, lists, nulls, and what was always there', () => {
    const [endpoint] = build([
      { method: 'POST', url: `${API}/orders`, requestText: json({ customer: { id: 1, name: 'A' }, items: [{ sku: 'x', qty: 2 }], note: 'hi', paid: true, total: 9.5, coupon: null }) },
      { method: 'POST', url: `${API}/orders`, requestText: json({ customer: { id: 2, name: 'B' }, items: [{ sku: 'y', qty: 1, gift: true }], paid: false, total: 10, coupon: 'X1' }) },
    ]).endpoints
    expect(endpoint?.body?.type).toBe('json')
    const byName = Object.fromEntries((endpoint?.body?.fields ?? []).map((field) => [field.name, field]))
    expect(byName.customer).toMatchObject({ type: 'object', required: true })
    expect(byName.customer?.children?.map((c) => `${c.name}:${c.type}`)).toEqual(['id:int', 'name:string'])
    expect(byName.items).toMatchObject({ type: 'list<object>', required: true })
    expect(byName.items?.children?.find((c) => c.name === 'sku')).toMatchObject({ type: 'string', required: true })
    expect(byName.items?.children?.find((c) => c.name === 'gift')?.required).toBeUndefined()
    expect(byName.note?.required).toBeUndefined()
    expect(byName.paid).toMatchObject({ type: 'boolean', required: true })
    expect(byName.total).toMatchObject({ type: 'number', required: true })
    expect(byName.coupon).toMatchObject({ type: 'string', nullable: true })
  })

  it('does not call a field required on the word of one sample', () => {
    const [endpoint] = build([{ method: 'POST', url: `${API}/orders`, requestText: json({ a: 1, b: 'x' }) }]).endpoints
    expect(endpoint?.body?.fields?.every((field) => field.required === undefined)).toBe(true)
    expect(endpoint?.description).toContain('1 sample')
  })

  it('uses string and says so when the samples disagree about a type', () => {
    const built = build([
      { method: 'POST', url: `${API}/x`, requestText: json({ v: 1 }) },
      { method: 'POST', url: `${API}/x`, requestText: json({ v: 'one' }) },
    ])
    expect(built.endpoints[0]?.body?.fields?.[0]).toMatchObject({ name: 'v', type: 'string' })
    expect(built.notes.join(' ')).toMatch(/POST \/x.*v/)
  })

  it('knows lists of plain values, empty lists, and a list at the top', () => {
    const [endpoint] = build([
      { method: 'POST', url: `${API}/x`, requestText: json({ tags: ['a'], ids: [1, 2], ratios: [0.5], flags: [true], nothing: [] }) },
      { url: `${API}/y`, responseText: json([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]) },
    ]).endpoints
    expect(Object.fromEntries((endpoint?.body?.fields ?? []).map((f) => [f.name, f.type]))).toEqual({ tags: 'list<string>', ids: 'list<int>', ratios: 'list<number>', flags: 'list<boolean>', nothing: 'list<string>' })
    const list = build([{ url: `${API}/y`, type: 'xhr', responseText: json([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]) }]).endpoints[0]
    expect(list?.responses?.[0]?.fields?.map((f) => f.name)).toEqual(['id', 'name'])
    expect(list?.responses?.[0]?.description).toContain('list')
  })

  it('reads form bodies and multipart bodies, with files as files', () => {
    const built = build([
      { method: 'POST', url: `${API}/login`, requestMime: 'application/x-www-form-urlencoded', requestText: 'user=a&remember=true&n=3' },
      { method: 'POST', url: `${API}/upload`, requestMime: 'multipart/form-data; boundary=x', requestParams: [{ name: 'title', value: 'x' }, { name: 'avatar', value: '', fileName: 'me.png' }] },
    ])
    const login = built.endpoints.find((e) => e.path === '/login')
    expect(login?.body).toMatchObject({ type: 'urlencoded' })
    expect(Object.fromEntries((login?.body?.fields ?? []).map((f) => [f.name, f.type]))).toEqual({ user: 'string', remember: 'boolean', n: 'int' })
    const upload = built.endpoints.find((e) => e.path === '/upload')
    expect(upload?.body).toMatchObject({ type: 'form-data' })
    expect(Object.fromEntries((upload?.body?.fields ?? []).map((f) => [f.name, f.type]))).toEqual({ title: 'string', avatar: 'file' })
  })

  it('leaves out a body that GET and DELETE do not take, and keeps other text as raw', () => {
    const built = build([
      { url: `${API}/a`, type: 'xhr' },
      { method: 'PUT', url: `${API}/notes/1`, requestMime: 'text/plain', requestText: 'just some words' },
    ])
    expect(built.endpoints.find((e) => e.path === '/a')?.body).toBeUndefined()
    expect(built.endpoints.find((e) => e.path === '/notes/{noteId}')?.body).toMatchObject({ type: 'raw', raw: 'just some words' })
  })

  it('does not follow a deeply nested sample further than it can describe', () => {
    let deep: unknown = { leaf: 1 }
    for (let level = 0; level < 20; level += 1) deep = { next: deep }
    const built = build([{ method: 'POST', url: `${API}/deep`, requestText: json(deep) }])
    const depth = (fields: Array<{ children?: unknown[] }> | undefined): number => (fields?.length ? 1 + Math.max(...fields.map((f) => depth(f.children as never))) : 0)
    expect(depth(built.endpoints[0]?.body?.fields as never)).toBeLessThanOrEqual(8)
    expect(built.notes.join(' ')).toMatch(/deep/)
  })
})

describe('responses', () => {
  it('are listed by status code, with the text of the status and the fields of the JSON that came back', () => {
    const [endpoint] = build([
      { url: `${API}/users/1`, responseText: json({ id: 1, name: 'A' }) },
      { url: `${API}/users/2`, responseText: json({ id: 2, name: 'B' }) },
      { url: `${API}/users/3`, status: 404, statusText: 'Not Found', responseText: json({ message: 'no such user' }) },
      { url: `${API}/users/4`, status: 500, statusText: 'Server Error', responseMime: 'text/html', responseText: '<h1>oops</h1>' },
    ]).endpoints
    expect(endpoint?.responses?.map((r) => r.status)).toEqual(['200', '404', '500'])
    expect(endpoint?.responses?.[0]).toMatchObject({ description: 'OK', fields: [{ name: 'id', type: 'int', required: true }, { name: 'name', type: 'string', required: true }] })
    expect(endpoint?.responses?.[1]?.fields?.[0]).toMatchObject({ name: 'message' })
    expect(endpoint?.responses?.[2]?.fields).toBeUndefined()
  })
})

describe('headers', () => {
  it('drop what the browser and the transport add, and keep what the API asks for', () => {
    const [endpoint] = build([
      {
        url: `${API}/a`,
        type: 'xhr',
        requestHeaders: { Host: 'x', 'User-Agent': 'u', Accept: '*/*', 'Accept-Encoding': 'gzip', Origin: 'o', Referer: 'r', Cookie: 'c=1', 'Content-Length': '0', 'sec-fetch-mode': 'cors', ':authority': 'a', Authorization: 'Bearer abc', 'X-Api-Version': '3', 'X-Request-Id': 'r1', traceparent: '00-abc' },
      },
    ]).endpoints
    expect(endpoint?.headers?.map((h) => h.name).sort()).toEqual(['Authorization', 'X-Api-Version'])
  })

  it('can move the headers every endpoint has into the project’s common headers', () => {
    const calls: Call[] = [
      { url: `${API}/a`, type: 'xhr', requestHeaders: { Authorization: 'Bearer abc', 'X-Only-A': '1' } },
      { url: `${API}/b`, type: 'xhr', requestHeaders: { Authorization: 'Bearer abc' } },
    ]
    const shared = build(calls, { shareHeaders: true })
    expect(shared.commonHeaders.map((h) => h.name)).toEqual(['Authorization'])
    expect(shared.endpoints.find((e) => e.path === '/a')?.headers?.map((h) => h.name)).toEqual(['X-Only-A'])
    expect(shared.endpoints.find((e) => e.path === '/b')?.headers).toBeUndefined()
    const kept = build(calls, { shareHeaders: false })
    expect(kept.commonHeaders).toEqual([])
    expect(kept.endpoints.find((e) => e.path === '/b')?.headers?.map((h) => h.name)).toEqual(['Authorization'])
  })
})

describe('how much comes out', () => {
  it('stops at the number of endpoints one call may add, keeps the busiest, and says what was left out', () => {
    const calls: Call[] = Array.from({ length: 230 }, (_, index) => ({ url: `${API}/r${index}`, type: 'xhr' }))
    calls.push({ url: `${API}/r229`, type: 'xhr' }, { url: `${API}/r229`, type: 'xhr' })
    const built = build(calls)
    expect(built.endpoints).toHaveLength(LIMITS.endpointsPerCall)
    expect(built.endpoints.some((e) => e.path === '/r229')).toBe(true)
    expect(built.notes.join(' ')).toMatch(/30 endpoints/)
    expect(built.stats.endpoints).toBe(LIMITS.endpointsPerCall)
  })

  it('marks what it inferred, so that nobody takes a recording for a specification', () => {
    const [endpoint] = build([{ url: `${API}/a`, type: 'xhr' }]).endpoints
    expect(endpoint?.description).toMatch(/Inferred from recorded traffic/)
  })

  it('does not carry the query string or the host into the path', () => {
    const built = build([{ url: `${API}/a?token=abc`, type: 'xhr' }])
    expect(JSON.stringify(built.endpoints)).not.toContain('api.example.com')
    expect(built.endpoints[0]?.path).toBe('/a')
  })
})

describe('parseCurl', () => {
  const one = (command: string): TrafficEntry => {
    const parsed = parseCurl(command)
    if (!('entries' in parsed)) throw new Error(parsed.error)
    expect(parsed.entries).toHaveLength(1)
    return parsed.entries[0] as TrafficEntry
  }

  it('reads the address, the method, the headers and the data', () => {
    const entry = one(`curl -X PUT 'https://api.example.com/users/1?x=2' -H 'Content-Type: application/json' -H "Authorization: Bearer abc" --data-raw '{"name":"A"}' --compressed`)
    expect(entry).toMatchObject({ method: 'PUT', url: 'https://api.example.com/users/1?x=2', requestBody: { mime: 'application/json', text: '{"name":"A"}' } })
    expect(entry.requestHeaders).toEqual([['Content-Type', 'application/json'], ['Authorization', 'Bearer abc']])
    expect(entry.status).toBeNull()
  })

  it('takes data to mean a POST, the address from --url, and -G to put the data in the query', () => {
    expect(one(`curl https://api.example.com/a -d 'a=1&b=2'`)).toMatchObject({ method: 'POST', requestBody: { mime: 'application/x-www-form-urlencoded', text: 'a=1&b=2' } })
    expect(one(`curl --url https://api.example.com/a`).method).toBe('GET')
    expect(one(`curl -G https://api.example.com/a -d 'a=1' --data-urlencode 'q=hello world'`)).toMatchObject({ method: 'GET', url: 'https://api.example.com/a?a=1&q=hello%20world', requestBody: null })
    expect(one(`curl --json '{"a":1}' https://api.example.com/a`)).toMatchObject({ method: 'POST', requestBody: { mime: 'application/json', text: '{"a":1}' } })
  })

  it('reads the way a browser writes "Copy as cURL": ANSI-C quotes, escaped newlines, flags it does not need', () => {
    const entry = one(`curl 'https://api.example.com/search' \\\n  -H 'accept: application/json' \\\n  -H 'user-agent: Mozilla/5.0' \\\n  --data-raw $'{"q":"caf\\u00e9\\n","n":1}' \\\n  -k -s -L -v`)
    expect(entry).toMatchObject({ method: 'POST', requestBody: { text: '{"q":"café\n","n":1}' } })
  })

  it('reads several commands, and says which it could not use', () => {
    const parsed = parseCurl(`curl https://api.example.com/a\ncurl -X DELETE https://api.example.com/b; echo done\n# a comment\ncurl --version\nwget https://api.example.com/c`)
    if (!('entries' in parsed)) throw new Error(parsed.error)
    expect(parsed.entries.map((e) => `${e.method} ${e.url}`)).toEqual(['GET https://api.example.com/a', 'DELETE https://api.example.com/b'])
    expect(parsed.notes.length).toBeGreaterThan(0)
  })

  it('turns the user of -u and a bearer option into an Authorization header, and never keeps the secret as it was', () => {
    const basic = one(`curl -u alice:s3cr3t https://api.example.com/a`)
    expect(basic.requestHeaders.find(([name]) => name.toLowerCase() === 'authorization')?.[1]).toMatch(/^Basic /)
    expect(JSON.stringify(basic)).not.toContain('s3cr3t')
    expect(JSON.stringify(basic)).not.toContain('alice')
    const bearer = one(`curl --oauth2-bearer abc123 https://api.example.com/a`)
    expect(bearer.requestHeaders).toContainEqual(['Authorization', 'Bearer abc123'])
  })

  it('reads forms, and a file in a form is a file, which is not followed', () => {
    const entry = one(`curl -F 'title=x' -F 'avatar=@/etc/passwd;type=image/png' https://api.example.com/up`)
    expect(entry.method).toBe('POST')
    expect(entry.requestForm).toEqual([{ name: 'title', value: 'x' }, { name: 'avatar', value: '', file: true }])
    expect(JSON.stringify(entry)).not.toContain('passwd')
  })

  it('does not read a file named with @, nor run anything: it stays text', () => {
    const parsed = parseCurl(`curl -d @/etc/passwd https://api.example.com/a -H "X-Who: $(whoami)" -H 'X-Home: '$HOME`)
    if (!('entries' in parsed)) throw new Error(parsed.error)
    expect(JSON.stringify(parsed)).not.toContain('root:')
    expect(parsed.entries[0]?.requestBody).toBeNull()
    expect(parsed.notes.join(' ')).toMatch(/file/)
    expect(parsed.entries[0]?.requestHeaders.find(([name]) => name === 'X-Who')?.[1]).toBe('$(whoami)')
  })

  it('says so when there is no address, or nothing that looks like a command', () => {
    expect(parseCurl('curl -X POST')).toHaveProperty('error')
    expect(parseCurl('hello there')).toHaveProperty('error')
    expect(parseCurl('')).toHaveProperty('error')
  })

  it('goes through endpoints the same way a HAR file does', () => {
    const parsed = parseCurl(`curl -X POST 'https://api.example.com/orders' -H 'Content-Type: application/json' -d '{"sku":"x","qty":2}'\ncurl 'https://api.example.com/orders/17'`)
    if (!('entries' in parsed)) throw new Error(parsed.error)
    const built = buildEndpoints(parsed.entries, { redact: 'secrets', shareHeaders: false })
    expect(built.endpoints.map((e) => `${e.method} ${e.path}`).sort()).toEqual(['GET /orders/{orderId}', 'POST /orders'])
    expect(built.endpoints.find((e) => e.method === 'POST')?.body?.fields?.map((f) => f.name)).toEqual(['sku', 'qty'])
    expect(built.endpoints[0]?.responses).toBeUndefined()
  })
})
