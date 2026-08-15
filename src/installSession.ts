/**
 * C2：安装会话状态机（awaiting-input）。
 *
 * git 源 cordis 插件安装暂停等待环境变量时，记录扫描白名单与克隆目录；
 * 用户提交 answers 后按白名单校验注入（防 PATH/HOME 等任意键注入劫持）。
 *
 * 会话以 spec 为键（同一 spec 同时只有一个进行中的暂停安装），15 分钟
 * TTL 惰性清理；克隆目录本身在 <dshHome>/plugin-manager-src/ 持久缓存，
 * 会话只记引用，重启进程丢失会话也无害（用户重新发起安装即可，克隆可复用）。
 */

export interface InstallSession {
  /** 原始安装源 spec（npm 名 / git URL / 本地路径）。 */
  readonly spec: string
  /** 扫描过的仓库目录（克隆缓存或本地路径）。 */
  readonly cacheDir: string
  /** 扫描白名单：只允许这些键被注入。 */
  readonly scanned: readonly string[]
  readonly createdAt: number
}

/** 会话存活时间：超过后视为放弃，克隆缓存保留（可复用）。 */
const SESSION_TTL_MS = 15 * 60 * 1000

/** Normalize the session key: trailing slashes and case must not split one
 *  install into two sessions (audit — a re-submit with a different slash or
 *  case rebuilt the session and re-scanned). */
function sessionKey(spec: string): string {
  return spec.trim().replace(/\/+$/, '').toLowerCase()
}

const sessions = new Map<string, InstallSession>()

/** 创建会话（同 spec 已存在则覆盖），返回 spec 键。 */
export function createInstallSession(spec: string, cacheDir: string, scanned: readonly string[]): string {
  pruneExpiredSessions()
  const key = sessionKey(spec)
  sessions.set(key, { spec, cacheDir, scanned, createdAt: Date.now() })
  return key
}

export function getInstallSession(spec: string): InstallSession | undefined {
  pruneExpiredSessions()
  return sessions.get(sessionKey(spec))
}

/** 丢弃会话（用户取消 / 安装继续后不再需要）。 */
export function dropInstallSession(spec: string): void {
  sessions.delete(sessionKey(spec))
}

/**
 * 校验并过滤 answers（白名单来自会话或本次扫描，两者等价）：
 *  - 键必须 ∈ 扫描白名单（防 PATH/HOME/__proto__ 等任意键注入）；
 *  - 空字符串 = 跳过（键出现即视为已提供，不注入）；
 *  - __ 前缀内部键一律拒绝（目前没有内部确认问题，纯防御）。
 */
export function filterAnswers(scanned: readonly string[], answers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (answers === undefined) return out
  for (const [key, value] of Object.entries(answers)) {
    if (key.startsWith('__')) continue
    if (!scanned.includes(key)) continue
    if (typeof value !== 'string' || value.length === 0) continue
    out[key] = value
  }
  return out
}

/** 惰性清理过期会话（每次访问时顺带执行，无需定时器）。 */
export function pruneExpiredSessions(): void {
  const now = Date.now()
  for (const [key, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) sessions.delete(key)
  }
}

/** 当前会话数（诊断用）。 */
export function sessionCount(): number {
  return sessions.size
}
