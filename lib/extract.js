// 网页正文抽取：把 HTML 变成**能喂给蒸馏器**的文本。
//
// ── 为什么值得单独一个模块（实测，不是感觉）──
//
// 原来这里只有一条 `htmlToText`：正则去 script/style/注释，再把所有标签换成空格。
// 实测（2026-09-16，直连抓三个真实页面）：
//
//   nodejs.org/api/zlib.html        raw 483,428 → 朴素剥离得 101,828 字符
//   MDN CompressionStream            raw 148,098 → 朴素剥离得   4,161 字符
//   github.com/zstd issue #2411      raw 373,040 → 朴素剥离得   7,630 字符
//
// 两个问题同时暴露，而且方向相反：
//
//   1. **噪声挤压**：MDN / GitHub 这类页面，正文只占几个百分点，剩下的全是
//      导航、侧栏、页脚、以及 GitHub 那种把全部 issue 塞进内联 JSON 的脚本块。
//      4,161 字符里真正回答问题的可能不到 800 —— 而 `fetchMaxChars` 又只有 4,000，
//      于是**截断截在噪声上**，正文根本没进提示词。
//   2. **短页面被误判**：把整页剥完才有 4,161 字符时，"够不够用"这件事
//      看起来像页面本身太短，而不是我们没抽干净。
//
// 所以这里做两件朴素但有效的事：**先按块打分选正文容器**，再从那里剥文本。
// 打分只用不随站点变化的量（文本密度、段落数、链接占比），不引第三方库 ——
// 一个"看起来更聪明"的抽取库会把失败变成不可解释的失败，而这里最需要的是
// 失败时知道**为什么**（后面 acquire.js 会把这个判断记进 gap 的证据统计）。
//
// ── 明确不做 ──
//
// 不做 JS 渲染（要渲染的话该由宿主/browser 插件去做），不做正文之外的元数据
// 提取，不做编码嗅探（抓取层已经拿到 decoded 文本）。

/** 整块丢弃的标签：它们的内容永远不是"回答问题的正文"。 */
const DROP_TAGS = ['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'form', 'nav', 'header', 'footer', 'aside']

/** 常见正文容器候选。命中就参与打分，命中不了也不影响后续兜底。 */
const CANDIDATE_TAGS = ['article', 'main', 'div', 'section', 'td']

/** 类名/ID 里出现这些词，说明它是**页面骨架**而不是正文。 */
const BOILERPLATE_HINT = /(^|[-_\s])(nav|navbar|menu|sidebar|side-bar|footer|header|breadcrumb|pagination|pager|toc|toc-|toolbar|comment|comments|related|recommend|share|social|cookie|banner|advert|ads?|promo|subscribe|newsletter|skip-link|search-form|site-search)([-_\s]|$)/i

/** 类名/ID 里出现这些词，说明它**很可能是正文**。 */
const CONTENT_HINT = /(^|[-_\s])(content|article|post|entry|markdown|md-content|main|body|readme|documentation|docs|doc-content|prose|wiki)([-_\s]|$)/i

function stripBlocks(html) {
  let out = String(html ?? '')
  for (const tag of DROP_TAGS) {
    out = out.replace(new RegExp('<' + tag + '\\b[^>]*>[\\s\\S]*?<\\/' + tag + '\\s*>', 'gi'), ' ')
    // 自闭合/未闭合形态（实测 HTML 里很常见，尤其是 <script ... />）
    out = out.replace(new RegExp('<' + tag + '\\b[^>]*\\/?>', 'gi'), ' ')
  }
  return out.replace(/<!--[\s\S]*?-->/g, ' ')
}

/** 实体的解码。**必须只做一遍**：先解码再剥标签会把 &lt;div&gt; 变成真标签。 */
export function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&amp;/g, '&')
}

function safeChar(code) {
  try {
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ' '
    return String.fromCodePoint(code)
  } catch { return ' ' }
}

/** 块级标签 → 换行，行内标签 → 空格。这是保住段落结构的唯一一步。 */
const BLOCK_RE = /<\/?(p|div|section|article|main|li|ul|ol|tr|td|th|table|h[1-6]|pre|blockquote|br|hr|figure|figcaption|details|summary)\b[^>]*>/gi

function tagsToText(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(BLOCK_RE, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
}

/** 归一化：压掉多余空行与行内空白。保留段落边界（蒸馏器要看得出结构）。 */
export function normalizeText(text) {
  return String(text ?? '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function attrOf(openTag, name) {
  const m = String(openTag).match(new RegExp(name + '\\s*=\\s*("([^"]*)"|\x27([^\x27]*)\x27|([^\\s>]+))', 'i'))
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : ''
}

function looksBoilerplate(openTag) {
  const id = attrOf(openTag, 'id')
  const cls = attrOf(openTag, 'class')
  const role = attrOf(openTag, 'role')
  if (/^(navigation|banner|contentinfo|search|complementary)$/i.test(role)) return true
  const hay = (id + ' ' + cls).trim()
  if (!hay) return false
  if (CONTENT_HINT.test(hay) && !BOILERPLATE_HINT.test(hay)) return false
  return BOILERPLATE_HINT.test(hay)
}

/**
 * 给一段 HTML 打分。分数只用于**排序候选容器**，绝对值没有意义。
 *
 * 判据（都来自"正文长什么样"这个朴素事实）：
 *   · 文本量           —— 正文一定长；这是主项
 *   · 段落数           —— 正文有 <p>，导航没有
 *   · 链接文本占比     —— 链接挤满的地方是导航/列表页，不是正文（**惩罚项**）
 *   · 标签密度         —— 同样字数下标签越多越像骨架（**惩罚项**）
 */
export function scoreBlock(html) {
  const text = tagsToText(html)
  const chars = text.replace(/\s+/g, ' ').trim().length
  if (chars === 0) return { score: 0, chars: 0, paragraphs: 0, linkRatio: 1 }
  const paragraphs = (String(html).match(/<p\b/gi) ?? []).length
  let linkChars = 0
  for (const m of String(html).matchAll(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi)) {
    linkChars += tagsToText(m[0]).replace(/\s+/g, ' ').trim().length
  }
  const linkRatio = Math.min(1, linkChars / Math.max(1, chars))
  const tagCount = (String(html).match(/<[a-z]/gi) ?? []).length
  const tagDensity = tagCount / Math.max(1, chars)
  // ★ 评分是**量 × 纯度**，不是纯量。
  //
  //   试过两版都不行，都记在这里免得下次重犯：
  //     · 线性（chars × …）：最大的区域永远赢 —— nodejs.org 的 API 目录
  //       （9.5 万字符的链接）压过正文，抽出 300 字符全是一百多个 API 名字。
  //     · 纯幂律 chars^0.7：整页仍然赢，因为整页的"字符"里也包括正文，
  //       幂律对小区域的衰减赶不上整页的量级优势。
  //
  //   现在：**文本量**（chars）与**像不像正文**（proseRatio）相乘。
  //   导航区文本量可以很大，但纯度极低（实测 0.02），一乘就没了。
  //   指数 0.85 让长文档仍随长度受益，但不足以压过纯度的差距。
  const score = Math.pow(chars, 0.85) * (proseRatioOf(html) + 0.4) - tagDensity * 200
  return { score, chars, paragraphs, linkRatio }
}

/** scoreBlock 内部要用到 prose，但 proseRatio 需要的是**文本**；这里做一次转换。 */
function proseRatioOf(html) {
  return proseRatio(normalizeText(tagsToText(html)))
}

/**
 * 这段文本像**正文**还是像**链接列表**。
 *
 * ── 为什么必须有这个判据（实测，第一版就是栽在这里）──
 *
 * 第一版只按"谁的字数多 + 链接占比"打分，结果 nodejs.org/api/zlib.html 抽出来的是
 * **整个左侧 API 目录**（`<div class="clearfix">`）：它文本量最大、链接占比也不高
 * （每个链接都是 "Buffer" 这种短词，除以总字数就摊薄了）。抽出来的前 300 字符
 * 是 "Node.js / About this documentation / Assertion testing / Asynchronous context
 * tracking / …" —— 一百多个 API 名字，**一个字的答案都没有**。
 *
 * 所以判据换成**行**而不是整段：正文的行是句子（长、少），目录的行是词条
 * （短、多）。实测这个比值把两者分得很开。
 *
 * 返回 0..1：prose 行 / 非空行。低到某个程度就该判定"这不是正文"。
 */
export function proseRatio(text) {
  const lines = String(text ?? '').split('\n').map(l => l.trim()).filter(Boolean)
  if (lines.length === 0) return 0
  // 目录行：短且不含句末标点。阈值 60 字符来自实测（"Asynchronous context tracking"
  // 这类最长也就 30 出头，而真正的一句话很少短于 60）。
  const linkish = lines.filter(l => l.length < 60 && !/[.。！？!?：:]\s*$/.test(l)).length
  return 1 - linkish / lines.length
}

/**
 * 抽出正文文本。
 *
 * 返回 `{ text, picked }`：`picked` 说明**是怎么选的**，用于失败时解释
 * （"整页兜底"和"命中了 <article>"是完全不同的两件事，前者更可能是渲染页）。
 *
 * @param html 原始 HTML
 * @param maxChars 截断上限（按字符，正文优先，尾部截断）
 */
export function extractReadableText(html, { maxChars = 120000 } = {}) {
  const raw = String(html ?? '')
  if (!raw.trim()) return { text: '', picked: 'empty', chars: 0 }
  const cleaned = stripBlocks(raw)

  // ── 候选打分：在**配对标签树**上比，而不是在等宽的窗口上比 ──
  //
  // ★ 这一路试了三版，前两版都错在真实页面上，记在这里免得下次重犯：
  //
  //   1. 贪心整棵子树：正文与左侧 API 目录同属一个 `<div class="clearfix">` 包装层，
  //      包装层的整棵子树文本量最大 → 永远胜出 → 抽出一百多个 API 名字（nodejs.org）。
  //   2. 同级兄弟窗口：MDN 那种导航与正文不在同一层的页面立刻退化 ——
  //      窗口里混着导航和正文，纯度被摊薄，于是**抽出一个 note 卡片**而不是整篇文章。
  //
  //   两次的根因是同一个：**用等宽的窗口去近似语义容器**。窗口的边界由标签位置决定，
  //   与"哪一块是正文"无关。所以这里老老实实做配对：`<div>` 一直配到它真正的
  //   `</div>`，子节点各自成候选，纯度在每一层都能算准。
  currentHtml = cleaned
  const tree = parseTagTree(cleaned)
  let best = null
  for (const node of flatten(tree)) {
    const c = candidateOf(node)
    if (!c) continue
    // ★ 严格大于：同分时**保留先遇到的那个**，而铺平是父在子前 ——
    //   所以同分选父。这正是想要的：父节点文本更全，且两者纯度已经一样。
    if (!best || c.s.score > best.s.score) best = c
  }

  if (best) {
    const text = normalizeText(tagsToText(cleaned.slice(best.from, best.to)))
    if (text.length >= 200) {
      return {
        text: cut(text, maxChars),
        picked: '<' + best.tag + '>' + (attrOf(best.openTag, 'class') ? '.' + attrOf(best.openTag, 'class').split(/\s+/)[0] : ''),
        chars: text.length,
        prose: proseRatio(text),
      }
    }
  }

  const whole = normalizeText(tagsToText(cleaned))
  return {
    text: cut(whole, maxChars),
    picked: 'whole-page',
    chars: whole.length,
    prose: proseRatio(whole),
    ...looksLikeShell(raw, whole),
  }
}

/**
 * 这一页看起来**根本没渲染出正文**吗。
 *
 * ── 为什么必须能说出这一条（实测 GitHub）──
 *
 * 实测 github.com/facebook/zstd/issues/2411：抓回 373,040 字节的 HTML，
 * 剥完只剩 874 字符，内容是 "Add this suggestion to a batch that can be applied
 * as a single commit. …" 这种**表单提示语** —— GitHub 的 issue 正文是 JS 渲染的。
 * 也就是说：抓取**成功了**（HTTP 200、字节数很大），却一个字的答案都没有。
 *
 * 没有这个判据时，上层只会看到"取到 874 字符"，于是可能：
 *   · 把它当证据喂给蒸馏器（噪声 → 要么拒绝、要么写出一页垃圾）；
 *   · 或者记成"该站取不到"，而真正的原因是**该站需要浏览器**，修法完全不同
 *     （前者该换来源，后者该换抓取方式）。
 *
 * 判据故意做成"两条件同时成立才算"，宁可漏报：HTML 大但文本极少，
 * 才说明它把内容放在脚本里；小而短的页面只是短页面。
 */
export function looksLikeShell(rawHtml, text) {
  const raw = String(rawHtml ?? '').length
  const chars = String(text ?? '').replace(/\s+/g, ' ').trim().length
  // 阈值来自实测：GitHub 是 373KB/874 字符（比值 427:1），
  // 而正常的文档页都在 10:1 以内（nodejs.org 483KB/90K ≈ 5:1，MDN 148KB/1.3K ≈ 100:1 但绝对量小）。
  const shell = raw > 60000 && chars < 3000
  return {
    shell,
    textBytes: chars,
    rawBytes: raw,
    why: shell ? 'HTML ' + raw + ' 字节但只剥出 ' + chars + ' 字符 —— 正文可能是 JS 渲染的' : '',
  }
}

/**
 * 用一次扫描把 HTML 折成**配对标签树**。
 *
 * 为什么值得写这 40 行，而不是继续用正则窗口（试过两版都错，见 extractReadableText 的注释）：
 *   · 窗口的边界由"标签在第几个字节"决定，与"哪一块是正文"无关；
 *   · 配对的边界才是语义容器的边界。`<div class="markdown-body">…</div>`
 *     只有在配对上才是一个整体，在窗口上永远是几截。
 *
 * 只对**块级标签**配对（CANDIDATE_TAGS + body/html）——行内标签不需要成节点，
 * 少一个数量级的节点，也就少一个数量级的出错机会。
 *
 * 不闭合的标签按"延伸到父节点结束"处理（畸形 HTML 里 div 不闭合是常态），
 * 并对节点总数设硬上限：48 万字符的页面能开出 500+ 个候选标签。
 */
export function parseTagTree(html, { maxNodes = 30000 } = {}) {
  const NODE_TAGS = new Set([...CANDIDATE_TAGS, 'body', 'html'])
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g
  const root = { tag: '#root', openTag: '', start: 0, end: String(html).length, children: [], parent: null }
  const stack = [root]
  let count = 0
  let m
  while ((m = re.exec(html)) !== null) {
    const tag = m[2].toLowerCase()
    if (m[1] === '/') {
      // 闭合：从栈顶往下找最近一个同名开标签（中间那些视为未闭合）
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) {
          stack[i].end = m.index + m[0].length
          stack.length = i
          break
        }
      }
      continue
    }
    if (!NODE_TAGS.has(tag)) continue
    // 自闭合形态（<div/>）不该开节点
    if (/\/\s*>$/.test(m[0])) continue
    if (++count > maxNodes) break
    const node = { tag, openTag: m[0], start: m.index, end: String(html).length, children: [], parent: stack[stack.length - 1] }
    stack[stack.length - 1].children.push(node)
    stack.push(node)
  }
  return root
}

/**
 * 深度优先铺平（父在子前，便于"同分时取更具体的节点"）。
 *
 * ★ **必须迭代，不能递归**：实测 `'<div>'.repeat(2000)` 这种畸形但真实的输入
 *   （未闭合标签层层嵌套）会把递归版本直接打爆 —— "Maximum call stack size exceeded"，
 *   而它抛出的位置在抽取函数**深处**，看起来像是别的地方坏了。
 *   抽取层的输入是**任意外部 HTML**，"深到爆栈"是它的正常输入之一，不是边界情况。
 */
export function flatten(node) {
  const out = []
  const stack = [...node.children].reverse()
  while (stack.length > 0) {
    const n = stack.pop()
    out.push(n)
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i])
  }
  return out
}

/** 一个节点是否够格当正文候选，以及它的分数。不够格返回 null。 */
function candidateOf(node) {
  if (node.tag === 'html' || node.tag === '#root') return null
  if (node.openTag && looksBoilerplate(node.openTag)) return null
  const html = currentHtml.slice(node.start, node.end)
  if (html.length < 40) return null
  const s = scoreBlock(html)
  if (s.chars < 200) return null
  // ★ 链接目录**整块排除**：实测左侧 API 目录的 (1-链接占比) 极低而文本量极大，
  //   任何"只扣分"的打法它都还能赢。
  if (s.linkRatio > 0.5 && s.chars > 1200) return null
  const text = normalizeText(tagsToText(html))
  const prose = proseRatio(text)
  if (prose < 0.3) return null
  s.prose = prose
  // ★ 主项是 **prose 字符量 × 纯度**，而不是总字符量。
  //
  //   用总字符量时父节点永远赢（它把导航也算进去），用纯幂律又让小片段赢
  //   （实测抽出一个 note 卡片）。用 *prose 字符量* 恰好把两者都按住：
  //     · 整页：prose 很大，但纯度低（导航摊薄）→ 打折扣
  //     · 导航目录：prose 小、纯度也低 → 出局
  //     · 正文容器：prose 大且纯度中上 → 赢
  //   指数 0.9 是标定出来的：>1 会让整页重新赢，<0.8 会让 note 片段赢。
  s.proseChars = Math.round(s.chars * prose)
  s.score = Math.pow(s.proseChars, 0.9) * (prose + 0.4)
  return { from: node.start, to: node.end, s, tag: node.tag, openTag: node.openTag }
}

/**
 * 当前正在解析的 HTML。`candidateOf` 需要它来切片。
 *
 * 用模块级变量而不是把它一层层传下去：这条路径是纯函数、单线程、每次调用
 * 立刻用完（extractReadableText 里同步跑完），传参会多出三层噪音而无收益。
 * 代价是**不可重入** —— 所以这里不 await 任何东西，将来要改成异步必须先拆掉它。
 */
let currentHtml = ''

function cut(text, maxChars) {
  const n = Number(maxChars)
  if (!Number.isFinite(n) || n <= 0 || text.length <= n) return text
  return text.slice(0, n) + '\n…（已截断）'
}

/**
 * 兼容旧名字。
 *
 * 保留它是因为它是**公开导出的 API**（有测试与外部脚本在用），
 * 而"改了导出名字"这种事在这里的代价是把调用方变成运行时才发现的错误。
 */
export function htmlToText(html) {
  return extractReadableText(html, { maxChars: 120000 }).text.replace(/\s+/g, ' ').trim()
}
