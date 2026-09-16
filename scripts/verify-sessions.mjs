// 历史会话读层 + 摘要 + 索引的自检。
//
// 这一块的风险和别处不同：它读的是**已经发生过的**数据，出错时不会有任何人当场发现
// —— 摘错了只是让人读到错的结论。所以判据要钉得比平时更死：
//   * 同一堵墙不能因为内外两层记录而数成两次（实测 124 vs 122，几乎 1:1）
//   * 回显别人的退出码不能算失败（实测 51/759 是这种）
//   * 没有可描述症状的失败不能成"墙"（否则指纹就是一堆 PASS 行）
//   * 注入物不能当成人说的话（否则等于把自己学一遍）
import { rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { listSessions, readSessionEvents, readSessionHeader, decodeSession, isSubagentHeader, sessionFormatVersion, FILE_RE } from '../lib/session-store.js'
import { digestSession, renderDigest, sessionTranscript } from '../lib/session-digest.js'
import { loadSessionIndex, collectWalls } from '../lib/session-index.js'
import { ensureRepo } from '../lib/wiki.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

const ROOT = '.tmp-sessions-test'
const SROOT = '.tmp-sessions-root'
await rm(ROOT, { recursive: true, force: true })
await rm(SROOT, { recursive: true, force: true })
await ensureRepo(ROOT)

// ── 造一个真实形状的多帧 zstd 会话文件 ──
const userMsg = (text, kind = 'user') => ({ type: 'user/message', seq: 1, data: { role: 'user', source: { kind }, content: [{ type: 'text', text }] } })
const asstMsg = (parts) => ({ type: 'assistant/message', seq: 2, data: { turn: 1, step: 1, message: { role: 'assistant', content: parts } } })
const toolCall = (callId, name, args) => ({ type: 'tool/call', seq: 3, data: { turn: 1, step: 1, callId, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } })
const dispatch = (rootCallId, name, args, { text = '', isError = false } = {}) => ({
  type: 'tool/code-dispatch', seq: 4,
  data: { rootCallId, parentCallId: rootCallId, subCallId: rootCallId + ':code:1', name, arguments: args, isError, content: [{ type: 'text', text }] },
})
// v3 会话里的内层派发叫 ptc-dispatch（宿主 0.1.5-rc.2 起）。
// 载荷结构相同，只有 type 不一样 —— 夹具也照这个差别造，别多造差异。
const ptcDispatch = (rootCallId, name, args, { text = '', isError = false } = {}) => ({
  type: 'tool/ptc-dispatch', seq: 4,
  data: { rootCallId, parentCallId: rootCallId, subCallId: rootCallId + ':ptc:1', name, arguments: args, isError, content: [{ type: 'text', text }] },
})
const result = (callId, text, isError = false) => ({
  type: 'tool/result', seq: 5,
  data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError }] } },
})

/**
 * 造一个会话文件。
 *
 * ★ `version` 参数决定**文件名**：宿主 0.1.5-rc.2 起把会话格式版本写进了文件名
 *   （`session.v3.jsonl.zstd`，无版本 = v0）。这里必须能造出两种名字，
 *   否则"新版会话读不读得到"这件事根本测不到 —— 而它正是实测漏掉的那条。
 */
function writeSessionFile(dir, header, events, version = 0) {
  const lines = [JSON.stringify(header), ...events.map(e => JSON.stringify(e))]
  // ★ 一帧一行地压，再拼起来 —— 这正是真实文件的形态（每次追加写一帧）。
  //   用一帧写完整文件就测不到"多帧解码"这件事了，而那是这一层最容易错的地方。
  const buf = Buffer.concat(lines.map(l => zlib.zstdCompressSync(Buffer.from(l + '\n', 'utf8'))))
  const p = join(dir, version > 0 ? 'session.v' + version + '.jsonl.zstd' : 'session.jsonl.zstd')
  return { p, buf }
}

const HEAD_A = { type: 'session', version: 0, id: 'sess-aaa', createdAt: 2000, cwd: 'D:\\Proj', delegationDepth: 0, agentPreset: 'code' }
const HEAD_SUB = { type: 'session', version: 0, id: 'sub-bbb', createdAt: 3000, cwd: 'D:\\Proj', delegationDepth: 1, origin: 'subagent', parentSession: 'sess-aaa' }
const HEAD_OTHER = { type: 'session', version: 0, id: 'sess-ccc', createdAt: 1000, cwd: 'D:\\Other', delegationDepth: 0 }

const evA = [
  { type: 'session/title', seq: 0, data: { title: '修一个分帧问题' } },
  { type: 'turn/start', seq: 0, data: {} },
  { type: 'step/start', seq: 0, data: {} },
  userMsg('Widget 的分帧为什么不对'),
  userMsg('<system-reminder>这是我们自己的注入块</system-reminder>', 'plugin'),
  asstMsg([{ type: 'reasoning', text: '这是草稿，不该被算进对话' }, { type: 'text', text: '先看看代码。' }]),
  // 同一个 run_code 里：内层 edit 失败两次，外层 run_code 也失败（复述）
  toolCall('call-1', 'run_code', { code: 'x' }),
  dispatch('call-1', 'edit', { file_path: 'D:/Proj/a.js', old_string: 'v1' }, { text: 'Error: old_string was not found in "D:/Proj/a.js"', isError: true }),
  dispatch('call-1', 'edit', { file_path: 'D:/Proj/a.js', old_string: 'v2' }, { text: 'Error: old_string was not found in "D:/Proj/a.js"', isError: true }),
  result('call-1', 'Error: code run failed (exception): ToolCallError: old_string was not found in "D:/Proj/a.js"', true),
  // 之后用 grep 看清楚了，再改成功
  toolCall('call-2', 'run_code', { code: 'y' }),
  dispatch('call-2', 'grep', { pattern: 'framer' }, { text: 'a.js:12 framer' }),
  dispatch('call-2', 'edit', { file_path: 'D:/Proj/a.js', old_string: 'v3' }, { text: 'ok' }),
  result('call-2', 'done'),
  // 一个"命令失败但没有可描述症状"的：输出全是 PASS 行
  toolCall('call-3', 'run_code', { code: 'z' }),
  dispatch('call-3', 'pwsh', { command: 'npm test' }, { text: '✓ PASS 1\n✓ PASS 2\n[exit code: 1]' }),
  // 回显别人的退出码：job_output 不是 shell 工具，不该算失败
  toolCall('call-4', 'run_code', { code: 'w' }),
  dispatch('call-4', 'job_output', { id: 'j1' }, { text: '... [exit code: 1] ...' }),
]

await mkdir(join(SROOT, '--D-Proj--', 'sess-aaa'), { recursive: true })
await mkdir(join(SROOT, '--D-Proj--', 'sub-bbb'), { recursive: true })
await mkdir(join(SROOT, '--D-Other--', 'sess-ccc'), { recursive: true })
const fa = writeSessionFile(join(SROOT, '--D-Proj--', 'sess-aaa'), HEAD_A, evA)
await writeFile(fa.p, fa.buf)
const fb = writeSessionFile(join(SROOT, '--D-Proj--', 'sub-bbb'), HEAD_SUB, [userMsg('子代理的活儿')])
await writeFile(fb.p, fb.buf)
const fc = writeSessionFile(join(SROOT, '--D-Other--', 'sess-ccc'), HEAD_OTHER, [userMsg('别的项目')])
await writeFile(fc.p, fc.buf)

// ── 新版会话（v3 命名 + tool/ptc-dispatch）────────────────────────────
//
// 这一组夹具是**实测缺口的回归**（2026-09-16）：宿主把会话文件改名成
// session.v3.jsonl.zstd 之后，精确字符串匹配让新版会话全部消失，
// 而这是"不报错、只是历史不再增长"的形态，不测就永远看不见。
const HEAD_V3 = { type: 'session', version: 3, id: 'sess-v3', createdAt: 4000, cwd: 'D:\\Proj', delegationDepth: 0, agentPreset: 'ptc' }
const evV3 = [
  { type: 'session/title', seq: 0, data: { title: 'PTC 会话' } },
  { type: 'turn/start', seq: 0, data: {} },
  userMsg('PTC 模式下改个文件'),
  asstMsg([{ type: 'text', text: '动手。' }]),
  toolCall('p-1', 'run_code', { code: 'x' }),
  ptcDispatch('p-1', 'edit', { file_path: 'D:/Proj/b.js', old_string: 'v1' }, { text: 'Error: old_string was not found in "D:/Proj/b.js"', isError: true }),
  ptcDispatch('p-1', 'edit', { file_path: 'D:/Proj/b.js', old_string: 'v2' }, { text: 'Error: old_string was not found in "D:/Proj/b.js"', isError: true }),
  result('p-1', 'done'),
]
await mkdir(join(SROOT, '--D-Proj--', 'sess-v3'), { recursive: true })
const fv3 = writeSessionFile(join(SROOT, '--D-Proj--', 'sess-v3'), HEAD_V3, evV3, 3)
await writeFile(fv3.p, fv3.buf)

// 目录里真实存在这类备份（实测）：它们**不是**会话，绝不能被当成会话读进来 ——
// 那等于把已经判定损坏的文件重新塞回历史。用精确锚定的正则挡掉。
await writeFile(join(SROOT, '--D-Proj--', 'sess-v3', 'session.jsonl.zstd.bak-20260915'), 'not a session')
await writeFile(join(SROOT, '--D-Proj--', 'sess-aaa', 'session.v3.jsonl.zstd.frame-broken-bak'), 'not a session')

console.log('=== 会话存储 ===')
const ev = readSessionEvents(fa.p)
check('★ 多帧 zstd 全部解出（不是只解第一帧）', ev.length === evA.length + 1, '解出 ' + ev.length + ' 条, 期望 ' + (evA.length + 1))
check('首条是会话头', ev[0].type === 'session' && ev[0].id === 'sess-aaa')
const h = readSessionHeader(fa.p)
check('只读第一帧也能拿到头', h?.id === 'sess-aaa' && h.cwd === 'D:\\Proj', JSON.stringify(h))
check('isSubagentHeader 认得子代理', isSubagentHeader(HEAD_SUB) === true && isSubagentHeader(HEAD_A) === false)

const all = listSessions({ root: SROOT })
check('默认排除子代理', all.length === 3 && !all.some(s => s.id === 'sub-bbb'), all.map(s => s.id).join(','))
const withSub = listSessions({ root: SROOT, includeSubagents: true })
check('includeSubagents 时包含', withSub.length === 4, withSub.map(s => s.id).join(','))
check('★ 按**头里的 cwd 字段**过滤，不靠目录名反推',
  listSessions({ root: SROOT, cwd: 'D:\\Proj' }).length === 2
  && listSessions({ root: SROOT, cwd: 'D:\\Proj' }).every(s => s.cwd === 'D:\\Proj'))
check('按时间倒序', all[0].id === 'sess-v3', all.map(s => s.id + '@' + s.createdAt).join(','))

// ── 文件命名（新版带版本号）──────────────────────────────────────────
//
// 这一组是**实测缺口的回归**：宿主改名成 session.v3.jsonl.zstd 之后，
// 精确字符串匹配让所有新版会话消失，而它不报错、只是历史不再增长。
const names = [
  ['session.jsonl.zstd', true, 'v0 老命名'],
  ['session.v3.jsonl.zstd', true, 'v3 新命名'],
  ['session.v12.jsonl.zstd', true, '两位数版本也不能漏'],
  ['session.jsonl.zstd.bak-20260915', false, '备份不是会话（实测目录里就有）'],
  ['session.jsonl.zstd.frame-broken-bak', false, '已判损坏的备份'],
  ['session.v3.jsonl.zstd.frame-broken-bak', false, 'v3 的损坏备份'],
  ['notes.jsonl.zstd', false, '别的文件名'],
]
const wrong = names.filter(([n, want]) => FILE_RE.test(n) !== want).map(([n]) => n)
check('★ 会话文件名按**整名锚定**匹配（放行 vN、挡住备份）', wrong.length === 0, wrong.length ? '判错: ' + wrong.join(', ') : names.length + ' 个名字全部判对')

const v3Row = all.find(s => s.id === 'sess-v3')
check('★ 新版命名的会话**读得到**（这是本轮修的那个静默失效）', !!v3Row, all.map(s => s.id).join(','))
check('版本从**事件流头部**读，不从文件名反推', v3Row?.version === 3, 'version=' + v3Row?.version)
check('老会话报 v0', all.find(s => s.id === 'sess-aaa')?.version === 0)
check('★ 版本读不到时是 null，不是 0（"不知道"与"v0"必须分得开）',
  sessionFormatVersion(null, 'weird-name.zstd') === null
  && sessionFormatVersion(null, 'session.jsonl.zstd') === 0
  && sessionFormatVersion(null, 'session.v7.jsonl.zstd') === 7)
check('头部读得出时以头部为准（副本与真源不一致时信真源）',
  sessionFormatVersion({ version: 3 }, 'session.jsonl.zstd') === 3)

console.log('')
console.log('=== 摘要 ===')
const d = digestSession(ev, h)
check('标题取自 session/title', d.title === '修一个分帧问题', d.title)
check('★ 注入块不算人说的话', d.counts.humanMessages === 1 && d.firstAsk.includes('分帧'), 'humanMessages=' + d.counts.humanMessages)
check('★ reasoning 不算助手说的话', !d.firstAsk.includes('草稿'))
// 计数规则：6 次内层派发 + 1 次外层 run_code 结果。
// 外层那次是 call-2 的（成功、不是复述）；call-1 的外层是失败复述，被跳过；
// call-3 / call-4 只造了派发没造外层结果。所以是 7 而不是 6 —— 第一版我把
// 自己的夹具数错了，断言写成了 6。
check('数到了工具调用', d.counts.toolCalls === 7, 'toolCalls=' + d.counts.toolCalls)
check('数到了文件', Object.keys(d.filesTouched).some(f => f.endsWith('a.js')), JSON.stringify(Object.keys(d.filesTouched)))
check('★ 外层 run_code 的失败是对内层的**复述**，不重复计数',
  d.counts.failures === 3, 'failures=' + d.counts.failures + '（内层 edit ×2 + pwsh ×1；外层 run_code 应被跳过，job_output 应被跳过）')
check('★ 非 shell 工具里的 [exit code: 1] 是回显，不算失败',
  !d.walls.some(w => /job_output/.test(w.tools && Object.keys(w.tools).join())), JSON.stringify(d.walls.map(w => w.tools)))

const oldStringWall = d.walls.find(w => /old_string was not found/.test(w.sig))
check('★ 撞两次的墙被认出来了', !!oldStringWall && oldStringWall.count === 2, JSON.stringify(d.walls.map(w => ({ s: w.sig.slice(0, 40), n: w.count }))))
check('★ 墙带 tools 归属', oldStringWall?.tools?.edit === 2, JSON.stringify(oldStringWall?.tools))
check('★ 之后没再撞 → resolvedAfter 为真', oldStringWall?.resolvedAfter === true)
check('★ 最后一次失败之后第一步取**内层**调用（不是包着一切的 run_code）',
  oldStringWall?.afterLastFailure?.name === 'grep', JSON.stringify(oldStringWall?.afterLastFailure))

const weakSig = d.walls.find(w => /PASS/.test(w.sig))
check('★ 没有可描述症状的失败（输出全是 PASS）不成墙', !weakSig, weakSig ? weakSig.sig.slice(0, 60) : '（正确地没有）')
check('★ 但它没有被静默丢弃，计进了 weakFailures', d.counts.weakFailures === 1, 'weakFailures=' + d.counts.weakFailures)
check('两类加起来 = 全部失败', d.walls.reduce((n, w) => n + w.count, 0) + d.counts.weakFailures === d.counts.failures,
  d.walls.reduce((n, w) => n + w.count, 0) + '+' + d.counts.weakFailures + ' vs ' + d.counts.failures)
check('renderDigest 能渲染', renderDigest(d).includes('会话 sess-aaa'))

// ── v3 会话的内层派发（tool/ptc-dispatch）────────────────────────────
//
// 与上面那组同源：宿主把内层派发从 tool/code-dispatch 改名成 tool/ptc-dispatch。
// 漏掉它的后果不是"少几张卡片"，而是**摘要会反过来说话** ——
// toolsUsed 只剩 run_code、filesTouched 全空、failures 为 0，
// 读起来像"这次没改过文件也没踩过坑"。
const ev3 = readSessionEvents(fv3.p)
const h3 = readSessionHeader(fv3.p)
const d3 = digestSession(ev3, h3)
check('★ v3 的 ptc-dispatch 被认成工具调用（漏掉会让摘要反过来说话）',
  d3.counts.toolCalls === 3, 'toolCalls=' + d3.counts.toolCalls + '（2 次内层 edit + 1 次外层 run_code 结果）')
check('★ 内层调用进了 toolsUsed', d3.toolsUsed.edit === 2 && d3.toolsUsed.run_code === 1, JSON.stringify(d3.toolsUsed))
check('★ 内层调用带的文件进了 filesTouched（漏掉的话这里会是空的）',
  Object.keys(d3.filesTouched).some(f => f.endsWith('b.js')), JSON.stringify(Object.keys(d3.filesTouched)))
check('★ ptc 的 isError 被认成失败，且两层同一堵墙只数两次',
  d3.counts.failures === 2, 'failures=' + d3.counts.failures)
check('★ ptc 会话也能认出这堵墙', d3.walls.some(w => /old_string was not found/.test(w.sig) && w.count === 2),
  JSON.stringify(d3.walls.map(w => ({ s: w.sig.slice(0, 40), n: w.count }))))
check('★ 头部 version=3 如实带进摘要可判断的形状（不是猜出来的）', h3?.version === 3, 'version=' + h3?.version)

console.log('')
console.log('=== 取材规则：实时与历史必须同一套 ===')
const tr = sessionTranscript(ev, {})
check('★ sessionTranscript 与 wiki_harvest 用的是同一个函数', tr.text.includes('分帧') && !tr.text.includes('注入块'))
const { extractSessionText } = await import('../lib/harvest.js')
const live = extractSessionText({ id: 'sess-aaa', session: { events: ev } }, {})
check('★ 实时路径与历史路径给出**逐字相同**的文本（否则同一段对话两条路会提炼出不同东西）',
  live.text === tr.text, JSON.stringify({ live: live.text.slice(0, 60), hist: tr.text.slice(0, 60) }))
check('实时路径带 session:// 锚点', live.sessionRef === 'session://sess-aaa')

console.log('')
console.log('=== 索引（缓存与预算）===')
const t0 = Date.now()
// 带上子代理，才有 3 个会话可用来看"预算"这件事。
// （默认 includeSubagents=false 时只有 2 个 —— 那是对的，第一版我按 3 写错了。）
const i1 = await loadSessionIndex(ROOT, { sessionsRoot: SROOT, cwd: null, maxNew: 2, includeSubagents: true })
check('第一次只摘预算内的', i1.digested === 2, 'digested=' + i1.digested)
check('★ 没摘的如实报出来，不假装全都索引了', i1.pending === 2 && i1.scanned === 4, JSON.stringify({ pending: i1.pending, scanned: i1.scanned }))
const i2 = await loadSessionIndex(ROOT, { sessionsRoot: SROOT, cwd: null, maxNew: 2, includeSubagents: true })
check('第二次读缓存 + 继续推进', i2.cached === 2 && i2.digested === 2 && i2.pending === 0, JSON.stringify({ cached: i2.cached, digested: i2.digested, pending: i2.pending }))
const i3 = await loadSessionIndex(ROOT, { sessionsRoot: SROOT, cwd: null, maxNew: 0, includeSubagents: true })
check('maxNew=0 时只读缓存，不摘新的', i3.digested === 0 && i3.cached === 4, JSON.stringify({ cached: i3.cached, digested: i3.digested }))
check('索引耗时合理（缓存命中不该重算）', Date.now() - t0 < 20000, (Date.now() - t0) + 'ms')

const walls = collectWalls(i3.digests)
check('跨会话聚合能跑', Array.isArray(walls) && walls.length >= 1, 'walls=' + walls.length)
check('聚合里带上出现的会话', walls[0]?.sessions?.length >= 1 && typeof walls[0].sig === 'string')

await rm(ROOT, { recursive: true, force: true })
await rm(SROOT, { recursive: true, force: true })
console.log('')
if (failures === 0) console.log('ALL PASS — 历史会话可读、摘要可信、缓存正确')
else console.log(failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
