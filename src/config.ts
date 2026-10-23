import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SignIn } from './kit.js'

/**
 * Where Hyperlink keeps its state: `HYPERLINK_HOME`, or `~/.hyperlink`.
 *
 *   connectors.json  the connectors, in the shape most agent apps use for MCP servers
 *   token            the key every caller must present (made on first start)
 */
export function hyperlinkHome(): string {
  return process.env.HYPERLINK_HOME?.trim() || join(homedir(), '.hyperlink')
}

export const DEFAULT_PORT = 7466

/** One connector: an MCP server Hyperlink starts (command) or reaches (url). */
export interface ConnectorConfig {
  /** Letters, digits, dash and underscore; the prefix of its tools ("chrome" → "chrome__navigate"). */
  readonly name: string
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly cwd?: string
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
  /** Only these tools are passed through; absent passes all of them. */
  readonly allow?: readonly string[]
  /** A connector can be kept but switched off. */
  readonly disabled?: boolean
  /** He signs in to its app once (OAuth 2); what it ends with is kept in the vault. */
  readonly signIn?: SignIn
}

interface ConnectorsFile { readonly connectors: Record<string, Omit<ConnectorConfig, 'name'>> }

const NAME = /^[A-Za-z0-9_-]{1,32}$/

export function validName(name: string): boolean {
  return NAME.test(name)
}

export async function readConnectors(home = hyperlinkHome()): Promise<ConnectorConfig[]> {
  let text: string
  try { text = await readFile(join(home, 'connectors.json'), 'utf8') } catch { return [] }
  const parsed = JSON.parse(text) as Partial<ConnectorsFile>
  return Object.entries(parsed.connectors ?? {})
    .filter(([name, entry]) => validName(name) && (typeof entry.command === 'string' || typeof entry.url === 'string'))
    .map(([name, entry]) => ({ name, ...entry }))
}

export async function writeConnectors(connectors: readonly ConnectorConfig[], home = hyperlinkHome()): Promise<void> {
  await mkdir(home, { recursive: true })
  const file: ConnectorsFile = { connectors: Object.fromEntries(connectors.map(({ name, ...rest }) => [name, rest])) }
  const target = join(home, 'connectors.json')
  const staging = `${target}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(staging, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
  await rename(staging, target)
}

/** The key callers present as `Authorization: Bearer <token>`; made once, readable only by this user. */
export async function readOrMakeToken(home = hyperlinkHome()): Promise<string> {
  const path = join(home, 'token')
  try {
    const token = (await readFile(path, 'utf8')).trim()
    if (token.length >= 32) return token
  } catch { /* first start */ }
  await mkdir(home, { recursive: true })
  const token = randomBytes(32).toString('hex')
  await writeFile(path, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
  await chmod(path, 0o600).catch(() => {})
  return token
}
