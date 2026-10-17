# Pico MCP

[![CI](https://github.com/hermasyp/pico-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/hermasyp/pico-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Let an AI agent such as **Claude Code, Codex, OpenCode, Claude Desktop or Cursor** read and edit your API contracts in
[Pico](https://pico.hermasyp.space), the client-only API contract editor. The agent can

- turn a **design** (a screenshot you give it) into endpoints, using its own eyes;
- turn **existing code** (routes, DTOs, annotations) into endpoints, or write OpenAPI and import it;
- turn a **recording** of real requests (a HAR file from the browser's network tab, or curl commands) into
  endpoints, with tokens and passwords hidden, and put a **design picture** into an endpoint from a file;
- **edit the contract you have open**: "fix this endpoint", "add the error responses", "rename these";
- read the contract back (as OpenAPI, Markdown, a Pico file, or example payloads) to write tests,
  fixtures and client types;
- **review** the contract (endpoints that never say how they fail, repeated routes, names written in two
  styles…) and **compare** it with an OpenAPI document that the code generates, to see where the two have
  drifted apart;
- **change many endpoints at once**: "add the 401 and 500 responses to every endpoint", "rename `user_id` to
  `userId` everywhere", in one step with one Undo.

Everything it does appears in front of you at once, Pico keeps a restore point first, and you can undo it.

## How it works

Pico keeps your projects in your browser; there is no Pico server to hand to an agent. So this package is
a small program that runs **on your own machine**: the agent starts it and talks MCP to it over stdio, and
the Pico tab connects to it over a WebSocket on `127.0.0.1`.

```text
Agent (Claude Code, Codex, OpenCode, Cursor…)
  │  MCP over stdio
  ▼
pico-mcp   this program: Node 20+, started by the agent
  │  WebSocket on 127.0.0.1 only · Host and Origin checked · a one-time code proved, never sent
  ▼
the Pico tab that can edit   (only the projects you shared)
```

What you share reaches the agent (and so the company that runs the model), exactly as if you had pasted it
into its chat; nothing else leaves your computer, and Pico sends nothing to any server for this.

## Install

You need **Node 20 or later**. Download the connector, one file with its dependencies inside:

```bash
curl -L -o pico-mcp.mjs https://github.com/hermasyp/pico-mcp/releases/latest/download/pico-mcp.mjs
```

Then tell your agent to start it. Use the absolute path of the file.

**Claude Code**

```bash
claude mcp add pico -- node /absolute/path/to/pico-mcp.mjs
```

**Claude Desktop** (`claude_desktop_config.json`) and **Cursor** (`.cursor/mcp.json`, or the one in your home directory)

```json
{
  "mcpServers": {
    "pico": {
      "command": "node",
      "args": ["/absolute/path/to/pico-mcp.mjs"]
    }
  }
}
```

**Codex** (the Codex CLI)

```bash
codex mcp add pico -- node /absolute/path/to/pico-mcp.mjs
```

That adds the table below to `~/.codex/config.toml`, where you can also write it yourself. On Windows, put the
path in single quotes so that its backslashes stay as they are.

```toml
[mcp_servers.pico]
command = "node"
args = ["/absolute/path/to/pico-mcp.mjs"]
```

Codex (0.163.0) gives a tool call 300 seconds, and *Ask me first* can keep a change waiting for you for 5 minutes.
Add `tool_timeout_sec = 330` to the table if you use it, so that Pico's own answer reaches the agent when you are
away, rather than Codex's time-out (an older Codex may give a call less, and then this line matters more).

**OpenCode** (`opencode.json` in your project, or `~/.config/opencode/opencode.json` for every project)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "pico": {
      "type": "local",
      "command": ["node", "/absolute/path/to/pico-mcp.mjs"],
      "enabled": true
    }
  }
}
```

`opencode mcp list` starts the connector and should show `pico` as connected. Leave `timeout` out of the entry, or
keep it at `15000` or more: OpenCode gives up on a tool that has been silent for that many milliseconds, and *Ask me first*
is silent for up to 10 seconds between its progress notices.

**Pictures and recordings (optional).** For the agent to hand Pico a design picture or a recording (a HAR file) from a file, start the
connector with the one folder it may read: add `--root` and the folder's absolute path after the path of
`pico-mcp.mjs`, in any of the settings above, for example
`claude mcp add pico -- node /absolute/path/to/pico-mcp.mjs --root /Users/you/design`. Without it the connector
reads no file at all. See [Pictures and recorded traffic](docs/REFERENCE.md#pictures-and-recorded-traffic).

Restart the agent so that it starts the connector. The Claude Desktop and Cursor snippets follow each
product's documentation. The connector itself is tested with the official MCP SDK client over stdio, and it was
also started and used by the real Codex CLI and OpenCode (see [docs/REFERENCE.md](docs/REFERENCE.md#verification)).
Each agent has its own habits, such as how long it waits for a tool, and they are written down in
[Using it with each agent](docs/REFERENCE.md#using-it-with-each-agent).

The package is meant to be published to npm as `pico-mcp`; until it is, use the file above. To build it from
source instead:

```bash
git clone https://github.com/hermasyp/pico-mcp
cd pico-mcp
npm ci
npm run build          # writes dist/pico-mcp.mjs
```

## Connect

1. Ask the agent to connect to Pico. It calls `pico_connect` and shows you a **pairing code**
   (`pico:47631:ABCD-EFGH-…`) and a link.
2. In Pico choose **⋯ → Agent connection…** (or press Ctrl K and run *Connect an agent…*), paste the code and
   press **Connect**. Opening the link fills the code in for you, but never connects by itself: letting an
   agent in is your decision, so you press **Connect** yourself.
3. A chip with a dot and the word **Agent** appears in the top bar. Click it for the pane, where you choose
   what the agent may see and whether it may edit.

Only the Pico tab that can edit may connect. **Browsers:** Chrome and Edge may ask once to allow access to
devices on your local network when a page on the internet talks to `127.0.0.1`: choose Allow. Firefox is
expected to work. Safari does not allow a secure page to open `ws://127.0.0.1`, so it is not supported there.

## Safety

- **Local only.** The connector listens on `127.0.0.1` and refuses a page that is not an allowed Pico.
- **A code that is proved, not sent.** A random 128-bit token is made on each start; the tab and the connector
  prove they know it with HMAC-SHA256 over fresh nonces, so it never travels.
- **Least privilege.** By default the agent sees only the project that is open; you tick more. A project you
  did not share is never read, named or changed. **Ask me first** holds every change until you apply it in
  Pico; a **Read only** switch refuses every change.
- **Everything is restorable.** Pico keeps a restore point before the first change of a burst of edits, and one
  Undo message takes the whole burst back, exactly or not at all.
- **Nothing runs.** The tools read and edit a contract. They do not execute requests or open connections.
  The connector reads a file only if you started it with `--root <folder>`, and then only a picture or a recording
  inside that folder that the agent names. It sends what it reads to the Pico tab and nowhere else, but an agent
  can read an imported recording back as endpoints, so tokens, keys and passwords in it are hidden (a rule of
  thumb, not a promise; see the reference), and names and other personal details are not.

The details, the limits and what this does **not** protect against are in
[docs/REFERENCE.md](docs/REFERENCE.md#security). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Documentation

[docs/REFERENCE.md](docs/REFERENCE.md): the options, every tool and prompt, the errors, the limits, the
security model, troubleshooting, and the protocol for anyone building another end of it.

## For developers

The package also exports the library that Pico's web app imports, so that the two ends cannot drift apart:
`pico-mcp/protocol` (frames, pairing codes, proofs, limits), `pico-mcp/catalog` (the tools, the guide, the
prompts) and `pico-mcp/vocabulary`.

```bash
npm ci
npm run verify         # type-check, tests, build
npm run host-check -- codex   # optional: start the built connector from a real Codex or OpenCode
```

## License

[MIT](LICENSE). The single-file connector bundles a few packages; their licences are in
`dist/THIRD_PARTY_LICENSES.txt` and attached to each release.
