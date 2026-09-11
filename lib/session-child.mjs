// 会话解析子进程：真正把重活挪出宿主。
//
// ── 为什么必须是独立**进程**，不能是 worker_threads ──
//
// 宿主在这条路径上原生崩过四次（只有 crashpad 一行，没有 JS 堆栈），
// 实测崩在"开始扫描"之后约 1 秒、扫描**内部**。
//
// worker_threads 是**同一进程内的线程** —— 原生 abort/segfault 照样带走整个
// 宿主进程，等于没隔离。只有独立进程能把它挡住：子进程死了，父进程只拿到
// 一个退出码，可以把失败**如实报出去**而不是跟着一起死。
//
// 用 ELECTRON_RUN_AS_NODE=1 起 Electron 自带的 Node 跑纯计算 ——
// 实测这条路径在 Electron-as-Node 下完全正常（14MB 会话、58566 事件、
// 6-7 秒跑完），所以隔离层本身不引入新问题。
//
// ── 协议 ──
// 不用 stdout 传结果：stdout 混着别的东西、还有管道截断的风险（吃过一次亏）。
// 子进程把结果**写文件**，父进程读文件；stdout/stderr 只用于诊断。
import fs from 'node:fs'
import { streamSessionEvents } from './session-store.js'
import { digestSessionFile, sessionTranscriptFile, digestAndTranscriptFile } from './session-digest.js'

const reqPath = process.argv[2]
const outPath = process.argv[3]

function write(obj) {
  try { fs.writeFileSync(outPath, JSON.stringify(obj), 'utf8') } catch { /* 父进程会看到文件缺失 */ }
}

try {
  const req = JSON.parse(fs.readFileSync(reqPath, 'utf8'))
  const { kind, file, header, opts = {} } = req
  if (kind === 'digest') {
    write({ ok: true, result: await digestSessionFile(file, header, streamSessionEvents) })
  } else if (kind === 'transcript') {
    write({ ok: true, result: await sessionTranscriptFile(file, streamSessionEvents, opts) })
  } else if (kind === 'both') {
    write({ ok: true, result: await digestAndTranscriptFile(file, header, streamSessionEvents, opts) })
  } else if (kind === 'index') {
    // 批量：一次起进程算完整个库，避免"每个会话起一个进程"的开销
    const out = []
    for (const it of req.items ?? []) {
      try {
        out.push({ id: it.id, ok: true, digest: await digestSessionFile(it.file, it.header, streamSessionEvents) })
      } catch (e) {
        out.push({ id: it.id, ok: false, error: String(e?.message ?? e) })
      }
    }
    write({ ok: true, result: out })
  } else {
    write({ ok: false, error: '未知 kind: ' + kind })
  }
} catch (e) {
  write({ ok: false, error: String(e?.stack ?? e) })
}
