/**
 * 界面快照：把**真实的组件树**渲染成 HTML，再用无头 Chrome 截成 PNG。
 *
 * ★ 先读这一条：PNG 只有**看得见图**的模型（或人）能消费。
 *   如果当前模型不接受图像输入（read_image 会直接拒绝），这个脚本的产出对
 *   它毫无用处 —— 那种情况下请用 **scripts/ui-probe.mjs**，它把同一份页面
 *   用真实浏览器排版量成**文本**（列宽、行高、滚动长度、哪些文字被截断）。
 *
 * 它是什么、不是什么（不许含糊）：
 *   · **是**真 React、真组件树、真 CSS 类名、真布局结构，
 *     配色取自 DSW 真实的 token 契约。
 *   · **不是** DSH 真原语的渲染结果。Pill / Button / StateDot / MarkdownText /
 *     图标全部是**替身**（见 scripts/lib/ui-harness.mjs）。所以：
 *       组件内部控件的确切外观**不代表真实应用**。
 *       结构、密度、分组、行数、对齐意图是可信的。
 *   · 数据是夹具。想看真实数据：把 /learn-wiki/api/state 的响应存成 JSON，
 *     用 --state 传进来。
 *
 * 用法：
 *   node scripts/ui-snapshot.mjs                    # 四个视图全截
 *   node scripts/ui-snapshot.mjs --only knowledge
 *   node scripts/ui-snapshot.mjs --state state.json --out .snapshots
 *   node scripts/ui-snapshot.mjs --no-png           # 只写 HTML
 */
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'
import { loadHarness, makeState, PLUGIN_ROOT } from './lib/ui-harness.mjs'
import { buildDocument, loadTokens, VIEWS } from './lib/ui-preview.mjs'

const argv = process.argv.slice(2)
const argOf = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null }
const only = argOf('--only')
const outDir = argOf('--out') || join(PLUGIN_ROOT, '.snapshots')
const statePath = argOf('--state')
const noPng = argv.includes('--no-png')
const mode = argOf('--mode') || 'dark'

const H = await loadHarness()
const M = H.build(true)
const state = statePath ? JSON.parse(await readFile(statePath, 'utf8')) : makeState()
const { css: tokens, note: tokenNote } = await loadTokens(mode)

function findBrowser() {
  const cands = [
    process.env.DSH_SNAPSHOT_BROWSER,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean)
  for (const c of cands) if (existsSync(c)) return c
  const cache = join(process.env.LOCALAPPDATA || '', 'ms-playwright')
  if (existsSync(cache)) {
    try {
      for (const d of readdirSync(cache)) {
        if (!d.startsWith('chromium')) continue
        const exe = join(cache, d, 'chrome-win', 'chrome.exe')
        if (existsSync(exe)) return exe
      }
    } catch { /* 找不到就算了 */ }
  }
  return null
}

function shot(browser, htmlPath, pngPath) {
  const profile = join(outDir, '.chrome-profile')
  return new Promise((resolve) => {
    execFile(browser, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      '--no-default-browser-check', '--force-device-scale-factor=1',
      '--user-data-dir=' + profile, '--window-size=1120,980',
      '--screenshot=' + pngPath, pathToFileURL(htmlPath).href,
    ], { timeout: 60000, windowsHide: true }, (err) => {
      resolve({ ok: existsSync(pngPath), err: err ? String(err.message || err) : null })
    })
  })
}

await mkdir(outDir, { recursive: true })
const picked = only ? VIEWS.filter((v) => v.id === only || v.tab === only) : VIEWS
if (picked.length === 0) {
  console.log('没有匹配的视图。可选：' + VIEWS.map((v) => v.id).join(', '))
  process.exit(1)
}

const browser = noPng ? null : findBrowser()
console.log('输出目录：' + outDir)
console.log('浏览器：' + (browser || '（没找到，只写 HTML）'))
console.log('数据：' + (statePath || '内置夹具 makeState()'))
console.log('')

for (const view of picked) {
  const markup = H.renderToStaticMarkup(H.h(M.__components.Workbench, {
    state, initialTab: view.tab, initialSeg: view.seg, onClose: () => {},
  }))
  const htmlPath = join(outDir, view.id + '.html')
  const pngPath = join(outDir, view.id + '.png')
  await writeFile(htmlPath, buildDocument({ view, markup, pluginCss: M.__css, tokens, tokenNote, mode }), 'utf8')
  let line = '  ' + view.id.padEnd(22) + 'html ' + htmlPath
  if (browser) {
    const r = await shot(browser, htmlPath, pngPath)
    line += r.ok
      ? '\n' + ' '.repeat(24) + 'png  ' + pngPath
      : '\n' + ' '.repeat(24) + 'PNG 失败：' + r.err
  }
  console.log(line)
}
try { await rm(join(outDir, '.chrome-profile'), { recursive: true, force: true }) } catch {}

console.log('')
console.log('提醒：这些图**不是**真实应用的截图。原语是替身，数据是夹具。')
console.log('      模型读不了图的话，改用：node scripts/ui-probe.mjs')
