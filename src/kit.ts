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
  /** For a connector with a sign-in: a fresh access token (renewed as it runs out). Throws, in a sentence, before he has signed in. */
  readonly accessToken: () => Promise<string>
}

/**
 * How the owner signs in to an app once (OAuth 2: an authorization code with PKCE, answered on this
 * machine). Hyperlink keeps what it ends with in the vault; the connector then gets a fresh access
 * token on every call, and never sees his password.
 */
export interface SignIn {
  /** The page he signs in on, e.g. https://accounts.google.com/o/oauth2/v2/auth */
  readonly authorize: string
  /** Where a code or a refresh token becomes an access token; its host must be in `reaches`. */
  readonly token: string
  readonly scopes: readonly string[]
  /** Extra parameters for the sign-in page (Google: access_type=offline, prompt=consent). */
  readonly params?: Readonly<Record<string, string>>
}

/** What a sign-in keeps for a connector, given to it as HYPERLINK_SECRET_<NAME>: his app's client, and the refresh token it ends with. */
export const SIGN_IN_SECRETS = ['OAUTH_CLIENT_ID', 'OAUTH_CLIENT_SECRET', 'OAUTH_REFRESH_TOKEN'] as const

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
  /** The app needs him to sign in once (OAuth 2); its tools then call accessToken(). */
  readonly signIn?: SignIn
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
  if (definition.signIn !== undefined) {
    const signIn = definition.signIn as Partial<SignIn> | null
    const https = (value: unknown) => { try { return new URL(String(value)).protocol === 'https:' } catch { return false } }
    if (!signIn || !https(signIn.authorize) || !https(signIn.token)) throw new Error('signIn needs an https authorize page and an https token address')
    const tokenHost = new URL(String(signIn.token)).hostname
    if (!definition.reaches.some(host => tokenHost === host || tokenHost.endsWith(`.${host}`))) throw new Error(`signIn's token address (${tokenHost}) must be in reaches`)
    if (!Array.isArray(signIn.scopes) || signIn.scopes.some(scope => typeof scope !== 'string')) throw new Error('signIn.scopes must be a list of strings')
    if (signIn.params !== undefined && (typeof signIn.params !== 'object' || Object.values(signIn.params).some(value => typeof value !== 'string'))) throw new Error('signIn.params must be plain text values')
  }
  return definition as ConnectorDefinition
}

/** A fresh access token from the refresh token a sign-in kept, through the connector's own fetch; kept until shortly before it runs out. */
function accessTokens(definition: ConnectorDefinition, fetchFor: ToolContext['fetch']): ToolContext['accessToken'] {
  let kept: { readonly token: string; readonly until: number } | null = null
  const env = (name: string) => process.env[`HYPERLINK_SECRET_${name}`]
  return async () => {
    const signIn = definition.signIn
    if (!signIn) throw new Error(`${definition.name} has no sign-in.`)
    if (kept && Date.now() < kept.until) return kept.token
    const refresh = env('OAUTH_REFRESH_TOKEN'), client = env('OAUTH_CLIENT_ID'), clientSecret = env('OAUTH_CLIENT_SECRET')
    // Said to an agent as much as to a person: only he can sign in, and nothing else of this connector works until he has.
    if (!refresh || !client) throw new Error(`Not signed in to ${definition.name} yet. Only the owner can sign in, once, himself, on Hyperlink's page in his app; until he has, no tool of ${definition.name} can reach it.`)
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: client, ...(clientSecret ? { client_secret: clientSecret } : {}) })
    const response = await fetchFor(signIn.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body })
    const answer = await response.json().catch(() => null) as { access_token?: unknown; expires_in?: unknown; error?: unknown } | null
    if (!response.ok || typeof answer?.access_token !== 'string') throw new Error(`The sign-in to ${definition.name} no longer works (${typeof answer?.error === 'string' ? answer.error : response.status}): the owner signs in again.`)
    const seconds = typeof answer.expires_in === 'number' ? answer.expires_in : 3600
    kept = { token: answer.access_token, until: Date.now() + Math.max(30, seconds - 60) * 1000 }
    return kept.token
  }
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
  const fetchFor = restrictedFetch(definition.reaches, realFetch)
  const context: ToolContext = {
    fetch: fetchFor,
    secret: name => (definition.secrets ?? []).includes(name) ? process.env[`HYPERLINK_SECRET_${name.toUpperCase()}`] : undefined,
    accessToken: accessTokens(definition, fetchFor),
  }
  // Its permit facts travel in the handshake, so Hyperlink learns them without loading its code.
  const server = new Server({ name: definition.name, version: '1' }, { capabilities: { tools: {} }, instructions: JSON.stringify({ description: definition.description, reaches: definition.reaches, secrets: definition.secrets ?? [], ...(definition.signIn ? { signIn: definition.signIn } : {}), examples: Object.fromEntries(definition.tools.filter(tool => !tool.changes && tool.example && typeof tool.example === 'object').map(tool => [tool.name, tool.example])) }) })
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
