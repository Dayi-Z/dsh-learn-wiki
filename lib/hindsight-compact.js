// Hindsight 注入块的压缩：把每轮都要背着的重复正文换成短指针。
//
// ── 为什么这件事值得单独一个模块 ──
//
// 它此前埋在 index.js 的闭包里，**测不到**。而这一路正好是"改了没生效"的高发区：
// 常驻成本（每个请求都付）、无报错（多出来的 token 不会以任何形式报警）、
// 而且随着宿主那一侧的版本升级会**悄悄多出一个块**（下面那个 refresh）。
//
// 所以判据要有断言，而断言要有入口。这里只放纯函数：不读配置、不碰 ctx、
// 不 import 宿主 —— 需要造消息时由调用方把 buildUserMessage 注入进来。

export const HINDSIGHT_MARK = '<hindsight_knowledge>'
export const HINDSIGHT_REFRESH_MARK = '<hindsight_knowledge_refresh>'

/**
 * 首块的替身。
 *
 * 工具 schema 只说明"怎么用"，不说明"现在该用"；那一句时机提示有价值，
 * 所以留 ~50 token 而不是全删。
 */
export const HINDSIGHT_COMPACT = HINDSIGHT_MARK
  + '本仓库有 Hindsight 长期记忆与知识页。回答项目相关问题前先用 hindsight_search_knowledge_pages 检索并引用页面；'
  + '开始非平凡任务前用 hindsight_list_knowledge_pages 看项目已知什么。详见各 hindsight_* 工具的 schema。'
  + '</hindsight_knowledge>'

/** refresh 块里 Reminder 段的替身（TOOL_GUIDE 与首块逐字相同，纯重复）。 */
export const HINDSIGHT_REFRESH_POINTER = 'Reminder — 本仓库的 hindsight_* 工具随时可用；用法见各工具 schema。'

/**
 * 把首块（<hindsight_knowledge>）**就地**换成短指针。
 *
 * 就地（而不是"整条正文换掉"）：同一条文本里可能还有别的注入块，
 * 整条换会把它们一起吃掉。见 createHindsightCompactor 里的注释。
 *
 * 正则里的闭合标签写死 `</hindsight_knowledge>` 是安全的：refresh 块的闭合标签是
 * `</hindsight_knowledge_refresh>`，那个 `_refresh` 让它**不可能**被这个模式匹配到
 * （`>` 对不上 `_`）。所以两种块谁先谁后都不会互相误伤。
 */
export function compactFirstBlock(text) {
  let touched = false
  const out = String(text ?? '').replace(/<hindsight_knowledge>[\s\S]*?<\/hindsight_knowledge>/g, () => {
    touched = true
    return HINDSIGHT_COMPACT
  })
  return { text: out, touched }
}

/**
 * 压一个 **refresh** 块的正文：页面清单原样留下，只把 TOOL_GUIDE 换成一行指针。
 *
 * ── 为什么不能连清单一起压 ──
 *
 * <hindsight_knowledge_refresh> 的成分和首块**不一样**：
 *
 *   Current Hindsight knowledge pages (may have changed):   ← 清单，**要留**
 *   - 页面名 (kp-xxxx)
 *   Reminder — ... call them at the right moments:
 *   - hindsight_search_knowledge_pages(query) — ...          ← TOOL_GUIDE，实测 1,743 字符
 *
 * 清单是**唯一在变**的部分，也是这个块存在的理由（页会新增、会改写）。
 * 压掉它就把一次"刷新"变成了纯噪声注入。
 *
 * ── 为什么逐块处理，而不是整条消息一次替换 ──
 *
 * 一条消息里可能堆着多份历史注入，**每份有自己的清单**。整条替换只会留下最后一份，
 * 等于静默删掉前面的页面清单。
 *
 * ── 为什么读不懂就原样返回 ──
 *
 * 没有 Reminder 段（宿主改了格式、或块被截断）时不压：少压一次只是多花点 token，
 * 压错一次会把清单一起带走。两种失败的代价不对称，所以取保守的那一边。
 */
export function compactRefreshText(text) {
  let touched = false
  const out = String(text ?? '').replace(
    /<hindsight_knowledge_refresh>([\s\S]*?)<\/hindsight_knowledge_refresh>/g,
    (whole, inner) => {
      const i = inner.search(/Reminder\s*[—\-]/)
      if (i < 0) return whole
      touched = true
      const roster = inner.slice(0, i).replace(/\s+$/, '')
      const body = (roster ? roster + '\n' : '') + HINDSIGHT_REFRESH_POINTER
      return HINDSIGHT_REFRESH_MARK + '\n' + body + '\n</hindsight_knowledge_refresh>'
    },
  )
  return { text: out, touched }
}

/**
 * 把一批消息里的 hindsight 注入正文换成指针。
 *
 * @param messages 要说人话的消息数组（宿主 pre-step 的 decision.messages）
 * @param buildUserMessage 由调用方注入（index.js 传宿主那版，带退化兜底）
 */
/**
 * 这个 part 里的文本能压吗；能就给出压后的文本。
 *
 * ★ **不能只认 `type === 'text'`** —— 这是实测（2026-09-17，宿主重启后）。
 *
 *   插件日志里 `compact:` 只出现过**一次**（2026-09-10），而同一时期
 *   `capabilities:` 有几百条：也就是说这个压缩**三个多月没真正跑过**，
 *   而且一声不响 —— 它只在"确实压到了东西"时才写日志，认不出形状时静默返回。
 *
 *   拿真实会话里那份注入文本试过所有可能的形状，结果：
 *     content = [{type:'text', text}]   → 压 ✅（测试夹具一直是这个形状）
 *     content = '字符串'                 → 不认 ❌
 *     content = [{type:'input_text'}]    → 不认 ❌
 *     content = [{text}]（无 type）      → 不认 ❌
 *   夹具只覆盖了第一种，于是"测得到"和"跑得到"之间裂开了一条缝。
 *
 *   所以判据改成**以"有没有 string 的 text"为准**，而不是以某个 type 字面量为准；
 *   同时把"认不出"的情况**数出来**（见 compactHindsight 的返回），
 *   让下一次形状变化至少能被看见一次。
 *
 * @returns { text, touched } —— touched 为 true 表示这一 part 被改写
 */
function compactPart(p) {
  if (!p || typeof p !== 'object') return { text: null, untouched: true }
  // 已知的非文本 part 明确跳过（图片/工具调用/工具结果等）
  if (typeof p.type === 'string' && p.type !== 'text' && p.type !== 'input_text') return { text: null, untouched: true }
  if (typeof p.text !== 'string') return { text: null, untouched: true }
  let text = p.text
  let touched = false
  if (text.includes(HINDSIGHT_MARK)) {
    const r = compactFirstBlock(text)
    if (r.touched) { text = r.text; touched = true }
  }
  if (text.includes(HINDSIGHT_REFRESH_MARK)) {
    const r = compactRefreshText(text)
    if (r.touched) { text = r.text; touched = true }
  }
  return { text, touched }
}

export function createHindsightCompactor(buildUserMessage) {
  return function compactHindsight(messages) {
    let changed = false
    // 认不出形状、但**确实带着注入块**的消息数。用来让"压不动"不再无声。
    let unrecognized = 0
    const out = messages.map((m) => {
      const content = m?.content
      // ── 形状一：content 是**字符串**（早期/其它路径）──
      if (typeof content === 'string') {
        const r = compactPart({ type: 'text', text: content })
        if (r.text === null) return m
        if (!r.touched) { if (content.includes(HINDSIGHT_MARK) || content.includes(HINDSIGHT_REFRESH_MARK)) unrecognized++; return m }
        changed = true
        return buildUserMessage(r.text, m.source)
      }
      const parts = content
      if (!Array.isArray(parts)) {
        // 形状二：既不是字符串也不是数组 —— 只有**带着注入块**时才值得记一笔
        try {
          const s = JSON.stringify(m)
          if (s && (s.includes(HINDSIGHT_MARK) || s.includes(HINDSIGHT_REFRESH_MARK))) unrecognized++
        } catch { /* 无法序列化就不管 */ }
        return m
      }
      let hit = false
      // ★ 逐 part 就地替换，**绝不是"整条换成首块指针"**。
      //
      //   早先那版就是把含首块的整条正文直接换成 HINDSIGHT_COMPACT，于是同一段文本里
      //   跟在后面的 <hindsight_knowledge_refresh> 被**整块吃掉** —— 页面清单，
      //   也就是那个块存在的全部理由，一声不响地没了。
      //   是 scripts/verify-hindsight-compact.mjs 里"两个块同在"那条抓到的；
      //   只测单块的夹具永远看不见它（而现实中宿主确实会把注入拼进同一条消息）。
      const next = parts.map((p) => {
        const r = compactPart(p)
        if (r.text === null) return p
        if (!r.touched) {
          if (r.text.includes(HINDSIGHT_MARK) || r.text.includes(HINDSIGHT_REFRESH_MARK)) unrecognized++
          return p
        }
        hit = true
        return { ...p, text: r.text }
      })
      if (!hit) return m
      changed = true
      // 保留原来源归属，只换正文。
      // ★ 拼出正文而不是一律用 HINDSIGHT_COMPACT 顶替：refresh 块的正文是
      //   "清单 + 指针"，顶替会把清单丢掉 —— 而那正是这个块存在的理由。
      const merged = next
        .filter(p => p && typeof p.text === 'string')
        .map(p => p.text).join('\n')
      return buildUserMessage(merged, m.source)
    })
    if (changed) return { messages: out, changed: true, unrecognized }
    // ★ 认得出注入块却压不动时，把这件事**报出去**而不是静默返回 ——
    //   上面那段注释记的正是"三个多月没跑过却没人发现"的代价。
    return { messages, changed: false, unrecognized }
  }
}
