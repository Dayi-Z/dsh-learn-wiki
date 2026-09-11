// 插件日志。
//
// 为什么需要它：DSH 桌面版里插件的 console.log 基本不可见（没有稳定的
// stdout 捕获）。之前排查补料为什么没跑时，因为"没有任何日志"而只能靠猜，
// 浪费了整整一轮。所以一切诊断信息都同时写进 <wikiRoot>/.learn-wiki.log。
import { appendFile } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_ARG = 600

function stringify(a) {
  if (typeof a === 'string') return a.length > MAX_ARG ? a.slice(0, MAX_ARG) + '…' : a
  try { const s = JSON.stringify(a); return s && s.length > MAX_ARG ? s.slice(0, MAX_ARG) + '…' : (s ?? String(a)) }
  catch { return String(a) }
}

/**
 * @param wikiRoot 日志目录
 * @param opts.sync  true = **同步**落盘。默认 false（异步、不阻塞调用方）。
 *
 * 为什么需要同步这一档：默认的异步写盘在**原生崩溃**时会丢。
 * 实测到的崩溃形态就是原生层的（只有 crashpad 一行，没有 JS 堆栈、
 * 没有 uncaughtException），异步写的那几行日志全部没落下来，
 * 于是"崩在哪一步"完全无从判断。诊断重路径时改用同步写 ——
 * 只在**阶段边界**写几行，代价可以忽略。
 */
export function createLogger(wikiRoot, { sync = false } = {}) {
  let file = null
  try { file = join(wikiRoot, '.learn-wiki.log') } catch { /* wikiRoot 异常时退化为纯 console */ }
  return (...args) => {
    const line = '[' + new Date().toISOString() + '] ' + args.map(stringify).join(' ')
    try { console.log('[dsh-learn-wiki]', ...args) } catch { /* console 不可用无所谓 */ }
    if (!file) return
    if (sync) {
      // 同步档：必须落盘，且绝不能因为写日志本身把调用方搞挂
      try { appendFileSync(file, line + '\n', 'utf8') } catch { /* 写不进去就算了，不能反过来影响主流程 */ }
      return
    }
    // 异步档：落盘永不抛异常、永不阻塞调用方
    appendFile(file, line + '\n', 'utf8').catch(() => {})
  }
}
