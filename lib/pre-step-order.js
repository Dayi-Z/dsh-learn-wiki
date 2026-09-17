// pre-step 钩子的**链路顺序**：把本插件的钩子从 Hindsight 的下游提到链头。
//
// ── 为什么这件事值得单独一个模块 ──
//
// 它埋在 index.js 的闭包里就**测不到**，而这一路已经这样静默失效过一次：
// 「压缩 Hindsight 注入块」从 2026-09-10 起再没跑过（插件日志里 compact: 只有一条），
// 而同一钩子里的 capabilities: 有几百条 —— 钩子在跑，只是永远看不见该压的东西。
//
// 根因不是消息形状，是**链路顺序**（实测逐行确认，2026-09-17）：
//
//   · hindsight-coding-agents 也注册 agent/pre-step，且带 { prepend: true }；
//     cordis 里 prepend 就是 unshift（后注册的排最前，见 cordis lib 的 register()），
//     而它在 profile 的 bundle 列表里排在本插件**之后**（第 12 位 vs 第 6 位）。
//     于是链序 = [hindsight, 本插件]。
//
//   · cordis 的 waterfall 是「外层先跑、next() 拿下游结果、再后处理」：
//         const next = () => (cbs.shift() ?? inner)(...args)
//     dsh-agent-loop 的 preStep 调它。Hindsight 的手册写法正是：
//         async preStep({agent, signal}, next) {
//           const decision = await next()      // ← 先跑下游（含本插件）
//           ...
//           return { kind:'enter', messages: [...decision.messages, injectionMessage(injection)] }
//         }
//     注入块是在**它的 next() 返回之后**才 append 进去的。
//
//   所以在下游的钩子**结构上**永远看不到那个块 —— 无论形状支持得多全。
//   一次性探针证实：decision.messages 有 3 条、含 hindsight 块=false。
//
// ── 为什么不能简单给自己加 prepend ──
//
// 本插件的注册时机更早（bundle 第 6 位），Hindsight 后来的 unshift 仍会把
// 自己排到最前面。所以要**等它注册完之后**再挂：第一次触发时重挂一次即可 ——
// 那一刻所有插件都已 apply 完毕，unshift 必然落到链头。
//
// ── 重挂为什么安全 ──
//
//   · dispatch() 每次都用 filter/map **新建**回调数组，改注册表不影响正在跑的这条链；
//   · ctx.on 里 listener 会过 reflect.bind()，每次返回**新的 Proxy**，
//     所以两次注册的 callback 引用不同，注销能精确落到该删的那一份。
//
// 但仍留一道去重兜底：万一注销失败、同一 handler 挂在链上两份，
// 就只让第一份干活（否则注入会被插两次）。两种失败的代价不对称 ——
// 少跑一次只是没压到，跑两次会把同一段知识插进上下文两遍。

export const PRE_STEP_EVENT = 'agent/pre-step'

/**
 * @param ctx   宿主 ctx（只用到 ctx.on）
 * @param body  真正干活的钩子体（本插件的 pre-step）：(payload, next) => decision
 * @param log   日志（默认吞掉）
 * @param name  事件名（默认 agent/pre-step；测试里可换）
 */
export function createPreStepOrder({ ctx, body, log = () => {}, name = PRE_STEP_EVENT }) {
  let disposer = null
  let attempted = false   // 已经尝试过提升（无论成败，只试一次）
  let atHead = false      // 提升**成功**，现在挂在链头
  const seen = new WeakSet()

  const handler = async (payload, next) => {
    // 兜底：注销失败导致同一 handler 在链上两份时，只有第一份干活。
    if (payload && typeof payload === 'object') {
      if (seen.has(payload)) return next()
      seen.add(payload)
    }
    if (!attempted) {
      attempted = true
      try {
        // 先挂新的（链头），成功了再注销旧的 —— 顺序刻意如此：
        // 反过来的话，一旦 ctx.on 抛异常就会**一份注册都不剩**，
        // 整个 pre-step 路径（注入/能力包/技能裁剪/压缩）全哑，
        // 比原来的"压不到"严重得多。
        const fresh = ctx.on(name, handler, { prepend: true })
        try { disposer?.() } catch (e) {
          log('compact: 旧注册注销失败（已由去重兜底拦住重复执行）：' + (e?.message ?? e))
        }
        disposer = fresh
        atHead = true
        log('compact: pre-step 钩子已提到链头（否则永远排在 Hindsight 之后，看不见注入块）')
      } catch (e) {
        log('compact: 提到链头失败（保留原注册，功能不受影响）：' + (e?.message ?? e))
      }
    }
    return body(payload, next)
  }

  return {
    /** 交给 body 之外用的同一个引用（调试/日志用）。 */
    handler,
    /** 先按普通顺序登记（此刻即使 prepend 也会被 Hindsight 后来居上）。 */
    register() { disposer = ctx.on(name, handler); return disposer },
    get attempted() { return attempted },
    get atHead() { return atHead },
  }
}
