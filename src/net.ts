/**
 * Marketplace network helpers: per-request timeout and proxy support.
 *
 * Node's global fetch ignores undici's `dispatcher` option, so a
 * proxy-aware fetch must come from the undici package itself: marketplace
 * requests run through undici's fetch with a ProxyAgent dispatcher when
 * HTTP_PROXY / HTTPS_PROXY is set. Without this, users whose only path to
 * GitHub is a system/rule-mode accelerator (browser works, Node does not)
 * would see an empty marketplace with no way to fix it.
 */

import { ProxyAgent, fetch as undiciFetch } from 'undici'
import type { RequestInit as UndiciRequestInit, Response as UndiciResponse } from 'undici'

/** Per-request cap: a silently hung connection must not pin the page. */
export const MARKETPLACE_FETCH_TIMEOUT_MS = 15_000

/** Cached agents, one per proxy URL (agents are stateless dispatchers). */
const agents = new Map<string, ProxyAgent>()

/** Whether a NO_PROXY entry covers the host (simple suffix match). */
function noProxyMatches(host: string): boolean {
  const noProxy = process.env.NO_PROXY ?? process.env.no_proxy
  if (noProxy === undefined || noProxy === '') return false
  return noProxy.split(',').some((entry) => {
    const e = entry.trim()
    return e === '*' || host === e || host.endsWith('.' + e)
  })
}

/** Proxy agent for the URL's scheme, or null when no proxy applies. */
export function proxyAgentFor(url: string): ProxyAgent | null {
  const proxy = url.startsWith('https:')
    ? process.env.HTTPS_PROXY ?? process.env.https_proxy
    : process.env.HTTP_PROXY ?? process.env.http_proxy
  if (proxy === undefined || proxy === '') return null
  if (noProxyMatches(new URL(url).hostname)) return null
  let agent = agents.get(proxy)
  if (agent === undefined) {
    agent = new ProxyAgent(proxy)
    agents.set(proxy, agent)
  }
  return agent
}

/**
 * Fetch one marketplace URL with a bounded timeout through the configured
 * proxy. The caller's init (headers etc.) is preserved. Returns undici's
 * Response (its fetch, not the global one — the global fetch drops the
 * dispatcher option).
 */
export async function marketplaceFetch(url: string, init?: UndiciRequestInit): Promise<UndiciResponse> {
  const agent = proxyAgentFor(url)
  return await undiciFetch(url, {
    ...init,
    signal: AbortSignal.timeout(MARKETPLACE_FETCH_TIMEOUT_MS),
    ...(agent !== null ? { dispatcher: agent } : {}),
  })
}
