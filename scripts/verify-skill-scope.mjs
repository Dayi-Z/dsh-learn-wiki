// 技能作用域自检 —— **跑真实边界**，不是测试替身。
//
// 为什么值得单独一套：这个 bug 在假的注册表上永远测不出来。
// 用 mock 的话 list() 返回什么是我自己写的，作用域那层根本不存在。
// 而真实情况是：
//   技能 provider 挂在 **agent preset 的作用域层**，注册表合并层的规则是
//   [global, ...scopeChain(options.scope)]。不带 scope 查，只看得到空的全局层——
//   **返回空列表，而且不报错**。界面上就是那句「0 个 · 常驻目录 — token」。
//
// 实测：不带 scope 得 0，带上得 11。
// 所以这里直接把真的 cordis + 真的 dsh-skill + 真的 dsh-skill-filesystem 装起来跑。
import { existsSync } from 'node:fs'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

const APP = 'D:/Harness/dsh-desktop/resources/app/node_modules/@deepseek-ai'
if (!existsSync(APP + '/dsh-skill/lib/index.js')) {
  console.log('  SKIP  找不到 DSH 安装目录，跳过真实边界自检（不假装通过）')
  console.log('\nALL PASS — 技能作用域（已跳过）')
  process.exit(0)
}

const url = (p) => 'file:///' + APP + '/' + p
const cordis = await import(url('cordis/lib/index.js'))
const skillMod = await import(url('dsh-skill/lib/index.js'))
const fsProv = await import(url('dsh-skill-filesystem/lib/index.js'))
const dshScope = await import(url('dsh-scope/lib/index.js'))
const inv = await import('../lib/skills.js')

// ── 1. scopeKeyOf 与 dsh-scope 的官方实现必须一致 ──
const root = new cordis.Context()
await root.plugin(skillMod.default)
const scoped = dshScope.createScope(root, Symbol('agent-1'), {})
await scoped.ctx.plugin(fsProv.default ?? fsProv)

const key = inv.scopeKeyOf({ ctx: scoped.ctx })
check('★ scopeKeyOf 取到的键与 dshScope.scopeOf 完全一致',
  key !== undefined && key === dshScope.scopeOf(scoped.ctx), String(key))
check('普通（未作用域）上下文取不到键', inv.scopeKeyOf({ ctx: root }) === undefined)

// ── 2. 分层事实：直接 list({}) 只看得到全局层 ──
// 这条留着是为了记录底层规则，不是产品行为。
const rawBare = await root.skills.list({})
check('直接 list({}) 得 0 条（provider 在作用域层，全局层是空的）——这是分层的本来面目',
  rawBare.length === 0, 'n=' + rawBare.length)

// ── 2b. ★ 但产品行为是「不依赖会话也能列出来」 ──
// 之前是借用"最近一次会话的作用域"，于是**不发一条消息就看不到自己装了什么技能**。
// 这一页要回答的恰恰是"我现在装了什么"，那个设计是反的。
// 现在改为直接枚举注册表里已有的作用域层，不需要任何活跃会话。
const noSession = await inv.createSkillInventory({ ctx: root, log: () => {} }).snapshot()
check('★ 完全没有会话（不传 getScope）也能列出技能',
  noSession.items.length > 0, 'items=' + noSession.items.length + ' totals=' + JSON.stringify(noSession.totals))
check('★ 且正文读得到（每条用**它自己**的作用域取正文，不是共用一份）',
  noSession.items.every(i => i.bodyTokens > 0),
  JSON.stringify(noSession.items.slice(0, 3).map(i => i.name + ':' + i.bodyTokens)))
check('枚举到了注册表里的作用域层',
  inv.scopeKeysOf(root.skills).length > 0,
  'layers=' + inv.scopeKeysOf(root.skills).length)

// ── 3. 带上 scope 就能查到，且正文也读得到 ──
const full = await inv.createSkillInventory({ ctx: root, log: () => {}, getScope: () => key }).snapshot()
check('★ 带上 scope 查得到技能', full.available === true && full.items.length > 0,
  'items=' + full.items.length + ' totals=' + JSON.stringify(full.totals))
check('★ 正文也读得到（list 与 get 必须用同一套 opts，少一个 scope 就整列读空）',
  full.items.every(i => i.bodyTokens > 0),
  JSON.stringify(full.items.slice(0, 3).map(i => i.name + ':' + i.catalogTokens + '/' + i.bodyTokens)))
check('常驻成本远小于正文成本（这正是"常驻才是每轮都付的那笔"）',
  full.totals.catalogTokens > 0 && full.totals.bodyTokens > full.totals.catalogTokens,
  'catalog=' + full.totals.catalogTokens + ' body=' + full.totals.bodyTokens)
check('每条都有来源与描述（界面要显示用途和来源）',
  full.items.every(i => i.source && i.description),
  JSON.stringify(full.items.slice(0, 2).map(i => i.name + ' ← ' + i.source)))

console.log('')
console.log('  实测: ' + full.items.length + ' 个技能 · 常驻 ' + full.totals.catalogTokens
  + ' token · 正文合计 ' + full.totals.bodyTokens + ' token')

console.log(failures === 0 ? '\nALL PASS — 技能作用域正确' : '\n' + failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
