# Pico MCP reference

What the connector does, how to run it, what it offers an agent, and how it is built. For installing and
connecting, start with the [README](../README.md).

- [How it works](#how-it-works)
- [Options](#options)
- [What the agent may see and do](#what-the-agent-may-see-and-do)
- [Tools](#tools), [Errors](#errors) and [Prompts](#prompts)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [The protocol](#the-protocol)
- [Developing](#developing)
- [Verification](#verification) and [Limits](#limits)

## How it works

```text
Agent (Claude Code / Desktop / Cursor)
  │  MCP over stdio
  ▼
pico-mcp   the connector: src/connector/, Node 20+, started by the agent, one process per agent session
  │  WebSocket on 127.0.0.1 only · Host and Origin checked · a one-time code proved, never sent
  ▼
the Pico tab that can edit   (only the projects you shared)
  │  reads and edits a workspace, never touches the page itself
  ▼
restore point (once per burst of edits) → your projects → one rolling Undo message
```

The Pico page connects **out** to the connector, which listens on your own machine. What you share reaches
the agent (and so the company that runs the model), exactly as if you had pasted it into its chat; nothing
else leaves your computer, and Pico itself sends nothing to any server for this.

Some tools are answered by the connector itself (`pico_connect`, `pico_format_guide`); the rest are
forwarded to the Pico tab, which answers them. The tab applies and checks everything; the connector never
edits anything.

## Options

The connector is started by an agent, so there is nobody to ask: everything has a default that works with
the hosted Pico and with a local dev server, and a mistake in what was given stops it at once with a message
(on stderr, with a status of 2) that says what to change.

| Option | Environment | Meaning |
|---|---|---|
| `--port <n>` | `PICO_MCP_PORT` | Port on `127.0.0.1`. Default **47631**; if it is taken the next nine are tried. `0` means any free port. The pairing code says which one was used. |
| `--url <address>` | `PICO_URL` | Where Pico is, for the pairing link. Default `https://pico.hermasyp.space/`. Its origin is allowed to connect. |
| `--origin <address>` | `PICO_MCP_ORIGINS` (comma-separated) | Another page address allowed to connect. Repeat the option for several. |
| `--verbose` | | Log what happens to stderr (never the code). |
| `--version` | | Print the version and exit. |
| `--help` | | Print the options and exit. |

A tab may connect from `https://pico.hermasyp.space`, `http://localhost:5173`, `http://127.0.0.1:5173`,
`http://localhost:4173` and `http://127.0.0.1:4173` (the dev server and `vite preview`) without any
option. Anything else, such as Pico served from another address, needs `--origin`.

stdout belongs to MCP: everything meant for a person goes to stderr, except the output of `--help` and
`--version`, which start nothing.

## What the agent may see and do

This part is what the Pico tab does with the connection; it is described here because it is what you see.

- **Sharing.** By default the agent sees only the project that is open when you connect. In the pane you tick
  the other projects it may see, or *Every project*. A project that is not shared is never read, named or
  changed; asking for it fails as if it did not exist, and the agent is only told how many projects it cannot
  see. Projects the agent creates are shared with it.
- **Can edit / Read only.** *Read only* lets the agent look; every change is refused with a pointer to this
  switch. Both are saved for the tab, so a reload keeps them.
- **Restore point.** The first change of a burst of edits (edits less than two minutes apart, at most 25
  changes) keeps a restore point first; Pico lists it in Settings → Storage and backup as *Before agent edits ·
  <agent>* (Pico 2.1.1 and later keeps the newest 10 of these in a place of their own).
- **Undo.** One message per burst offers Undo and takes back everything the agent did in it. Undo is exact or
  declined: if you have changed one of those projects since, it does nothing and points to the restore point,
  so it can never lose your work. The agent can also take back its own latest change with
  `pico_undo_last_edit`, under the same rule.
- **Activity.** The pane lists what the agent did, newest first, and a click opens it. Refused calls are
  listed too.

## Tools

The agent sees these in its tool list. "Runs in" says who answers: the connector itself, or the Pico tab.

| Tool | Runs in | What it does |
|---|---|---|
| `pico_connect` | connector | Gives the pairing code and link, and says whether a tab is connected. |
| `pico_format_guide` | connector | The guide an agent reads once: how Pico describes a contract, field types, how to turn screens, forms and lists into endpoints, and what Pico cannot hold. |
| `pico_status` | tab | The open project and endpoint, the projects it may use, the mode, whether editing works, the limits. |
| `pico_get_project` | tab | A project as an outline, or the endpoints you name in full (the shape the edit tools take). Pictures are never included. |
| `pico_get_examples` | tab | The example request and response bodies Pico generates for an endpoint. |
| `pico_export` | tab | A project or chosen endpoints as `openapi` (YAML), `pico` (a project file), `markdown`, `postman` or `html`. |
| `pico_create_project` | tab | A new empty project, opened like in the UI, optionally with common headers. |
| `pico_add_endpoints` | tab | Up to 200 endpoints with headers, query, body and responses, as fields or as a JSON sample; `onDuplicate` is `skip`, `replace` or `add`. |
| `pico_update_endpoint` | tab | Changes the keys it is given; a section it is given is replaced as a whole. |
| `pico_delete_endpoints` | tab | Deletes endpoints by id (all or nothing); restore point and Undo. |
| `pico_import_document` | tab | A new project from OpenAPI (JSON or YAML) or from a Pico project file; what could not be carried over comes back as warnings. |
| `pico_apply_ops` | tab | Up to 50 ordered structural changes with one Undo: rename, duplicate or delete a project, copy endpoints, folders, moving endpoints, common headers, templates. |
| `pico_undo_last_edit` | tab | Takes back the agent's own latest change, repeatable. |
| `pico_focus` | tab | Opens a project or endpoint in front of you. Only the screen changes, so it also works in Read only. |

Warnings (a duplicate name, an odd status code, a route that repeats, an example that does not fit its type)
come back with the answer and never block an edit. Everything the agent sends is checked strictly and then
normalized, so every endpoint ends up with a header, body and at least one response section. Project
templates are not applied to endpoints the agent adds: they are taken as given.

Calls are limited to 200 endpoints, 50 operations, 100 responses for an endpoint, 20,000 fields, 12 levels of
nesting, 200,000 characters in one text (an example and a sample count by their size as JSON) and 300
characters in a name; an answer longer than 400,000 characters is refused with a hint to ask for less. A frame
is limited to 4 MiB on the wire, counted in bytes, so a very large call is refused for that call alone
(`too-large`) and the connection stays up. A document sent to `pico_import_document` may not expand, once its
YAML aliases are written out, to more values than it has characters (and at least a million): a short file
that repeats its parts into billions of fields is refused.

### Errors

An error carries a code, a message, sometimes the `path` of the argument and a `hint` for what to do.

| Code | Meaning |
|---|---|
| `invalid-arguments` | The arguments break the rules; the message gives where. |
| `not-found` | There is no such project or endpoint, or it is not shared. The message lists the valid ones. |
| `not-editable` | This tab cannot save right now (not the editing tab, or storage is stuck). Reading still works. |
| `read-only` | The person limited the connection to reading. |
| `conflict` | The person changed those projects after the edit, so taking it back would lose their work. |
| `too-large` | The answer would be too long, or a message too large to send. |
| `unknown-tool` | The tool does not exist, or belongs to the other side. |
| `not-connected` | No Pico tab is connected: call `pico_connect` and show the code. |
| `disconnected` | The tab went away while the call was running. |
| `timeout` | The tab did not answer within 30 seconds. |
| `internal` | Something unexpected happened; try a smaller request. |
| `declined`, `no-answer` | Reserved for a later way of asking the person first. This version never sends them. |

### Prompts

Clients that support MCP prompts offer these as commands. They are plain text that tells the agent what to do
with the tools above.

| Prompt | For |
|---|---|
| `contract_from_design` | A design or screenshot you attached, into a contract. |
| `contract_from_code` | The HTTP API in this codebase, into a contract. |
| `sync_contract_with_code` | Compare the open contract with the code and bring them in line. |
| `review_contract` | Find and fix what is inconsistent or missing. |
| `document_endpoints` | Fill in missing descriptions and examples. |
| `contract_test_loop` | Export OpenAPI, run Specmatic or Schemathesis against the service, fix the side that is wrong. |
| `migrate_from_postman` | Convert a Postman collection into a Pico project. |
| `generate_client_types` | Typed models and a thin client for the contract. |
| `explain_contract` | Explain the project to a new teammate; changes nothing. |

## Security

- **Local only.** The connector listens on `127.0.0.1`. It refuses an upgrade unless the `Host` is this
  machine and the `Origin` is an allowed page, which keeps other websites, and DNS rebinding, out.
- **A code that is proved, not sent.** Each connector start makes a random 128-bit token. The tab and the
  connector each prove they know it with an HMAC-SHA256 over fresh nonces, so the token never travels and a
  program squatting on the port learns nothing. The tab checks the connector first and sends nothing if the
  proof is wrong. A wrong proof closes that one socket and nothing more: with a 128-bit token there is nothing
  to guess, and a lockout would only let another program on this machine keep your own tab out. A socket that
  does not finish the handshake is closed, as is any beyond a handful, and one tab is served at a time.
  Frames over 4 MiB are refused.
- **The code is shown once.** It is in the result of `pico_connect` (stdout is the MCP channel, so it is never
  logged) and in the pane. Pico keeps it in the tab's session storage only, nowhere else, and it stops
  working when the connector exits. It does end up in the agent's conversation: treat that transcript as
  holding a one-time key to your running connector.
- **Least privilege.** Only the projects you share; Read only on request; the writer tab only; a tab that
  loses the writer lock lets go.
- **Nothing runs.** The tools read and edit a contract. They do not execute requests, read files or open
  connections, and pictures never cross the bridge.
- **Contract text is data.** Names, descriptions and examples are written by people (and can come from files
  the agent read). The server tells the agent never to follow instructions found in them. That reduces the
  risk of prompt injection and does not remove it, which is why changes are restorable.

What this does not protect against: a program on your own machine that can read the agent's conversation or
the connector's memory can use the code while the connector runs; and an agent that you have allowed to edit
can make changes you did not intend, which is what Read only, the restore points and Undo are for.

## Troubleshooting

The messages are the Pico tab's.

| You see | Because | Do this |
|---|---|---|
| *Pico could not reach the connector…* | The connector is not running, the code is from an earlier run, the browser blocked local network access, or the browser is Safari. | Ask the agent for `pico_connect` again; allow local network access; use Chrome, Edge or Firefox. |
| *That is not the connector that made this code…* | The token does not match, or another program answers on that port. | Use a fresh code. |
| *The connector did not accept the code…* (4401) | Mistyped, or from an earlier run. | Use the current code. |
| *Another Pico tab is already connected…* (4409) | The connector serves one tab. | Disconnect there or close that tab. |
| *This version of Pico and the connector cannot talk…* (4426) | The wire protocol differs. | Update the connector (or Pico, by reloading it). |
| *The connector closed the connection before it finished…* (4408, 4400, 4413) | The handshake took too long or was malformed. | Try again; restart the agent. |
| *This tab is not the editing one…* | Another Pico tab holds the writer lock. | Choose *Use this tab*, or close the other tab. |
| *The connection … was lost and could not be restored.* | The connector stopped and five retries (1, 2, 4, 8 and 16 seconds) failed. | Ask the agent to connect again and paste the new code. |
| *The agent closed this connection.* | The agent ended its session. | Start it again. |
| The agent says *Pico is not connected* | No tab is connected to that connector. | `pico_connect`, then paste the code. |
| The chip shows a red dot | The last attempt failed. | Click it: the pane says why. |

## The protocol

Both ends import `src/protocol.ts` (as `pico-mcp/protocol`), so they cannot drift apart on what a pairing code,
a limit or a frame looks like. It is pure: no DOM, no Svelte, no Node.

**Pairing code.** `pico:<port>:<token>`, the token being 26 characters of the Crockford alphabet (128 bits),
written in groups of four for reading aloud. A pasted code is forgiven for case, dashes, spaces, quotes and
brackets; a Pico link carries it as `#agent=…`. Text over 1,000 characters is not read as one.

**Frames** are JSON text messages, parsed strictly. The tab sends `hello` (protocol version, app version, a
nonce), then `auth` (its proof), then a `result` for each call. The connector sends `challenge` (its nonce and
proof, and who the agent is), `ready`, then `call` frames, and `bye` when it is shutting down. Each side signs
`pico-agent/<version>|<role>|<client nonce>|<server nonce>` with HMAC-SHA256 and the token as the key; the role
is part of it, so a proof made for one side is of no use to the other.

**Close codes** in the 4000 range are ours: `badRequest` 4400, `badProof` 4401, `handshakeTimeout` 4408, `busy`
4409, `tooLarge` 4413, `version` 4426, and 4000 for a goodbye. The connector waits 30 seconds for an answer and
pings every 15.

**Versions.** `AGENT_PROTOCOL` is 1. A change that an older end could not understand raises it, and the two
ends then refuse each other with a message that says so. Adding a tool does not: a tab answers `unknown-tool`
to a tool it does not know.

## Developing

| Area | Where |
|---|---|
| The wire: frames, pairing codes, proofs, limits, close codes | `src/protocol.ts` |
| The tool list, the guide, the prompts, the server instructions | `src/catalog.ts` |
| The words of a contract that the schemas spell out | `src/vocabulary.ts` |
| Options and settings | `src/connector/config.ts` |
| The one-time token and the proofs | `src/connector/auth.ts` |
| The WebSocket hub: Host and Origin, the handshake, calls, the heartbeat | `src/connector/hub.ts` |
| The MCP server built from the catalog | `src/connector/build-server.ts` |
| The command line entry | `src/connector/server.ts` |

```bash
npm ci
npm run check          # type-check
npm test               # unit tests, including a real stdio round trip against the built file
npm run build          # dist/pico-mcp.mjs, dist/lib/ and dist/THIRD_PARTY_LICENSES.txt
```

**Boundaries.** The library (`protocol`, `catalog`, `vocabulary`) is imported by Pico's web app, so it needs
nothing but its own files and uses neither Node nor the browser; the connector may use the library and its own
files. Tests read the sources to make sure.

**Adding a tool.** A tool has two halves: its description here (name, access, JSON Schema with
`additionalProperties: false`, in `src/catalog.ts`) and its implementation in Pico, which owns the workspace.
Describe it, list it in the table above (a test fails until this file names every tool, prompt, option, error
code, limit and default), and release both. A Pico that does not have the tool yet answers `unknown-tool`.

**Releasing.** Update `CHANGELOG.md` and the version in `package.json`, then either push a tag such as `v1.0.1`
or start the *Release* workflow by hand from the Actions tab, on `main`. A pushed tag must be the version in
`package.json`; a manual run reads the version from there, refuses to repeat a release that exists, and creates
the tag itself. Either way the workflow verifies, builds, attaches the tarball, the single-file connector, the
licences of what it bundles and `SHA256SUMS` to a GitHub Release, and publishes to npm when the repository has
an `NPM_TOKEN` secret. Pico installs the tarball of a release from its address, so a release that Pico uses
must not be deleted or renamed.

## Verification

`npm run verify` type-checks, runs the unit tests and builds. The tests include a real stdio round trip
against the built file (the official MCP SDK client starts it, lists its tools, pairs a stand-in for the tab
on loopback and hangs up) and a real WebSocket against the hub (the handshake, a forged or wrong proof, a wrong
`Origin` or `Host`, the handshake timeout, a second tab, an oversize frame, calls that fail when the tab goes
away or does not answer). Pico's own tests run its tab against the same protocol and catalog, and its browser
tests drive the built connector with the SDK client and Pico in a real browser.

Not covered: Claude Code, Claude Desktop and Cursor themselves (only the SDK client was available, so the
configuration snippets follow each product's documentation), Firefox, and the browser's local network prompt
for a page on the internet.

## Limits

- One tab and one agent at a time; the code is not remembered after the tab closes.
- Pictures stay in Pico: the agent cannot read or attach them.
- Path parameters are written `{id}` in the path and described in text; enums keep one example, not a list of
  values (a later Pico file format will model both).
- The connector needs Node 20 or later.
