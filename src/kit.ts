import { pathToFileURL } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

/**
 * The connector kit: what a made connector is, and how it runs.
 *
 * A connector the brain makes is a plain definition: a name, the hosts it reaches, and its tools.
 * It has no imports and no access to the process. Each tool gets a `fetch` that reaches only the
 * hosts its permit card names, and the secrets it declared, nothing else. It runs in its own
 * process under Node's permission system: it reads only its own folder and Hyperlink, and cannot
 * start programs, workers or add-ons.
 */

export interface ToolContext {
  /** fetch, to the hosts in `reaches` only. */
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>
  /** A secret this connector declared (an API key), or undefined when none is set. */
  readonly secret: (name: string) => string | undefined
}

export interface ConnectorTool {
  readonly name: string
  readonly description: string
  /** JSON Schema of the arguments (type: object). */
  readonly input: { readonly type: 'object'; readonly properties?: Record<string, unknown>; readonly required?: readonly string[] }
  /** True when the tool changes something (sends, writes, deletes); such a tool is never run as a test. */
  readonly changes?: boolean
  /** Arguments for a safe test run of a tool that changes nothing. */
  readonly example?: Record<string, unknown>
  readonly run: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>
}

export interface ConnectorDefinition {
  readonly name: string
  readonly description: string
  /** The hosts it may reach, e.g. ["en.wikipedia.org"]; a subdomain of one is allowed too. */
  readonly reaches: readonly string[]
  /** Names of the secrets it needs (API keys), given to it as HYPERLINK_SECRET_<NAME>. */
  readonly secrets?: readonly string[]
  readonly tools: readonly ConnectorTool[]
}

const CALL_TIMEOUT_MS = 60_000
const MAX_RESPONSE_BYTES = 5_000_000
const MAX_REDIRECTS = 5

export function validateDefinition(value: unknown): ConnectorDefinition {
  const definition = value as Partial<ConnectorDefinition> | null
  if (!definition || typeof definition !== 'object') throw new Error('the connector exports no definition object')
  if (typeof definition.name !== 'string' || !/^[a-z0-9-]{1,32}$/u.test(definition.name)) throw new Error('name must be 1-32 lowercase letters, digits or dashes')
  if (typeof definition.description !== 'string' || !definition.description.trim()) throw new Error('description is missing')
  if (!Array.isArray(definition.reaches) || definition.reaches.some(host => typeof host !== 'string' || !/^[a-z0-9.-]+$/iu.test(host))) throw new Error('reaches must be a list of host names (no scheme, no path)')
  if (!Array.isArray(definition.tools) || definition.tools.length === 0) throw new Error('tools is empty')
  const names = new Set<string>()
  for (const tool of definition.tools) {
    if (typeof tool?.name !== 'string' || !/^[a-z0-9_]{1,48}$/u.test(tool.name)) throw new Error(`tool name "${String(tool?.name)}" must be lowercase letters, digits and underscores`)
    if (names.has(tool.name)) throw new Error(`two tools are named ${tool.name}`)
    names.add(tool.name)
    if (typeof tool.description !== 'string' || !tool.description.trim()) throw new Error(`${tool.name} has no description`)
    if (tool.input?.type !== 'object') throw new Error(`${tool.name}: input must be a JSON Schema with type "object"`)
    if (typeof tool.run !== 'function') throw new Error(`${tool.name}: run must be a function`)
  }
  return definition as ConnectorDefinition
}

/** fetch to the declared hosts only, https only (http for this machine), redirects checked one by one. */
export function restrictedFetch(reaches: readonly string[], realFetch: typeof fetch): ToolContext['fetch'] {
  const allowed = (url: URL) => {
    const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return false
    return reaches.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))
  }
  return async (input, init) => {
    let url = new URL(input)
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (!allowed(url)) throw new Error(`${url.hostname} is not on this connector's permit (it reaches: ${reaches.join(', ') || 'nothing'})`)
      const response = await realFetch(url, { ...init, redirect: 'manual', signal: init?.signal ?? AbortSignal.timeout(CALL_TIMEOUT_MS) })
      const location = response.headers.get('location')
      if (response.status >= 300 && response.status < 400 && location) { url = new URL(location, url); continue }
      const length = Number(response.headers.get('content-length') ?? 0)
      if (length > MAX_RESPONSE_BYTES) throw new Error(`the answer from ${url.hostname} is too large (${length} bytes)`)
      return response
    }
    throw new Error('too many redirects')
  }
}

/** Run a made connector as an MCP server on stdio (called by `hyperlink connector <file>`). */
export async function runConnector(file: string): Promise<void> {
  // The connector reaches the network only through the fetch it is given.
  const realFetch = globalThis.fetch.bind(globalThis)
  for (const name of ['fetch', 'WebSocket', 'EventSource'] as const) Reflect.deleteProperty(globalThis, name)
  const loaded = await import(pathToFileURL(file).href) as { default?: unknown }
  const definition = validateDefinition(loaded.default)
  const context: ToolContext = {
    fetch: restrictedFetch(definition.reaches, realFetch),
    secret: name => (definition.secrets ?? []).includes(name) ? process.env[`HYPERLINK_SECRET_${name.toUpperCase()}`] : undefined,
  }
  // Its permit facts travel in the handshake, so Hyperlink learns them without loading its code.
  const server = new Server({ name: definition.name, version: '1' }, { capabilities: { tools: {} }, instructions: JSON.stringify({ description: definition.description, reaches: definition.reaches, secrets: definition.secrets ?? [], examples: Object.fromEntries(definition.tools.filter(tool => !tool.changes && tool.example && typeof tool.example === 'object').map(tool => [tool.name, tool.example])) }) })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: definition.tools.map(tool => ({ name: tool.name, description: `${tool.description}${tool.changes ? ' (changes something)' : ''}`, inputSchema: tool.input as { type: 'object' } })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const tool = definition.tools.find(entry => entry.name === request.params.name)
    if (!tool) return { content: [{ type: 'text', text: `No tool named ${request.params.name}` }], isError: true }
    try {
      const result = await Promise.race([
        tool.run(request.params.arguments ?? {}, context),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${tool.name} took longer than ${CALL_TIMEOUT_MS / 1000} s`)), CALL_TIMEOUT_MS)),
      ])
      return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) ?? '' }] }
    } catch (error) {
      return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }
    }
  })
  await server.connect(new StdioServerTransport())
}
