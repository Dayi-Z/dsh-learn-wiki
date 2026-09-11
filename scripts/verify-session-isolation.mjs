// 会话解析隔离层的自检。
//
// ── 为什么这一层需要自己的测试 ──
//
// 宿主在宿主进程里扫描大会话时**原生崩过四次**（只有 crashpad 一行、没有 JS 堆栈），
// 而同样的计算在应用之外全部正常。找不到原生触发点，于是把重活挪进独立子进程 ——
// 子进程死了，宿主只拿到一个退出码。
//
// 这一层的**全部价值**在于失败时的行为，所以测的也主要是失败：
//   * 结果必须与同进程计算**逐字节一致**（挪出去不能改变答案）
//   * 子进程崩了/超时了，只能变成 { ok:false }，**绝不能抛异常把调用方带走**
//     —— 抛出去的话，"隔离"就成了摆设
import { rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { streamSessionEvents } from '../lib/session-store.js'
import { digestAndTranscriptFile } from '../lib/session-digest.js'
import { runSessionChild, sessionBothRemote, sessionIndexRemote } from '../lib/session-remote.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

const ROOT = '.tmp-isolation-test'
await rm(ROOT, { recursive: true, force: true })
await mkdir(ROOT, { recursive: true })

const HEADER = { type: 'session', version: 0, id: 'sess-iso', createdAt: 5000, cwd: 'D:\\Proj', delegationDepth: 0 }
const lines = [JSON.stringify(HEADER)]
for (let i = 0; i < 400; i++) {
  lines.push(JSON.stringify({
    type: 'tool/code-dispatch', seq: i, time: 1700000000000 + i,
    data: { name: 'run_code', arguments: { code: 'x'.repeat(60) }, isError: i % 40 === 0, content: [{ type: 'text', text: i % 40 === 0 ? 'Error: boom at line 7' : 'ok' }] },
  }))
}
// 一帧一行地压再拼 —— 真实文件就是这个形态（每次追加写一帧）
const buf = Buffer.concat(lines.map(l => zlib.zstdCompressSync(Buffer.from(l + '\n', 'utf8'))))
const file = join(ROOT, 'session.jsonl.zstd')
await writeFile(file, buf)

// ── 1) 挪出去不能改变答案 ──
{
  const remote = await sessionBothRemote(file, HEADER, { maxChars: 3000, maxTurns: 4 })
  check('子进程返回成功', remote.ok, remote.ok ? '' : String(remote.error).slice(0, 200))
  if (remote.ok) {
    const local = await digestAndTranscriptFile(file, HEADER, streamSessionEvents, { maxChars: 3000, maxTurns: 4 })
    check('digest 与同进程计算逐字节一致', JSON.stringify(local.digest) === JSON.stringify(remote.result.digest))
    check('transcript 与同进程计算逐字节一致', JSON.stringify(local.transcript) === JSON.stringify(remote.result.transcript))
    check('事件数没丢', remote.result.digest.eventsScanned === local.digest.eventsScanned,
      remote.result.digest.eventsScanned + ' vs ' + local.digest.eventsScanned)
  }
}

// ── 2) 失败必须是返回值，不是异常 ──
{
  let threw = null
  let r = null
  try { r = await sessionBothRemote(join(ROOT, 'does-not-exist.jsonl.zstd'), HEADER, {}) } catch (e) { threw = e }
  check('文件不存在：不抛异常，返回 ok:false', !threw && r && r.ok === false, threw ? 'threw ' + threw : String(r?.error).slice(0, 120))
}

{
  let threw = null
  let r = null
  try { r = await runSessionChild({ kind: '不存在的类型', file, header: HEADER }, {}) } catch (e) { threw = e }
  check('未知 kind：不抛异常，返回 ok:false', !threw && r && r.ok === false, threw ? 'threw ' + threw : String(r?.error).slice(0, 120))
}

// ── 3) 超时保险丝：宿主必须活下来并拿到可读理由 ──
{
  const t0 = Date.now()
  let threw = null
  let r = null
  // 1ms 超时必然先到 —— 这是在测保险丝本身，不是测性能
  try { r = await runSessionChild({ kind: 'both', file, header: HEADER, opts: {} }, { timeoutMs: 1 }) } catch (e) { threw = e }
  const ms = Date.now() - t0
  check('超时：不抛异常，返回 ok:false 且理由可读',
    !threw && r && r.ok === false && /超时/.test(String(r.error)),
    threw ? 'threw ' + threw : String(r?.error).slice(0, 120))
  check('超时后很快就返回（没把调用方挂住）', ms < 5000, ms + 'ms')
}

// ── 4) 批量索引与逐个摘要一致 ──
{
  const items = [{ id: 'sess-iso', file, header: HEADER }]
  const idx = await sessionIndexRemote(items, { timeoutMs: 60000 })
  check('批量索引成功', idx.ok && idx.result.length === 1 && idx.result[0].ok,
    idx.ok ? JSON.stringify(idx.result.map(x => ({ id: x.id, ok: x.ok }))) : String(idx.error).slice(0, 160))
  if (idx.ok && idx.result[0].ok) {
    const local = await digestAndTranscriptFile(file, HEADER, streamSessionEvents, {})
    check('批量索引的 digest 与本地一致', JSON.stringify(idx.result[0].digest) === JSON.stringify(local.digest))
  }
}

await rm(ROOT, { recursive: true, force: true })
console.log(failures === 0 ? '\n隔离层自检全部通过' : '\n有 ' + failures + ' 项未通过')
process.exit(failures === 0 ? 0 : 1)
