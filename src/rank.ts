/**
 * 模糊名称匹配打分（vendor 自 DSH 官方 ui-primitives 的 rank-by-name.ts，
 * dsh-v0.1.3-alpha.1 引入——npm 尚未发布 0.1.3，peer 包里还拿不到该导出，
 * 待 0.1.3 上架 npm 后可评估切回官方导入）。
 *
 * 语义：整条 query 作为"有序子序列"去候选名里匹配（不分词）。官方设计记录
 * （.agents/notes/implemented/feature/2026-08-04-web-slash-command-fuzzy-discovery.md）
 * 明确否决了无序字符匹配与第三方 fuzzy 依赖（bundle 权重 + 排序不可预测）：
 * 小候选目录 + 一条受约束的子序列规则即可。打分规则（经长名适配，见
 * fuzzyScore 注释）：
 *  - 命中位是名字首位、或前一个字符是 - / _（分隔符边界）加分；
 *  - 连续命中（上一个 query 字符落在前一位）强加分；
 *  - 间隔命中按实际间距扣分；首字符起始位有界扣分；
 *  - 不是子序列直接淘汰；前缀命中在调用方排序时优先于对齐分。
 *
 * 纯函数、无依赖——host 单测（tests/rank.test.mjs）与 client bundle
 * （市场/目录搜索框）共用同一实现，保证两处行为一致。
 */

/** 边界加分：命中位是名字首位，或前一个字符是 - / _。 */
function boundaryBonus(name: string, index: number): number {
  if (index === 0) return 8
  const prev = name[index - 1]
  return prev === '-' || prev === '_' ? 8 : 0
}

/** A2 预筛掩码：字符串里出现过的小写 ASCII 字母集合（26 位）。 */
export type CharMask = number

/**
 * 计算 {@link CharMask}：把 a–z 映射到 26 个 bit。市场搜索在**预构建小写
 * 索引**时对每个候选字段算一次，之后每键击只算一次 needle 的掩码。
 *
 * 只用 ASCII 字母：非 ASCII 字符（CJK / emoji）不进掩码，因此掩码**只会**
 * 放过、绝不会误杀——这是预筛正确性的前提。子序列匹配要求 needle 的每个
 * 字符都在 haystack 里出现过，即字符集合是超集关系，掩码检查是它的必要
 * 条件。
 */
export function charMask(value: string): CharMask {
  let mask = 0
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    // 小写 a–z（调用方传入的已是小写串）；大写一并兼容，避免误用。
    if (code >= 97 && code <= 122) mask |= 1 << (code - 97)
    else if (code >= 65 && code <= 90) mask |= 1 << (code - 65)
  }
  return mask
}

/**
 * 模糊名称匹配打分：query 作为 name 的有序子序列的最优对齐分
 * （时间 O(name×query)，空间 O(query)）。返回 null 表示不是子序列
 * （淘汰）。大小写不敏感。
 *
 * 对官方算法的一处适配：官方用"全局 -index"惩罚晚起始（面向短命令名），
 * 在 marketplace 的长仓库名上会累计成大负分（如 trmnl→dsh-terminal-panel
 * = -14），反而输给 1 分的描述兜底命中。这里改为：
 *  - 首字符惩罚有界（-min(i, 6)），保持"前缀 > 边界 > 晚起始"的排序意图；
 *  - 间隔命中按实际间距扣分（-(gap-1)），连续命中强加分（+4）；
 *  - 总分下限 1——名称命中（哪怕很松）恒不低于描述子串兜底命中。
 */
export function fuzzyScore(name: string, query: string): number | null {
  return fuzzyScoreLowered(name.toLowerCase(), query.toLowerCase())
}

/**
 * A2 掩码预筛（唯一落地的 A2 优化）。
 *
 * 两个**可选**参数，不传即完全退回原行为（签名与语义向后兼容）：
 * @param hayMask - {@link charMask}(haystack)，调用方预构建索引时算一次。
 * @param needleMask - {@link charMask}(needle)，每键击算一次。
 *   两个都传时启用 O(1) 预筛：needle 的字符集合不是 haystack 的子集 ⇒
 *   一定不是子序列 ⇒ 直接淘汰，跳过整个 DP。掩码只做**拒绝**、不参与
 *   打分，所以传与不传的命中分数逐条相同（tests/rank.test.mjs 有断言）。
 *
 * **DP 数组缓冲复用：实测后放弃**（perf.md 的 A2 建议包含它，但数据不支持）。
 * 实测（/tmp/pmperf/bench-a2-holey.mjs，13k×2 字段，15 轮交错中位数）：
 *   每次 new Array + fill（现状）  26.32 ms
 *   模块缓冲复用（holey）          28.78 ms  (+9%)
 *   模块缓冲复用（packed）         28.30 ms  (+8%)
 * 缓冲复用**更慢**——分配 4 个小数组在 V8 里很便宜（young-gen bump allocation），
 * 而复用要付重置 4×(m+1) 格 + 长生命周期数组阻碍逃逸分析/标量替换的代价。
 * 它还引入模块级可变状态（重入风险），因此这里保持每次新分配：更快且是纯函数。
 * 详见 docs/private/audit/perf-verify.md。
 */
export function fuzzyScoreLowered(haystack: string, needle: string, hayMask?: CharMask, needleMask?: CharMask): number | null {
  const m = needle.length
  if (m === 0) return 0
  const n = haystack.length
  if (m > n) return null
  // A2 预筛：只做必要条件检查（见上方说明），不影响任何命中条目的分数。
  if (hayMask !== undefined && needleMask !== undefined && (hayMask & needleMask) !== needleMask) return null

  // 逐扫描位推进的两行 DP：
  //  exact[j] —— query 前 j 个字符已匹配、且第 j 个字符恰好命中的最优分；
  //  bestScore[j]/bestPos[j] —— 前 j 个字符已匹配的最优分及其最后命中位，
  //          是间隔命中的来源（间隔 = i - bestPos）。
  // j 降序遍历保证读到的 best[j-1] 不含当前位的命中。
  let exactRow: Array<number | null> = new Array<number | null>(m + 1).fill(null)
  let nextRow: Array<number | null> = new Array<number | null>(m + 1).fill(null)
  const bestScore: Array<number | null> = new Array<number | null>(m + 1).fill(null)
  const bestPos: number[] = new Array<number>(m + 1).fill(0)
  bestScore[0] = 0
  for (let i = 0; i < n; i += 1) {
    const ch = haystack[i]
    for (let j = Math.min(m, i + 1); j >= 1; j -= 1) {
      if (needle[j - 1] !== ch) continue
      const bonus = boundaryBonus(haystack, i)
      let score: number
      if (j === 1) {
        // 首字符：分隔符边界加分，晚起始有界扣分。
        score = 1 + bonus - Math.min(i, 6)
      } else {
        const gap = i - bestPos[j - 1]! // ≥ 1（best 含上一扫描位）
        const gapped = bestScore[j - 1] !== null
          ? bestScore[j - 1]! + 1 + bonus - (gap - 1)
          : null
        const consecutive = exactRow[j - 1] !== null
          ? exactRow[j - 1]! + 1 + bonus + 4
          : null
        score = consecutive !== null && gapped !== null
          ? Math.max(consecutive, gapped)
          : (consecutive ?? gapped)!
      }
      if (nextRow[j] === null || score > nextRow[j]!) nextRow[j] = score
      if (bestScore[j] === null || score > bestScore[j]!) {
        bestScore[j] = score
        bestPos[j] = i
      }
    }
    // 扫描位推进：当前行并入历史最优，旧行复用为下一行的 exact。
    const swap = exactRow
    exactRow = nextRow
    nextRow = swap
    nextRow.fill(null)
  }
  const raw = bestScore[m]
  return raw === null ? null : Math.max(raw, 1)
}

/** fuzzyFilter 的一条命中：原条目 + 排序键。 */
export interface FuzzyHit<T> {
  readonly item: T
  /** 对齐分（越大越好）。 */
  readonly score: number
  /** 前缀命中（排序时优先于对齐分）。 */
  readonly prefix: boolean
}

/**
 * 对条目列表做模糊过滤并按官方排序契约排好：前缀命中 > 对齐分 > 原顺序。
 * 空 query 返回 null（调用方走自己的默认路径）。
 */
export function fuzzyFilter<T>(
  items: readonly T[],
  nameOf: (item: T) => string,
  query: string,
): FuzzyHit<T>[] | null {
  const trimmed = query.trim()
  if (trimmed.length === 0) return null
  const needle = trimmed.toLowerCase()
  // A2：needle 掩码每查询算一次；候选掩码随小写串一起现算（本函数没有预构建
  // 索引的调用方）。掩码只做拒绝，命中与分数与不传掩码时逐条相同。
  const needleMask = charMask(needle)
  const hits: FuzzyHit<T>[] = []
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!
    const lowered = nameOf(item).toLowerCase()
    const score = fuzzyScoreLowered(lowered, needle, charMask(lowered), needleMask)
    if (score === null) continue
    hits.push({ item, score, prefix: lowered.startsWith(needle) })
  }
  hits.sort((left, right) =>
    Number(right.prefix) - Number(left.prefix) || right.score - left.score || 0)
  // 稳定排序下同分保持原顺序（ES 规范保证 Array.sort 稳定），无需再带 index。
  return hits
}
