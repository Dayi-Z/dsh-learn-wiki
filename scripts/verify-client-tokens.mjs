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

// ── DSH 应用在哪 ──
//
// ★ 这里踩过一次，值得写下来：候选路径原先写的是
//     D:/Harness/dsh-desktop/resources/app/...
//   而应用实际装在
//     D:/Harness/dsh-desktop/DSH Desktop/resources/app/...
//   —— 中间那个**带空格的子目录**。于是 existsSync 全部为假，脚本打了
//   "SKIP 找不到…（不假装通过）" 就退出了。诚实，但**等于这条核对从来没跑过**，
//   而它本来是唯一能挡住"引用了不存在的 token"的闸门；
//   上一次真出这个 bug 时，它就是这么静默失效过去的。
//
//   所以现在做两件事：候选路径带上真实形状；并且**扫不到就红**（见下面
//   "决定性"那几条）—— 一条永远 SKIP 的检查等于没有检查。
const APP_CANDIDATES = [
  'D:/Harness/dsh-desktop/DSH Desktop/resources/app',
  'D:/Harness/dsh-desktop/resources/app',
  join(process.env.APPDATA || '', '..', 'Local', 'Programs', 'dsh-desktop', 'resources', 'app'),
  join(process.env.APPDATA || '', '..', 'Local', 'Programs', 'DSH Desktop', 'resources', 'app'),
].filter(Boolean)

let aiDir = null       // .../resources/app/node_modules/@deepseek-ai
for (const a of APP_CANDIDATES) {
  const d = join(a, 'node_modules', '@deepseek-ai')
  if (existsSync(d)) { aiDir = d; break }
}

const { readdir } = await import('node:fs/promises')
const client = await readFile(CLIENT, 'utf8')

/**
 * 收集 DSH 真实定义过的主题变量。
 *
 * ★ 扫描范围是 **client 插件包**，不是前端 dist 里的 .css。
 *   实测（2026-09-16）：--dsw-* 这一族在前端 dist 的 CSS 里**一个都没有**
 *   （那里只有 --dsh-boot-* 等启动期变量），它们定义在
 *   dsh-client-ui-+ / lib/client.js 的内联样式里。旧版只扫 CSS，
 *   于是"提取到 2 个变量"然后判客户端引用的 33 个全部不存在 —— 一个假红，
 *   而且它红得很有说服力（看起来像客户端引用了不存在的 token）。
 *   这次把定义域换成真正的定义处，判据才站得住。
 */
async function collectDefinedTokens(dir) {
  const defined = new Set()
  let scanned = 0
  const walk = async (d, depth) => {
    if (depth > 3) return
    let es
    try { es = await readdir(d, { withFileTypes: true }) } catch { return }
    for (const e of es) {
      const p = join(d, e.name)
      if (e.isDirectory()) {
        // dist/assets/types 里没有定义，只有拷贝
        if (['node_modules', 'dist', 'assets', 'types'].includes(e.name)) continue
        await walk(p, depth + 1)
      } else if (/\.(js|css)$/.test(e.name)) {
        let t = ''
        try { t = await readFile(p, 'utf8') } catch { continue }
        scanned++
        // 只看**定义**（--x: value），不看引用
        for (const m of t.matchAll(/--(?:dsw|dsh|ds)-[A-Za-z0-9-]+\s*:/g)) {
          defined.add(m[0].replace(/\s*:$/, ''))
        }
      }
    }
  }
  await walk(dir, 0)
  return { defined, scanned }
}

let defined = new Set()
let scannedFiles = 0
if (aiDir) {
  const pkgs = (await readdir(aiDir, { withFileTypes: true }))
    .filter(e => e.isDirectory() && (e.name.startsWith('dsh-client-') || e.name.startsWith('dsh-web-')))
    .map(e => e.name)
  for (const p of pkgs) {
    const r = await collectDefinedTokens(join(aiDir, p))
    for (const n of r.defined) defined.add(n)
    scannedFiles += r.scanned
  }
}

// ★ "查不了"不许变成"没问题"。找不到应用就**红**，不再 SKIP ——
//   这条检查的价值全在"它真的跑过"，跳过它等于把上一次那个 bug 的闸门焊死。
check('★ 找得到 DSH 应用目录（找不到就是这条核对没跑，而不是没问题）',
  !!aiDir, aiDir ?? ('试过: ' + APP_CANDIDATES.join(' | ')))
check('提取到 DSH 主题变量集合', defined.size > 50, 'n=' + defined.size + '（扫了 ' + scannedFiles + ' 个文件）')

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

// ── 不许自己发明配色 ──
//
// 这一条是被真实缺陷逼出来的：待办条的 primary 按钮原先写成
//   background:var(--lw-brand); color:#fff
// 结果"字体颜色与按钮同色、完全不可见" —— 因为品牌色在浅色主题下不是深色，
// 白字压上去等于没字。DSH 自己给的配对是
//   background:var(--dsw-alias-button-primary-fill)
//   color:     var(--dsw-alias-label-primary-foreground)
// 两个 token 是一对，拆开自己配就会在某个主题下翻车。
//
// 判据取"最朴素也最有效"的那条：**颜色字面量只允许出现在 var() 的回退位**。
// 出现在别处 = 自己发明了一个不跟主题走的颜色。
function stripVarFallbacks(src) {
  let out = ''
  let i = 0
  while (i < src.length) {
    const at = src.indexOf('var(', i)
    if (at < 0) { out += src.slice(i); break }
    out += src.slice(i, at)
    // 从 var( 的括号开始配对，把整段（含回退值）替换成占位符
    let depth = 0
    let j = at + 3
    for (; j < src.length; j++) {
      if (src[j] === '(') depth++
      else if (src[j] === ')') { depth--; if (depth === 0) { j++; break } }
    }
    out += 'VAR'
    i = j
  }
  return out
}

// ★ 必须**先剥注释**再扫。第一版没剥，结果抓到的"发明配色"全是我自己
//   写在注释里解释这个 bug 的那两个 #fff 字样 —— 测试红在了它要防的东西的
//   说明文字上。注意 `//` 的剥离要避开 `https://`（前面是冒号的不算注释）。
const code = client
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const bare = stripVarFallbacks(code)
const invented = [...bare.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(/g)].map(x => x[0])
check('★ 没有自己发明的颜色（字面色只允许出现在 var() 回退位里）',
  invented.length === 0,
  invented.length ? '写在回退位之外的: ' + [...new Set(invented)].slice(0, 6).join(', ') : '全部走 token')

// ── primary 的底色与字色必须成对 ──
//
// 只查"有没有用 token"还不够：用了 fill 却配一个别的字色 token 一样会不可见。
// 这里按 CSS 规则块切，块里出现 button-primary-fill 就必须同时出现
// label-primary-foreground。
const blocks = [...client.matchAll(/\{[^{}]*\}/g)].map(m => m[0]).filter(b => /background/.test(b))
const fills = blocks.filter(b => b.includes('--dsw-alias-button-primary-fill'))
check('★ 确实存在用 primary-fill 作底色的规则（否则下面那条是空转）',
  fills.length > 0, 'n=' + fills.length)
check('★ primary 底色与字色成对出现（拆开自己配会在某个主题下不可见）',
  fills.every(b => b.includes('--dsw-alias-label-primary-foreground')),
  fills.map(b => b.replace(/\s+/g, ' ').slice(0, 120)).join(' ｜ '))

// ── --dsh-* 变量（会话布局那一族）──
//
// 为什么要单独做：待办条的宽度靠 **和输入框卡片完全相同的公式** 对齐，
//   宽 = min(容器宽 - 2*side-clearance, card-max-width)
// 而这三个变量是 --dsh-* 前缀，**不在**上面的 --dsw-* 集合里（前端 dist 里
// 一个都没有，它们定义在 dsh-client-ui-conversation/lib/client.js）。
// 不查的后果是：DSH 哪天改名，条子会静默退回 780px 并悄悄和输入框错开 —
// 正是这个文件开头说的那类"因为带回退色所以一直静默失效"的故障。
// ★ 这一族与上面那族现在**共用同一个定义域**（defined 收集的就是
//   --dsw-* / --dsh-* / --ds-* 三种前缀），所以这里只需要把引用筛出来比对。
//   旧版为它单独扫一遍 dsh-client-*\lib\client.js，于是同一件事有两处实现 ——
//   而上面那次路径失配正好只坏了一处。
const dshRefs = new Set()
for (const m of client.matchAll(/var\(\s*(--dsh-[a-z0-9-]+)/g)) dshRefs.add(m[1])
const dshMissing = [...dshRefs].filter(n => !defined.has(n)).sort()
check('★ 引用的每个 --dsh-* 变量都真实存在（否则宽度会静默退回兜底值并错位）',
  dshRefs.size > 0 && dshMissing.length === 0,
  dshMissing.length ? '不存在的: ' + dshMissing.join(', ') : '全部 ' + dshRefs.size + ' 个已核对')
check('★ 待办条用输入框的宽度变量对齐（不是自己写一个 px）',
  dshRefs.has('--dsh-composer-card-max-width') && dshRefs.has('--dsh-composer-side-clearance'),
  [...dshRefs].join(', '))

console.log(failures === 0 ? '\nALL PASS — 客户端引用正确' : '\n' + failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
