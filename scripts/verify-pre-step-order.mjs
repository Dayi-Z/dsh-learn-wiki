// pre-step 钩子**链路顺序**的自检。
//
// 为什么单独一个文件：这一路已经静默失效过一次 —— 「压缩 Hindsight 注入块」
// 三个月没跑，而日志里一声不响。根因不是形状，是**顺序**（本插件排在 Hindsight
// 下游，而块是在 Hindsight 的 next() 返回之后才 append 的）。
// 这个自检要证明的正是那条顺序规则本身，而不是压缩算法。
import { createPreStepOrder } from '../lib/pre-step-order.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

// ── 假宿主：记录注册顺序与选项，并按 cordis 的真实语义派发 ──
//
// cordis 的 waterfall：cbs.shift() 逐个调用，每个都拿到 next()；
// prepend 就是 unshift（后注册的排最前）。这里照抄这个语义 ——
// 夹具复述的是**宿主的规则**，不是我们的假设。
function fakeCtx() {
  const hooks = []
  const log = []
  return {
    hooks,
    log,
    on(name, cb, opts) {
      const rec = { name, cb, prepend: !!(opts && opts.prepend) }
      if (rec.prepend) hooks.unshift(rec); else hooks.push(rec)
      const dispose = () => { const i = hooks.indexOf(rec); if (i >= 0) hooks.splice(i, 1); return true }
      rec.dispose = dispose
      return dispose
    },
    async dispatch(payload, inner) {
      const cbs = hooks.slice()   // ★ 每次新建数组（cordis dispatch() 就是这么做的）
      const next = async () => {
        const rec = cbs.shift()
        if (!rec) return inner()
        return rec.cb(payload, next)
      }
      return next()
    },
  }
}

console.log('=== 顺序规则 ===')
{
  const ctx = fakeCtx()
  // ★ 要断言的是「**我们的钩子体**从 next() 拿到的那份 decision 里有没有块」，
  //   不是「最终的 decision 里有没有块」—— 后者永远有（Hindsight 最后才 append）。
  //   第一版断言就写错在这里：它证明不了任何与顺序有关的事。
  let seenByBody = null
  const order = createPreStepOrder({
    ctx, log: (m) => ctx.log.push(m),
    body: async (p, next) => { const d = await next(); seenByBody = JSON.stringify(d.messages ?? []); return d },
  })
  order.register()
  // 复刻真实顺序：本插件先注册，Hindsight 后注册且 prepend → 它排到链头（上游）。
  ctx.on('agent/pre-step', async (p, next) => {
    const d = await next()
    return { ...d, messages: [...d.messages, { role: 'user', content: [{ type: 'text', text: '<hindsight_knowledge>大块</hindsight_knowledge>' }] }] }
  }, { prepend: true })

  await ctx.dispatch({ seq: 1 }, async () => ({ kind: 'enter', messages: [] }))
  const sawBefore = seenByBody.includes('hindsight_knowledge')
  check('★ 提升之前，下游钩子看不到注入块（复现真实故障）', sawBefore === false, '钩子体看到含块=' + sawBefore)

  // 第二次派发：handler 在第一次触发时已把自己提到链头（当前这条链是旧顺序）
  await ctx.dispatch({ seq: 2 }, async () => ({ kind: 'enter', messages: [] }))
  const sawAfter = seenByBody.includes('hindsight_knowledge')
  check('★ 提升之后，同一个钩子体看到了注入块（这就是修好的判据）', sawAfter === true, '钩子体看到含块=' + sawAfter)
  check('提升成功被如实记录', order.atHead === true)
  check('提上去之后我们的注册确实在链头', ctx.hooks[0] && ctx.hooks[0].cb === order.handler, 'pos=' + ctx.hooks.findIndex(h => h.cb === order.handler))
  check('链上只剩一份我们的注册（旧的注销掉了）', ctx.hooks.filter(h => h.cb === order.handler).length === 1)
  check('日志里说了这件事', ctx.log.some(m => String(m).includes('提到链头')), JSON.stringify(ctx.log).slice(0, 90))
}

console.log('')
console.log('=== 只提升一次 ===')
{
  const ctx = fakeCtx()
  const order = createPreStepOrder({ ctx, log: () => {}, body: async (p, next) => next() })
  order.register()
  for (let i = 0; i < 4; i++) await ctx.dispatch({ seq: i }, async () => ({ kind: 'enter', messages: [] }))
  check('多次触发不会反复重挂（链上始终一份）', ctx.hooks.filter(h => h.cb === order.handler).length === 1)
  check('只尝试过一次', order.attempted === true)
}

console.log('')
console.log('=== 失败不对称：挂新的失败必须保住旧的 ===')
{
  const ctx = fakeCtx()
  let calls = 0
  const realOn = ctx.on.bind(ctx)
  ctx.on = (name, cb, opts) => { calls++; if (opts && opts.prepend) throw new Error('fiber inactive'); return realOn(name, cb, opts) }
  const logs = []
  const order = createPreStepOrder({ ctx, log: (m) => logs.push(m), body: async (p, next) => next() })
  order.register()
  const d = await ctx.dispatch({ seq: 1 }, async () => ({ kind: 'enter', messages: ['x'] }))
  check('★ 提升失败时原注册仍在（不能一份都不剩）', ctx.hooks.length === 1 && ctx.hooks[0].cb === order.handler, 'hooks=' + ctx.hooks.length)
  check('钩子体照常执行（功能不受影响）', d.messages.length === 1)
  check('失败被如实记下来（不许静默）', logs.some(m => String(m).includes('提到链头失败')), JSON.stringify(logs).slice(0, 100))
  check('atHead 保持 false（没成功就不许说自己成功了）', order.atHead === false)
}

console.log('')
console.log('=== 注销失败的兜底：不许同一份执行两次 ===')
{
  const ctx = fakeCtx()
  const realOn = ctx.on.bind(ctx)
  // 让"注销旧的"失败：返回的 dispose 变成空操作
  let n = 0
  ctx.on = (name, cb, opts) => { n++; const dispose = realOn(name, cb, opts); return n === 1 ? (() => {}) : dispose }
  let bodyRuns = 0
  const order = createPreStepOrder({ ctx, log: () => {}, body: async (p, next) => { bodyRuns++; return next() } })
  order.register()
  await ctx.dispatch({ seq: 1 }, async () => ({ kind: 'enter', messages: [] }))
  bodyRuns = 0
  await ctx.dispatch({ seq: 2 }, async () => ({ kind: 'enter', messages: [] }))
  check('★ 链上确实有两份（这就是兜底要对付的情况）', ctx.hooks.filter(h => h.cb === order.handler).length === 2)
  check('★ 同一个 payload 只让一份干活', bodyRuns === 1, 'bodyRuns=' + bodyRuns)
}

console.log('')
if (failures === 0) console.log('ALL PASS — 链头提升的顺序规则成立，且失败时不会把注册弄丢')
else console.log(failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
