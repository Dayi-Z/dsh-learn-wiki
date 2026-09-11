// 客户端引用自检：**引用的每个 DSH 变量都必须真实存在**。
//
// 为什么值得单独一条测试：这个 bug 已经犯过一次而且完全静默——
// 旧客户端用了 --dsw-alias-bg-hover / -border / -bg-elevated / -text 四个
// **根本不存在的变量**，因为每个都带回了退避色，所以既没报错也没生效，
// 只是悄悄地永远显示成硬编码色，和 DSH 主题脱节。肉眼看不出，日志里也没有。
//
// 这里做的是最朴素也最有效的事：把 DSH 前端 CSS 里真实定义过的变量集合提取出来，
// 再逐个核对客户端用到的名字。名字错了就红。
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

const CLIENT = new URL('../client/client.js', import.meta.url)

// DSH 安装位置不固定；找不到就跳过，而不是假装通过。
const CANDIDATES = [
  'D:/Harness/dsh-desktop/resources/app/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets',
  join(process.env.APPDATA || '', '..', 'Local', 'Programs', 'dsh-desktop', 'resources', 'app', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets'),
].filter(Boolean)

let cssDir = null
for (const d of CANDIDATES) if (existsSync(d)) { cssDir = d; break }

if (!cssDir) {
  console.log('  SKIP  找不到 DSH 前端资源目录，跳过变量核对（不假装通过）')
  console.log('\nALL PASS — 客户端变量核对（已跳过）')
  process.exit(0)
}

const client = await readFile(CLIENT, 'utf8')

// ── 收集 DSH 真实定义过的变量 ──
const { readdir } = await import('node:fs/promises')
const files = (await readdir(cssDir)).filter(f => f.endsWith('.css'))
let defined = new Set()
for (const f of files) {
  const css = await readFile(join(cssDir, f), 'utf8')
  // 只看**定义**（--x: value），不看引用
  const re = /(--(?:dsw|ds)-[a-z0-9-]+)\s*:/g
  let m
  while ((m = re.exec(css))) defined.add(m[1])
}
check('提取到 DSH 主题变量集合', defined.size > 50, 'n=' + defined.size)

// ── 收集客户端引用的变量（排除插件自定义的 --lw-* 本地变量）──
const referenced = new Set()
const reRef = /var\(\s*(--[a-z0-9-]+)/g
let mm
while ((mm = reRef.exec(client))) {
  const name = mm[1]
  if (name.startsWith('--lw-')) continue      // 插件自己的局部变量
  if (name.startsWith('--dsw-') || name.startsWith('--ds-')) referenced.add(name)
}
check('客户端确实引用了 DSH 变量', referenced.size > 10, 'n=' + referenced.size)

const missing = [...referenced].filter(n => !defined.has(n)).sort()
check('★ 客户端引用的每个 DSH 变量都真实存在（不存在会因为回退色而静默失效）',
  missing.length === 0, missing.length ? '不存在的: ' + missing.join(', ') : '全部 ' + referenced.size + ' 个已核对')

// ── 字号不许手写 ──
// 手写 px 的结果就是 11/11.5/12/12.5/13 混在一个面板里；统一走 --dsw-font-* 阶梯。
const hardcoded = [...client.matchAll(/font-size:\s*([\d.]+)px/g)].map(x => x[0])
check('★ 没有手写的 font-size（统一走 DSH 字体阶梯）',
  hardcoded.length === 0, hardcoded.slice(0, 6).join(' , '))

// ── 面板宽度不能被原语的 Modal 尺寸绑架 ──
check('★ 没有使用 DSH 的 Modal 原语（它写死 380px，装不下宽面板）',
  !/P\.Modal|\bModal\b\s*[,)]/.test(client.replace(/\/\*[\s\S]*?\*\//g, '')),
  '面板应自绘遮罩')

// ── 工具表的排序不得依赖勾选状态 ──
//
// 实测踩到：上一版把"裁掉的"排到最前面，于是点一下方框，这一行就从指针底下
// 消失了——点错了都找不回来。顺序必须只由**不随交互变化**的字段决定。
//
// 这里做的是源码级检查：排序比较函数里不许出现 denied。
// 弱，但它卡的正是这个回归，而且是这个文件里唯一能卡住它的地方。
//
// ★ 锚点必须是**结构**，不能是缩进。
//   原来用 "\n        })"（八个空格）当结束锚，因为比较函数当时嵌在
//   useMemo 回调里，正好是那个缩进。后来把排序提取成顶层纯函数
//   toolGroups()，缩进变成六个空格 —— 锚点就再也匹配不上了，
//   非贪婪匹配一路吞到后面某个八空格 }) 才停，把无关代码里的 denied
//   圈了进来，于是这条断言**红在了和它要防的东西毫无关系的地方**。
//   现在锚在比较函数的最后一行（return a.name ...），那一行是它的语义终点。
const sortBlock = (client.match(/\.sort\(function \(a, b\) \{[\s\S]*?return a\.name[^\n]*\n\s*\}\)/) || [''])[0]
check('★ 找得到工具表的排序比较函数', sortBlock.length > 0, sortBlock.slice(0, 60).replace(/\n/g, ' '))
// 窗口不许膨胀：如果哪天锚点又失配、吞掉半张文件，这条先红，
// 免得下面两条断言在"读了太多代码"的情况下给出一个假的通过。
check('★ 抓到的窗口确实是"一个比较函数"而不是半张文件', sortBlock.length > 0 && sortBlock.length < 700,
  'len=' + sortBlock.length)
check('★ 工具排序不依赖勾选状态（否则行会在你点它的时候跑掉）',
  sortBlock.length > 0 && !/denied/.test(sortBlock),
  /denied/.test(sortBlock) ? '比较函数里出现了 denied —— 顺序会随勾选变化' : '只按 family / name 排')
check('工具排序有确定的键（族 → 名字）',
  /family/.test(sortBlock) && /name/.test(sortBlock), sortBlock.slice(0, 120).replace(/\n/g, ' '))

console.log(failures === 0 ? '\nALL PASS — 客户端引用正确' : '\n' + failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
