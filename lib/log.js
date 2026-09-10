// 插件日志。
//
// 为什么需要它：DSH 桌面版里插件的 console.log 基本不可见（没有稳定的
// stdout 捕获）。之前排查补料为什么没跑时，因为"没有任何日志"而只能靠猜，
// 浪费了整整一轮。所以一切诊断信息都同时写进 <wikiRoot>/.learn-wiki.log。
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_ARG = 600

function stringify(a) {
  if (typeof a === 'string') return a.length > MAX_ARG ? a.slice(0, MAX_ARG) + '…' : a
  try { const s = JSON.stringify(a); return s && s.length > MAX_ARG ? s.slice(0, MAX_ARG) + '…' : (s ?? String(a)) }
  catch { return String(a) }
}

export function createLogger(wikiRoot) {
  let file = null
  try { file = join(wikiRoot, '.learn-wiki.log') } catch { /* wikiRoot 异常时退化为纯 console */ }
  return (...args) => {
    const line = '[' + new Date().toISOString() + '] ' + args.map(stringify).join(' ')
    try { console.log('[dsh-learn-wiki]', ...args) } catch { /* console 不可用无所谓 */ }
    // 落盘必须永不抛异常、永不阻塞调用方
    if (file) appendFile(file, line + '\n', 'utf8').catch(() => {})
  }
}
