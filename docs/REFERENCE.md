# Pico MCP reference

What the connector does, how to run it, what it offers an agent, and how it is built. For installing and
connecting, start with the [README](../README.md).

- [How it works](#how-it-works)
- [Options](#options)
- [Using it with each agent](#using-it-with-each-agent)
- [What the agent may see and do](#what-the-agent-may-see-and-do)
- [Tools](#tools), [Review and comparison](#review-and-comparison), [Changing many endpoints](#changing-many-endpoints),
  [Pictures and recorded traffic](#pictures-and-recorded-traffic), [Errors](#errors) and [Prompts](#prompts)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [The protocol](#the-protocol)
- [Developing](#developing)
- [Verification](#verification) and [Limits](#limits)

## How it works

```text
Agent (Claude Code, Codex, OpenCode, Cursor…)
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
forwarded to the Pico tab, which answers them. Two start from a file, and the connector reads that file, only
if you started it with `--root` (see [Pictures and recorded traffic](#pictures-and-recorded-traffic)):
`pico_import_har` works out endpoints from a recording and asks the tab to add them, and `pico_attach_image`
hands a picture to the tab. The tab applies and checks everything; the connector never edits anything.

## Options

The connector is started by an agent, so there is nobody to ask: everything has a default that works with
the hosted Pico and with a local dev server, and a mistake in what was given stops it at once with a message
(on stderr, with a status of 2) that says what to change.

| Option | Environment | Meaning |
|---|---|---|
| `--port <n>` | `PICO_MCP_PORT` | Port on `127.0.0.1`. Default **47631**; if it is taken the next nine are tried. `0` means any free port. The pairing code says which one was used. |
| `--url <address>` | `PICO_URL` | Where Pico is, for the pairing link. Default `https://pico.hermasyp.space/`. Its origin is allowed to connect. |
| `--origin <address>` | `PICO_MCP_ORIGINS` (comma-separated) | Another page address allowed to connect. Repeat the option for several. |
| `--root <folder>` | `PICO_MCP_ROOT` | The one folder the connector may read pictures and recordings from, as an absolute path such as `/Users/you/design`. Without it the connector reads no file. See [Pictures and recorded traffic](#pictures-and-recorded-traffic). |
| `--verbose` | | Log what happens to stderr (never the code). |
| `--version` | | Print the version and exit. |
| `--help` | | Print the options and exit. |

A tab may connect from `https://pico.hermasyp.space`, `http://localhost:5173`, `http://127.0.0.1:5173`,
`http://localhost:4173` and `http://127.0.0.1:4173` (the dev server and `vite preview`) without any
option. Anything else, such as Pico served from another address, needs `--origin`.

stdout belongs to MCP: everything meant for a person goes to stderr, except the output of `--help` and
`--version`, which start nothing.

## Using it with each agent

Any program that can start an MCP server over stdio can start the connector, so this is what to set and what
differs from agent to agent, not a list of what is allowed. The settings themselves are in the
[README](../README.md#install).

| Agent | Where it is set | Tried |
|---|---|---|
| Claude Code | `claude mcp add` | Not run here; the setting follows its documentation. |
| Claude Desktop | `claude_desktop_config.json` | Not run here; the setting follows its documentation. |
| Cursor | `.cursor/mcp.json` | Not run here; the setting follows its documentation. |
| Codex | `~/.codex/config.toml` | Codex CLI 0.163.0 started it, listed the tools and called them. |
| OpenCode | `opencode.json` | OpenCode 1.19.2 started it, listed the tools and called them. |

What *tried* covers, and what it does not, is under [Verification](#verification).

### Codex

- **The setting.** `codex mcp add pico -- node /absolute/path/to/pico-mcp.mjs` writes a `[mcp_servers.pico]` table
  with `command` and `args` to `~/.codex/config.toml`, which every project uses. `codex mcp list` shows it.
- **Options go in `args`.** Codex starts the connector with a small environment of its own: a variable set in your
  shell, such as `PICO_MCP_PORT`, did not reach it. Give the options as arguments, for example
  `args = ["/absolute/path/to/pico-mcp.mjs", "--port", "47700"]`, or list the variable in the entry's `env` table.
- **How long it waits for a tool.** Every call has a limit, `tool_timeout_sec` in the entry, and progress notices do
  not move it: with it set to 20 seconds, a change that waited for the person was cut after 20 seconds although the
  connector had sent notices. Codex 0.163.0 gives a call 300 seconds when the entry says nothing, which is the 5
  minutes that Pico waits for you, so the default is nearly right: if you do not answer, the agent is given Codex's
  time-out at about the moment Pico would have given it `no-answer`. Set `tool_timeout_sec = 330` and Pico's own
  answer, which tells the agent not to retry in a loop, arrives first. An older Codex, or a lower setting, cuts the
  wait short, and then the next point applies.
- **It does not say when it gives up.** When its limit passed, Codex did not tell the connector (MCP has a
  `notifications/cancelled` message for this) and went on, so the connector kept the call, and Pico kept the
  question, until you answered it or the 5 minutes ended. If you apply it then, the change is made, although the
  agent was told that the call failed: after a time-out, look in Pico before asking the agent to try again.
  If Codex itself ends while a change waits (we sent it an interrupt), the connector ends with it, and Pico
  drops the question.
- **What it showed.** Codex listed the 18 tools as one group under the name you gave the server (`pico`), with the
  connector's instructions as the group's description, and asked for progress notices on every call. It did not
  ask for the prompts (see below). With the connector started with `--root`, a picture file given to
  `pico_attach_image` reached the tab byte for byte, and a recording given to `pico_import_har` came back as a
  call of `pico_add_endpoints`.

### OpenCode

- **The setting.** The `mcp` table of `opencode.json`, in your project or in `~/.config/opencode/opencode.json`.
  `command` is one list: the program, then its arguments. `opencode mcp list` starts the connector and shows `pico`
  as connected.
- **Tool names carry the name of the server.** With the server called `pico`, the tools are `pico_pico_connect`,
  `pico_pico_status` and so on; call the server something else and the front changes with it.
- **`timeout` is how long OpenCode waits without hearing anything.** The entry's `timeout` (in milliseconds; the
  OpenCode documentation describes it as the time to list the tools, 5 seconds unless set) also limits a call, and it
  behaves as if every progress notice started the count again. The connector sends a notice every 10 seconds while a
  change waits for you, so 15 seconds or more is no problem: a wait of 25 seconds went through with 15, one of 45 with
  30, and with nothing set waits of 75 seconds and of the connector's whole 5 minutes and 15 seconds went through
  (the last one ended with the connector's own `timeout` message). A shorter `timeout` cuts the wait: 5 seconds ended
  it after 5 and 10 seconds after 20. OpenCode then tells the connector (it sent `notifications/cancelled` before any
  answer), so Pico drops the question, and the agent is given `MCP error -32001: Request timed out`. Leave `timeout`
  out, or keep it at 15000 or more.
- **Environment.** OpenCode starts the connector with its own environment, so `PICO_MCP_PORT` and the other
  variables reach it; the entry's `environment` table adds more.
- **What it showed.** OpenCode listed the 18 tools and asked for progress notices on every call. It did not ask
  for the prompts (see below). With `--root`, its picture and its recording went through as Codex's did. If OpenCode itself ends while a change waits (we sent it an interrupt), the
  connector ends with it, and Pico drops the question.

### Prompts with these agents

The prompts (`contract_from_design` and the others, see [Prompts](#prompts)) are offered to agents that list MCP
prompts, as Claude Code does as slash commands. In the runs Codex and OpenCode only asked for the tools, so with
them say in plain words what you want: the tools, their descriptions and `pico_format_guide` carry the same
guidance.

## What the agent may see and do

This part is what the Pico tab does with the connection; it is described here because it is what you see.

- **Sharing.** By default the agent sees only the project that is open when you connect. In the pane you tick
  the other projects it may see, or *Every project*. A project that is not shared is never read, named or
  changed; asking for it fails as if it did not exist, and the agent is only told how many projects it cannot
  see. Projects the agent creates are shared with it.
- **Can edit / Ask me first / Read only.** *Can edit* lets changes land at once, with Undo. *Read only* lets
  the agent look; every change is refused with a pointer to this switch. *Ask me first* (Pico 2.3.0 and a
  connector of 1.2.0 or later) holds back every change: Pico works out what it would do, shows you the list
  (`+` added, `~` changed, `−` removed, with the warnings), and only **Apply** makes it. **Decline** answers
  the agent with `declined` and changes nothing; so does no answer within 5 minutes (`no-answer`). Reading,
  `pico_focus` and a change that would change nothing never wait for you. If your contract changed while a
  proposal waited, it is worked out again and you are asked again, so what you apply is exactly what you
  were shown. The choice is saved for the tab, so a reload keeps it. A connector older than 1.2.0 cannot do
  this: Pico then offers only the other two and, if you had chosen *Ask me first*, falls back to *Read only*
  rather than to *Can edit*.
- **While a change waits.** The agent's call stays open for up to 5 minutes. If the agent asked for progress
  notices, the connector sends one every 10 seconds ("Waiting for the person to approve this change in
  Pico."). An agent that stops waiting sooner has to say so (MCP's `notifications/cancelled`), and then Pico drops
  the proposal and tells you; one that stops without saying so leaves the question in Pico until you answer it
  or the 5 minutes end (see [Codex](#codex)), and applying it then still makes the change. Only the Pico tab
  shows the question, so it also shows in the top bar and the page title.
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
| `pico_review_contract` | tab | Checks a project, or chosen endpoints, for what a reviewer would raise (see [Review](#review-and-comparison)). Returns counts and findings with a fix for each; changes nothing. |
| `pico_diff_with_openapi` | tab | Compares a project with an OpenAPI document (for example one the code generates): what exists on one side only, and what differs in the endpoints both have, each change marked breaking or not. Changes nothing. |
| `pico_create_project` | tab | A new empty project, opened like in the UI, optionally with common headers. |
| `pico_add_endpoints` | tab | Up to 200 endpoints with headers, query, body and responses, as fields or as a JSON sample; `onDuplicate` is `skip`, `replace` or `add`. |
| `pico_update_endpoint` | tab | Changes the keys it is given; a section it is given is replaced as a whole. |
| `pico_delete_endpoints` | tab | Deletes endpoints by id (all or nothing); restore point and Undo. |
| `pico_import_document` | tab | A new project from OpenAPI (JSON or YAML) or from a Pico project file; what could not be carried over comes back as warnings. |
| `pico_import_har` | connector, then tab | Turns a recording of real requests (a HAR file, or curl commands) into endpoints and adds them to the open project, to one you name, or to a new one. Answers with counts and notes, never with the recording. A file needs `--root` (see [Pictures and recorded traffic](#pictures-and-recorded-traffic)). |
| `pico_attach_image` | connector, then tab | Puts a PNG, JPEG, GIF or WebP picture from the `--root` folder into an endpoint's description. The picture goes to the tab, not through the agent. |
| `pico_apply_ops` | tab | Up to 50 ordered structural changes with one Undo: rename, duplicate or delete a project, copy endpoints, folders, moving endpoints, common headers, templates, and `patch_endpoints`, one change to many endpoints (see [Changing many endpoints](#changing-many-endpoints)). |
| `pico_undo_last_edit` | tab | Takes back the agent's own latest change, repeatable. In *Ask me first* it asks like any other change. |
| `pico_focus` | tab | Opens a project or endpoint in front of you. Only the screen changes, so it also works in Read only and never asks. |

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
that repeats its parts that way is refused with `too-large`. What its `$ref` references write out is counted by
the same budget, but is read less deep, or left out, with a note, and not refused (a document that would take
far more work to read than any ordinary one does is refused too). The same holds for the document of
`pico_diff_with_openapi`.

### Review and comparison

`pico_review_contract` reports **findings**, each with a `rule`, a `severity`, the `endpointId` (absent when it is
about the project as a whole), `where` in the endpoint, a `message` and a `fix` that names the tool to use. The
severity is `warning` for what is probably a mistake and `hint` for what could be better; nothing blocks an edit,
and the agent is told to drop findings that do not fit the API.

| Severity | Rules |
|---|---|
| warning | `endpoint-unnamed`, `route-conflict`, `name-duplicate`, `status-code`, `field-warning` (what the editor warns about: repeated names, an example that does not fit its type), `no-success-response`, `body-on-get` |
| hint | `no-error-response`, `body-on-delete`, `description-missing`, `example-missing`, `header-repeated` (a header on three or more endpoints that belongs in the common headers), `naming-mixed`, `path-style-mixed`, `trailing-slash` |

With `endpointIds` only those endpoints are checked and the checks across the whole project (`header-repeated`,
`naming-mixed`, `path-style-mixed`) are left out; a route or a name that another endpoint shares is still found.
At most 200 findings are listed, and `counts` covers all of them (`truncated` says when the list is cut short).

`pico_diff_with_openapi` takes the OpenAPI document (3.x or Swagger 2, JSON or YAML, up to 3,000,000
characters) and reads it the way Pico's import reads it: references inside the document (`$ref`) are followed,
`allOf` is merged, Swagger 2 bodies, form parameters and response schemas are read, and a schema is written out
only as deep as keeps it within about 2,000 properties (fewer when many places use references, and what a
property holds, such as a long text or a list of allowed values, counts too); one that does not fit even on its own
is left out. What could not be read or followed (a reference to another file, a cycle, a schema read less deep or
left out, the base path the document says its paths start at) is named in `notes`, quoting a reference in at most
120 characters. The **project is the baseline**. The answer lists `onlyInPico`, `onlyInOpenApi` and `changed` (per
endpoint, with the `where`, the `kind` of change and `before` and `after`), with a `summary` that counts everything.
A change is marked `breaking` when a caller built against the contract would break against the document: for
example a new required request field, a request field that changed type, a response field that was removed,
changed type, may be missing or may be null, an endpoint that is gone, or a success response that is gone. That is
a rule of thumb about requests and responses, not a proof, and each breaking change says why. A change of type
that still fits is listed but not marked breaking: a request field that now takes a number where it took an
integer, a response field that now gives an integer where it gave a number.

- **What is compared.** Methods and paths, headers, query parameters, request bodies and responses, with their
  fields (names, types, required, nullable). Header parameters named `Accept`, `Content-Type` and `Authorization`
  are left out on both sides, because OpenAPI says they are ignored and a framework does not write them. The name
  of a header is not case sensitive, the name of a query parameter is. An enum's values and a file read back as
  text on both sides and are not reported.
- **What is not compared.** A route that stands twice on one side (`/users` and `/users/`, or `/u/{id}` and
  `/u/{uid}`) and that the other side has too, a field name twice in one list and a status twice in one endpoint
  cannot be told from themselves, because the export writes one and the reader keeps one. They are left out and
  named in `notes`, so a project compared with its own export has no differences; a route that only one side has
  is listed as it is, however often it stands. A body or response that the document writes as a list or a map at
  the top is named in `notes` and not compared, because Pico describes the fields of an object. Where the
  document offers a body in several kinds, the JSON one is read.
- **What is listed.** Endpoints with breaking changes come first, and in an endpoint the breaking changes come
  first. At most 200 endpoints on either side only, 100 changed endpoints and 50 changes in each are listed, and
  when the answer would still be longer than an answer may be it is shortened further; `truncated` says so, and
  `summary` always counts everything.

The review is shortened in the same way when its findings would not fit, keeping the first ones and all the
counts.

### Changing many endpoints

`patch_endpoints` is an op of `pico_apply_ops`, so it shares the call's single step: one restore point and one
Undo, and if a later op fails nothing changes.

- **`where`** picks the endpoints. Give at least one of `endpointIds`, `folder` (a name or id; empty text means no
  folder; a name that several folders have takes all of them, and the answer says so), `method` and `pathPrefix`
  (`/orders` takes `/orders` and what is below it, not `/orders-archive`); an endpoint must match all that are
  given, so "everything" is never an accident (`pathPrefix` `/` says it on purpose).
- **`patch`** says what to do, at least one of `addResponses` (the shape `pico_add_endpoints` takes, each status
  once), `addHeaders`, `removeHeaders` (not one that `addHeaders` adds), `appendDescription`, `renameField`
  (`from`, `to` and where: `query`, `body`, `responses` or `headers`; without it query, body and responses) and
  `useCommonHeaders`.
- Each change is **skipped where it is already made**, so repeating the call changes nothing (the answer says
  `changed: 0`). A header counts as there when the endpoint has it or, once the patch is done, the project's
  headers give it. A note counts as there when the description has it as a paragraph. A header of the project is
  not taken off an endpoint by `removeHeaders` (the answer warns: turn the project's headers off for the endpoint
  with `useCommonHeaders`, or change them with `set_common_headers`). A rename into a name that is already used
  beside the field (or, for a header, one of the project's) is not done and is reported.
- **A limit on what it adds.** The fields a patch adds are counted for every endpoint that gets them, together
  with the rest of the call, against the 20,000 fields a call may have; over it, the call is refused before any
  of it is applied. A dry run counts the same. What the answer lists is short too: the first 50 endpoints that
  would change, and at most five header or response names for each.
- **`dryRun`: true** reports what would change, without changing it. `matched` and `changed` count all the
  endpoints. A dry run is still a call of the change tool, so a *Read only* connection refuses it.

### Pictures and recorded traffic

Two tools start from a file: `pico_attach_image` puts a design picture into an endpoint, and `pico_import_har` turns a
recording of real requests (a HAR file, or curl commands) into endpoints. A message to an agent carries neither well,
so the connector reads the file itself. That is the one place where it touches your disk, so it is **off** until you
turn it on: start the connector with `--root <folder>` (or set `PICO_MCP_ROOT`), an absolute path such as
`/Users/you/design` or `C:\Users\you\design`. Without it both tools answer `not-enabled`, with a hint that says what
to change, and nothing is read. (`pico_import_har` also takes curl commands as text in `content`, which reads no file.)
A folder that does not exist, is not a folder or is not absolute stops the connector at once, with a status of 2,
before it listens.

**What it may read.**

- Only inside that folder, as a path relative to it or an absolute one, and only a regular file whose real path is
  inside it. `..`, a link that leads out, a folder that is a link, a named pipe, a device and a folder are refused.
  A file that is missing, outside the folder or reached through a link gets one answer (`not-found`), so the agent
  learns nothing about the rest of the disk.
- Only a file that is what the tool wants, judged by its first bytes and not by its name: a PNG, JPEG, GIF or WebP
  picture (up to 3,000,000 bytes, 16,384 pixels on a side and 40,000,000 pixels in all), a HAR file (JSON with
  `log.entries`) or text of curl commands (up to 25,000,000 bytes). A HAR file of more than 20,000 entries is
  refused, and a body of more than 1,000,000 characters is left out, with a note.
- A file is read once, from an open handle and up to its limit, so a file that grows or is swapped while it is
  read changes nothing. An error never repeats what a file holds.

**`pico_attach_image`** finds the type and size of the picture from its bytes and sends the picture to the tab inside
the call (as base64, which is why 3,000,000 bytes is the most: it leaves room in a 4 MiB message). The agent is
told what was read (name, type, pixels, bytes) and never receives the bytes. Pico shrinks and stores the picture
the way it does one you add yourself, and the endpoint's description shows it. It needs Pico 2.4.0 or later: an
older Pico answers `unknown-tool`, and the connector then tells the agent to ask you to reload Pico. In *Ask me
first* the picture is listed by its name, type and size, and nothing is stored until you apply it.

**`pico_import_har`** reads the recording, works out the endpoints, and adds them with `pico_add_endpoints`: to the open
project, to `projectId`, or to a new project named by `newProject`, which is made first with `pico_create_project` and
gets the headers that every call had as its common headers. It works with any Pico that has those two tools. The
answer holds counts, the host used, how many values were hidden, notes and the first 60 routes, never a body or a value
from the recording.

- *Which calls.* Requests to web addresses that look like an API's: the browser called them XHR or fetch, or they
  sent or answered JSON. Pages, scripts, styles, images, fonts, preflights (`OPTIONS`), `HEAD` and any method that
  Pico does not have are left out. Of several hosts the one with most calls is used; `hosts` names others, and the
  notes name the ones left out.
- *Paths.* A segment that is a number, a UUID, a ULID, a long hex string or another long opaque string becomes a
  parameter named after the segment before it: `/users/42/orders/7` is `/users/{userId}/orders/{orderId}`. Calls
  with the same method and path become one endpoint, named like “List users”, “Get user” and “Create user”.
- *Fields.* The query, the body and the response are read from every sample of an endpoint and merged. A field is
  `required` only when two or more samples had it and every one did; a field with different types in different
  samples is a string, with a note. Nesting stops at 6 levels, a level at 200 fields and a call at 200 endpoints (the
  notes say what was left out). A response that is a list is described by its items, and the description says so.
  GraphQL on one path is flagged, because every operation shares it.
- *Ask me first.* With `newProject` there are two calls to Pico, the project and then the endpoints, so you are asked
  twice. If the second is declined or fails, the answer says that the project was made.

**Secrets.** A recording is full of them. With `redact: "secrets"`, the default, a value is replaced by `<redacted>`
when its name says it is a secret (`Authorization`, `Cookie`, `Set-Cookie`, and any header, query parameter or JSON key
with a word such as token, password, secret, session, signature or key in the sense of an API key), when it has the
shape of one (a JWT, `sk-…`, `ghp_…`, an AWS or Google key, `Bearer …`, `Basic …`, a long hex or base64 string, a
card number), or when it is the user and password of an address (`https://user:pass@host`); and so is a token inside a
longer text. That holds for the path, the query, the headers, the bodies and the responses, and a name that is
itself a token becomes `<key>`. It is a rule of thumb, not a promise: a secret with an innocent name and an
ordinary shape is not found. `all-examples` keeps no example value at all, only names and types, and is the choice for
a recording of real data; `none` keeps everything, and the answer says so. A curl command's `@file` is never followed
(a note says the body is missing) and `-u` becomes `Authorization: Basic <redacted>`. Nothing in a recording is run,
fetched or opened. What is left of it reaches the agent, which can read the endpoints back, and Pico, so look at them
in Pico before you share the contract.

### Errors

An error carries a code, a message, sometimes the `path` of the argument and a `hint` for what to do.

| Code | Meaning |
|---|---|
| `invalid-arguments` | The arguments break the rules; the message gives where. For a file: it is not what the tool wants (a folder, or not a picture or a recording that can be read). |
| `not-found` | There is no such project or endpoint, or it is not shared. The message lists the valid ones. For a file: there is none inside the `--root` folder. |
| `not-editable` | This tab cannot save right now (not the editing tab, or storage is stuck). Reading still works. |
| `read-only` | The person limited the connection to reading. |
| `conflict` | The person changed those projects after the edit, so taking it back would lose their work. Also: Pico already holds as many proposals as it will wait on, so wait for the person before sending more; or the person changed what you may do while the change waited, so it was not made and may be sent again. |
| `too-large` | The answer would be too long, or a message too large to send. For a file: it is over the limits above. |
| `unknown-tool` | The tool does not exist, or belongs to the other side. |
| `not-connected` | No Pico tab is connected: call `pico_connect` and show the code. |
| `not-enabled` | A tool that reads a file was used, but the connector was not started with `--root`. Only the connector says this. Tell the person what to change; do not try other paths. |
| `disconnected` | The tab went away while the call was running. |
| `timeout` | The tab did not answer within 30 seconds (or, for a change that waits for the person, said nothing within 5 minutes and 15 seconds). The connector then tells the tab to drop the call. |
| `internal` | Something unexpected happened; try a smaller request. |
| `declined` | In *Ask me first* the person said no. Nothing was changed. Do not send the same change again; ask what they want. Three refusals within two minutes make Pico refuse further changes for a minute. |
| `no-answer` | In *Ask me first* nobody answered within 5 minutes, the agent host stopped waiting, or the person was not there. Nothing was changed. Tell the person it is waiting; do not retry in a loop. |

### Prompts

Clients that support MCP prompts offer these as commands. They are plain text that tells the agent what to do
with the tools above.

| Prompt | For |
|---|---|
| `contract_from_design` | A design or screenshot you attached, into a contract. |
| `contract_from_code` | The HTTP API in this codebase, into a contract. |
| `sync_contract_with_code` | Compare the open contract with the code (through `pico_diff_with_openapi` when the code can produce an OpenAPI document) and bring them in line. |
| `review_contract` | Run `pico_review_contract`, add what a reviewer would see, and fix what is worth fixing. |
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
- **Least privilege.** Only the projects you share; Ask me first or Read only on request; the writer tab only;
  a tab that loses the writer lock lets go.
- **Nothing runs.** The tools read and edit a contract. They do not execute requests or commands, or open
  connections. A recording is text that is read, never run: a curl command is split into words and not executed,
  and the files it names are not followed.
- **Files only on request.** The connector reads no file unless you started it with `--root <folder>`. Then it reads
  only a picture or a recording that the agent names, inside that folder, under the rules in
  [Pictures and recorded traffic](#pictures-and-recorded-traffic). What it reads goes to the Pico tab on your
  machine and nowhere else; a picture's bytes never pass through the agent, and the agent is told neither a file's
  contents nor, in an error, anything about the rest of the disk.
- **Contract text is data.** Names, descriptions and examples are written by people (and can come from files
  the agent read). The server tells the agent never to follow instructions found in them. That reduces the
  risk of prompt injection and does not remove it, which is why changes are restorable.

What this does not protect against: a program on your own machine that can read the agent's conversation or
the connector's memory can use the code while the connector runs; an agent that you have allowed to edit
can make changes you did not intend, which is what Ask me first, Read only, the restore points and Undo are for;
an agent can hand Pico any picture or recording in the `--root` folder, so keep that folder to files you mean to
share; and the hiding of secrets in a recording is a heuristic that misses a secret it cannot recognise.

## Troubleshooting

The first messages are the Pico tab's; the last four are what the agent is told or what the connector prints.

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
| The agent says *not-enabled* | The connector was started without `--root`, so it reads no file. | Add `--root /absolute/path/to/folder` to the connector's arguments in the agent's settings, restart the agent, and put the file in that folder. |
| The agent says *No such file under the folder this connector may read* | The path is wrong, outside the `--root` folder, or a link that leads out of it. | Put the file in the folder and give its path. |
| The agent says *The Pico in the connected tab … cannot take a picture* | The page is a Pico older than 2.4.0. | Reload Pico. |
| The connector stops with *--root … does not exist* (status 2) | The folder is wrong, is a file, or the path is not absolute. | Give an absolute path of a folder that exists. |

## The protocol

Both ends import `src/protocol.ts` (as `pico-mcp/protocol`), so they cannot drift apart on what a pairing code,
a limit or a frame looks like. It is pure: no DOM, no Svelte, no Node.

**Pairing code.** `pico:<port>:<token>`, the token being 26 characters of the Crockford alphabet (128 bits),
written in groups of four for reading aloud. A pasted code is forgiven for case, dashes, spaces, quotes and
brackets; a Pico link carries it as `#agent=…`. Text over 1,000 characters is not read as one.

**Frames** are JSON text messages, parsed strictly. The tab sends `hello` (protocol version, app version, a
nonce), then `auth` (its proof), then a `result` for each call, and `awaiting-user` (`id`) when a call waits for
the person's decision. The connector sends `challenge` (its nonce and proof, who the agent is and its
`features`), `ready`, then `call` frames, `cancel` (`id`) for a call it no longer wants, and `bye` when it is
shutting down. Each side signs
`pico-agent/<version>|<role>|<client nonce>|<server nonce>` with HMAC-SHA256 and the token as the key; the role
is part of it, so a proof made for one side is of no use to the other.

**Close codes** in the 4000 range are ours: `badRequest` 4400, `badProof` 4401, `handshakeTimeout` 4408, `busy`
4409, `tooLarge` 4413, `version` 4426, and 4000 for a goodbye. The connector waits 30 seconds for an answer and
pings every 15. Once the tab has said `awaiting-user` for a call it waits 5 minutes plus 15 seconds from that
notice (once per call; saying it again changes nothing), which is longer than the 5 minutes the tab gives the
person, so the tab's own answer comes first.

**Pictures and recordings add no frame and no ability.** `pico_attach_image` is a call like any other, with the picture
inside its arguments (`image: { name, mime, data }`, where `data` is base64), and a Pico without the tool answers
`unknown-tool`. `pico_import_har` calls two tools that every Pico since 2.1.0 has.

**Versions.** `AGENT_PROTOCOL` is 1. A change that an older end could not understand raises it, and the two
ends then refuse each other with a message that says so. Adding a tool does not: a tab answers `unknown-tool`
to a tool it does not know.

**Abilities.** An ability that only some versions have is announced in the connector's challenge as `features`
(today `ask`), and the tab uses it only when it is named: a tab never sends `awaiting-user` to a connector that
did not announce `ask`, because a connector drops the socket on a frame it does not know. A tab ignores a frame
it does not know, so the connector may send `cancel` to any tab. A `features` list that makes no sense is read
as "none"; it never makes the connector unusable.

| | connector 1.1.0 or earlier | connector 1.2.0 or later |
|---|---|---|
| **Pico 2.2.0 or earlier** | as before | as before: the tab never asks the person, so nothing waits |
| **Pico 2.3.0 or later** | *Can edit* and *Read only* only | all three modes |

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
| What a tool gives back, and the progress notices | `src/connector/results.ts` |
| Reading a file, and what may be read | `src/connector/files.ts` |
| Recorded traffic to endpoints, and hiding secrets | `src/connector/traffic.ts` |
| The two tools that start from a file | `src/connector/file-tools.ts` |
| The command line entry | `src/connector/server.ts` |

```bash
npm ci
npm run check          # type-check
npm test               # unit tests, including a real stdio round trip against the built file
npm run build          # dist/pico-mcp.mjs, dist/lib/ and dist/THIRD_PARTY_LICENSES.txt
```

**Boundaries.** The library (`protocol`, `catalog`, `vocabulary`) is imported by Pico's web app, so it needs
nothing but its own files and uses neither Node nor the browser; the connector may use the library and its own
files. Only `files.ts` opens a file, and `traffic.ts` is pure (text in, endpoints out). Tests read the sources to
make sure.

**Trying a real agent.** `npm run host-check -- codex` (or `opencode`) builds the connector and starts it from the real
agent program: the one on your PATH, or `--bin <path>`, in an empty temporary directory with settings of its own,
so yours are not read. The model behind the agent is a script that asks for `pico_connect`, `pico_status` and
`pico_add_endpoints`, then for `pico_attach_image` and `pico_import_har` on a picture and a recording in a folder that
the connector is started with (`--root`), and the Pico tab is a stand-in, so no account, model or browser is needed.
It reports what the agent did: which tools it was offered, whether the five calls came back, whether the picture
reached the tab byte for byte and the recording became a call of `pico_add_endpoints`, whether it asked for progress
notices, whether it cancelled a call, which environment reached the connector and how the connector ended. Options make the
third call wait for "the person" (`--ask-wait-s 75`), give the agent a lower limit for a call (`--tool-timeout-sec 20`)
or interrupt it (`--sigint-after-s 5`); `--help` lists them all. It is not part of `npm test` or of CI: it needs
the agent installed (`npm install --prefix ~/.cache/pico-mcp-host-check @openai/codex opencode-ai` is enough, about
700 MB), and what it shows holds for the version that was run. The script is in `scripts/host-check/`, and
`test/host-check.test.ts` tests the parts of it that need no agent. What the runs found is under
[Using it with each agent](#using-it-with-each-agent).

**Adding a tool.** A tool has two halves: its description here (name, access, JSON Schema with
`additionalProperties: false`, in `src/catalog.ts`) and its implementation in Pico, which owns the workspace.
Describe it, list it in the table above (a test fails until this file names every tool, prompt, option, error
code, limit and default), and release both. A Pico that does not have the tool yet answers `unknown-tool`. A tool
that starts from a file is marked `reads: 'file'` in the catalog: the connector reads the file first, so what the
tab is called with differs from what the agent gave, and Pico's tests name it as an exception.

**Releasing.** Update `CHANGELOG.md` and the version in `package.json`, then either push a tag such as `v1.0.1`
or start the *Release* workflow by hand from the Actions tab, on `main`. A pushed tag must be the version in
`package.json`; a manual run reads the version from there, refuses to repeat a release that exists, and creates
the tag itself. Either way the workflow verifies, builds, attaches the tarball, the single-file connector, the
licences of what it bundles and `SHA256SUMS` to a GitHub Release, and publishes to npm when the repository has
an `NPM_TOKEN` secret. A version that already has a release cannot be run again, so adding the secret after
v1.0.0 does not publish v1.0.0: either run `npm publish` once from a clone at that tag, or release the next
version. Pico installs the tarball of a release from its address, so a release that Pico uses must not be
deleted or renamed.

## Verification

`npm run verify` type-checks, runs the unit tests and builds. The tests include a real stdio round trip
against the built file (the official MCP SDK client starts it, lists its tools, pairs a stand-in for the tab
on loopback and hangs up) and a real WebSocket against the hub (the handshake, a forged or wrong proof, a wrong
`Origin` or `Host`, the handshake timeout, a second tab, an oversize frame, calls that fail when the tab goes
away or does not answer). Pico's own tests run its tab against the same protocol and catalog, and its browser
tests drive the built connector with the SDK client and Pico in a real browser.

**Codex and OpenCode.** In October 2026 the built connector was started by the real Codex CLI (0.163.0) and
OpenCode (1.19.2), each in an empty directory with settings of its own. The model was a script that asks for
five fixed calls (`pico_connect`, `pico_status`, `pico_add_endpoints`, then `pico_attach_image` and `pico_import_har`
on a picture and a recording in the folder given with `--root`), and the Pico tab was a stand-in, written
like the one the connector's own tests use, not the page. Both programs started the connector, listed its 18 tools and got
every answer; the picture, 70 bytes, reached the stand-in the same as the file, and the recording became a call of
`pico_add_endpoints` with three endpoints. Both asked for progress notices on every call, and a change that waited for the person went through
after 75 seconds in both and after 150 seconds in Codex. Further runs measured what is written under
[Using it with each agent](#using-it-with-each-agent): the environment each one passes on, Codex's time limit
and what it does when the limit passes, OpenCode's `timeout` and what it does when that passes, and what quitting
each does. These runs are not
part of `npm test`; `npm run host-check` repeats them (see [Developing](#developing)), and they say something about one version
of each program.

Not covered: Claude Code, Claude Desktop and Cursor themselves (only the SDK client was available, so the
configuration snippets follow each product's documentation), a real model behind Codex or OpenCode, the real
Pico page with either of them, their interactive screens and their own permission questions, other versions of
them, Windows, Firefox, and the browser's local network prompt for a page on the internet.

## Limits

- One tab and one agent at a time; the code is not remembered after the tab closes.
- A picture or a recording is read only from the `--root` folder and within the limits above. The agent cannot read
  a picture back: `pico_get_project` leaves pictures out.
- Path parameters are written `{id}` in the path and described in text; enums keep one example, not a list of
  values (a later Pico file format will model both).
- The connector needs Node 20 or later.
