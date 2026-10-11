import { describe, expect, it } from 'vitest'
import { DEFAULT_PORT } from '../src/protocol'
import { ConfigError, DEFAULT_ORIGINS, DEFAULT_PICO_URL, parseConfig } from '../src/connector/config'

describe('the connector’s settings', () => {
  it('start from sensible defaults: the usual port, the hosted site and the dev servers', () => {
    const config = parseConfig([], {})
    expect(config.port).toBe(DEFAULT_PORT)
    expect(config.picoUrl).toBe(DEFAULT_PICO_URL)
    expect(config.origins).toEqual(expect.arrayContaining([...DEFAULT_ORIGINS]))
    expect(config.origins).toContain('https://pico.hermasyp.space')
    expect(config.origins).toContain('http://localhost:5173')
    expect(config.verbose).toBe(false)
  })

  it('take flags and environment, with flags winning', () => {
    const config = parseConfig(['--port', '50000', '--url', 'https://pico.example/app/', '--verbose'], { PICO_MCP_PORT: '51000', PICO_URL: 'https://ignored.example/' })
    expect(config.port).toBe(50000)
    expect(config.picoUrl).toBe('https://pico.example/app/')
    expect(config.verbose).toBe(true)
    const fromEnv = parseConfig([], { PICO_MCP_PORT: '51000', PICO_URL: 'https://env.example/' })
    expect(fromEnv.port).toBe(51000)
    expect(fromEnv.picoUrl).toBe('https://env.example/')
  })

  it('accept the equals form of a flag', () => {
    expect(parseConfig(['--port=50001', '--origin=http://localhost:9000'], {}).port).toBe(50001)
    expect(parseConfig(['--port=50001', '--origin=http://localhost:9000'], {}).origins).toContain('http://localhost:9000')
  })

  it('add the address of the Pico it links to, and every origin it is told about, as origins only', () => {
    const config = parseConfig(['--url', 'https://self-hosted.example/pico/', '--origin', 'http://127.0.0.1:4999/path'], { PICO_MCP_ORIGINS: 'https://a.example, https://b.example:8443 ,' })
    expect(config.origins).toEqual(expect.arrayContaining(['https://self-hosted.example', 'http://127.0.0.1:4999', 'https://a.example', 'https://b.example:8443']))
    expect(config.origins.every((origin) => !origin.endsWith('/'))).toBe(true)
    expect(new Set(config.origins).size).toBe(config.origins.length)
  })

  it('allow port 0, which means any free port', () => {
    expect(parseConfig(['--port', '0'], {}).port).toBe(0)
  })

  it('refuse a port that is not one, an origin that is not an address, and a flag it does not know', () => {
    expect(() => parseConfig(['--port', 'abc'], {})).toThrow(ConfigError)
    expect(() => parseConfig(['--port', '70000'], {})).toThrow(ConfigError)
    expect(() => parseConfig(['--port', '80'], {})).toThrow(ConfigError)
    expect(() => parseConfig(['--port'], {})).toThrow(ConfigError)
    expect(() => parseConfig(['--origin', 'not a url'], {})).toThrow(ConfigError)
    expect(() => parseConfig(['--url', 'nope'], {})).toThrow(ConfigError)
    expect(() => parseConfig(['--surprise'], {})).toThrow(ConfigError)
    expect(() => parseConfig([], { PICO_MCP_PORT: 'x' })).toThrow(ConfigError)
  })

  it('refuse an origin that is not http or https', () => {
    expect(() => parseConfig(['--origin', 'file:///etc/passwd'], {})).toThrow(ConfigError)
    expect(() => parseConfig(['--origin', 'null'], {})).toThrow(ConfigError)
  })
})
