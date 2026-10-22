import { randomBytes } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { readConnectors, writeConnectors, type ConnectorConfig } from '../config.js'
import { checkModule, makeLoop, type BrainModel, type Made, type Permit, type Tester, type TestReport } from './loop.js'

/**
 * Making a way, on this machine: staging a written connector, testing it in the sandbox, and
 * installing it once he says yes. The loop itself (the brain writing and fixing) is in loop.ts.
 * The connector's code is never loaded inside Hyperlink itself, only in its sandboxed process.
 */

const DOCS_CHARS = 30_000
const TEST_TIMEOUT_MS = 90_000
/** One test call: a tool that hangs fails its test rather than holding the whole try. */
const TOOL_TEST_TIMEOUT_MS = 20_000

/** Where this package lives: the sandbox may read it (the kit and the MCP SDK), and nothing else of it. */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLI = join(PACKAGE_ROOT, 'dist', 'cli.js')

/** How a made connector is started: in its own process, under Node's permission system. */
export function sandboxCommand(file: string): { command: string; args: string[] } {
  return { command: process.execPath, args: ['--permission', `--allow-fs-read=${dirname(file)}`, `--allow-fs-read=${PACKAGE_ROOT}`, CLI, 'connector', file] }
}

/** Start a connector in the sandbox, read its permit from the handshake, and run its safe examples. */
export async function testConnector(file: string): Promise<TestReport> {
  const { command, args } = sandboxCommand(file)
  let stderr = ''
  const transport = new StdioClientTransport({ command, args, stderr: 'pipe' })
  transport.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-2_000) })
  const client = new Client({ name: 'hyperlink-maker', version: '1' })
  try {
    await Promise.race([client.connect(transport), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('it did not start')), TEST_TIMEOUT_MS))])
    const facts = JSON.parse(client.getInstructions() ?? '{}') as { description?: string; reaches?: string[]; secrets?: string[]; examples?: Record<string, Record<string, unknown>> }
    // Plain data the sandboxed connector reported about itself.
    const examples = facts.examples ?? {}
    const listed = (await client.listTools()).tools
    const permit: Permit = {
      name: client.getServerVersion()?.name ?? 'connector',
      description: facts.description ?? '',
      reaches: facts.reaches ?? [],
      secrets: facts.secrets ?? [],
      tools: listed.map(tool => ({ name: tool.name, description: (tool.description ?? '').replace(/ \(changes something\)$/u, ''), changes: (tool.description ?? '').endsWith('(changes something)') })),
    }
    const tests: TestReport['tests'][number][] = []
    for (const tool of permit.tools) {
      if (tool.changes || !examples[tool.name]) continue
      const started = Date.now()
      const result = await client.callTool({ name: tool.name, arguments: examples[tool.name] }, undefined, { timeout: TOOL_TEST_TIMEOUT_MS }).catch(error => ({ isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }))
      const text = ((result.content ?? []) as { type: string; text?: string }[]).map(part => part.text ?? '').join('\n')
      const empty = text.trim() === '' || text.trim() === '[]' || text.trim() === '{}'
      tests.push({ tool: tool.name, ok: result.isError !== true && !empty, ms: Date.now() - started, chars: text.length, ...(result.isError ? { error: text.slice(0, 600) } : empty ? { error: 'it returned nothing' } : {}) })
    }
    return { permit, tests, problem: null }
  } catch (error) {
    return { permit: null, tests: [], problem: `${error instanceof Error ? error.message : String(error)}${stderr ? `\n${stderr.trim().slice(-800)}` : ''}` }
  } finally {
    await client.close().catch(() => {})
  }
}

const stagedFile = (home: string, id: string) => join(home, 'made', id, 'connector.ts')

/** The tester on this machine: refuse the text, or stage it under made/<id> and test it there. */
export function localTester(home: string): Tester & { last(): { id: string; report: TestReport } | null } {
  let last: { id: string; report: TestReport } | null = null
  return {
    last: () => last,
    async test(code) {
      const refused = checkModule(code)
      if (refused) return { refused }
      const id = randomBytes(6).toString('hex')
      const file = stagedFile(home, id)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, `${code}\n`, 'utf8')
      const report = await testConnector(file)
      // Only the newest try is kept: an earlier one that failed is gone once a new one is staged.
      if (last) await rm(join(home, 'made', last.id), { recursive: true, force: true })
      last = { id, report }
      return last
    },
  }
}

/** Approved: the staged connector moves to its own folder and joins the list, started in the sandbox. */
export async function installStaged(id: string, permit: Permit, home: string): Promise<ConnectorConfig> {
  if (!/^[a-f0-9]{12}$/u.test(id)) throw new Error('There is no such staged connector.')
  const existing = await readConnectors(home)
  let name = permit.name
  for (let n = 2; existing.some(entry => entry.name === name); n += 1) name = `${permit.name}-${n}`
  const folder = join(home, 'connectors', name)
  await mkdir(folder, { recursive: true })
  const target = join(folder, 'connector.ts')
  await rename(stagedFile(home, id), target)
  await rm(join(home, 'made', id), { recursive: true, force: true })
  const config: ConnectorConfig & { made: true; reaches: readonly string[] } = { name, ...sandboxCommand(target), made: true, reaches: permit.reaches }
  await writeConnectors([...existing, config], home)
  return config
}

/** Hyperlink's own `make`: its brain, this machine's sandbox. */
export async function makeConnector(request: string, options: { readonly model: BrainModel; readonly home: string; readonly docsUrl?: string; readonly log?: (line: string) => void }): Promise<Made & { readonly file: string | null }> {
  const log = options.log ?? (() => {})
  const docs = options.docsUrl ? await readDocs(options.docsUrl).catch(error => { log(`The docs could not be read: ${error instanceof Error ? error.message : String(error)}`); return '' }) : ''
  const made = await makeLoop(request, { model: options.model, tester: localTester(options.home), ...(docs ? { docs } : {}), log })
  return { ...made, file: made.id ? stagedFile(options.home, made.id) : null }
}

/** A documentation page as plain text, for the brain to read. */
export async function readDocs(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`${response.status}`)
  const html = await response.text()
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/giu, ' ').replace(/<[^>]+>/gu, ' ').replace(/&nbsp;/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, DOCS_CHARS)
}
