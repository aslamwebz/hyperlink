#!/usr/bin/env node
import { watch } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_PORT, hyperlinkHome, readConnectors, readOrMakeToken, validName, writeConnectors, type ConnectorConfig } from './config.js'
import { Hub } from './hub.js'
import { startServer } from './server.js'
import { createInterface } from 'node:readline/promises'
import { installStaged, makeConnector } from './brain/make.js'
import type { Permit, TestReport } from './brain/loop.js'
import { modelFromEnv } from './brain/model.js'
import { moveSecretsIntoVault, secretSlot, Vault, VAULT_PLACEHOLDER } from './vault.js'

const USAGE = `hyperlink — one MCP server in front of all your MCP servers

  hyperlink start [--port ${DEFAULT_PORT}]          run Hyperlink (http://127.0.0.1:<port>)
  hyperlink add <name> -- <command> [args…]   add a connector that Hyperlink starts
  hyperlink add <name> --url <address>        add a connector that runs elsewhere
  hyperlink remove <name>                     remove a connector
  hyperlink list                              the connectors in the list
  hyperlink status                            ask a running Hyperlink how its connectors are
  hyperlink make "<what>" [--docs <url>] [--yes]  the brain writes a connector, tests it, and asks you
  hyperlink secret set <connector> <NAME>     keep a key in the vault (asked for, never on the command line)
  hyperlink secret list [connector]           the keys kept (names only)
  hyperlink secret remove <connector> <NAME>  forget one

  Agents connect to http://127.0.0.1:<port>/mcp with "Authorization: Bearer <token>";
  the token is in ${join('<HYPERLINK_HOME>', 'token')} (HYPERLINK_HOME is ~/.hyperlink unless set).`

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv
  switch (command) {
    case 'start': return start(rest)
    case 'add': return add(rest)
    case 'remove': return remove(rest)
    case 'list': return list()
    case 'status': return status()
    case 'make': return make(rest)
    case 'secret': return secret(rest)
    // Internal: how a made connector runs, inside the sandbox.
    case 'connector': return (await import('./kit.js')).runConnector(rest[0] ?? '')
    default:
      console.log(USAGE)
      if (command && command !== 'help' && command !== '--help') process.exitCode = 2
  }
}

async function start(args: string[]): Promise<void> {
  const home = hyperlinkHome()
  const port = Number(option(args, '--port') ?? process.env.HYPERLINK_PORT ?? DEFAULT_PORT)
  const token = await readOrMakeToken(home)
  // The vault: without it, a connector that needs a key does not start (nothing is kept in plain text instead).
  const vault = await Vault.open(home).catch(error => { console.error(`[hyperlink] the vault is closed: ${error instanceof Error ? error.message : String(error)}`); return null })
  /** The list as it should run: any key written in plain text moved into the vault first. */
  const readList = async () => {
    const read = await readConnectors(home)
    if (!vault) return read
    const { configs, moved } = await moveSecretsIntoVault(read, vault)
    if (moved > 0) {
      await writeConnectors(configs, home)
      console.log(`[hyperlink] moved ${moved} key(s) from the connector list into the vault`)
    }
    return configs
  }
  const hub = new Hub(async () => vault ? vault.read() : {})
  await hub.start(await readList())
  const server = await startServer({ hub, token, port, home, vault })
  if (vault) console.log(`[hyperlink] the vault is open (its key kept by ${vault.protectedBy})`)
  const url = `http://127.0.0.1:${port}`
  // Where a caller on this machine finds a running Hyperlink.
  await writeFile(join(home, 'endpoint.json'), JSON.stringify({ url, mcp: `${url}/mcp`, pid: process.pid }, null, 2), 'utf8')
  console.log(`[hyperlink] ${url} · ${hub.status().length} connectors · ${hub.tools().length} tools`)
  for (const entry of hub.status()) console.log(`[hyperlink] ${entry.name}: ${entry.state}${entry.problem ? ` (${entry.problem})` : ` · ${entry.tools} tools`}`)

  // The list is watched: a connector added or removed while it runs starts or stops at once.
  let pending: NodeJS.Timeout | undefined
  const reconcile = async () => {
    const wanted = await readList().catch(() => null)
    if (!wanted) return
    const current = new Map(hub.status().map(entry => [entry.name, entry]))
    for (const name of current.keys()) if (!wanted.some(config => config.name === name)) { await hub.remove(name); console.log(`[hyperlink] ${name}: removed`) }
    for (const config of wanted) {
      if (current.has(config.name) && JSON.stringify(config) === configs.get(config.name)) continue
      await hub.add(config)
      const entry = hub.status().find(item => item.name === config.name)
      console.log(`[hyperlink] ${config.name}: ${entry?.state}${entry?.problem ? ` (${entry.problem})` : ` · ${entry?.tools ?? 0} tools`}`)
    }
    configs = new Map(wanted.map(config => [config.name, JSON.stringify(config)]))
  }
  let configs = new Map((await readConnectors(home)).map(config => [config.name, JSON.stringify(config)]))
  await mkdir(home, { recursive: true })
  // A key set or changed in the vault: the connectors that use one start again with it.
  let pendingKeys: NodeJS.Timeout | undefined
  const rekey = async () => {
    for (const config of await readConnectors(home).catch(() => [] as ConnectorConfig[])) {
      if (![...Object.values(config.env ?? {}), ...Object.values(config.headers ?? {})].includes(VAULT_PLACEHOLDER)) continue
      await hub.add(config)
      const entry = hub.status().find(item => item.name === config.name)
      console.log(`[hyperlink] ${config.name}: ${entry?.state} with its keys${entry?.problem ? ` (${entry.problem})` : ''}`)
    }
  }
  const watcher = watch(home, (_event, file) => {
    if (file === 'vault.enc') { clearTimeout(pendingKeys); pendingKeys = setTimeout(() => { void rekey() }, 300); return }
    if (file !== 'connectors.json') return
    clearTimeout(pending)
    pending = setTimeout(() => { void reconcile() }, 300)
  })

  const stop = async () => {
    watcher.close()
    server.close()
    await hub.close()
    await rm(join(home, 'endpoint.json'), { force: true })
    process.exit(0)
  }
  process.on('SIGINT', () => { void stop() })
  process.on('SIGTERM', () => { void stop() })
  // Started by another program (Freya's supervisor): it goes when that program goes, never left holding the port.
  const parent = Number(process.env.HYPERLINK_PARENT_PID)
  if (parent > 0) setInterval(() => { try { process.kill(parent, 0) } catch { void stop() } }, 2_000)
}

async function add(args: string[]): Promise<void> {
  const [name, ...rest] = args
  if (!name || !validName(name)) return fail('Give the connector a name: letters, digits, dash and underscore.')
  const dash = rest.indexOf('--')
  const url = option(rest, '--url')
  const config: ConnectorConfig = url
    ? { name, url }
    : dash >= 0 && rest[dash + 1]
      ? { name, command: rest[dash + 1]!, args: rest.slice(dash + 2) }
      : fail('Say how to reach it: -- <command> [args…], or --url <address>.')
  const connectors = (await readConnectors()).filter(entry => entry.name !== name)
  await writeConnectors([...connectors, config])
  console.log(`Added ${name}. A running Hyperlink starts it now.`)
}

async function remove(args: string[]): Promise<void> {
  const [name] = args
  const connectors = await readConnectors()
  if (!name || !connectors.some(entry => entry.name === name)) return fail(`There is no connector named "${name ?? ''}".`)
  await writeConnectors(connectors.filter(entry => entry.name !== name))
  console.log(`Removed ${name}.`)
}

async function list(): Promise<void> {
  const connectors = await readConnectors()
  if (connectors.length === 0) return console.log('No connectors yet.')
  for (const entry of connectors) console.log(`${entry.name}${entry.disabled ? ' (off)' : ''}  ${entry.url ?? [entry.command, ...(entry.args ?? [])].join(' ')}`)
}

async function status(): Promise<void> {
  const home = hyperlinkHome()
  let endpoint: { url: string }
  try { endpoint = JSON.parse(await readFile(join(home, 'endpoint.json'), 'utf8')) as { url: string } } catch { return fail('Hyperlink is not running (start it with: hyperlink start).') }
  const token = await readOrMakeToken(home)
  const response = await fetch(`${endpoint.url}/api/status`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) }).catch(() => null)
  if (!response?.ok) return fail(`Hyperlink at ${endpoint.url} did not answer.`)
  const body = await response.json() as { connectors: { name: string; state: string; tools: number; problem: string | null }[]; tools: number }
  console.log(`${endpoint.url} · ${body.connectors.length} connectors · ${body.tools} tools`)
  for (const entry of body.connectors) console.log(`  ${entry.name}: ${entry.state}${entry.problem ? ` (${entry.problem})` : ` · ${entry.tools} tools`}`)
}

async function make(args: string[]): Promise<void> {
  const docs = option(args, '--docs')
  const yes = args.includes('--yes')
  const request = args.filter((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--docs').join(' ').trim()
  if (!request) return fail('Say what to connect, e.g. hyperlink make "Wikipedia: search articles and read a summary"')
  const home = hyperlinkHome()
  const model = modelFromEnv()
  console.log(`Making a connector for: ${request}  (brain: ${model.name})`)
  const started = Date.now()
  const made = await makeConnector(request, { model, home, ...(docs ? { docsUrl: docs } : {}), log: line => console.log(`  ${line}`) })
  const seconds = Math.round((Date.now() - started) / 1000)
  console.log(`  ${made.attempts} tr${made.attempts === 1 ? 'y' : 'ies'}, ${seconds} s, ${made.tokens.input + made.tokens.output} tokens`)
  if (!made.ok || !made.id || !made.file || !made.report?.permit) {
    if (made.report) printReport(made.report)
    return fail(`It could not be made: ${made.problem ?? 'no connector came back'}${made.file ? ` (the last try is in ${made.file})` : ''}`)
  }
  printCard(made.report.permit, made.report)
  if (!yes) {
    const answer = await createInterface({ input: process.stdin, output: process.stdout }).question('Add it? [y/N] ')
    if (!/^y(es)?$/iu.test(answer.trim())) return console.log(`Not added. It is kept in ${made.file}`)
  }
  const config = await installStaged(made.id, made.report.permit, home)
  console.log(`Added ${config.name}. A running Hyperlink starts it now; its tools are ${config.name}__<tool>.`)
  process.exit(0)
}

/** The permit card: what it is, what it can reach, what it may change, and how its test went. */
function printCard(permit: Permit, report: TestReport): void {
  console.log('')
  console.log(`  ┌ ${permit.name}: ${permit.description}`)
  console.log(`  │ reaches   ${permit.reaches.join(', ') || 'nothing'}`)
  if (permit.secrets.length) console.log(`  │ needs     ${permit.secrets.join(', ')} (set HYPERLINK_SECRET_<NAME>)`)
  for (const tool of permit.tools) console.log(`  │ ${tool.changes ? 'changes' : 'reads  '}   ${tool.name}: ${tool.description.slice(0, 90)}`)
  printReport(report, '  │ ')
  console.log('  └ runs in its own process: no files but its own, no programs, network only to the hosts above')
  console.log('')
}

function printReport(report: TestReport, prefix = '  '): void {
  for (const test of report.tests) console.log(`${prefix}tested    ${test.tool}: ${test.ok ? 'ok' : 'failed'} in ${test.ms} ms${test.ok ? `, ${test.chars} characters` : ` (${test.error ?? ''})`}`)
  if (report.problem) console.log(`${prefix}problem   ${report.problem.split('\n')[0]}`)
}

/** hyperlink secret set|list|remove: keys into and out of the vault; a value is never on the command line. */
async function secret(args: string[]): Promise<void> {
  const [action, connector, name] = args
  const home = hyperlinkHome()
  const vault = await Vault.open(home).catch(error => fail(error instanceof Error ? error.message : String(error)))
  if (action === 'list') {
    const names = await vault.names()
    const shown = Object.entries(names).filter(([entry]) => !connector || entry === connector)
    if (shown.length === 0) return console.log(`No keys in the vault${connector ? ` for ${connector}` : ''}.`)
    for (const [entry, keys] of shown) console.log(`${entry}: ${keys.join(', ') || '(none)'}`)
    return console.log(`(the vault's key is kept by ${vault.protectedBy}; values are never shown)`)
  }
  if ((action !== 'set' && action !== 'remove') || !connector || !name) return fail('Use: hyperlink secret set <connector> <NAME>, hyperlink secret remove <connector> <NAME>, or hyperlink secret list [connector]')
  const connectors = await readConnectors(home)
  const config = connectors.find(entry => entry.name === connector)
  if (!config) return fail(`There is no connector named "${connector}".`)
  const slot = secretSlot(config, name)
  if (action === 'remove') {
    console.log(await vault.remove(connector, slot.key) ? `Removed ${slot.key} for ${connector}.` : `${connector} has no ${slot.key} in the vault.`)
    return
  }
  const value = await readHidden(`${slot.key} for ${connector}: `)
  if (!value) return fail('Nothing was given, so nothing changed.')
  await vault.set(connector, slot.key, value)
  // The list names where the key goes; its value stays in the vault.
  if (config[slot.place]?.[slot.key] !== VAULT_PLACEHOLDER) {
    const next = { ...config, [slot.place]: { ...config[slot.place], [slot.key]: VAULT_PLACEHOLDER } }
    await writeConnectors(connectors.map(entry => entry.name === connector ? next : entry), home)
  }
  console.log(`Kept ${slot.key} for ${connector} in the vault. A running Hyperlink starts ${connector} again with it.`)
}

/** A line read without showing it (or the whole of stdin, when it is piped in). */
async function readHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks).toString('utf8').trim()
  }
  process.stdout.write(prompt)
  return new Promise(done => {
    let value = ''
    process.stdin.setRawMode(true)
    process.stdin.resume()
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData); process.stdout.write('\n'); done(value.trim()); return }
        if (char === '\u0003') { process.stdout.write('\n'); process.exit(130) }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1)
        else value += char
      }
    }
    process.stdin.on('data', onData)
  })
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function fail(message: string): never {
  console.error(message)
  process.exit(2)
}

void main(process.argv.slice(2)).catch(error => fail(error instanceof Error ? error.message : String(error)))
