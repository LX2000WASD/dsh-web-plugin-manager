/**
 * REST surface primitives for the /api2/plugin-manager routes.
 *
 * Pure request-shaping helpers (trust fence + body parsing), kept free of
 * context/service dependencies so the Web-UI REST behavior is unit-testable
 * (tests/rest.test.mjs). The route wiring itself lives in index.ts.
 */

/** Loopback host literals always trusted (the DSH web UI binds here). */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost'])

/** Extra trusted Host values via env (comma-separated hostnames / IPs). */
function extraTrustedHosts(): Set<string> {
  const raw = process.env.DSH_PLUGIN_MANAGER_TRUSTED_HOSTS ?? ''
  return new Set(raw.split(',').map(s => s.trim().toLowerCase()).filter(s => s.length > 0))
}

/** Header value normalized to a string ('' when absent; arrays take the first). */
function headerValue(headers: Record<string, string | string[] | undefined> | undefined, name: string): string {
  const value = headers?.[name]
  if (typeof value === 'string') return value
  return Array.isArray(value) ? (value[0] ?? '') : ''
}

/** Hostname part of an authority value (handles IPv6 literals). */
function hostnameOf(authority: string): string {
  const s = authority.trim().toLowerCase()
  if (s.startsWith('[')) {
    const end = s.indexOf(']')
    return end >= 0 ? s.slice(0, end + 1) : s
  }
  const colon = s.lastIndexOf(':')
  return colon >= 0 ? s.slice(0, colon) : s
}

/** Port part of an authority value ('' when absent). */
function portOf(authority: string): string {
  const s = authority.trim()
  if (s.startsWith('[')) {
    const end = s.indexOf(']')
    return end >= 0 && s.length > end + 1 && s[end + 1] === ':' ? s.slice(end + 2) : ''
  }
  const colon = s.lastIndexOf(':')
  return colon >= 0 ? s.slice(colon + 1) : ''
}

/**
 * CSRF / DNS-rebinding fence for the REST surface.
 *  - Host must be loopback or an explicitly trusted host (an attacker domain
 *    resolving to 127.0.0.1 is refused — the check runs on the Host header,
 *    which the browser cannot fake cross-origin);
 *  - a cross-site fetch is refused (Sec-Fetch-Site);
 *  - when an Origin header is present, its host:port must equal the request's
 *    Host (a foreign page must not drive mutations); non-browser callers
 *    (curl, the CLI, same-process tools) carry no Origin and pass.
 *  - a request with NO Host header is impossible for a browser HTTP request
 *    (HTTP/1.1 always carries Host; a DNS-rebinding request carries the
 *    attacker's domain, which the checks above refuse). It arrives only from
 *    non-HTTP transports — desktop shells / custom-protocol carriers that
 *    dispatch fetch without an HTTP layer (issue #11). Such a request is
 *    accepted only when no browser context markers are attached (cross-site
 *    fetch label, or any Origin); local non-browser callers attach neither.
 */
export function isTrustedRequest(req: { headers?: Record<string, string | string[] | undefined> }): boolean {
  const rawHost = headerValue(req.headers, 'host')
  if (rawHost.length === 0) {
    const secFetch = headerValue(req.headers, 'sec-fetch-site').toLowerCase()
    if (secFetch === 'cross-site') return false
    if (headerValue(req.headers, 'origin').length > 0) return false
    return true
  }
  const host = hostnameOf(rawHost)
  if (!LOOPBACK_HOSTS.has(host) && !extraTrustedHosts().has(host)) return false
  const secFetch = headerValue(req.headers, 'sec-fetch-site').toLowerCase()
  if (secFetch === 'cross-site') return false
  const origin = headerValue(req.headers, 'origin')
  if (origin.length === 0) return true
  try {
    const url = new URL(origin)
    const originPort = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port
    const reqPort = portOf(rawHost) === '' ? '80' : portOf(rawHost)
    return url.hostname.toLowerCase() === host && originPort === reqPort
  } catch {
    return false
  }
}

/** The stream request shape the official webserver hands to routes. */
interface StreamRequest {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown
  on(event: 'end', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  destroy?(): void
}

/** Parse one JSON body text (empty text counts as an empty object). */
function parseJsonBody(text: string): unknown {
  return JSON.parse(text || '{}')
}

/** Default JSON body cap: 1 MB covers every op except the backup ones. */
const BODY_LIMIT_BYTES = 1_000_000

/**
 * Body cap for the backup ops. backupRestore embeds the whole uploaded
 * backup file inside the JSON body (and backupDiff the same for a preview),
 * and a profile with a few dozen plugins — each dependency a git URL or
 * source string — legitimately exceeds 1 MB. 16 MB keeps the fence bounded
 * while letting a real backup through.
 */
const BACKUP_BODY_LIMIT_BYTES = 16_000_000

/** The body cap for one route (backup ops carry a whole backup file). */
export function bodyLimitFor(op: string): number {
  return op === 'backupRestore' || op === 'backupDiff' ? BACKUP_BODY_LIMIT_BYTES : BODY_LIMIT_BYTES
}

/**
 * Read a JSON request body, bounded by `limit` (1 MB by default).
 *
 * Accepts whatever transport shape the host delivers: the node:http stream
 * (official `dsh web` server), a fetch-style request (`text()`/`json()`/a
 * string `body`), or a bare carrier shim with only `method`/`url`/`headers`
 * (desktop shells with no HTTP layer — issue #11). A transport with no body
 * channel resolves `{}` so routes fail on their own field validation with a
 * readable error instead of an opaque crash (which the webserver would answer
 * as a bare HTTP 400).
 */
export async function readJsonBody(req: unknown, limit: number = BODY_LIMIT_BYTES): Promise<unknown> {
  if (req !== null && typeof req === 'object') {
    const stream = req as StreamRequest
    if (typeof stream.on === 'function') {
      return await new Promise<unknown>((resolve, reject) => {
        const chunks: Buffer[] = []
        let size = 0
        stream.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > limit) {
            reject(new Error('request body too large'))
            stream.destroy?.()
          } else chunks.push(chunk)
        })
        stream.on('end', () => {
          try {
            resolve(parseJsonBody(Buffer.concat(chunks).toString('utf8')))
          } catch (error: unknown) {
            reject(error instanceof Error ? error : new Error(String(error)))
          }
        })
        stream.on('error', reject)
      })
    }
    const fetchLike = req as { text?(): Promise<string>; json?(): Promise<unknown>; body?: unknown }
    // The text()/json()/body shims cannot be interrupted mid-read, so the cap
    // is enforced after the fact — an unbounded read here would be the one
    // transport that ignores the fence (the stream branch above is the
    // normal one; these exist for desktop-shell carriers, issue #11).
    if (typeof fetchLike.text === 'function') {
      const text = await fetchLike.text()
      if (Buffer.byteLength(text, 'utf8') > limit) throw new Error('request body too large')
      return parseJsonBody(text)
    }
    if (typeof fetchLike.json === 'function') {
      const value = await fetchLike.json()
      if (Buffer.byteLength(JSON.stringify(value ?? null), 'utf8') > limit) throw new Error('request body too large')
      return value
    }
    if (typeof fetchLike.body === 'string') {
      if (Buffer.byteLength(fetchLike.body, 'utf8') > limit) throw new Error('request body too large')
      return parseJsonBody(fetchLike.body)
    }
  }
  return {}
}
