#!/usr/bin/env node
import { watch } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_PORT, hyperlinkHome, readConnectors, readOrMakeToken, validName, writeConnectors, type ConnectorConfig } from './config.js'
import { Hub } from './hub.js'
import { startServer } from './server.js'
import { createInterface } from 'node:readline/promises'
import { installConnector, makeConnector, type Permit, type TestReport } from './brain/make.js'
import { modelFromEnv } from './brain/model.js'

const USAGE = `hyperlink — one MCP server in front of all your MCP servers

  hyperlink start [--port ${DEFAULT_PORT}]          run Hyperlink (http://127.0.0.1:<port>)
  hyperlink add <name> -- <command> [args…]   add a connector that Hyperlink starts
  hyperlink add <name> --url <address>        add a connector that runs elsewhere
  hyperlink remove <name>                     remove a connector
  hyperlink list                              the connectors in the list
  hyperlink status                            ask a running Hyperlink how its connectors are
  hyperlink make "<what>" [--docs <url>] [--yes]  the brain writes a connector, tests it, and asks you

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
  const hub = new Hub()
  await hub.start(await readConnectors(home))
  const server = await startServer({ hub, token, port })
  const url = `http://127.0.0.1:${port}`
  // Where a caller on this machine finds a running Hyperlink.
  await writeFile(join(home, 'endpoint.json'), JSON.stringify({ url, mcp: `${url}/mcp`, pid: process.pid }, null, 2), 'utf8')
  console.log(`[hyperlink] ${url} · ${hub.status().length} connectors · ${hub.tools().length} tools`)
  for (const entry of hub.status()) console.log(`[hyperlink] ${entry.name}: ${entry.state}${entry.problem ? ` (${entry.problem})` : ` · ${entry.tools} tools`}`)

  // The list is watched: a connector added or removed while it runs starts or stops at once.
  let pending: NodeJS.Timeout | undefined
  const reconcile = async () => {
    const wanted = await readConnectors(home).catch(() => null)
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
  const watcher = watch(home, (_event, file) => {
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
  if (!made.ok || !made.file || !made.report?.permit) {
    if (made.report) printReport(made.report)
    return fail(`It could not be made: ${made.problem ?? 'no connector came back'}${made.file ? ` (the last try is in ${made.file})` : ''}`)
  }
  printCard(made.report.permit, made.report)
  if (!yes) {
    const answer = await createInterface({ input: process.stdin, output: process.stdout }).question('Add it? [y/N] ')
    if (!/^y(es)?$/iu.test(answer.trim())) return console.log(`Not added. It is kept in ${made.file}`)
  }
  const config = await installConnector({ file: made.file, permit: made.report.permit }, home)
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

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function fail(message: string): never {
  console.error(message)
  process.exit(2)
}

void main(process.argv.slice(2)).catch(error => fail(error instanceof Error ? error.message : String(error)))
