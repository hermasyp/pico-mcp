# Changelog

All notable changes to Pico MCP are recorded here, following
[Semantic Versioning](https://semver.org/) and [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The wire protocol has a version of its own (`AGENT_PROTOCOL`, now 1): a connector and a Pico tab that speak
different versions refuse each other with a message that says so.

## [1.0.0] - 2026-10-11

The connector, the wire protocol and the tool catalog that shipped inside Pico 2.1.0 and 2.1.1, as a project
of their own. The behaviour is the same and so is the protocol version (1); what is new is where it lives.

- A single-file connector (`dist/pico-mcp.mjs`, from the Releases page, or `npx` once the package is on npm)
  that speaks MCP on stdio to the agent and a WebSocket on 127.0.0.1 to the Pico tab.
- 14 tools, 9 prompts, a format guide and the server instructions, as plain JSON Schema and text.
- The library that Pico's web app imports, so the two sides cannot drift apart: `pico-mcp/protocol`,
  `pico-mcp/catalog` and `pico-mcp/vocabulary`.
- A connection that is proved, never sent: a one-time 128-bit token and HMAC-SHA256 proofs over fresh nonces,
  `Host` and `Origin` checks, frames limited to 4 MiB counted in bytes, and no lockout (a wrong proof closes only
  its own socket).
