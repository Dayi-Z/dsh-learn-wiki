// Hindsight 注入块压缩的自检。
//
// ── 为什么这条值得单独一个脚本 ──
//
// 这一路是"**改了没生效**"的高发形态，而且失败方向全都无声：
//   · 常驻成本 —— 每个请求都付，多出来的 token 不会以任何形式报警；
//   · 宿主那侧升级会**悄悄多出一个块**（hindsight-coding-agents 0.6.1 起
//     每 N 轮再注一份 <hindsight_knowledge_refresh>）；
//   · 压错方向更糟 —— 把页面清单一起压掉，等于把"刷新"变成纯噪声注入，
//     而注入块本身在界面上只是一段灰字，没人会去看。
//
// 所以这里钉三件事：
//   1. 首块压成指针；
//   2. refresh 块**只压 TOOL_GUIDE，清单一个字都不能少**；
//   3. 读不懂的块**原样放过**（宁可多花 token，不可删掉清单）。
//
// 夹具里的 TOOL_GUIDE 直接从**装在本机的 Hindsight 运行时**里抠出来，
// 不是手写的近似品 —— 手写夹具会随着上游改文案而失去意义，而这里要测的
// 恰恰是"上游长什么样我们认不认"。
import { readFile } from 'node:fs/promises'
import { compactRefreshText, createHindsightCompactor, HINDSIGHT_MARK, HINDSIGHT_REFRESH_MARK, HINDSIGHT_REFRESH_POINTER }
  from '../lib/hindsight-compact.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

// 与 index.js 的 buildUserMessage 同形状，但**不 import 宿主** —— 这个脚本要能在
// 没有 DSH 的环境里跑（压缩逻辑与宿主无关，测它不该需要宿主）。
const buildUserMessage = (text, source) => ({ role: 'user', content: [{ type: 'text', text }], source: source ?? { kind: 'plugin', plugin: 'dsh-learn-wiki' } })
const compact = createHindsightCompactor(buildUserMessage)

// ── 夹具：TOOL_GUIDE 从本机 Hindsight 运行时里抠 ──
const RUNTIME = process.env.USERPROFILE +
  '\\AppData\\Roaming\\dsh-desktop\\harness\\profiles\\web\\node_modules\\@vectorize-io\\hindsight-coding-agents\\dist\\dsh.js'
let TOOL_GUIDE = null
try {
  const s = await readFile(RUNTIME, 'utf8')
  const m = s.match(/var TOOL_GUIDE = `([\s\S]*?)`;/)
  if (m) TOOL_GUIDE = m[1].replace(/\\u2014/g, '—').replace(/\\u{1F9E0}/g, '🧠')
} catch { /* 运行时不在就退回下面那段最小夹具 */ }
const guideSource = TOOL_GUIDE ? '取自本机 Hindsight 运行时的 TOOL_GUIDE' : '（运行时不在，用最小夹具）'

const FIRST_BLOCK = HINDSIGHT_MARK + '\n'
  + 'This repository has a Hindsight memory + knowledge base (curated, continuously-updated pages plus the raw memory behind them). '
  + 'The tools below are registered, but you must actually CALL them at the right moments:\n'
  + (TOOL_GUIDE ?? '- hindsight_reflect(query) — deep reasoning over this repository memory.\n')
  + 'ALSO your correction tool: when you verify a Hindsight memory is wrong or stale, ingest a "Correction: <topic>" doc.\n'
  + 'Knowledge pages currently in this repository:\n- Component map (kp-bb3ab2732f8b40528cab91c9078460d0)\n- Conventions and patterns (kp-a2eef37b4b5b49c7a69097310d05d909)\n'
  + 'This tool guide and the page list are re-injected for you periodically as things change.\n'
  + '</hindsight_knowledge>'

const ROSTER = 'Current Hindsight knowledge pages (may have changed):\n'
  + '- Component map (kp-bb3ab2732f8b40528cab91c9078460d0)\n'
  + '- Conventions and patterns (kp-a2eef37b4b5b49c7a69097310d05d909)\n'
  + '- Core concepts (kp-9f84566621b9485288d4fcc0d7869296)'
const REFRESH_BLOCK = HINDSIGHT_REFRESH_MARK + '\n' + ROSTER + '\n'
  + 'Reminder — this repo\'s Hindsight tools are available; call them at the right moments:\n'
  + (TOOL_GUIDE ?? '- hindsight_reflect(query) — deep reasoning.\n')
  + '</hindsight_knowledge_refresh>'

console.log('=== 首块（<hindsight_knowledge>）===')
const msgA = { role: 'user', content: [{ type: 'text', text: FIRST_BLOCK }], source: { kind: 'plugin' } }
const rA = compact([msgA])
check('首块被压成短指针', rA.changed && rA.messages[0].content[0].text.includes('详见各 hindsight_* 工具的 schema'))
check('指针里不含 TOOL_GUIDE 的正文', !rA.messages[0].content[0].text.includes('FIRST STOP for any question'))
check('★ 压缩是"整块替换"，压完的长度远小于原文',
  rA.messages[0].content[0].text.length < FIRST_BLOCK.length / 3,
  FIRST_BLOCK.length + ' → ' + rA.messages[0].content[0].text.length + ' 字符')

console.log('')
console.log('=== 第二个块（<hindsight_knowledge_refresh>）' + ' — ' + guideSource + ' ===')
const msgB = { role: 'user', content: [{ type: 'text', text: REFRESH_BLOCK }], source: { kind: 'plugin' } }
const rB = compact([msgB])
const outB = rB.messages[0].content[0].text
check('refresh 块被处理了', rB.changed)
check('★ TOOL_GUIDE 被压成一行指针', outB.includes(HINDSIGHT_REFRESH_POINTER))
check('★ 页面清单**一个字都没少**（这是本功能存在的理由）',
  ROSTER.split('\n').every(line => outB.includes(line)),
  '清单 3 行，命中 ' + ROSTER.split('\n').filter(l => outB.includes(l)).length + ' 行')
check('★ 压缩后明显变短', outB.length < REFRESH_BLOCK.length, REFRESH_BLOCK.length + ' → ' + outB.length + ' 字符')
check('★ 省下来的量级 = TOOL_GUIDE 的量级（不是偶然变短）',
  REFRESH_BLOCK.length - outB.length > 500,
  '省 ' + (REFRESH_BLOCK.length - outB.length) + ' 字符，TOOL_GUIDE 本体 ' + (TOOL_GUIDE ? TOOL_GUIDE.length : '?') + ' 字符')
check('保留块边界（两个标签都还在，否则下游的剥除正则认不出来）',
  outB.includes(HINDSIGHT_REFRESH_MARK) && outB.includes('</hindsight_knowledge_refresh>'))

console.log('')
console.log('=== 保守边界：读不懂就别动 ===')
const unknown = HINDSIGHT_REFRESH_MARK + '\n- 某种我们没见过的格式\n</hindsight_knowledge_refresh>'
const rU = compact([{ role: 'user', content: [{ type: 'text', text: unknown }] }])
check('★ 没有 Reminder 段的 refresh 块**原样放过**（宁可多花 token，不可删掉清单）',
  !rU.changed && rU.messages[0].content[0].text === unknown)
const plain = { role: 'user', content: [{ type: 'text', text: '普通用户消息，没有任何注入' }] }
const rP = compact([plain])
check('不含注入块的消息逐字节不动', !rP.changed && rP.messages[0] === plain)
check('同一条消息里首块 + refresh 块：两个块各按各的规则压，且首块带的清单不会冒充 refresh 的清单',
  (() => {
    const both = { role: 'user', content: [{ type: 'text', text: FIRST_BLOCK + '\n\n' + REFRESH_BLOCK }] }
    const r = compact([both])
    const t = r.messages[0].content[0].text
    // 首块 → 短指针（**不带**清单：知识页清单只在 refresh 里保持新鲜，
    //   首块那份是会话开始时的快照，留着反而是过期信息）；
    // refresh 块 → 自己的清单 + 指针。
    return r.changed
      && t.includes('详见各 hindsight_* 工具的 schema')
      && t.includes(HINDSIGHT_REFRESH_POINTER)
      && t.includes('Core concepts (kp-9f84566621b9485288d4fcc0d7869296)')
      && !t.includes('FIRST STOP for any question')
  })())
check('★ 一条消息里**两份** refresh：两份清单都要在（整条替换只会留最后一份）',
  (() => {
    const roster2 = '- 另一份清单 (kp-ffffffffffffffffffffffffffffffff)'
    const two = { role: 'user', content: [{ type: 'text', text: REFRESH_BLOCK + '\n\n' + HINDSIGHT_REFRESH_MARK + '\n' + roster2 + '\nReminder — x\n- tool\n</hindsight_knowledge_refresh>' }] }
    const t = compact([two]).messages[0].content[0].text
    return t.includes('kp-9f84566621b9485288d4fcc0d7869296') && t.includes('kp-ffffffffffffffffffffffffffffffff')
  })())
check('纯函数 compactRefreshText 对空输入不炸', compactRefreshText('').touched === false && compactRefreshText(null).touched === false)

console.log('')
console.log('=== ★ 消息形状：宿主可能交给我们的每一种 ===')
{
  // 这一组是**真宿主里静默失效三个多月之后**补的（2026-09-17 查日志发现）：
  // 插件日志里 compact: 只出现过一次（2026-09-10），而同期 capabilities 有几百条。
  // 原因是原实现只认 content = [{type:'text', text}] —— 测试夹具一直是这个形状，
  // 于是"测得到"与"跑得到"之间裂了一条缝，而且**认不出形状时它静默返回**。
  const shapes = [
    ['content = [{type:text,text}]（夹具一直是这个）', { content: [{ type: 'text', text: FIRST_BLOCK }] }, true],
    ['content = 字符串', { content: FIRST_BLOCK }, true],
    ['content = [{type:input_text}]', { content: [{ type: 'input_text', text: FIRST_BLOCK }] }, true],
    ['content = [{text}]（没有 type 字段）', { content: [{ text: FIRST_BLOCK }] }, true],
    ['content 里混了 image part', { content: [{ type: 'text', text: FIRST_BLOCK }, { type: 'image', source: {} }] }, true],
    ['refresh 块走字符串形状', { content: REFRESH_BLOCK }, true],
  ]
  for (const [label, msg, want] of shapes) {
    const r = compact([msg])
    check(label, r.changed === want, r.changed === want ? '已压缩' : 'changed=' + r.changed + '，期望 ' + want)
  }
  const weird = compact([{ content: { not: 'array', but: HINDSIGHT_MARK + 'x</hindsight_knowledge>' } }])
  check('★ 认得出注入块却压不动时，返回里带上 unrecognized 计数（不再无声）',
    weird.changed === false && weird.unrecognized >= 1, 'unrecognized=' + weird.unrecognized)
  const normal = compact([{ content: [{ type: 'text', text: '普通消息' }] }])
  check('普通消息不会被记成"认不出"（否则这个计数会变成噪音）',
    normal.changed === false && normal.unrecognized === 0, 'unrecognized=' + normal.unrecognized)
  check('压完之后同一 part 里的其它正文仍然在（不丢内容）', (() => {
    const r = compact([{ content: [{ type: 'text', text: FIRST_BLOCK + '\n\n另一段普通文本' }] }])
    return r.changed && r.messages[0].content[0].text.includes('另一段普通文本')
  })())
}

console.log('')
if (failures === 0) console.log('ALL PASS — 两个注入块都压到位，且清单不会被压丢')
else console.log(failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
