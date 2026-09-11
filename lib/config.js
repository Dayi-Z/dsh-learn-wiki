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
  // 阈值是**唯一真源**：lib/recall.js 的 triage() 默认值从这里取。
  // 曾经两处各写了一份，改一处另一处不动——测试走的是 recall.js 那份，
  // 于是"改了配置却没生效"，而且没有任何报错。
  //
  // 取值来自 scripts/calibrate.mjs 的标定（正例 0.152–0.541 / 负例 0.000–0.105）。
  //
  // ★ 已知局限：那个标定跑在**合成语料**上，代表不了真实语料。
  //   实测：负例「如何配置 kubernetes sidecar 注入策略」在合成语料得 0.0000，
  //   在真实 12 页语料却得 0.2141（与 opencode 那页共享「配置/注入」两个通用词），
  //   跨过 0.20 被判成 hit——也就是把整页正文注进提示词。
  //   语料继续增长时应当对**真实语料**重跑标定，而不是继续用合成语料的数。
  // ★ 查询词里出现比例超过这个值的，视为**通用词**，不计入覆盖度。
  //
  //   为什么必须有：中文没有词边界，分词器输出字符二元组，而「的」是最常见的
  //   汉字——实测在 19 页真实语料里出现在 15 页（df/n≈0.79）且 tf 很高。
  //   它和内容词被同等对待，于是「Rust 的 borrow checker 报错怎么绕过」
  //   这条与语料毫无关系的查询拿到 0.3737，**比 13 条真实正例里的 4 条还高**。
  //   后果不是排名不好看，而是把无关页面的正文注进提示词。
  //
  //   0.2 是用 scripts/calibrate-real.mjs 在真实语料 + 18 条标注查询上扫出来的：
  //     基线（不过滤）  正例最低 0.2811 / 负例最高 0.3737 → Gap -0.093（不可分）
  //     0.5             0.2811 / 0.3136 → Gap -0.033
  //     0.4–0.25        0.2351 / 0.3136 → Gap -0.079
  //     **0.2**         0.2446 / 0.1969 → Gap **+0.048**  ← 第一个转正的点
  //     0.1             0.1593 / 0.1394 → Gap +0.020
  //   0.2 处正例 top1 正确率与基线**完全相同**（12/13），即没有为了分离开而牺牲命中。
  //
  //   ★ 样本只有 19 页 / 18 条查询，间隔 +0.048 是薄的。语料显著增长后必须重扫。
  maxDfRatio: 0.2,
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
  // 会话提炼的输出上限。比 distillMaxTokens 高，因为一次可能产出多条
  // （distill 只出一页）。**同样走配置而不是写死在代码里**——
  // 实测第一次真实调用就失败了，写死意味着调它要改代码、等重载、再试一轮。
  harvestMaxTokens: 3000,
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

  // ── 技能按 agent 粒度裁剪 ──
  // 技能目录是每一轮都要背着的固定成本（name + description），而不同 agent
  // 需要的技能不一样。刻意默认**关**：裁剪错了会让 agent 看不见它需要的技能，
  // 而那是个很难被发现的故障（模型不会说"我少看到一个技能"）。
  // 打开之前先用 ui:probe / 界面上的技能表看清常驻成本到底是多少。
  skills: {
    enabled: false,
    // 按会话头的 agentPreset 给名单；子代理统一用 'subagent' 这个键。
    // 例：{ "code": ["karpathy-guidelines"], "subagent": [] }
    perAgent: {},
    // 全局裁掉（任何 agent 都看不到）
    deny: [],
  },

  // ── 使用证据的处置策略（升级梯子，每一档都可逆）──
  //   1. 排序降权（自动，不碰数据）
  //   2. 标记待审（写进 usage.json，出现在 wiki_review）
  //   3. 停止自动注入（仍可被 wiki_recall 显式检索）
  // 刻意没有"删除"这一档 —— 我们没能力判断一条知识是不是真的错了。
  usagePolicy: {
    suspectFlagAt: 3,     // 嫌疑累计到几次 -> 隔离出自动注入
    deadAfterDays: 21,    // 页龄超过多少天且零命中 -> 死知识
  },

  // 投递的"弱确认"最小观察期。
  // 投递完立刻结束轮次的话，模型根本没机会用它 —— 那时记确认是**假阳性**，
  // 而且会抬高一条从未被检验过的知识的排序。宁可少记，不要记错。
  deliveryConfirmMinDwellMs: 10000,

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
  // 下面这套阈值不是拍的，是按实测分布调的。
  // 在一个真实开发会话里落了 23 条记录：edit-churn 20、repeat-failure 3、
  // recurring-error 1、repeat-identical 0。也就是说**阈值 4 的 edit-churn 基本等于
  // "只要你认真改一个文件就会报警"**——被记下的全是"client.js 改了 7 次"这种正常迭代，
  // 而它会真的去联网并把资料插进对话。唯一的 repeat-identical 零误报，阈值原样不动：
  // 那是最精确的信号，不该跟着一起放松。
  struggleRepeatIdentical: 5,     // 连续完全相同的调用（0 误报，保持）
  struggleRepeatFailure: 5,       // 连续失败 3→5：探测性试错（批量读一批不存在的文件）也会连着失败
  struggleEditChurn: 8,           // 同一文件被反复改写 4→8：4 次是正常编辑，8 次才值得看一眼
  // ★ edit-churn 必须**配上失败证据**才算"卡住"。
  //
  // 阈值从 4 提到 8 并没有解决问题：改完之后 43 条记录里仍有 35 条是 edit-churn，
  // 全部来自正常迭代（同一个 client.js 改了十几次、每次都跑通了）。
  // 它登记的两条 gap，一条被蒸馏器拒绝、一条沉淀出关于**另一个撞名项目**的内容。
  // 35 次触发，零正确产出 —— 提高阈值治不了，因为病不在阈值上：
  // **"反复修改"是努力，不是失败**。死胡同的证据是撞了墙。
  //
  // 设成 false 可以退回旧行为（只按次数）。留这个开关是因为这是行为变更，
  // 而行为变更应当可逆。
  struggleEditChurnNeedsFailure: true,
  // ★ 哪些挣扎信号**允许**变成联网检索。
  //
  // 判据不是"信号准不准"，而是"**这个查询网上有没有人写过**"：
  //   repeat-failure / recurring-error 携带着**错误文本** —— 那是可搜的，
  //     网上真的有人踩过同一堵墙并写下来。
  //   edit-churn 携带的只有一个**本地文件名**（"反复修改 client.js 仍不成功"），
  //     这句话在网上不存在。检索它最好的结果是噪声，最坏的结果是**同名项目**。
  //
  // 后者不是猜想，是实测：35 次 edit-churn 触发登记了 2 条 gap，一条被蒸馏器拒绝，
  // 另一条沉淀出了 llm-wiki-v120-client-crash-upgrade —— 一页关于**另一个叫
  // llm-wiki 的 npm 包**的内容，只因为都在改一个叫 client.js 的文件。
  // 那页现在躺在 .rejected/ 里当证据。
  //
  // edit-churn 仍然**照常记录**（它是"这一步很费劲"的有用观测，界面上看得到），
  // 只是不再通往联网。要重新打开就把 edit-churn 加回这个数组。
  gapTriggerSignals: ['repeat-failure', 'recurring-error'],
  struggleRecurringError: 5,      // 归一化后同一堵墙反复出现 3→5
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
  // 阈值必须是**有限数**且有序。
  // 只判断大小是不够的：undefined > 0.13 为 false，会被"修"成 DEFAULTS.hitThreshold，
  // 而那个也是 undefined —— 于是 score >= undefined 恒为 false，**没有任何查询能成为 hit**，
  // 而且一声不响。实测踩到过（一次编辑误删了这一行）。
  if (!Number.isFinite(cfg.hitThreshold) || !Number.isFinite(cfg.weakThreshold)
      || !(cfg.hitThreshold > cfg.weakThreshold)) {
    cfg.hitThreshold = DEFAULTS.hitThreshold
    cfg.weakThreshold = DEFAULTS.weakThreshold
  }
  return cfg
}
