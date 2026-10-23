import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { ConnectorConfig } from './config.js'
import type { SignIn } from './kit.js'
import type { Vault } from './vault.js'

/**
 * Signing in to an app once, the way a desktop app does (OAuth 2: an authorization code with PKCE).
 *
 * Hyperlink listens on this machine for the answer (127.0.0.1, a port of the moment), opens the
 * app's sign-in page in his browser, and swaps the code it gets back for a refresh token, which
 * the caller keeps in the vault. His password goes only to the app's own page.
 */

/** How long a sign-in waits for him before it gives up. */
export const SIGN_IN_WAIT_MS = 5 * 60_000

export interface SignInClient { readonly id: string; readonly secret?: string }

export async function beginSignIn(signIn: SignIn, client: SignInClient): Promise<{ readonly url: string; readonly finished: Promise<string> }> {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(16).toString('hex')
  let settle: { done: (token: string) => void; fail: (error: Error) => void } | undefined
  const finished = new Promise<string>((done, fail) => { settle = { done, fail } })
  let redirect = ''
  let over = false
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/callback' || over) { res.writeHead(404).end(); return }
    // An answer for another sign-in (or none at all) is not his.
    if (url.searchParams.get('state') !== state) { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('This answer is not for the sign-in Hyperlink is waiting for.'); return }
    const refused = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    if (refused || !code) { page(res, false, `The sign-in was not given (${refused ?? 'no code came back'}).`); finish(new Error(`The sign-in was not given (${refused ?? 'no code came back'}).`)); return }
    void exchange(code).then(
      token => { page(res, true, 'Signed in. You can close this tab.'); finish(token) },
      error => { const message = error instanceof Error ? error.message : String(error); page(res, false, message); finish(new Error(message)) },
    )
  })
  const timer = setTimeout(() => finish(new Error(`No sign-in came back within ${SIGN_IN_WAIT_MS / 60_000} minutes.`)), SIGN_IN_WAIT_MS)
  function finish(outcome: string | Error): void {
    if (over) return
    over = true
    clearTimeout(timer)
    server.close()
    if (typeof outcome === 'string') settle?.done(outcome)
    else settle?.fail(outcome)
  }
  async function exchange(code: string): Promise<string> {
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: client.id, code_verifier: verifier, ...(client.secret ? { client_secret: client.secret } : {}) })
    const response = await fetch(signIn.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body, signal: AbortSignal.timeout(30_000) })
    const answer = await response.json().catch(() => null) as { refresh_token?: unknown; error?: unknown; error_description?: unknown } | null
    if (!response.ok) throw new Error(`The app did not accept the sign-in (${typeof answer?.error_description === 'string' ? answer.error_description : typeof answer?.error === 'string' ? answer.error : response.status}).`)
    if (typeof answer?.refresh_token !== 'string') throw new Error('The app gave no refresh token, so the sign-in would not last. Sign in again (the app must allow offline access).')
    return answer.refresh_token
  }
  await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', () => done()) })
  const address = server.address()
  redirect = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/callback`
  const url = new URL(signIn.authorize)
  for (const [name, value] of Object.entries({ client_id: client.id, redirect_uri: redirect, response_type: 'code', scope: signIn.scopes.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256', ...signIn.params })) url.searchParams.set(name, value)
  return { url: url.href, finished }
}

/**
 * A connector's sign-in, from its client kept in the vault to the refresh token kept there too
 * (a running Hyperlink then starts it again with it). Throws, in a sentence, when it cannot begin.
 */
export async function signInConnector(config: ConnectorConfig, vault: Vault): Promise<{ readonly url: string; readonly finished: Promise<void> }> {
  if (!config.signIn) throw new Error(`${config.name} has no sign-in.`)
  const kept = (await vault.read())[config.name] ?? {}
  const id = kept.HYPERLINK_SECRET_OAUTH_CLIENT_ID
  if (!id) throw new Error(`Give ${config.name} its app's client ID (and client secret) first: they come from the app's developer console.`)
  const secret = kept.HYPERLINK_SECRET_OAUTH_CLIENT_SECRET
  const started = await beginSignIn(config.signIn, { id, ...(secret ? { secret } : {}) })
  return { url: started.url, finished: started.finished.then(token => vault.set(config.name, 'HYPERLINK_SECRET_OAUTH_REFRESH_TOKEN', token)) }
}

/** Opens a page in his own browser (no shell: the address is passed as it is). */
export function openInBrowser(url: string): void {
  if (!/^https:\/\//u.test(url)) return
  const [file, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]]
  execFile(file, args, { windowsHide: true }, () => {})
}

function page(res: import('node:http').ServerResponse, ok: boolean, text: string): void {
  const safe = text.replace(/[&<>"]/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char)
  res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(`<!doctype html><meta charset="utf-8"><title>Hyperlink</title><body style="font:16px system-ui;background:#111;color:#eee;display:grid;place-items:center;height:90vh"><p>${safe}</p></body>`)
}
