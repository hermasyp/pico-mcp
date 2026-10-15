# Changelog

All notable changes to Pico MCP are recorded here, following
[Semantic Versioning](https://semver.org/) and [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The wire protocol has a version of its own (`AGENT_PROTOCOL`, now 1): a connector and a Pico tab that speak
different versions refuse each other with a message that says so.

## [1.2.0] - 2026-10-15

A third way to work with an agent: **Ask me first**. The person sees what a change would do and applies or
declines it in Pico. It needs Pico 2.3.0 or later. The wire protocol is unchanged (1): everything below is
announced by the connector and used only when both ends have it, so an older Pico or an older connector still
works for everything else (Pico offers *Ask me first* only with a connector of this version).

- **A change can wait for the person.** The tab sends `awaiting-user` for a call that waits for the person's
  decision; the connector then keeps the call alive for 5 minutes and 15 seconds from that notice (once per call)
  instead of 30 seconds, and sends an MCP progress notice every 10 seconds to an agent that asked for them.
- **`cancel`.** When the agent stops waiting (it cancelled the request, or its host gave up) or the connector
  gives up, the tab is told to drop the call, so a proposal cannot be applied after nobody is waiting for it.
  The connector sends it for a timed-out call as well; a tab that does not know the frame ignores it.
- **`features` in the challenge.** The connector announces what it can do (`ask`); a list that makes no sense is
  read as none.
- **`declined` and `no-answer`** are no longer reserved: the tab sends them when the person says no, or does
  not answer within 5 minutes.
- The server instructions and the format guide tell an agent what to do: say what is coming, wait, never send a
  declined change again, and not retry in a loop when nobody answers. No tool changed: the list is the same 16
  tools.

## [1.1.0] - 2026-10-12

Review, compare and change many endpoints at once. The new tools and op need Pico 2.2.0 or later: an older
Pico answers `unknown-tool` for the tools and refuses the op as one it does not know. The wire protocol is
unchanged (1), so a connector of this version still works with an older Pico for everything else.

- **`pico_review_contract`**: checks a project, or chosen endpoints, for what a reviewer would raise (an
  endpoint that cannot succeed or never says how it fails, a body on a GET, odd status codes, repeated routes
  and names, names in two styles, headers that belong in the common headers, missing descriptions and
  examples) and returns counts and findings, each with a rule, a severity, where, and a fix. Advice only.
- **`pico_diff_with_openapi`**: compares a project with an OpenAPI document, for example the one the code
  generates. The project is the baseline; it lists what exists on one side only and what differs in the
  endpoints both have, marking the changes that would break a caller. It reads the JSON kind of a body when the
  document offers several, names a body or response that the document writes as a list or a map and does not
  compare it, and does not call a change of type breaking when it still fits.
- **`patch_endpoints`**, an op of `pico_apply_ops`: one change to many endpoints, chosen by id, folder, method
  or path. It adds responses and headers, removes headers, appends to descriptions, renames a field at every
  depth and turns the common headers on or off. Each change is skipped where it is already made, so repeating
  it changes nothing, and `dryRun` reports without changing.
- The `review_contract` and `sync_contract_with_code` prompts use them; the format guide and the server
  instructions teach them.
- The tool list grows from 14 to 16 tools and from about 18,000 to about 24,100 characters; its test budget is now 25,000.

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
