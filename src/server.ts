import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Hub } from './hub.js'
import { statusPage } from './page.js'
import { brokenConnector, installStaged, localTester, replaceConnector } from './brain/make.js'
import { widening, type Permit } from './brain/loop.js'
import { readConnectors, writeConnectors } from './config.js'
import { secretSlot, VAULT_PLACEHOLDER, type Vault } from './vault.js'

const MAX_BODY_BYTES = 4_000_000
const MAX_CODE_CHARS = 200_000

/**
 * Hyperlink's front door, on this machine only (127.0.0.1):
 *
 *   /mcp         one MCP server (Streamable HTTP) with every connector's tools
 *   /api/status  the connectors and their state
 *   /api/activity  recent calls: what, how long, whether it worked; never their contents
 *   /api/make/test     a connector an agent's brain wrote: refused, or staged and tested in the sandbox
 *   /api/make/install  a staged connector that passed, added to the list (the agent asked its owner first)
 *   /api/make/broken   a made connector that stopped working: its code, approved permit, and what went wrong
 *   /api/make/replace  a tested repair takes its place (the old kept beside it); one that needs more than its permit needs approved
 *   /api/secrets       keep a connector's key in the vault (POST), or list the names kept (GET); values never come back
 *   /            the status page
 *
 * Every request must name this host (so a web page cannot reach it by DNS rebinding), and every
 * call to /mcp or /api must carry the token. A browser page from another site is refused.
 */
export function startServer(options: { readonly hub: Hub; readonly token: string; readonly port: number; readonly home: string; readonly vault?: Vault | null; readonly listChanged?: () => Promise<void> }): Promise<HttpServer> {
  const { hub, token, port, home } = options
  const vault = options.vault ?? null
  const tester = localTester(home)
  /** Staged connectors that passed, by id, with the permit they showed: only these can be installed. */
  const passed = new Map<string, Permit>()
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
  const ownOrigins = new Set([...hosts].map(host => `http://${host}`))

  const server = createServer((req, res) => {
    void handle(req, res).catch(error => {
      if (!res.headersSent) send(res, 500, { error: error instanceof Error ? error.message : String(error) })
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hosts.has(req.headers.host ?? '')) return send(res, 421, { error: 'Hyperlink answers only on this machine.' })
    const origin = req.headers.origin
    if (origin !== undefined && !ownOrigins.has(origin)) return send(res, 403, { error: 'Requests from other sites are refused.' })
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' })
      res.end(statusPage(token))
      return
    }
    if (!authorised(req.headers.authorization, token)) return send(res, 401, { error: 'Missing or wrong token (Authorization: Bearer <token>; it is in the Hyperlink folder).' })

    if (url.pathname === '/api/status' && req.method === 'GET') return send(res, 200, { connectors: hub.status(), tools: hub.tools().length })
    if (url.pathname === '/api/activity' && req.method === 'GET') return send(res, 200, { activity: hub.recentActivity(Number(url.searchParams.get('limit') ?? 100)) })
    if (url.pathname === '/api/make/test' && req.method === 'POST') {
      const body = await readJson(req) as { code?: unknown } | undefined
      if (typeof body?.code !== 'string' || body.code.length > MAX_CODE_CHARS) return send(res, 400, { error: 'Send the module as code (a string).' })
      const tested = await tester.test(body.code)
      if ('report' in tested && tested.report.permit && !tested.report.problem && tested.report.tests.length > 0 && tested.report.tests.every(test => test.ok)) passed.set(tested.id, tested.report.permit)
      return send(res, 200, tested)
    }
    if (url.pathname === '/api/make/install' && req.method === 'POST') {
      const body = await readJson(req) as { id?: unknown } | undefined
      const permit = typeof body?.id === 'string' ? passed.get(body.id) : undefined
      if (!permit || typeof body?.id !== 'string') return send(res, 404, { error: 'No staged connector that passed its tests has that id.' })
      passed.delete(body.id)
      const config = await installStaged(body.id, permit, home)
      // Answered once it runs, so the agent's next call finds it.
      await options.listChanged?.()
      return send(res, 200, { name: config.name })
    }
    if (url.pathname === '/api/make/broken' && req.method === 'GET') {
      const name = url.searchParams.get('name') ?? ''
      try {
        return send(res, 200, await brokenConnector(name, home, hub.evidence(name)))
      } catch (error) {
        return send(res, 404, { error: error instanceof Error ? error.message : String(error) })
      }
    }
    if (url.pathname === '/api/make/replace' && req.method === 'POST') {
      const body = await readJson(req) as { name?: unknown; id?: unknown; approved?: unknown } | undefined
      const permit = typeof body?.id === 'string' ? passed.get(body.id) : undefined
      if (!permit || typeof body?.id !== 'string' || typeof body.name !== 'string') return send(res, 404, { error: 'No staged repair that passed its tests has that id.' })
      const before = await brokenConnector(body.name, home, null).catch(() => null)
      if (!before) return send(res, 404, { error: `${body.name} is not a connector Hyperlink made.` })
      // A repair that needs no more than he approved goes in; one that needs more waits for his yes.
      const wider = widening(before.permit, permit)
      if (wider.length > 0 && body.approved !== true) return send(res, 409, { needsApproval: true, widening: wider })
      passed.delete(body.id)
      await replaceConnector(body.name, body.id, permit, home)
      // Answered once the new code runs: a call right after a repair must not land on the old one.
      await options.listChanged?.()
      return send(res, 200, { name: body.name, widened: wider })
    }
    if (url.pathname === '/api/secrets') {
      if (!vault) return send(res, 503, { error: 'The vault is closed on this machine, so no key can be kept.' })
      if (req.method === 'GET') return send(res, 200, { names: await vault.names() })
      if (req.method !== 'POST') return send(res, 405, { error: 'GET or POST.' })
      const body = await readJson(req) as { connector?: unknown; name?: unknown; value?: unknown } | undefined
      if (typeof body?.connector !== 'string' || typeof body.name !== 'string' || typeof body.value !== 'string' || !body.value || body.value.length > 20_000) return send(res, 400, { error: 'Send connector, name and value.' })
      const connectors = await readConnectors(home)
      const config = connectors.find(entry => entry.name === body.connector)
      if (!config) return send(res, 404, { error: `There is no connector named ${body.connector}.` })
      const slot = secretSlot(config, body.name)
      await vault.set(config.name, slot.key, body.value)
      if (config[slot.place]?.[slot.key] !== VAULT_PLACEHOLDER) await writeConnectors(connectors.map(entry => entry.name === config.name ? { ...config, [slot.place]: { ...config[slot.place], [slot.key]: VAULT_PLACEHOLDER } } : entry), home)
      return send(res, 200, { kept: slot.key })
    }
    if (url.pathname === '/mcp') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Hyperlink takes MCP requests as POST.' })
      const body = await readJson(req)
      // Stateless: each request gets its own server and transport, all over the one hub.
      const mcp = mcpServer(hub)
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      res.on('close', () => { void transport.close(); void mcp.close() })
      await mcp.connect(transport)
      await transport.handleRequest(req, res, body)
      return
    }
    send(res, 404, { error: 'Not found.' })
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

function mcpServer(hub: Hub): Server {
  const server = new Server({ name: 'hyperlink', version: '0.1.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: hub.tools() }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => hub.call(request.params.name, request.params.arguments, extra.signal))
  return server
}

function authorised(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header?.startsWith('Bearer ') ? header.slice(7).trim() : '')
  const wanted = Buffer.from(token)
  return given.length === wanted.length && timingSafeEqual(given, wanted)
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Error('The request is too large.')
    chunks.push(chunk as Buffer)
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
}
