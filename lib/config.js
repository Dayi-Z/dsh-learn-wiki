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
  fetchTimeoutMs: 15000,    // 单页抓取超时
  maxAcquisitionsPerRun: 2,
  maxAttemptsPerGap: 2,
  minIntervalMs: 1500,
  distillMaxTokens: 1500,
  maxSourcesPerPage: 5,
  acquireCooldownMs: 20000,   // 两次后台补料之间的最小间隔
  // 太短的输入多半是寒暄（"我已重启"/"继续"/"好的"），不是真的知识缺口。
  // 实测这类消息会污染 gap 队列并触发无意义的联网，所以设长度下限。
  minGapQueryChars: 8,

  // ── 能力包：按需装配模型可见的工具集 ──
  // M0 实测：71 个工具 = 7,061 token/请求。workflow(633)+ralph(125) 的描述里
  // 明确写着「仅在用户显式要求时使用」，却每轮都在收费。
  capabilities: {
    enabled: true,
    // 显式专用：模型被明确告知不要主动调用，因此按需装配最安全
    explicitOnly: ['workflow', 'ralph'],
    // 纯诊断工具：系统提示词从没要求模型用它们，常驻纯属浪费。
    // 记忆族的"工作用"工具（search/list/read/reflect/capture/ingest）刻意保留 ——
    // 提示词明确指示模型在特定时机调用它们，裁掉会让那些指示无法执行。
    diagnostics: ['hindsight_sync_status', 'hindsight_diagnose'],
    // 额外要裁掉的工具名（必须是真实注册过的，否则会被静默跳过）
    deny: [],
  },

  // ── 挣扎检测：这才是真正的触发器 ──
  // observe = 只记录不联网（默认）。先跑几天看它报得准不准，再开自动联网——
  // 不用想象替代证据。
  // 记忆注入块压缩。
  // hindsight 插件每轮注入 ~1,900 字符的 <hindsight_knowledge> 块，但它的
  // TOOL_GUIDE 逐条重述了 8 个工具的用途 —— 而那些描述**已经在工具 schema 里**。
  // 纯重复，约 300 token/请求。这里换成一个短指针。
  compactHindsightBlock: true,

  // observe = 只记录不联网；active = 命中后自动登记补料。
  // 观察期实测：3 条记录全部是"同一文件改了 4 次"，而且正是我在反复调试那段代码的时刻
  // —— 判据准，所以切成 active。
  struggleMode: 'active',

  // ── 触发器来源：这才是关键改动 ──
  // 'miss'     = 检索未命中就补料（旧行为）
  // 'struggle' = 只有卡住了才补料（新行为）
  // 'both'     = 两者都
  //
  // 为什么换：实测 19 条 gap 全部是用户的对话原话（"ok 按你的倾向来"、
  // "已重启 一起写进 wiki"），没有一条是真的知识缺口。蒸馏器把其中 12 条拒了
  // —— 它在做触发器该做的活。唯一滑过去的那条产出了一页"6524 数字暗语"的垃圾。
  gapTrigger: 'struggle',
  struggleWindow: 40,             // 滑动窗口内保留多少次工具调用
  struggleRepeatIdentical: 5,     // 连续完全相同的调用（第一方中断器是 3；它负责提醒，我负责花钱）
  struggleRepeatFailure: 3,       // 连续失败（参数可以一直变，但每次都以错误收场）
  struggleEditChurn: 4,           // 同一文件被反复改写
  struggleRecurringError: 3,      // 归一化后同一堵墙反复出现
  struggleCooldownMs: 120000,     // 同一类信号的静默期，避免刷屏

  // ── 来源偏好：这类问题搜到的垃圾很多，优先取高权重域名 ──
  preferDomains: [
    'nodejs.org', 'developer.mozilla.org', 'docs.python.org', 'learn.microsoft.com',
    'github.com', 'stackoverflow.com', 'arxiv.org', 'pnpm.io', 'npmjs.com',
    'deepseekdocs.com', 'deepseek-ai.github.io',
  ],
  domainStrict: false,            // false = 白名单优先但不排除其他；true = 只用白名单

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
