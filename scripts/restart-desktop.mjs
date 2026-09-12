/**
 * 重启 DSH 桌面 app —— 让**宿主半**的改动真正生效。
 *
 * ── 为什么需要这个脚本 ──
 *
 * 实测（2026-09-12）：回收渲染器进程（触发主进程的 render-process-gone → 重载外壳）
 * 只能让**浏览器半**更新 —— 客户端模块是渲染器每次重新拉的，所以 FooterEntry、
 * 面板这些改动一重载就生效。
 *
 * 但**宿主半不会**。回收渲染器之后插件确实会重新 apply（日志里有
 * "ui: /learn-wiki 已注册…"），可是服务请求的那张路由表仍然是**更早那次 apply**
 * 的：新加的路由打过去一律 404，而且返回的是插件自己那句 "not found"，
 * 看起来像"路由写错了"，其实是"根本没走到新 handler"。
 *
 * 证据（同一天、同一份代码）：
 *   · 桌面 app 里 GET /learn-wiki/api/models -> 404（body 是插件自己的 not found）
 *   · 用 `dsh web --port 3099` 起一个真宿主    -> 200，6 个 provider / 29 个模型
 *   代码没问题，是桌面 app 在跑旧的宿主代码。
 *
 * 所以：**宿主半（index.js / lib/**.js）改完必须整 app 重启**；
 * 只想让界面变化生效，回收渲染器就够了。
 *
 * ── 用法 ──
 *   node scripts/restart-desktop.mjs                  立即重启
 *   node scripts/restart-desktop.mjs --delay 25000    延迟 25 秒再动手（让当前这轮先答复完）
 *   node scripts/restart-desktop.mjs --check          只看现状，不重启
 *
 * 结果追加到 <wikiRoot>/.learn-wiki.log —— 重启失败也留得下证据。
 */
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'

const argv = process.argv.slice(2)
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? (argv[i + 1] ?? d) : d }
const EXE = argOf('--exe', 'D:\\Harness\\dsh-desktop\\dsh-desktop.exe')
const LOG = argOf('--log', 'D:\\Harness\\dsh-wiki\\.learn-wiki.log')
const delayMs = Math.max(0, Number(argOf('--delay', '0')) || 0)
const checkOnly = argv.includes('--check')

const say = (m) => {
  const line = '[' + new Date().toISOString() + '] restart-desktop: ' + m
  console.log(line)
  try { appendFileSync(LOG, line + '\n', 'utf8') } catch { /* 日志写不进去不该挡住重启 */ }
}

/**
 * 找一个能用的 PowerShell。
 *
 * ★ 不能用裸 'pwsh'：它**不在** PATH 上（实测 spawnSync ENOENT，连交互式会话里
 *   Get-Command pwsh 都找不到）。系统自带的 Windows PowerShell 才是稳的那个。
 */
const SHELLS = [
  process.env.DSH_RESTART_SHELL,
  'C:\\windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  'powershell.exe',
].filter(Boolean)

function runPs(script) {
  let lastErr
  for (const sh of SHELLS) {
    try { return execFileSync(sh, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }) }
    catch (e) { lastErr = e }
  }
  throw lastErr ?? new Error('没有可用的 PowerShell')
}

/**
 * 主进程 = 命令行里没有 --type= 的那个（渲染器/GPU/utility 都带 --type=）。
 * 两句之间**必须带换行**：早先写成 join('') 把它们粘成了
 * `"SilentlyContinue"Get-CimInstance`，于是永远返回空列表。
 */
function mainProcs() {
  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    "Get-CimInstance Win32_Process -Filter \"Name='dsh-desktop.exe'\" | Where-Object { $_.CommandLine -notmatch '--type=' } | Select-Object -ExpandProperty ProcessId",
  ].join('\n')
  try {
    return runPs(script).split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(Number).filter(Number.isFinite)
  } catch (e) {
    say('列举进程失败：' + (e?.message ?? e))
    return []
  }
}

const before = mainProcs()
say('当前主进程: ' + (before.join(',') || '(无)'))
if (checkOnly) process.exit(0)
if (before.length === 0) { say('没有在跑的桌面 app，无事可做'); process.exit(0) }
if (!existsSync(EXE)) { say('找不到可执行文件 ' + EXE + '，放弃'); process.exit(1) }

if (delayMs > 0) {
  say('延迟 ' + delayMs + 'ms 后重启（让当前这一轮先把答复发出去）')
  await new Promise(r => setTimeout(r, delayMs))
}

for (const pid of before) {
  try { runPs('Stop-Process -Id ' + pid + ' -Force') } catch { /* 可能已经退了 */ }
}
say('已结束主进程 ' + before.join(','))

// 等它真的退干净：Electron 的渲染器 / GPU 子进程要跟着走。
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 500))
  if (mainProcs().length === 0) break
}
const leftover = mainProcs()
if (leftover.length) say('⚠ 主进程没退干净，仍在: ' + leftover.join(','))

const child = spawn(EXE, [], { detached: true, stdio: 'ignore' })
child.unref()
say('已重新拉起 ' + EXE + '（pid ' + child.pid + '）')

// 起来要时间（boot 整个 profile）。等一会儿确认它活着。
for (let i = 0; i < 60; i++) {
  await new Promise(r => setTimeout(r, 500))
  const now = mainProcs()
  if (now.length) { say('✔ 新主进程 pid ' + now.join(',') + ' 已就绪'); process.exit(0) }
}
say('✖ 等不到新的主进程 —— 桌面 app 可能没起来，请手动启动 ' + EXE)
process.exit(1)
