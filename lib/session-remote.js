// 把会话解析放到独立子进程里跑，并把"子进程死了"变成一条可读的失败。
//
// ── 这一层要挡住的是什么 ──
//
// 宿主在扫描大会话时**原生崩溃**过四次：只有 crashpad 一行、没有 JS 堆栈、
// 没有 uncaughtException、Windows 事件日志和 guardian 都没有记录。
// 实测崩在"开始扫描"之后约 1 秒、扫描内部（同步日志的最后一个阶段标记）。
//
// 同样的计算在应用之外全部正常：Node 24、Electron-as-Node（22.16）都能跑完
// 14MB / 58566 事件，把 RSS 顶到 1.3GB 也一样。
//
// 所以这不是"算得对不对"的问题，是"这段计算在宿主里会杀死宿主"的问题。
// 既然找不到宿主里那个原生触发点，就**别在宿主里做这件事**。
//
// ★ 用独立进程而不是 worker_threads：worker 是同一进程内的线程，
//   原生 abort 照样带走整个宿主，等于没隔离。
//
// ★ 这一层的契约是：**永远不抛异常给调用方**。
//   子进程崩溃/超时/输出缺失，都只能变成 { ok:false, error }。
//   "把失败如实报出来"远好过"跟着一起死" —— 后者连报错的机会都没有。
import { fork } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CHILD = join(HERE, 'session-child.mjs')

/** 子进程退出码 → 人话。原生崩溃在 Windows 上通常是 0xC0000005 / 0xC0000409 这类。 */
function describeExit(code, signal) {
  if (signal) return '子进程被信号 ' + signal + ' 终止'
  if (code === 0) return '子进程没有写出结果就退出了'
  const hex = code < 0 ? (code >>> 0).toString(16) : code.toString(16)
  return '子进程异常退出 code=' + code + ' (0x' + hex + ')'
}

/**
 * 在独立进程里跑一次会话解析。
 *
 * @returns { ok:true, result } 或 { ok:false, error } —— **永不抛异常**
 */
export function runSessionChild(req, { timeoutMs = 90000, log = () => {} } = {}) {
  return new Promise((resolve) => {
    let dir = null
    let child = null
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      try { if (child && child.exitCode === null) child.kill() } catch { /* 已经没了 */ }
      try { if (dir) rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录清不掉不影响结果 */ }
      resolve(v)
    }

    try {
      dir = mkdtempSync(join(tmpdir(), 'dsh-lw-sess-'))
      const reqPath = join(dir, 'req.json')
      const outPath = join(dir, 'out.json')
      writeFileSync(reqPath, JSON.stringify(req), 'utf8')

      let stderr = ''
      child = fork(CHILD, [reqPath, outPath], {
        // ★ 用 Electron 自带的 Node 跑纯计算。不设这个的话，
        //   fork 会去起一个完整的 Electron 应用窗口。
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      })
      const timer = setTimeout(() => {
        log('session-child: 超时 ' + timeoutMs + 'ms，已终止')
        finish({ ok: false, error: '会话解析超时（' + timeoutMs + 'ms）——已终止子进程，宿主未受影响。' })
      }, timeoutMs)
      timer.unref?.()

      child.stderr?.on('data', (c) => { stderr = (stderr + String(c)).slice(-2000) })

      child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, error: '无法启动子进程: ' + String(e?.message ?? e) }) })
      child.on('exit', (code, signal) => {
        clearTimeout(timer)
        if (done) return
        if (!existsSync(outPath)) {
          const why = describeExit(code, signal)
          log('session-child: ' + why + (stderr ? ' stderr=' + stderr.slice(0, 400) : ''))
          finish({ ok: false, error: why + '。会话解析在独立进程里死掉了，宿主没事。' + (stderr ? ' stderr: ' + stderr.slice(0, 300) : '') })
          return
        }
        try {
          const parsed = JSON.parse(readFileSync(outPath, 'utf8'))
          if (!parsed?.ok) { finish({ ok: false, error: String(parsed?.error ?? '子进程返回了失败') }); return }
          finish({ ok: true, result: parsed.result })
        } catch (e) {
          finish({ ok: false, error: '子进程输出无法解析: ' + String(e?.message ?? e) })
        }
      })
    } catch (e) {
      finish({ ok: false, error: '准备子进程失败: ' + String(e?.message ?? e) })
    }
  })
}

/** 语义化封装：摘要 / 取材 / 两者一起 / 批量索引。 */
export const sessionDigestRemote = (file, header, opts) => runSessionChild({ kind: 'digest', file, header, opts })
export const sessionTranscriptRemote = (file, header, opts) => runSessionChild({ kind: 'transcript', file, header, opts })
export const sessionBothRemote = (file, header, opts) => runSessionChild({ kind: 'both', file, header, opts })
export const sessionIndexRemote = (items, opts) => runSessionChild({ kind: 'index', items }, opts)
