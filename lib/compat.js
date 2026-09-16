// 宿主兼容性：rc 阶段「双版本回退」的判据与报告。
//
// ── 为什么需要（一个实测发现）──
//
// 实测（2026-09-11）：
//   插件自带 node_modules/@deepseek-ai/dsh-tools@**0.1.0-rc.8**
//   宿主应用跑的是                          @0.1.0-rc.12
//   从 lib/tools.js 出发 require.resolve 解析到的是**插件自带的那份**。
//
// 也就是说同一个进程里同时存在两份 dsh-tools / dsh-llm。它现在能跑通，
// 但那不是设计，是运气 —— rc 阶段任何一次内部形状变化都可能让它悄悄失效，
// 而且**不会有任何报错**：defineTool 照样返回一个对象，宿主照样注册它，
// 只是某一天某个字段的语义变了。
//
// ── 这个模块做什么、不做什么 ──
//
// 做：把"插件以为的版本"和"宿主实际的版本"摆在一起，逐条核对插件真正
//     用到的宿主 API 还在不在，并在越界时明说。
// 不做：不自动切换实现。没有证据表明两份实现有行为差异，
//     为想象中的差异写兼容层，只会让代码多一条没人走过、也没人敢删的路径。
//
// ── 判据 ──
//
// 版本范围用自写的比较器（不引依赖）：能比 prerelease，且是**数字比较**。
// 字符串比较会把 rc.12 判成小于 rc.8 —— 那正是这类检查最容易出的错。

import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'

const RC = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

/** 解析成可比较的形状。解析不了返回 null —— **不猜**。 */
export function parseVersion(v) {
  const m = String(v ?? '').trim().match(RC)
  if (!m) return null
  return {
    major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]),
    pre: m[4] ? m[4].split('.') : null,
  }
}

/** 比 prerelease 段：数字段按数字比，其余按字符串；数字 < 非数字（semver 规矩）。 */
function cmpPre(a, b) {
  if (a === null && b === null) return 0
  if (a === null) return 1      // 正式版 > 预发布版
  if (b === null) return -1
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y)
    if (nx && ny) { const d = Number(x) - Number(y); if (d) return d < 0 ? -1 : 1; continue }
    if (nx !== ny) return nx ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

export function compareVersions(a, b) {
  const A = parseVersion(a), B = parseVersion(b)
  if (!A || !B) return null
  for (const k of ['major', 'minor', 'patch']) if (A[k] !== B[k]) return A[k] < B[k] ? -1 : 1
  return cmpPre(A.pre, B.pre)
}

/**
 * 极简 semver 范围：只支持空格分隔的合取（`>=0.1.0-rc.6 <0.2.0`）。
 * 不支持 `||` / `^` / `~` —— 遇到了返回 null（"判不了"），
 * 而不是**猜一个答案**。判不了比判错好。
 */
export function satisfies(version, range) {
  const v = parseVersion(version)
  if (!v) return null
  const parts = String(range ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return null
  for (const p of parts) {
    const m = p.match(/^(>=|<=|>|<|=)?(.+)$/)
    if (!m) return null
    const op = m[1] || '='
    const c = compareVersions(version, m[2])
    if (c === null) return null
    if (op === '>=' && c < 0) return false
    if (op === '<=' && c > 0) return false
    if (op === '>' && c <= 0) return false
    if (op === '<' && c >= 0) return false
    if (op === '=' && c !== 0) return false
  }
  return true
}

/**
 * 插件真正依赖的宿主 API。
 *
 * ★ 这份清单是**手写的**，因为它不可能自动推导 —— 它记录的是"我们在哪些地方
 *   依赖了宿主的形状"。rc 升级时版本号对得上不代表这些还在。
 *   每加一处宿主调用，就该来这里加一行。
 */
/** 我们要盯的两个宿主模块。列表短是故意的 —— 只盯真正 import 过的。 */
export const WATCHED = ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-llm']

/** 宿主 app 的 package.json 可能在哪。打包后的 Electron 应用是第一种形状。 */
export function hostCandidates(execPath) {
  if (!execPath) return []
  const dir = dirname(String(execPath))
  return [
    join(dir, 'resources', 'app', 'package.json'),          // Windows / Linux 打包形状
    join(dir, '..', 'Resources', 'app', 'package.json'),    // macOS 形状
  ]
}

/**
 * 读宿主实际在跑的版本。**读不到就说读不到**，不编。
 *
 * @param candidates 显式给路径（测试用；不给就从 execPath 推）
 * @param read       注入的读取函数（测试用）
 */
export async function readHostVersions({ execPath = process.execPath, candidates = null, read = readFile } = {}) {
  const list = candidates ?? hostCandidates(execPath)
  for (const p of list) {
    let pkg = null
    try { pkg = JSON.parse(await read(p, 'utf8')) } catch { continue }
    const out = { app: pkg?.version ?? null, path: p }
    for (const name of WATCHED) {
      try {
        const sp = join(dirname(p), 'node_modules', name, 'package.json')
        out[name] = JSON.parse(await read(sp, 'utf8'))?.version ?? null
      } catch { out[name] = null }
    }
    return out
  }
  return { app: null, path: null }
}

/**
 * 读**插件自己解析到的**版本 —— 这才是 import 真正会加载的那一份。
 *
 * 实测（2026-09-11）：从 lib/tools.js 出发解析到的是**插件自带的 rc.8**，
 * 而宿主跑 rc.12。所以"插件以为的版本"和"宿主实际的版本"是两个不同的数，
 * 必须分开报，否则这份报告只会让人更糊涂。
 */
export function readPluginVersions(req = createRequire(import.meta.url)) {
  const out = {}
  for (const name of WATCHED) {
    try { out[name] = req(name + '/package.json')?.version ?? null } catch { out[name] = null }
  }
  return out
}

export const REQUIRED_APIS = [
  // ★ 可选项也在这里，但**必须分桶报**（optionalMissing）：混进 missing 会让人
  //   误判严重性，而一份夸大缺失的报告会训练人忽略它 —— 真正缺东西那天就没人看了。
  //
  // sessionQuery 是这一轮新加进来的观察项（宿主 0.1.5-rc.2 起有
  // @deepseek-ai/dsh-session-query + -sqlite，SQLite FTS5）。**本插件目前不依赖它**
  // ——但它正是"会话文件改个名就把历史读丢"这类故障的正解（那件事故见
  // lib/session-store.js 顶部的注释）。所以把它摆进报告，等哪天真接了，
  // 这份清单已经在看着它了。
  { path: 'sessionQuery', kind: 'service', why: '宿主原生的会话查询服务（本插件尚未依赖，作为观察项）', optional: true },
  { path: 'tools.register', kind: 'fn', why: '注册 11 个工具' },
  { path: 'tools.schemas', kind: 'fn', why: '读工具目录（能力包与技能表）' },
  { path: 'tools.restrict', kind: 'fn', why: '能力包的 deny 掩码（agent 作用域）', scope: 'agent' },
  { path: 'llm', kind: 'service', why: 'L3 蒸馏与 wiki_harvest' },
  { path: 'web.search', kind: 'fn', why: '联网补料' },
  { path: 'webServer.register', kind: 'fn', why: 'UI 数据路由' },
  { path: 'skills', kind: 'service', why: '技能盘点（不可用时如实报告，不静默）', optional: true },
  { path: 'agent.inject', kind: 'fn', why: '挣扎时把补料投回当前轮', scope: 'agent', optional: true },
]

function dig(obj, path) {
  let cur = obj
  for (const k of String(path).split('.')) {
    if (cur === null || cur === undefined) return undefined
    cur = cur[k]
  }
  return cur
}

/**
 * 逐条核对宿主 API。返回 { present, missing, optionalMissing }。
 *
 * ★ 判据分两种，第一版只按"必须是函数"判，于是把 ctx.llm 与 ctx.skills
 *   报成了缺失 —— 而它们是**服务对象**（llm.listProviders / skills.snapshot），
 *   本来就不是函数。一份把存在的东西报成缺失的报告，比没有报告更糟：
 *   它会训练人忽略这个警告，那真正缺东西的那天就没人看了。
 */
export function checkHostApis(ctxLike) {
  const present = []
  const missing = []
  const optionalMissing = []
  for (const req of REQUIRED_APIS) {
    const v = dig(ctxLike, req.path)
    const has = req.kind === 'service'
      ? (v !== undefined && v !== null)
      : typeof v === 'function'
    if (has) present.push(req.path)
    else if (req.optional) optionalMissing.push(req)
    else missing.push(req)
  }
  return { present, missing, optionalMissing }
}

/**
 * 组装一份兼容性报告。**只报告，不改行为**。
 *
 * @param pluginVersion 插件自己声明的宿主依赖版本（读它 node_modules 里那份）
 * @param hostVersion   宿主实际在跑的版本
 * @param range         插件声明的可接受范围（peerDependencies）
 */
export function compatReport({ pluginVersions = {}, hostVersions = {}, range = null, apis = null, pluginVersionNote = '' } = {}) {
  const rows = []
  // 只遍历**模块名**。第一版遍历了 hostVersions 的所有键，于是 app / path
  // 这两个非模块字段被当成"版本对不上"列进了报告 —— 一份自己制造噪音的报告
  // 比没有报告更糟，因为它会训练人忽略它。
  const names = [...new Set([...WATCHED, ...Object.keys(pluginVersions), ...Object.keys(hostVersions)])]
    .filter(n => !n.startsWith('__') && n !== 'app' && n !== 'path')
  for (const name of names) {
    const pv = pluginVersions[name] ?? null
    const hv = hostVersions[name] ?? null
    let verdict = 'unknown'
    if (pv && hv) {
      const c = compareVersions(pv, hv)
      verdict = c === 0 ? 'same' : 'differs'
    }
    rows.push({ name, plugin: pv, host: hv, verdict })
  }
  const differs = rows.filter(r => r.verdict === 'differs')
  // ★ 两个范围判定，含义不同，都要报 —— 第一版只判了前者，于是"宿主越界"
  //   （rc 阶段真正会咬人的那种）根本看不见。
  //     inRange     ：插件**实际加载**的那份在不在范围内（我们有没有自带一份越界的）
  //     hostInRange ：宿主在跑的那份在不在范围内（宿主有没有往前走过头）
  const pluginSubject = pluginVersions['@deepseek-ai/dsh-tools']
  const hostSubject = hostVersions['@deepseek-ai/dsh-tools']
  const inRange = (range && pluginSubject) ? satisfies(pluginSubject, range) : null
  const hostInRange = (range && hostSubject) ? satisfies(hostSubject, range) : null

  const lines = []
  lines.push('插件自带 vs 宿主实际：')
  for (const r of rows) lines.push('  ' + r.name + '  插件 ' + (r.plugin ?? '?') + ' / 宿主 ' + (r.host ?? '?') + '  ' + (r.verdict === 'same' ? '一致' : r.verdict === 'differs' ? '★ 不一致' : '未知'))
  if (range) {
    lines.push('声明范围 ' + range
      + '　插件自带那份：' + (inRange === null ? '判不了' : inRange ? '在范围内' : '★ 超出范围')
      + '　宿主那份：' + (hostInRange === null ? '判不了' : hostInRange ? '在范围内' : '★ 超出范围'))
  }
  if (apis) {
    lines.push('宿主 API 核对：' + apis.present.length + ' 项在' + (apis.missing.length ? '，★ 缺 ' + apis.missing.map(m => m.path).join(', ') : '')
      + (apis.optionalMissing.length ? '，可选缺 ' + apis.optionalMissing.map(m => m.path).join(',') : ''))
  }
  if (pluginVersionNote) lines.push(pluginVersionNote)

  return { rows, differs, inRange, hostInRange, apis, lines, rendered: lines.join('\n') }
}
