import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import type { ConnectorConfig } from './config.js'

/** Between a connector's name and its tool's: "chrome__browser_navigate". */
export const SEPARATOR = '__'

export interface ConnectorStatus {
  readonly name: string
  readonly kind: 'command' | 'url'
  readonly state: 'starting' | 'running' | 'failed' | 'disabled'
  readonly tools: number
  readonly problem: string | null
}

/** One call through Hyperlink: what was called, how long it took, whether it worked. Never its arguments or results. */
export interface ActivityEntry {
  readonly at: string
  readonly connector: string
  readonly tool: string
  readonly ms: number
  readonly ok: boolean
  readonly error?: string
}

interface Running {
  readonly config: ConnectorConfig
  client: Client | null
  tools: Tool[]
  state: ConnectorStatus['state']
  problem: string | null
}

const ACTIVITY_KEPT = 500
const START_TIMEOUT_MS = 90_000

/**
 * The middle of Hyperlink: every connector started and kept, their tools offered as one list,
 * and each call passed to the connector that owns it.
 *
 * A connector that fails to start is reported and the others still run.
 */
export class Hub {
  private readonly connectors = new Map<string, Running>()
  private readonly activity: ActivityEntry[] = []

  async start(configs: readonly ConnectorConfig[]): Promise<void> {
    await Promise.all(configs.map(config => this.add(config)))
  }

  async add(config: ConnectorConfig): Promise<void> {
    await this.remove(config.name)
    const running: Running = { config, client: null, tools: [], state: config.disabled ? 'disabled' : 'starting', problem: null }
    this.connectors.set(config.name, running)
    if (config.disabled) return
    const client = new Client({ name: 'hyperlink', version: '0.1.0' })
    try {
      const transport = config.url
        ? new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: { ...config.headers } } })
        : new StdioClientTransport({ command: config.command!, args: [...(config.args ?? [])], env: { ...processEnv(), ...config.env }, ...(config.cwd ? { cwd: config.cwd } : {}), stderr: 'pipe' })
      await withTimeout(client.connect(transport), START_TIMEOUT_MS, `${config.name} did not start within ${START_TIMEOUT_MS / 1000} s`)
      const listed = await client.listTools()
      const allowed = config.allow ? new Set(config.allow) : null
      running.tools = listed.tools.filter(tool => allowed === null || allowed.has(tool.name))
      running.client = client
      running.state = 'running'
    } catch (error) {
      running.state = 'failed'
      running.problem = error instanceof Error ? error.message : String(error)
      await client.close().catch(() => {})
    }
  }

  async remove(name: string): Promise<void> {
    const running = this.connectors.get(name)
    if (!running) return
    this.connectors.delete(name)
    await running.client?.close().catch(() => {})
  }

  /** Every running connector's tools, named "<connector>__<tool>". */
  tools(): Tool[] {
    return [...this.connectors.values()].flatMap(running => running.state !== 'running' ? [] : running.tools.map(tool => ({
      ...tool,
      name: `${running.config.name}${SEPARATOR}${tool.name}`,
      description: `${tool.description ?? tool.name} (from ${running.config.name}, through Hyperlink)`,
    })))
  }

  async call(name: string, args: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<CallToolResult> {
    const split = name.indexOf(SEPARATOR)
    const connector = split > 0 ? name.slice(0, split) : ''
    const tool = split > 0 ? name.slice(split + SEPARATOR.length) : name
    const running = this.connectors.get(connector)
    const started = Date.now()
    if (!running?.client || running.state !== 'running' || !running.tools.some(entry => entry.name === tool)) {
      const error = running ? `${connector} has no running tool "${tool}"` : `No connector named "${connector}"`
      this.log({ connector, tool, ms: 0, ok: false, error })
      return { content: [{ type: 'text', text: error }], isError: true }
    }
    try {
      const result = await running.client.callTool({ name: tool, arguments: args ?? {} }, undefined, signal ? { signal } : undefined) as CallToolResult
      this.log({ connector, tool, ms: Date.now() - started, ok: result.isError !== true })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log({ connector, tool, ms: Date.now() - started, ok: false, error: message })
      return { content: [{ type: 'text', text: `${connector} failed: ${message}` }], isError: true }
    }
  }

  status(): ConnectorStatus[] {
    return [...this.connectors.values()].map(running => ({
      name: running.config.name,
      kind: running.config.url ? 'url' : 'command',
      state: running.state,
      tools: running.tools.length,
      problem: running.problem,
    }))
  }

  recentActivity(limit = 100): ActivityEntry[] {
    return this.activity.slice(-limit).reverse()
  }

  async close(): Promise<void> {
    await Promise.all([...this.connectors.keys()].map(name => this.remove(name)))
  }

  private log(entry: Omit<ActivityEntry, 'at'>): void {
    this.activity.push({ at: new Date().toISOString(), ...entry })
    if (this.activity.length > ACTIVITY_KEPT) this.activity.splice(0, this.activity.length - ACTIVITY_KEPT)
  }
}

/** The environment a connector starts with: this process's, with the strings only. */
function processEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })]).finally(() => clearTimeout(timer))
}
