/*
 * Gmail, through Google's Gmail API (no browser). The owner signs in once with his Google account;
 * Hyperlink keeps the sign-in in its vault, and every call gets a fresh access token.
 *
 * Reads: search, a message, a thread, the labels. Changes: send (or reply), a draft, labels
 * (mark read or unread, archive, star). Nothing here deletes mail.
 */

const API = 'https://gmail.googleapis.com/gmail/v1/users/me'
const MAX_BODY_CHARS = 20_000

type Part = { mimeType?: string; filename?: string; body?: { data?: string; size?: number }; parts?: Part[]; headers?: { name: string; value: string }[] }
type Message = { id: string; threadId: string; labelIds?: string[]; snippet?: string; payload?: Part }
type Context = { fetch: (url: string, init?: RequestInit) => Promise<Response>; accessToken: () => Promise<string> }

/** One Gmail API call; T is the shape of its answer, as Google documents it. */
async function call<T>(context: Context, path: string, init: RequestInit = {}): Promise<T> {
  const token = await context.accessToken()
  const response = await context.fetch(API + path, { ...init, headers: { authorization: 'Bearer ' + token, accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) } })
  const text = await response.text()
  if (!response.ok) {
    let reason = text.slice(0, 300)
    try { reason = JSON.parse(text).error?.message ?? reason } catch { /* not JSON */ }
    throw new Error('Gmail answered ' + response.status + ': ' + reason)
  }
  return (text ? JSON.parse(text) : {}) as T
}

function header(part: Part | undefined, name: string): string {
  return part?.headers?.find(entry => entry.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

function decode(data: string): string {
  const binary = atob(data.replace(/-/g, '+').replace(/_/g, '/'))
  return new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)))
}

function encode(text: string): string {
  let binary = ''
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The message's words: its plain text part, else its HTML part as text. */
function bodyOf(part: Part | undefined): string {
  const find = (node: Part | undefined, type: string): string | null => {
    if (!node) return null
    if (node.mimeType === type && node.body?.data) return decode(node.body.data)
    for (const child of node.parts ?? []) { const found = find(child, type); if (found) return found }
    return null
  }
  const plain = find(part, 'text/plain')
  if (plain) return plain.trim()
  const html = find(part, 'text/html') ?? ''
  return html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim()
}

function attachmentsOf(part: Part | undefined): string[] {
  const names: string[] = []
  const walk = (node: Part | undefined) => { if (!node) return; if (node.filename) names.push(node.filename); for (const child of node.parts ?? []) walk(child) }
  walk(part)
  return names
}

function summary(message: Message) {
  return {
    id: message.id,
    thread_id: message.threadId,
    from: header(message.payload, 'From'),
    to: header(message.payload, 'To'),
    subject: header(message.payload, 'Subject'),
    date: header(message.payload, 'Date'),
    unread: (message.labelIds ?? []).includes('UNREAD'),
    snippet: message.snippet ?? '',
  }
}

function full(message: Message) {
  const body = bodyOf(message.payload)
  return {
    ...summary(message),
    cc: header(message.payload, 'Cc'),
    labels: message.labelIds ?? [],
    attachments: attachmentsOf(message.payload),
    body: body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) + ' …(cut)' : body,
  }
}

/** One line of a header: no line breaks, so nothing can be added to the message's headers. */
const line = (value: unknown): string => String(value ?? '').replace(/[\r\n]+/g, ' ').trim()
/** A header word outside plain ASCII (a subject in Sinhala, an emoji), as mail headers carry it: standard, padded base64. */
function encodedWord(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text)) return text
  const base64 = encode(text).replace(/-/g, '+').replace(/_/g, '/')
  return '=?UTF-8?B?' + base64 + '='.repeat((4 - (base64.length % 4)) % 4) + '?='
}

/** A message as Gmail takes it (RFC 2822, base64url), and the thread it belongs to when it is a reply. */
async function compose(context: Context, args: Record<string, unknown>): Promise<{ raw: string; threadId?: string }> {
  let subject = line(args.subject)
  const headers: string[] = []
  let threadId: string | undefined
  if (args.reply_to_message_id) {
    const original = await call<Message>(context, '/messages/' + encodeURIComponent(String(args.reply_to_message_id)) + '?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Reply-To')
    const id = header(original.payload, 'Message-ID')
    if (id) headers.push('In-Reply-To: ' + id, 'References: ' + (header(original.payload, 'References') + ' ' + id).trim())
    if (!subject) subject = /^re:/i.test(header(original.payload, 'Subject')) ? header(original.payload, 'Subject') : 'Re: ' + header(original.payload, 'Subject')
    if (!args.to) args = { ...args, to: header(original.payload, 'Reply-To') || header(original.payload, 'From') }
    threadId = original.threadId
  }
  const to = line(args.to)
  if (!to) throw new Error('Say who it goes to (to).')
  const lines = [
    'To: ' + to,
    ...(args.cc ? ['Cc: ' + line(args.cc)] : []),
    ...(args.bcc ? ['Bcc: ' + line(args.bcc)] : []),
    'Subject: ' + encodedWord(subject),
    ...headers,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    String(args.body ?? ''),
  ]
  return { raw: encode(lines.join('\r\n')), ...(threadId ? { threadId } : {}) }
}

const messageArgs = {
  to: { type: 'string', description: 'Who it goes to: one address, or several separated by commas. Optional for a reply (it goes to the sender).' },
  subject: { type: 'string', description: 'The subject. Optional for a reply.' },
  body: { type: 'string', description: 'The message, as plain text.' },
  cc: { type: 'string', description: 'Copy to (optional).' },
  bcc: { type: 'string', description: 'Blind copy to (optional).' },
  reply_to_message_id: { type: 'string', description: 'The id of the message this answers, to reply in its thread (optional).' },
}

export default {
  name: 'gmail',
  description: 'Gmail through Google\'s Gmail API: search, read, reply, send, draft and label mail, without a browser.',
  reaches: ['gmail.googleapis.com', 'oauth2.googleapis.com'],
  signIn: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/gmail.modify'],
    params: { access_type: 'offline', prompt: 'consent' },
  },
  tools: [
    {
      name: 'search_messages',
      description: 'Finds messages with Gmail\'s own search words (from:, to:, subject:, is:unread, newer_than:2d, has:attachment, in:inbox, label:…); returns sender, subject, date, a snippet and whether it is unread, newest first.',
      input: { type: 'object', properties: { query: { type: 'string', description: 'Gmail search words; empty for the newest mail.' }, max: { type: 'number', description: 'How many (1-20, default 10).' } } },
      example: { query: 'in:inbox', max: 3 },
      run: async (args: Record<string, unknown>, context: Context) => {
        const max = Math.max(1, Math.min(20, Number(args.max) || 10))
        const found = await call<{ messages?: { id: string }[]; nextPageToken?: string }>(context, '/messages?maxResults=' + max + (args.query ? '&q=' + encodeURIComponent(String(args.query)) : ''))
        const ids: { id: string }[] = found.messages ?? []
        if (ids.length === 0) return { messages: [], note: 'No message matches.' }
        const messages: Message[] = await Promise.all(ids.map(entry => call<Message>(context, '/messages/' + entry.id + '?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date')))
        return { messages: messages.map(summary), more: Boolean(found.nextPageToken) }
      },
    },
    {
      name: 'read_message',
      description: 'Reads one message in full: sender, recipients, subject, date, labels, attachment names and its text.',
      input: { type: 'object', properties: { id: { type: 'string', description: 'The message id (from search_messages).' } }, required: ['id'] },
      run: async (args: Record<string, unknown>, context: Context) => full(await call<Message>(context, '/messages/' + encodeURIComponent(String(args.id)) + '?format=full')),
    },
    {
      name: 'read_thread',
      description: 'Reads a whole conversation, oldest message first, each with its sender, date and text.',
      input: { type: 'object', properties: { thread_id: { type: 'string', description: 'The thread id (from search_messages).' } }, required: ['thread_id'] },
      run: async (args: Record<string, unknown>, context: Context) => {
        const thread = await call<{ id: string; messages?: Message[] }>(context, '/threads/' + encodeURIComponent(String(args.thread_id)) + '?format=full')
        return { thread_id: thread.id, messages: (thread.messages ?? []).map(full) }
      },
    },
    {
      name: 'list_labels',
      description: 'The mailbox\'s labels (system ones like INBOX, UNREAD, STARRED, and its own), with their ids.',
      input: { type: 'object', properties: {} },
      example: {},
      run: async (_args: Record<string, unknown>, context: Context) => ((await call<{ labels?: { id: string; name: string; type: string }[] }>(context, '/labels')).labels ?? []).map(label => ({ id: label.id, name: label.name, type: label.type })),
    },
    {
      name: 'send_message',
      description: 'Sends an email from the signed-in account, or a reply in a thread (give reply_to_message_id).',
      input: { type: 'object', properties: messageArgs, required: ['body'] },
      changes: true,
      run: async (args: Record<string, unknown>, context: Context) => {
        const sent = await call<{ id: string; threadId: string }>(context, '/messages/send', { method: 'POST', body: JSON.stringify(await compose(context, args)) })
        return { sent: true, id: sent.id, thread_id: sent.threadId }
      },
    },
    {
      name: 'create_draft',
      description: 'Saves an email as a draft (not sent), or a draft reply in a thread (give reply_to_message_id).',
      input: { type: 'object', properties: messageArgs, required: ['body'] },
      changes: true,
      run: async (args: Record<string, unknown>, context: Context) => {
        const draft = await call<{ id: string; message?: { id: string } }>(context, '/drafts', { method: 'POST', body: JSON.stringify({ message: await compose(context, args) }) })
        return { drafted: true, draft_id: draft.id, id: draft.message?.id }
      },
    },
    {
      name: 'change_labels',
      description: 'Adds or removes labels on a message: mark read (remove UNREAD), unread (add UNREAD), archive (remove INBOX), star (add STARRED), or a label of its own by id.',
      input: { type: 'object', properties: { id: { type: 'string', description: 'The message id.' }, add: { type: 'array', items: { type: 'string' }, description: 'Label ids to add.' }, remove: { type: 'array', items: { type: 'string' }, description: 'Label ids to remove.' } }, required: ['id'] },
      changes: true,
      run: async (args: Record<string, unknown>, context: Context) => {
        const list = (value: unknown) => Array.isArray(value) ? value.map(String) : []
        const changed = await call<Message>(context, '/messages/' + encodeURIComponent(String(args.id)) + '/modify', { method: 'POST', body: JSON.stringify({ addLabelIds: list(args.add), removeLabelIds: list(args.remove) }) })
        return { id: changed.id, labels: changed.labelIds ?? [] }
      },
    },
  ],
}
