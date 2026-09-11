// 键控串行锁：把「读-改-写同一个文件」这段序列整体串起来。
//
// 为什么需要：wikiRoot 下的 usage.json / gaps/queue.jsonl 都是**整文件
// 读-改-写**。两条这样的序列并发跑，后写的那条会拿旧快照整体覆盖，
// 前一条刚写进去的东西**静默消失**。
//
// 这不是理论问题，实测踩到两次，而且是同一类：
//   1. acquire.js:316 已经记过一次：runAcquisition 写回 gap 状态时把
//      appendGap 刚登记的 gap 整个覆盖掉了（冷却设 0 时立刻复现）。
//      当时只在 runAcquisition 里打了局部补丁（重读+合并），
//      但 appendGap 自己还是裸的 —— 于是两个并发 appendGap 照样互吃。
//   2. verify-subagent-guard.mjs 第一次跑就复现了 (1) 的残留形态：
//      两个 agent 相隔 3ms 各登记一条 gap，最终文件里只剩一条。
//
// 教训：**在调用方逐个打补丁治不了这一类 bug**，因为每个新调用方都是一次
// 新的机会。要把原语本身做成安全的。
//
// 进程内锁就够：插件与它的所有 agent 跑在同一个 Node 进程里。
// 如果将来出现多进程同时写同一个 wikiRoot（比如两个 DSH 实例共用一个库），
// 这个锁**不够** —— 那时需要文件锁。这一点写在这里，免得将来误以为它是万能的。
const chains = new Map()

export function withLock(key, fn) {
  const prev = chains.get(key) ?? Promise.resolve()
  // 前一个失败不该阻塞后一个：两种结果都往下走
  const next = prev.then(() => fn(), () => fn())
  // 存进链里的是"只关心完成、不关心成败"的版本，
  // 否则一个 rejection 会被下一位当成"前驱失败"再传染一遍。
  const settled = next.then(() => {}, () => {})
  chains.set(key, settled)
  // 排空后清理键。判据是"链尾还是我"——有后来者接上时它已经是别的对象了，
  // 这时候删就会把后来者的链头一起删掉。
  settled.then(() => { if (chains.get(key) === settled) chains.delete(key) })
  return next
}

/** 测试用：等所有锁排空，并清掉键。 */
export async function drainLocks() {
  const keys = [...chains.keys()]
  for (const k of keys) { try { await chains.get(k) } catch {} }
  chains.clear()
}
