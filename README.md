# Hyperlink

**The hyperlink connected every page on the web. Hyperlink connects every app.**

Hyperlink is a many-to-many middleman for AI agents. You run it on your machine, add your apps to it as connectors (MCP servers), and every agent (Claude Code, Cursor, your own) connects to Hyperlink once and reaches all of them.

```
 your agent ─┐                       ┌─ Chrome      (an MCP server it starts)
 Claude ─────┤──► HYPERLINK ◄────────┼─ GitHub      (an MCP server it starts)
 Cursor ─────┤    one MCP server     ├─ Notion      (a hosted MCP server)
 a script ───┘                       └─ …
```

## What it does today (v0.1)

- **One MCP server in front of all your MCP servers.** Connectors are started from a command or reached at an address; their tools are offered as `<connector>__<tool>` at `http://127.0.0.1:7466/mcp`.
- **Live.** Add or remove a connector while it runs and it starts or stops at once.
- **Local and locked.** It listens on 127.0.0.1 only, every call needs its token, requests naming another host are refused (no DNS rebinding), and pages from other sites are refused.
- **Logged, not recorded.** Every call is logged as what, how long and whether it worked, never its arguments or results. You can see the log on the status page at `http://127.0.0.1:7466/`.

## The brain: when nothing connects, it makes a way

```sh
hyperlink make "Wikipedia: search articles, and read an article's summary"
```

```
  The brain is writing it (try 1 of 3)…
  Testing it in the sandbox…
  2 tries, 20 s, 4221 tokens

  ┌ wikipedia: Searches English Wikipedia and reads article summaries.
  │ reaches   en.wikipedia.org
  │ reads     search_articles: Searches English Wikipedia and returns up to 10 matching articles…
  │ reads     read_summary: Reads an English Wikipedia article's introductory summary.
  │ tested    search_articles: ok in 545 ms, 1218 characters
  │ tested    read_summary: ok in 245 ms, 3139 characters
  └ runs in its own process: no files but its own, no programs, network only to the hosts above

Add it? [y/N]
```

1. **It writes** a connector: a plain definition of tools, in TypeScript, with no imports and no access to the process.
2. **It tests** it for real: Hyperlink starts it in a sandbox and runs every tool that changes nothing against the live service. Failures go back to the brain to fix, up to three tries.
3. **You approve** the permit card: what it reaches, what it reads, what it changes, how its tests went. Nothing is added without your yes (`--yes` skips the question).
4. **It runs sandboxed:** its own process under Node's permission system (no files but its own, no programs, no workers), no global fetch, and a fetch that reaches only the hosts on its permit.

The brain is any OpenAI-compatible model; MiniMax M3.1 Flash by default (`HYPERLINK_MODEL_URL`, `HYPERLINK_MODEL`, `HYPERLINK_MODEL_KEY`). It wakes only to make or repair: a working connector runs with no AI at all. Point it at an API's docs with `--docs <url>`.

## Repair: when a service changes, the brain fixes its connector

A connector the brain made that will not start, or fails three calls in a row, is marked as needing repair.

```sh
hyperlink repair wikipedia
```

The brain gets its code and its last errors, writes a fix, and Hyperlink tests it in the sandbox like a new one. A fix that needs no more than its permit (the same hosts, keys and kinds of tools) goes in at once; one that needs more (a new host, a new key, a tool that now changes things) waits for your yes. The old version is kept as `connector.ts.previous`, and the connector starts again before the repair answers.

## The vault: keys sealed, each connector gets only its own

```sh
hyperlink secret set github GITHUB_TOKEN    # asked for hidden (or piped in), never on the command line
hyperlink secret list                       # names only; values are never shown
```

- **Sealed at rest.** Keys live in `vault.enc` (AES-256-GCM). Its key is kept by the operating system: Windows DPAPI, the macOS Keychain, or the Secret Service on Linux; on a server, `HYPERLINK_VAULT_PASSWORD`. Where none of those is there, Hyperlink keeps nothing rather than keep it in plain text.
- **Nothing secret in the list.** `connectors.json` holds a `<vault>` placeholder where a key goes. A key written there in plain text (by hand, or by an app that installed a server) is moved into the vault as soon as Hyperlink sees it.
- **Each connector gets its own keys and no one else's,** when it starts; nothing it inherits from Hyperlink's environment looks like a key. Change a key and the connector starts again with it.
- **The brain never sees a secret.** A made connector declares the keys it needs; they reach it at run time, never its code.

## Sign-in: apps that need you to log in once

Some apps (Gmail, Google Calendar, most "Sign in with…" APIs) need you to sign in rather than give a key. A connector can declare its sign-in (OAuth 2), and Hyperlink does the rest:

```sh
hyperlink ready add gmail     # a connector that comes with Hyperlink: its permit card, then your yes
hyperlink signin gmail        # your app's client ID once, then the app's own sign-in page in your browser
```

- **Your password goes only to the app's page.** Hyperlink listens on this machine for the answer (an authorization code with PKCE) and keeps the refresh token it ends with in the vault.
- **Every call gets a fresh access token,** renewed as it runs out; the connector never sees your password or the refresh token's use beyond its own app.
- **Until you sign in it still starts,** and its tools answer with a sentence saying you have to; the status says the sign-in is needed.
- **The permit card shows where it signs in and what it asks for;** a repair that asks for more needs your yes.

The client ID is your own app's, made once in the app's developer console (for Google: a project with the Gmail API on, and an OAuth client of the kind "Desktop app"). It is kept in the vault like any key.

**Gmail** (`ready/gmail.ts`) uses Google's Gmail API, no browser: search with Gmail's own search words, read a message or a whole thread, list labels, send or reply, save a draft, and change labels (mark read, archive, star). It asks for `gmail.modify`, which reads, sends and labels mail but cannot delete it for good.

## Where it is going

- **Links:** "when this happens in A, do that in B", planned by the brain from a sentence, then running with no AI at all.
- **The map:** your apps around the brain, links lit as data flows.

## Use it

```sh
npm install -g hyperlink-mcp        # or run from a clone: npm install && npm run build
hyperlink add chrome -- npx -y @playwright/mcp
hyperlink start                     # http://127.0.0.1:7466
```

Point any MCP client at `http://127.0.0.1:7466/mcp` with the header `Authorization: Bearer <token>`. The token is in `~/.hyperlink/token` (set `HYPERLINK_HOME` to keep Hyperlink somewhere else).

| Command | |
|---|---|
| `hyperlink start [--port 7466]` | run Hyperlink |
| `hyperlink add <name> -- <command> [args…]` | add a connector Hyperlink starts |
| `hyperlink add <name> --url <address>` | add a connector that runs elsewhere |
| `hyperlink remove <name>` | remove one |
| `hyperlink list` | the connectors in the list |
| `hyperlink status` | how a running Hyperlink's connectors are |
| `hyperlink make "<what>" [--docs <url>] [--yes]` | the brain writes a connector, tests it, asks you |
| `hyperlink repair <name> [--yes]` | the brain fixes a connector it made that stopped working |
| `hyperlink secret set <connector> <NAME>` | keep a key in the vault |
| `hyperlink secret list [connector]` | the keys kept (names only) |
| `hyperlink secret remove <connector> <NAME>` | forget one |
| `hyperlink signin <connector>` | sign in to its app once, in your browser (OAuth); kept in the vault |
| `hyperlink ready [add <name>] [--yes]` | the connectors that come with Hyperlink; add one |

## Built with

TypeScript on Node 22.18+, and the official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk). Hyperlink is also the way [Freya](https://github.com/aslamwebz), a desktop AI companion, reaches every app outside herself.

## License

MIT
