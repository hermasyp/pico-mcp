# Security

Pico MCP is a program that runs on your own machine and talks to a browser tab, so its security
properties matter. They are described in [docs/REFERENCE.md](docs/REFERENCE.md#security).

## Reporting a problem

Please report a vulnerability **privately**, through the **Report a vulnerability** button on the
Security tab of this repository (GitHub's private vulnerability reporting), and do not open a public issue
for it. Say what you found, how to reproduce it, and which version (`pico-mcp --version` prints it).

## What is in scope

- The connector (`src/connector/`): who can connect to it, what it forwards, what it prints.
- The wire protocol (`src/protocol.ts`): the handshake, the proofs, the frame limits.
- The tool catalog (`src/catalog.ts`): what an agent is told and what it may ask for.

Pico itself (the web app) is a separate project and has its own way of reporting problems.
