// 知识页的「使用证据」与强化因子。
//
// 为什么需要（调研后的结论）：
//   现在的排序**只有相似度**。而"一条过期的真话"和"一条当前的假话"，
//   对查询的相似度完全一样 —— 相似度检索里没有"不再为真"这个概念。
//
//   所以不问"这条对不对"（那个问题没有答案），而是记录**它有没有被确认**：
//   命中且当轮没继续挣扎 = 弱确认；命中后仍然挣扎 = 疑似有害。
//   让没被确认的知识自己沉下去 —— 降权可逆，删除不可逆。
//
// 三个信号：
//   hits      —— 被召回注入的次数（liveness：从没命中过就是死知识）
//   confirmed —— 命中且该轮**没有**触发挣扎（弱正证据）
//   suspect   —— 命中后**仍然**挣扎了（弱负证据，可能是有害知识）
//
// 最后一类是自动沉淀最致命的盲区，而它恰好是可测的。
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const FILE = 'usage.json'

export function emptyUsage() {
  return { version: 1, pages: {} }
}

export async function loadUsage(repoRoot) {
  try {
    const raw = await readFile(join(repoRoot, FILE), 'utf8')
    const j = JSON.parse(raw)
    if (j && typeof j === 'object' && j.pages && typeof j.pages === 'object') return j
  } catch { /* 没有就是没有 */ }
  return emptyUsage()
}

export async function saveUsage(repoRoot, usage) {
  try {
    await mkdir(repoRoot, { recursive: true })
    await writeFile(join(repoRoot, FILE), JSON.stringify(usage, null, 2) + '\n', 'utf8')
    return true
  } catch { return false }
}

function entry(usage, id) {
  usage.pages[id] ??= { hits: 0, confirmed: 0, suspect: 0, lastHit: null, lastConfirmed: null }
  return usage.pages[id]
}

/**
 * 记录一次召回命中。
 *
 * 注意：命中**不等于**确认 —— 它只证明"这条被检索到了"。
 * 确认要看这一轮后来有没有挣扎。所以这里只动 hits。
 */
export function recordHit(usage, ids, now = new Date().toISOString()) {
  for (const id of ids) {
    if (!id) continue
    const e = entry(usage, id)
    e.hits += 1
    e.lastHit = now
  }
  return usage
}

/** 该轮没有挣扎 -> 弱确认。 */
export function recordConfirmed(usage, ids, now = new Date().toISOString()) {
  for (const id of ids) {
    if (!id) continue
    const e = entry(usage, id)
    e.confirmed += 1
    e.lastConfirmed = now
  }
  return usage
}

/** 该轮**仍然**挣扎 -> 疑似有害。这是最有价值的一类信号。 */
export function recordSuspect(usage, ids, now = new Date().toISOString()) {
  for (const id of ids) {
    if (!id) continue
    const e = entry(usage, id)
    e.suspect += 1
  }
  return usage
}

const DAY = 86400000
const BOOST_CAP = 5        // 确认带来的加成最多算 5 次
const BOOST_PER = 0.10     // 每次 +10%，封顶 +50%
const FRESH_DAYS = 90      // 确认的加成在 90 天内线性衰减
const SUSPECT_PENALTY = 0.30
const FLOOR = 0.15         // 有嫌疑时的下限 —— 降权而非删除

/**
 * 强化因子。
 *
 * 刻意让**无证据 = 1.0（中性）**：新知识没有证据，不该因为"没人确认过"就被惩罚，
 * 否则冷启动永远起不来。只有**出现证据之后**才让分数上下浮动。
 */
export function reinforcementFactor(stat, now = Date.now()) {
  if (!stat) return 1
  const c = stat.confirmed ?? 0
  const s = stat.suspect ?? 0
  if (c === 0 && s === 0) return 1

  // 确认加成：随时间衰减（"被反复确认的保持热度，没被确认的下沉"）
  let boost = 1
  if (c > 0) {
    const last = stat.lastConfirmed ? Date.parse(stat.lastConfirmed) : NaN
    const ageDays = Number.isFinite(last) ? (now - last) / DAY : FRESH_DAYS
    const freshness = Math.max(0, 1 - ageDays / FRESH_DAYS)
    boost = 1 + Math.min(c, BOOST_CAP) * BOOST_PER * freshness
  }

  // 嫌疑惩罚：每次 -30%，但有下限 —— 降权可逆，删除不可逆
  const penalty = s === 0 ? 1 : Math.max(FLOOR, 1 - s * SUSPECT_PENALTY)

  const raw = boost * penalty
  // ★ 有嫌疑就**不许被抬升**。
  // 一条曾经导致挣扎的知识，不该因为历史确认多就被推到中性以上；
  // 嫌疑封顶 1.0，确认只能在嫌疑存续期间把它拉回中性。
  return s > 0 ? Math.min(raw, 1) : raw
}

/** 供 UI/诊断：给一条使用记录打标签。 */
export function usageLabel(stat) {
  if (!stat || (stat.hits ?? 0) === 0) return 'dead'        // 从没被命中 -> 死知识
  if ((stat.suspect ?? 0) > 0) return 'suspect'             // 命中后仍挣扎 -> 疑似有害
  if ((stat.confirmed ?? 0) > 0) return 'confirmed'         // 命中且没挣扎 -> 弱确认
  return 'unconfirmed'                                      // 命中过但无后续证据
}
