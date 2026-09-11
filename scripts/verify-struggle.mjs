// 挣扎检测器自检。判据决定"什么时候花钱联网"，所以这里必须覆盖
// 触发与不触发两侧——只会触发的检测器等于没有检测器。
import { detect, canonicalArgs, normalizeError, createStruggleTracker, SIGNAL_TYPES, looksLikeFailure, resultText, symptomQuery } from '../lib/struggle.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

const cfg = {
  struggleWindow: 40,
  struggleRepeatIdentical: 5,
  struggleRepeatFailure: 3,
  struggleEditChurn: 4,
  struggleRecurringError: 3,
  struggleCooldownMs: 120000,
}

// 字段名是 `failed` 而不是 `isError`：检测器现在认的是"这次算不算失败"，
// 它比 harness 的 isError 宽（多算了"命令非零退出"）。测试跟着改，
// 免得名字不一致时"测试绿了但生产没变"。
const ev = (o = {}) => ({ ts: 1, tool: 'read', key: 'read|{}', failed: false, errorSig: '', file: undefined, ...o })
const types = (evs) => detect(evs, cfg).map(s => s.type)

// ── 规范化 ──
console.log('=== 规范化 ===')
check('参数属性顺序不影响链键',
  canonicalArgs({ b: 1, a: 2 }) === canonicalArgs({ a: 2, b: 1 }),
  canonicalArgs({ b: 1, a: 2 }))

const e1 = normalizeError('Error: connect ECONNREFUSED 127.0.0.1:8888 at C:\\Users\\HP\\x.js:12:5')
const e2 = normalizeError('Error: connect ECONNREFUSED 127.0.0.1:9999 at C:\\Users\\HP\\y.js:88:2')
check('同一堵墙的不同实例归一化为同一指纹', e1 === e2, JSON.stringify(e1))
const e3 = normalizeError('Error: something else entirely')
check('不同错误不会混为一谈', e1 !== e3)

// ── 逐个信号的触发条件 ──
console.log('\n=== 触发条件 ===')
check('连续相同调用 5 次 → repeat-identical',
  types(Array.from({ length: 5 }, () => ev())).includes('repeat-identical'))
check('连续相同调用 4 次 → 不触发（阈值 5）',
  !types(Array.from({ length: 4 }, () => ev())).includes('repeat-identical'))

check('连续失败 3 次 → repeat-failure',
  types(Array.from({ length: 3 }, (_, i) => ev({ tool: 't' + i, key: 'k' + i, failed: true, errorSig: 'e' + i }))).includes('repeat-failure'))
check('连续失败 2 次 → 不触发（阈值 3）',
  !types(Array.from({ length: 2 }, (_, i) => ev({ tool: 't' + i, key: 'k' + i, failed: true, errorSig: 'e' + i }))).includes('repeat-failure'))

// ★ edit-churn 的语义变了：光"改得多"不算卡住，还必须**有失败证据**。
//   实测依据：35 次 edit-churn 触发全部来自正常迭代（改了十几次、每次都跑通），
//   产出的唯一一页是关于另一个撞名项目的内容。提高阈值治不了——病不在阈值上。
const churnWithFail = Array.from({ length: 4 }, (_, i) => ev({ tool: 'edit', key: 'edit|' + i, file: 'a.js', failed: i === 3 }))
check('★ 同一文件改 4 次**且中间失败过** → edit-churn（真死胡同）',
  types(churnWithFail).includes('edit-churn'), JSON.stringify(types(churnWithFail)))
check('同一文件改 3 次 → 不触发（阈值 4）',
  !types(Array.from({ length: 3 }, (_, i) => ev({ tool: 'edit', key: 'edit|' + i, file: 'a.js', failed: true }))).includes('edit-churn'))
check('四个文件各改一次 → 不触发',
  !types(['a', 'b', 'c', 'd'].map((f, i) => ev({ tool: 'edit', key: 'edit|' + i, file: f }))).includes('edit-churn'))

// ★ 本次修复的核心断言：改得多但一路顺利 = 正常迭代，不是卡住。
const churnClean = Array.from({ length: 12 }, (_, i) => ev({ tool: 'edit', key: 'edit|' + i, file: 'client.js' }))
check('★ 同一文件改 12 次、一次都没失败 → 不是挣扎（那 35 条误报就是这个形态）',
  !types(churnClean).includes('edit-churn'), JSON.stringify(types(churnClean)))
const firedChurn = detect(churnWithFail, cfg).find(s => s.type === 'edit-churn')
check('★ 信号带上失败次数，便于事后核账', firedChurn?.failCount === 1, JSON.stringify(firedChurn))
check('detail 里写明"其间 N 次失败"', /其间 1 次失败/.test(firedChurn?.detail ?? ''), firedChurn?.detail)
const cfgLoose = { ...cfg, struggleEditChurnNeedsFailure: false }
check('★ 关掉开关可退回旧行为（行为变更是可逆的）',
  detect(churnClean, cfgLoose).some(s => s.type === 'edit-churn'))

check('同一错误 3 次 → recurring-error',
  types(Array.from({ length: 3 }, (_, i) => ev({ key: 'k' + i, tool: 't' + i, failed: true, errorSig: 'same' }))).includes('recurring-error'))
check('三个不同错误 → 不触发',
  !types(['x', 'y', 'z'].map((s, i) => ev({ key: 'k' + i, tool: 't' + i, failed: true, errorSig: s }))).includes('recurring-error'))

// ── 不得误报 ──
console.log('\n=== 不得误报 ===')
const healthy = Array.from({ length: 12 }, (_, i) => ev({ tool: 'tool' + i, key: 'k' + i }))
check('一路顺利的长任务 → 零信号', types(healthy).length === 0, JSON.stringify(types(healthy)))

const iterate = [
  ev({ tool: 'edit', key: 'edit|1', file: 'a.js' }),
  ev({ tool: 'pwsh', key: 'pwsh|1' }),
  ev({ tool: 'edit', key: 'edit|2', file: 'b.js' }),
  ev({ tool: 'pwsh', key: 'pwsh|2' }),
  ev({ tool: 'edit', key: 'edit|3', file: 'a.js' }),
]
check('正常的"改-测-改"迭代 → 零信号', types(iterate).length === 0, JSON.stringify(types(iterate)))

// ── 状态机：冷却与重置 ──
console.log('\n=== 状态机 ===')
const tracker = createStruggleTracker(cfg)
const agent = {}
const mk = (i) => ({ name: 'read', arguments: { file_path: 'x' }, agent })
const res = { isError: false }

let firstFire = null
for (let i = 0; i < 8; i++) {
  const f = tracker.observe(agent, mk(i), res)
  if (f.length && !firstFire) firstFire = { at: i, f }
}
check('第 5 次观察时首次触发（阈值 5）', firstFire && firstFire.at === 4, 'at=' + (firstFire?.at))
check('冷却期内不重复触发同一类信号', firstFire && firstFire.f.length === 1)

tracker.reset(agent)
const afterReset = tracker.observe(agent, mk(9), res)
check('reset 后窗口清空，不立即再触发', afterReset.length === 0, JSON.stringify(afterReset.map(s => s.type)))

check('全部信号类型都已列入 SIGNAL_TYPES', SIGNAL_TYPES.length === 4, SIGNAL_TYPES.join(','))

// ── 失败判据：harness 错误 vs 命令失败 ──
//
// ★ 这一节是本次修复的地基。实测 15868 条真实 tool/result：
//   isError=true 的 1228 条，**全部是 "unknown tool" 这类 harness 层错误**；
//   正文里带 "[exit code: N]"(N≠0) 的 588 条，**没有一条**置了 isError。
// 也就是说"改了 → 跑检查 → 失败"这条最典型的死胡同，原来对检测器完全不可见。
console.log('\n=== 失败判据 ===')
const resShape = (text, isError) => ({ content: [{ type: 'tool-result', content: [{ type: 'text', text }], isError }] })

check('harness 层错误（isError=true）算失败', looksLikeFailure({ isError: true }) === true)
// ★ 退出码判据只对 **shell 工具**成立，所以必须把工具名传进去。
//   实测（77 个会话）：759 条带非零退出标记的结果里，51 条来自非 shell 工具
//   —— 最多的是 job_output（35 条，它返回的就是另一个进程的 stdout）。
//   那些是**回显**，不是自己失败。不传工具名时退回"只认 isError"，
//   也就是宁可漏判也不误判。
check('★ 命令非零退出（shell 工具的正文带 [exit code: 1]）也算失败 —— 这是原来漏掉的那一半',
  looksLikeFailure(resShape('[exit code: 1]', false), 'pwsh') === true)
check('★ 同样的正文，但工具不是 shell → 判定为**回显**，不算失败',
  looksLikeFailure(resShape('[exit code: 1]', false), 'job_output') === false)
check('★ 不传工具名时退回保守判据（只认 isError），不误判',
  looksLikeFailure(resShape('[exit code: 1]', false)) === false)
check('退出码 0 不算失败', looksLikeFailure(resShape('done\n[exit code: 0]', false), 'pwsh') === false)
check('★ 正文里出现 "Error:" 但退出码为 0 → **不算**失败（保守：不认语气，只认证据）',
  looksLikeFailure(resShape('the log says: Error: something happened\n[exit code: 0]', false), 'pwsh') === false)
check('普通成功输出不算失败', looksLikeFailure(resShape('all tests passed', false), 'pwsh') === false)
check('空结果不抛异常且不算失败', looksLikeFailure(null) === false && looksLikeFailure({}) === false)
check('★ 嵌套文本能抠出来（真实结果形状是 content[0].content[0].text）',
  resultText(resShape('hello world', false)).includes('hello world'))
check('多个 exit code 标记时，只要有一个非 0 就算失败',
  looksLikeFailure(resShape('[exit code: 0] ... [exit code: 2]', false), 'pwsh') === true)
check('★ 讨论报错的输出不会被误判（正文里出现 "exit code" 但没有方括号标记）',
  looksLikeFailure(resShape('we print [exit code: N] when a command fails', false), 'pwsh') === false)

// ── 症状查询不得撒谎 ──
console.log('\n=== 症状查询 ===')
const qWithFail = symptomQuery([{ type: 'edit-churn', file: 'D:/x/client.js', failCount: 2 }])
check('有失败证据时才说"仍不成功"', /仍不成功/.test(qWithFail), qWithFail)
const qNoFail = symptomQuery([{ type: 'edit-churn', file: 'D:/x/client.js', failCount: 0 }])
check('★ 没有失败证据就**不**声称"仍不成功"（原版把这四个字写死了）',
  !/仍不成功/.test(qNoFail), qNoFail)
check('症状查询仍然带文件名', /client\.js/.test(qNoFail), qNoFail)

// ★ 查询文本不能随计数变化。
//   同一个坑的第二半：identity 早就改成不带计数了（为了冷却去重），
//   但 symptomQuery 取的还是 detail，而 detail 里写着"连续 N 次失败"。
//   失败连着涨的时候同一个错误会依次变成 5、6、7、8 次失败，每次都生成一个
//   **不同的查询** → 新 hash → gap 队列里同一堵墙躺成好几条，
//   每一条都可能独立触发一次联网。实测在 verify-plugin 日志里看到 5/6/7/8 四条。
const wall = (n) => Array.from({ length: n }, (_, i) => ev({ tool: 'pwsh', key: 'k' + i, failed: true, errorSig: 'Error: WALL_OVERFLOW at <path>' }))
const rf = (n) => detect(wall(n), cfg).filter(s => s.type === 'repeat-failure')
const q5 = symptomQuery(rf(5))
const q8 = symptomQuery(rf(8))
check('★ 连续 5 次和连续 8 次失败 → **同一个**查询（否则同一个错误会躺成好几条 gap）',
  q5 === q8 && q5.length > 0, JSON.stringify({ q5, q8 }))
check('★ 查询里带错误指纹（这才是可搜的部分）', /WALL_OVERFLOW/.test(q5), q5)
check('★ 查询里不带计数', !/\d+\s*次失败/.test(q5), q5)
const rfNoSig = detect(Array.from({ length: 5 }, (_, i) => ev({ tool: 'pwsh', key: 'k' + i, failed: true })), cfg).filter(s => s.type === 'repeat-failure')
const qNoSig = symptomQuery(rfNoSig)
check('没有错误指纹时退回工具名，仍然不带计数', /pwsh/.test(qNoSig) && !/\d+\s*次失败/.test(qNoSig), qNoSig)

console.log(failures === 0 ? '\nALL PASS — 挣扎检测器判据正确' : '\n' + failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
