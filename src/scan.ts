/**
 * C2：环境变量需求扫描 + env 卫生（纯函数，可单测）。
 *
 * 面向 git 源 cordis 插件安装：克隆/本地目录就绪后，扫描仓库里安装/构建
 * 阶段可能需要的环境变量（README/.env/package.json/yaml/install 脚本中的
 * 敏感形态变量名），由安装流程暂停询问用户提供；提供的值只按扫描白名单
 * 注入子进程 env（防 PATH/HOME 等任意键注入劫持），其余宿主环境变量不再
 * 透传给第三方包的生命周期脚本（prepare/postinstall 等会继承子进程 env，
 * 全量透传等于把宿主各类 token/key 直接交给未审核的第三方代码）。
 *
 * 参考实现：reference/dsh-plugins-marketplace/lib/index.js
 * （isSensitiveEnvKey / SCRIPT_ENV_KEYS / buildMinimalEnv / buildFilteredEnv / scanRequirements）。
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 敏感环境变量名判定：TOKEN / KEY / SECRET / PASSWORD / PASS / CREDENTIAL，
 * 大小写不敏感。不能用 \b 词边界（下划线是 \w 单词字符，GITHUB_TOKEN 中
 * TOKEN 前无边界）——用 (?!...)/(?<!...) 字母数字感知边界：GITHUB_TOKEN /
 * OPENAI_API_KEY / DB_PASSWORD 都命中，而 KEYBOARD_LAYOUT（KEY 后是 B）
 * 不误伤。
 */
export function isSensitiveEnvKey(name: string): boolean {
  return /(?<![A-Za-z0-9])(TOKEN|KEY|SECRET|PASSWORD|PASS|CREDENTIALS?)(?![A-Za-z0-9])/i.test(String(name ?? ''))
}

/**
 * 扫描匹配的变量名形态（README/.env/脚本中的引用）：
 *   OPENAI_API_KEY / GITHUB_TOKEN / DB_PASSWORD / XXX_PASS / 驼峰 ApiKey…
 * 只匹配「敏感形态」——安装/构建阶段通常只有凭据类变量需要用户提供；
 * 普通配置项（PORT、NODE_ENV 等）默认值可用，扫出来只会打扰用户。
 */
const ENV_PATTERN = /\b(?:[A-Z][A-Z0-9_]{1,}(?:API_KEY|_KEY|_TOKEN|_SECRET|_PASSWORD)|[A-Z][A-Z0-9_]{3,}_PASS|[a-z][A-Za-z0-9]*(?:ApiKey|Token|Secret|Password))\b/g

/** 扫描成本上限：文件数 / 目录深度 / 返回变量数。 */
const SCAN_MAX_FILES = 40
const SCAN_MAX_DEPTH = 2
const SCAN_MAX_VARS = 8

/**
 * 扫描仓库目录，返回安装/构建阶段可能需要的环境变量名（去重、上限 8 个）。
 * 递归两层（跳过点目录 / node_modules / dist / build），只读候选文件
 * （readme / install / .env / package.json / yaml / markdown），成本可控。
 */
export async function scanRequirements(dir: string): Promise<string[]> {
  const names = new Set<string>()
  const files: string[] = []
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > SCAN_MAX_DEPTH || files.length >= SCAN_MAX_FILES) return
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const p = join(current, ent.name)
      if (ent.isDirectory()) {
        if (ent.name.startsWith('.') || ent.name === 'node_modules' || ent.name === 'dist' || ent.name === 'build') continue
        await walk(p, depth + 1)
      } else if (/(readme|install|\.env|package\.json|\.ya?ml$|\.md$)/i.test(ent.name)) {
        files.push(p)
      }
    }
  }
  await walk(dir, 0)
  for (const file of files.slice(0, SCAN_MAX_FILES)) {
    try {
      const text = await readFile(file, 'utf8')
      for (const m of text.matchAll(ENV_PATTERN)) names.add(m[0])
    } catch {
      /* binary or unreadable */
    }
  }
  return [...names].slice(0, SCAN_MAX_VARS)
}

/**
 * 过滤 env：剔除敏感键（npm/pnpm 子进程用）。pnpm 自身不需要凭据类变量
 * （私有 registry 走 .npmrc / 凭据助手），生命周期脚本也不该拿到它们——
 * 防止 GITHUB_TOKEN、各类 API Key 被第三方 prepare 脚本静默读取上传。
 */
export function buildFilteredEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    if (!isSensitiveEnvKey(key)) env[key] = value
  }
  return env
}
