// 「被纠正」触发器。
//
// ── 为什么需要第三个触发器 ──
//
// 现在有两个：**检索未命中**（太廉价，任何新话题都未命中）与**挣扎**
// （工具层的失败）。它们有一个共同盲区：
//
//   **工具全都成功了，但答案是错的。**
//
// 那一刻工具链干净、没有报错、挣扎检测器一声不响 —— 而用户说"不对"。
// 这是唯一能看见它的信号。项目自己的知识页里就写着这类故障：
// note-688633「静默失败与可见性自噬」。
//
// ── 它和另外两个触发器有什么不同（这决定了它该做什么）──
//
// 未命中与挣扎都要**去网上找答案**。而纠正不一样：**答案来自用户**。
// 联网搜用户刚说过的话，最可能的结局是搜到一堆无关内容，
// 而且等于承认我们没在听。所以纠正触发器的动作不是补料，而是：
//   1. 把**上一轮注入过的那条知识**标成嫌疑（比"继续挣扎"更强的证据：
//      用户明确说它不是对的）
//   2. 留下一条记录 —— 用户的原话本身就是最值钱的东西，它该被人/模型看见
//
// ── 判据必须保守 ──
//
// 这是**关键词**检测，不是语义理解。误报的代价：把一条好知识降权、
// 在日志里留下噪音。所以宁可漏报：
//   · 以问号结尾的一律不算（"这样不对吗？"是在问，不是在纠正）
//   · 只认开头附近的强标记，或者明确无歧义的短语
//   · 说得出是**哪个**标记命中的，不搞黑箱

/** 出现在开头附近才算数的强标记。 */
const HEAD = [
  [/^不对/, '不对'], [/^不是/, '不是'], [/^错(了|啦|的)/, '错了'], [/^搞错/, '搞错'], [/^弄错/, '弄错'],
  [/^你(应该|应当|要|得)/, '你应该'], [/^我说的是/, '我说的是'], [/^我指的是/, '我指的是'],
  [/^我的意思/, '我的意思'], [/^重来/, '重来'], [/^重新/, '重新'], [/^别/, '别'],
  [/^不要/, '不要'], [/^纠正/, '纠正'], [/^更正/, '更正'],
  [/^no[,:，!\s]/i, 'no,'], [/^that'?s (wrong|not right)/i, "that's wrong"],
  [/^incorrect/i, 'incorrect'], [/^actually[,:，\s]/i, 'actually'],
  [/^i said/i, 'i said'], [/^you should/i, 'you should'], [/^wrong[,:，!\s]/i, 'wrong'],
]

/** 出现在任何位置都算的、无歧义的短语。 */
const ANYWHERE = [
  [/你(理解|搞|弄)错/, '你理解错'], [/不是这样/, '不是这样'], [/不是这个/, '不是这个'],
  [/我说的是/, '我说的是'], [/我指的是/, '我指的是'], [/我说过/, '我说过'],
]

/** 文本开头多长范围内算"开头附近"。 */
const HEAD_WINDOW = 12

/**
 * 这段用户输入像不像一次纠正？
 *
 * @returns { yes: boolean, markers: string[], reason?: string }
 */
export function looksLikeCorrection(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return { yes: false, markers: [] }
  // ★ 问句一律不算。这是最重要的一条保守规则：
  //   "这样不对吗？""为什么不生效？" 都是在**问**，不是在**纠正**。
  //   把它们当成纠正，就会把好知识无故降权。
  if (/[?？]\s*$/.test(raw)) return { yes: false, markers: [], reason: '以问号结尾，判为提问' }

  const markers = []
  const head = raw.slice(0, HEAD_WINDOW)
  for (const [re, name] of HEAD) if (re.test(head)) markers.push(name)
  for (const [re, name] of ANYWHERE) if (re.test(raw)) markers.push(name)

  if (markers.length === 0) return { yes: false, markers: [] }
  return { yes: true, markers: [...new Set(markers)] }
}

/**
 * 把一次纠正变成一条**与挣扎记录同形**的日志条目。
 *
 * 同形是刻意的：wiki_struggle / wiki_sessions / 界面都已经在读那个形状，
 * 再造一种形状就得把读取方全改一遍，而且很容易漏掉一处 ——
 * 那正是"看起来记了、其实没人看得见"。
 */
export function correctionRecord({ agent, text, markers, corrected = [], origin = 'agent', depth = 0, now = Date.now() }) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
  return {
    ts: now,
    sessionId: agent?.id ?? '',
    mode: 'active',
    signals: [{
      type: 'user-correction',
      // identity 不要带时间/计数 —— 那些会把同一件事拆成不同的键
      identity: clean.slice(0, 80),
      count: 1,
      markers,
      // 被纠正时**用户给了正确答案**，所以这里存原话而不是"症状查询"。
      // 症状查询是给搜索引擎用的；纠正的原话是给人/模型读的。
      detail: clean,
    }],
    corrected,
    origin,
    depth,
  }
}
