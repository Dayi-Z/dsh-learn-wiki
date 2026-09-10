// 配置：代码内默认值 + <wikiRoot>/wiki.config.json 覆盖 + apply() 第二参数覆盖。
//
// 刻意不使用 Cordis 的 Config schema：本插件在 rc 阶段要能容忍未知键，
// 而严格 schema 会把用户多写的一个键变成加载失败。
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const DEFAULTS = {
  enabled: true,
  wikiRoot: 'D:\\Harness\\dsh-wiki',

  // ── 旋钮 A：记忆什么时候注入 ──
  autoContext: true,          // A1/A3：宿主自动注入，不需要模型主动查
  maxInjectChars: 3000,
  maxInjectPages: 8,
  minConfidence: 0.3,         // 低于此置信度的页不参与召回
  // 阈值来自 scripts/calibrate.mjs 实测标定；语料显著变化后需重跑标定
  hitThreshold: 0.20,         // score >= 此值 → hit（注入正文）
  weakThreshold: 0.13,        // score >= 此值 → weak（只注入标题索引）；低于 → miss
  injectOncePerSession: true, // 同一会话内容不变则只注入一次（KV cache 友好）

  // ── 旋钮 B：未命中之后干什么（B2 非阻塞后台补料）──
  autoAcquire: true,
  webMaxResults: 5,
  // 搜索只返回标题 + 短 snippet，不含正文。只喂 snippet 给蒸馏器，
  // 它只能拒绝——实测两条 gap 都是这么被拒的，理由写得很对：
  // "搜索结果仅提供标题与 URL，未包含任何可引用的正文内容"。
  // 所以要真的抓正文，蒸馏才有据可依。
  fetchSources: true,
  fetchTopN: 3,             // 抓取前 N 条结果的正文
  fetchMaxChars: 4000,      // 每条正文截断长度
  maxAcquisitionsPerRun: 2,
  maxAttemptsPerGap: 2,
  minIntervalMs: 1500,
  distillMaxTokens: 1500,
  maxSourcesPerPage: 5,
  acquireCooldownMs: 20000,   // 两次后台补料之间的最小间隔
  // 太短的输入多半是寒暄（"我已重启"/"继续"/"好的"），不是真的知识缺口。
  // 实测这类消息会污染 gap 队列并触发无意义的联网，所以设长度下限。
  minGapQueryChars: 8,

  // ── 蒸馏用模型（留空跟随宿主默认）──
  llmProvider: '',
  llmModel: '',
}

export async function loadConfig(wikiRoot, override = {}) {
  const root = override.wikiRoot || wikiRoot || DEFAULTS.wikiRoot
  let fileCfg = {}
  try {
    const raw = await readFile(join(root, 'wiki.config.json'), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fileCfg = parsed
  } catch { /* 没有配置文件就用默认值 */ }
  const cfg = { ...DEFAULTS, ...fileCfg, ...(override && typeof override === 'object' ? override : {}), wikiRoot: root }
  // 阈值必须有序，否则三分桶会退化成二分类
  if (!(cfg.hitThreshold > cfg.weakThreshold)) {
    cfg.hitThreshold = DEFAULTS.hitThreshold
    cfg.weakThreshold = DEFAULTS.weakThreshold
  }
  return cfg
}
