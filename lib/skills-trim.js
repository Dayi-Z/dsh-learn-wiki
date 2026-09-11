// 技能按 agent 粒度裁剪。
//
// ── 为什么需要 ──
//
// 技能目录是**每一轮都要背着的固定成本**：11 个技能的 name + description
// 就在上下文里，无论是否调用都要付。而不同 agent 需要的技能根本不一样 ——
// 一个纯写代码的 agent 不需要"设计 banner"。
//
// ── 做法（这是我核实过的，不是想当然）──
//
// 宿主 dsh-tool-skill 的 README 写着：
//   "每条目录消息都携带 `skill-catalog` 来源……它的 `entries` 精确记录本次
//    发布的 name/description 对……**digest 覆盖这些持久条目，而不是渲染后的正文**，
//    因此 <system-reminder> 包装不会影响是否重发。"
//
// 也就是说：
//   改 content[].text（渲染出来的散文）-> 宿主不认为目录变了，**不重发**
//   改 source.entries                -> digest 变了 -> 宿主判定目录变化 ->
//                                        **每一步都重发一遍**
// 所以裁剪只改渲染文本，绝不碰 entries。这不是优化，是正确性。

const LINE = /^-\s+`([^`]+)`:/

/**
 * 从会话头取 agent 身份键。
 *
 * 子代理统一归到 'subagent'：它们和主代理需要的东西不一样（临时工 vs 正式工，
 * 这个项目在挣扎检测里已经学过同一课）。
 */
export function agentKeyOf(agent) {
  const h = agent?.session?.header
  const depth = Number(h?.delegationDepth) || 0
  if (depth > 0) return 'subagent'
  return String(h?.agentPreset ?? 'default')
}

/** 算出这个 agent 最终该看到哪些技能。 */
export function allowedSkillNames({ allNames = [], key = 'default', cfg = {} } = {}) {
  const s = cfg.skills ?? {}
  if (s.enabled !== true) return { names: allNames, trimmed: false, why: '未启用' }
  const deny = new Set((s.deny ?? []).map(String))
  let names = allNames.filter(n => !deny.has(n))
  const per = s.perAgent ?? {}
  const allow = per[key]
  if (Array.isArray(allow)) names = names.filter(n => allow.includes(n))
  // ★ 安全闸：allow 列表一个都没匹配上时**不清空目录**。
  //   "配的名单和实际技能名对不上"几乎总是配置写错，而静默清空的后果是
  //   这一整个 agent 的技能能力消失，且没有任何报错 —— 正是这个项目
  //   反复栽过的那种"看起来在学习、其实什么都没发生"。
  const original = allNames.filter(n => !deny.has(n))
  if (names.length === 0 && original.length > 0) {
    return { names: original, trimmed: false, why: 'allow 列表（' + JSON.stringify(allow ?? []) + '）一个都没匹配上，已保持原样而不是清空' }
  }
  return { names, trimmed: names.length !== allNames.length, why: allow ? 'perAgent[' + key + ']' : 'deny' }
}

/**
 * 只改渲染文本里的 <available_skills> 段，**不动 source.entries**。
 *
 * 只删行，不改行 —— 保留宿主自己的措辞，包括那段"若要调用请用确切名字"的
 * 使用说明。改写那些句子会引入我没验证过的行为。
 */
export function trimCatalogText(text, allowed) {
  const s = String(text ?? '')
  const open = s.indexOf('<available_skills>')
  const close = s.indexOf('</available_skills>')
  if (open < 0 || close < 0 || close < open) return { text: s, changed: false, removed: 0 }
  const head = s.slice(0, open + '<available_skills>'.length)
  const body = s.slice(open + '<available_skills>'.length, close)
  const tail = s.slice(close)
  const keep = new Set(allowed)
  const lines = body.split('\n')
  const out = []
  let removed = 0
  for (const line of lines) {
    const m = line.match(LINE)
    if (m && !keep.has(m[1])) { removed++; continue }
    out.push(line)
  }
  if (removed === 0) return { text: s, changed: false, removed: 0 }
  return { text: head + out.join('\n') + tail, changed: true, removed }
}

/**
 * 对一批消息做裁剪。返回新的 messages 数组（不改原对象）。
 *
 * @returns { messages, changed, removed, keys }
 */
export function applySkillTrim(messages, { cfg = {}, agentKey = 'default', log = () => {} } = {}) {
  if (!Array.isArray(messages) || (cfg.skills?.enabled !== true)) {
    return { messages, changed: false, removed: 0 }
  }
  let totalRemoved = 0
  let anyChanged = false
  const out = messages.map(msg => {
    const src = msg?.source
    if (!src || src.kind !== 'skill-catalog') return msg
    // entries 是**发布事实**，一个字节都不能动（动了就每步重发）
    const allNames = Array.isArray(src.entries) ? src.entries.map(e => e?.name).filter(Boolean) : []
    if (allNames.length === 0) return msg
    const pick = allowedSkillNames({ allNames, key: agentKey, cfg })
    if (!pick.trimmed) {
      if (pick.why && !/未启用/.test(pick.why)) log('skills: 未裁剪 ' + agentKey + ' —— ' + pick.why)
      return msg
    }
    const content = Array.isArray(msg.content) ? msg.content : []
    const next = content.map(block => {
      if (block?.type !== 'text') return block
      const r = trimCatalogText(block.text, pick.names)
      if (!r.changed) return block
      totalRemoved += r.removed
      anyChanged = true
      return { ...block, text: r.text }
    })
    return { ...msg, content: next }
  })
  return { messages: out, changed: anyChanged, removed: totalRemoved }
}
