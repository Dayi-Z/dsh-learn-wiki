// 挣扎检测器自检。判据决定"什么时候花钱联网"，所以这里必须覆盖
// 触发与不触发两侧——只会触发的检测器等于没有检测器。
import { detect, canonicalArgs, normalizeError, createStruggleTracker, SIGNAL_TYPES } from '../lib/struggle.js'

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

const ev = (o = {}) => ({ ts: 1, tool: 'read', key: 'read|{}', isError: false, errorSig: '', file: undefined, ...o })
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
  types(Array.from({ length: 3 }, (_, i) => ev({ tool: 't' + i, key: 'k' + i, isError: true, errorSig: 'e' + i }))).includes('repeat-failure'))
check('连续失败 2 次 → 不触发（阈值 3）',
  !types(Array.from({ length: 2 }, (_, i) => ev({ tool: 't' + i, key: 'k' + i, isError: true, errorSig: 'e' + i }))).includes('repeat-failure'))

check('同一文件改 4 次 → edit-churn',
  types(Array.from({ length: 4 }, (_, i) => ev({ tool: 'edit', key: 'edit|' + i, file: 'a.js' }))).includes('edit-churn'))
check('同一文件改 3 次 → 不触发（阈值 4）',
  !types(Array.from({ length: 3 }, (_, i) => ev({ tool: 'edit', key: 'edit|' + i, file: 'a.js' }))).includes('edit-churn'))
check('四个文件各改一次 → 不触发',
  !types(['a', 'b', 'c', 'd'].map((f, i) => ev({ tool: 'edit', key: 'edit|' + i, file: f }))).includes('edit-churn'))

check('同一错误 3 次 → recurring-error',
  types(Array.from({ length: 3 }, (_, i) => ev({ key: 'k' + i, tool: 't' + i, isError: true, errorSig: 'same' }))).includes('recurring-error'))
check('三个不同错误 → 不触发',
  !types(['x', 'y', 'z'].map((s, i) => ev({ key: 'k' + i, tool: 't' + i, isError: true, errorSig: s }))).includes('recurring-error'))

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

console.log(failures === 0 ? '\nALL PASS — 挣扎检测器判据正确' : '\n' + failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
