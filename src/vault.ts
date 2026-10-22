import { execFile } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * The vault: every connector's keys, sealed at rest.
 *
 * vault.enc is AES-256-GCM sealed with a random key. That key is kept by the operating system,
 * never in the clear on disk: Windows DPAPI (this user), the macOS Keychain, or the Secret Service
 * on Linux (secret-tool); on a server, HYPERLINK_VAULT_PASSWORD derives it instead. Where none of
 * those is there, the vault refuses to keep anything rather than keep it in plain text.
 *
 * The brain never sees a secret. A connector names what it needs, and gets its own keys, and only
 * its own, as environment variables when it starts.
 */

export type Secrets = Record<string, Record<string, string>>

/** Written in connectors.json where a secret goes: the value comes from the vault when it starts. */
export const VAULT_PLACEHOLDER = '<vault>'

const SERVICE = 'hyperlink-vault'
const AAD = 'hyperlink.vault.v1'

interface KeyStore { readonly kind: string; load(): Promise<Buffer | null>; save(key: Buffer): Promise<void> }

function run(file: string, args: readonly string[], input?: string): Promise<string> {
  return new Promise((done, fail) => {
    const child = execFile(file, args, { windowsHide: true, timeout: 30_000, maxBuffer: 1_000_000 }, (error, stdout) => error ? fail(error) : done(stdout.trim()))
    if (input !== undefined) { child.stdin?.end(input) }
  })
}

/** Windows: the key wrapped by DPAPI for this user, in vault.key; passed on stdin, never on a command line. */
function dpapi(home: string): KeyStore {
  const file = join(home, 'vault.key')
  const ps = (script: string, input: string) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); ${script}`], input)
  return {
    kind: 'Windows DPAPI',
    async load() {
      let wrapped: string
      try { wrapped = (await readFile(file, 'utf8')).trim() } catch { return null }
      return Buffer.from(await ps("[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))", wrapped), 'base64')
    },
    async save(key) {
      const wrapped = await ps("[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))", key.toString('base64'))
      await writeFile(file, `${wrapped}\n`, { encoding: 'utf8', mode: 0o600 })
    },
  }
}

/** macOS: the key as a generic password in the login Keychain. */
function keychain(home: string): KeyStore {
  const account = resolve(home)
  return {
    kind: 'macOS Keychain',
    async load() {
      try { return Buffer.from(await run('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w']), 'base64') } catch { return null }
    },
    async save(key) {
      await run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-w', key.toString('base64')])
    },
  }
}

/** Linux: the key in the Secret Service (GNOME Keyring, KWallet) through secret-tool; given on stdin. */
function secretService(home: string): KeyStore {
  const account = resolve(home)
  return {
    kind: 'Secret Service',
    async load() {
      try { const value = await run('secret-tool', ['lookup', 'service', SERVICE, 'account', account]); return value ? Buffer.from(value, 'base64') : null } catch { return null }
    },
    async save(key) {
      await run('secret-tool', ['store', '--label=Hyperlink vault', 'service', SERVICE, 'account', account], key.toString('base64'))
    },
  }
}

/** A server: the key derived from HYPERLINK_VAULT_PASSWORD (scrypt, its salt kept beside the vault). */
function password(home: string, secret: string): KeyStore {
  const file = join(home, 'vault.salt')
  return {
    kind: 'password',
    async load() {
      try { return scryptSync(secret, Buffer.from((await readFile(file, 'utf8')).trim(), 'base64'), 32) } catch { return null }
    },
    async save() { /* the key is the password's: there is nothing to store but its salt (see keyStore) */ },
  }
}

async function keyStore(home: string): Promise<KeyStore> {
  const secret = process.env.HYPERLINK_VAULT_PASSWORD
  if (secret) {
    const file = join(home, 'vault.salt')
    try { await readFile(file, 'utf8') } catch { await writeFile(file, `${randomBytes(16).toString('base64')}\n`, { encoding: 'utf8', mode: 0o600 }) }
    return password(home, secret)
  }
  if (process.platform === 'win32') return dpapi(home)
  if (process.platform === 'darwin') return keychain(home)
  return secretService(home)
}

export class Vault {
  private constructor(private readonly home: string, private readonly key: Buffer, readonly protectedBy: string) {}

  /** Opens the vault, making its key the first time. Throws, in a sentence, where no key can be kept safely. */
  static async open(home: string): Promise<Vault> {
    await mkdir(home, { recursive: true })
    const store = await keyStore(home)
    let key = await store.load().catch(error => { throw new Error(`The vault key could not be read from ${store.kind}: ${error instanceof Error ? error.message : String(error)}`) })
    if (!key) {
      key = store.kind === 'password' ? await store.load() : randomBytes(32)
      if (!key) throw new Error('The vault key could not be made.')
      if (store.kind !== 'password') {
        await store.save(key).catch(error => { throw new Error(`There is nowhere safe to keep the vault key (${store.kind}: ${error instanceof Error ? error.message : String(error)}). Set HYPERLINK_VAULT_PASSWORD to use a password instead.`) })
      }
    }
    if (key.length !== 32) throw new Error('The vault key is not the right length.')
    return new Vault(home, key, store.kind)
  }

  private get file(): string { return join(this.home, 'vault.enc') }

  async read(): Promise<Secrets> {
    let raw: Buffer
    try { raw = await readFile(this.file) } catch { return {} }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12))
      decipher.setAAD(Buffer.from(AAD))
      decipher.setAuthTag(raw.subarray(12, 28))
      return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')) as Secrets
    } catch {
      throw new Error(`The vault does not open with this key (a different password, or a vault made for another user or machine). It is left as it is in ${this.file}.`)
    }
  }

  private async write(secrets: Secrets): Promise<void> {
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce)
    cipher.setAAD(Buffer.from(AAD))
    const body = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf8'), cipher.final()])
    const staging = `${this.file}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(staging, Buffer.concat([nonce, cipher.getAuthTag(), body]), { mode: 0o600 })
    await rename(staging, this.file)
    await chmod(this.file, 0o600).catch(() => {})
  }

  async set(connector: string, name: string, value: string): Promise<void> {
    const secrets = await this.read()
    secrets[connector] = { ...secrets[connector], [name]: value }
    await this.write(secrets)
  }

  async remove(connector: string, name?: string): Promise<boolean> {
    const secrets = await this.read()
    if (!secrets[connector] || (name !== undefined && !(name in secrets[connector]!))) return false
    if (name === undefined) delete secrets[connector]
    else delete secrets[connector]![name]
    await this.write(secrets)
    return true
  }

  /** The names kept for each connector; never the values. */
  async names(): Promise<Record<string, string[]>> {
    return Object.fromEntries(Object.entries(await this.read()).map(([connector, values]) => [connector, Object.keys(values)]))
  }
}

/** Names that hold a key: a variable or header like API_KEY, GITHUB_TOKEN, Authorization. */
export function looksSecret(name: string): boolean {
  return /key|token|secret|password|passwd|auth|credential|bearer|cookie|session/iu.test(name)
}

type Configurable = { readonly name: string; readonly url?: string; readonly env?: Readonly<Record<string, string>>; readonly headers?: Readonly<Record<string, string>> }

/**
 * Keys written in plain text in the list (by hand, by an app that installs a server, from an older
 * setup) go into the vault, and the list keeps a placeholder: nothing secret stays on disk in the clear.
 */
export async function moveSecretsIntoVault<T extends Configurable>(configs: readonly T[], vault: Vault): Promise<{ readonly configs: T[]; readonly moved: number }> {
  let moved = 0
  const next: T[] = []
  for (const config of configs) {
    const take = async (values: Readonly<Record<string, string>> | undefined) => {
      if (!values) return values
      const kept: Record<string, string> = {}
      for (const [name, value] of Object.entries(values)) {
        if (looksSecret(name) && value && value !== VAULT_PLACEHOLDER) {
          await vault.set(config.name, name, value)
          kept[name] = VAULT_PLACEHOLDER
          moved += 1
        } else kept[name] = value
      }
      return kept
    }
    const env = await take(config.env)
    const headers = await take(config.headers)
    next.push({ ...config, ...(env ? { env } : {}), ...(headers ? { headers } : {}) })
  }
  return { configs: next, moved }
}

/** Where a secret goes for a connector: its variable or header of that name (a made connector's "token" is HYPERLINK_SECRET_TOKEN). */
export function secretSlot(config: Configurable, name: string): { readonly key: string; readonly place: 'env' | 'headers' } {
  const made = `HYPERLINK_SECRET_${name.toUpperCase()}`
  if (config.env && name in config.env) return { key: name, place: 'env' }
  if (config.env && made in config.env) return { key: made, place: 'env' }
  if (config.headers && name in config.headers) return { key: name, place: 'headers' }
  return { key: name, place: config.url ? 'headers' : 'env' }
}
