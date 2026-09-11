/**
 * 界面**文本**探针：把真实浏览器排版量成文字，给读不了图的模型看。
 *
 * 为什么不是截图：截图（ui-snapshot.mjs）只有看得见图的模型或人能消费。
 * 当前这个 agent 跑的模型不接受图像输入（read_image 会直接拒绝 "does not
 * declare image input"），所以 PNG 对它等于零信息。而"界面长什么样"这件事
 * 又是必须回答的 —— 否则只能靠猜，猜出来的东西会被当成事实写进结论。
 *
 * 所以这条路把同一个页面（同一个装载台、同一份夹具、同一份 CSS）交给
 * 无头 Chrome 真排版，然后用 CDP 把**几何**取出来，翻成文本：
 *
 *   · 面板/表体/各段的真实矩形，以及"内容高 vs 可视高" → 要滚几屏
 *   · 每一列的真实像素宽度 → 表格有没有把可用宽度用掉
 *   · 每个单元格的文字有没有被 CSS 截断（scrollWidth > clientWidth）
 *   · 行高、行数、分组结构
 *
 * 它**不**告诉你颜色好不好看、圆角对不对 —— 那些它量不出来，也不会假装量了。
 * 原语依然是替身，所以控件外观依然不代表真实应用。
 *
 * 用法：
 *   node scripts/ui-probe.mjs                     # 四个视图全量
 *   node scripts/ui-probe.mjs --only knowledge
 *   node scripts/ui-probe.mjs --json out.json     # 顺便留一份原始几何
 */
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadHarness, makeState, PLUGIN_ROOT } from './lib/ui-harness.mjs'
import { buildDocument, loadTokens, VIEWS } from './lib/ui-preview.mjs'

const argv = process.argv.slice(2)
const argOf = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null }
const only = argOf('--only')
const jsonOut = argOf('--json')
const statePath = argOf('--state')
const outDir = join(PLUGIN_ROOT, '.snapshots')
const mode = argOf('--mode') || 'dark'

// ── 在页面里跑的探针。必须是自包含的 IIFE（它会被序列化后送去浏览器执行）。──
const PROBE = `(() => {
  const R = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }
  const rx = (sel) => R(document.querySelector(sel))
  const txt = (el) => (el ? String(el.textContent || '').replace(/\\s+/g, ' ').trim() : '')
  const clipped = (el) => !!el && el.scrollWidth > el.clientWidth + 1

  const body = document.querySelector('.lw-body')
  const table = document.querySelector('table.lw-table')
  const thead = table ? table.querySelector('thead tr') : null

  // 列宽：优先取表头单元格（每列一个），没有表头就退回第一行
  const colCells = thead ? Array.from(thead.children) : (table && table.querySelector('tbody tr') ? Array.from(table.querySelector('tbody tr').children) : [])

  const rows = []
  if (table) {
    for (const tr of table.querySelectorAll('tbody > tr')) {
      const r = R(tr)
      const cells = Array.from(tr.children).map((td) => ({
        w: Math.round(td.getBoundingClientRect().width),
        text: txt(td).slice(0, 60),
        clipped: clipped(td),
      }))
      rows.push({ y: r.y, h: r.h, group: tr.className.indexOf('lw-group') >= 0, cells })
    }
  }

  // 所有被截断的单元格（含表头与副行）—— 这是"信息看不全"的直接证据。
  // 空文本的元素不算：一个 20px 宽的图标按钮 scrollWidth 比 clientWidth 大 1px
  // 也会被判成"截断"，但它里面本来就没有文字，报出来只是噪音。
  const clippedCells = []
  for (const el of document.querySelectorAll('.lw-td, .lw-th, .lw-sub, .lw-sec-n, .lw-title')) {
    const t = txt(el)
    if (!t) continue
    if (clipped(el)) clippedCells.push({ cls: el.className, text: t.slice(0, 90), hidden: el.scrollWidth - el.clientWidth })
  }

  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    doc: { scrollH: document.documentElement.scrollHeight },
    panel: rx('.lw-panel'),
    head: rx('.lw-head'),
    tabs: Array.from(document.querySelectorAll('.lw-tabs [role="tab"], .lw-tabs button, .lw-tabs span.lw-chip')).map((el) => ({
      text: txt(el), active: el.getAttribute('aria-selected') === 'true', rect: R(el),
    })),
    segments: Array.from(document.querySelectorAll('.lw-seg [role="tab"]')).map((el) => ({
      text: txt(el), active: el.getAttribute('aria-selected') === 'true', rect: R(el),
    })),
    body: body ? Object.assign(R(body), {
      scrollH: body.scrollHeight, clientH: body.clientHeight,
      scrollTop: body.scrollTop,
    }) : null,
    sections: Array.from(document.querySelectorAll('.lw-sec')).map((el) => {
      const t = el.querySelector('.lw-sec-t')
      const n = el.querySelector('.lw-sec-n')
      return { title: txt(t), meta: Array.from(el.querySelectorAll('.lw-sec-n')).map(txt).join(' | '), rect: R(el) }
    }),
    table: table ? Object.assign(R(table), { rows: table.querySelectorAll('tbody > tr').length }) : null,
    columns: colCells.map((td) => ({ w: Math.round(td.getBoundingClientRect().width), text: txt(td).slice(0, 40) })),
    rows,
    clippedCells,
    notes: Array.from(document.querySelectorAll('.lw-note')).map((el) => txt(el).slice(0, 120)),
  }
})()`

// ── 无头 Chrome + CDP（不依赖 playwright；Node 自带 WebSocket）──
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
    } catch {}
  }
  return null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function withChrome(fn) {
  const browser = findBrowser()
  if (!browser) throw new Error('找不到 Chrome / Edge；用 DSH_SNAPSHOT_BROWSER 指定路径')
  const profile = join(outDir, '.probe-profile')
  await rm(profile, { recursive: true, force: true })
  const child = execFile(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--window-size=1120,980', 'about:blank',
  ], { windowsHide: true, timeout: 120000 })

  // --remote-debugging-port=0 时，真实端口写在 DevToolsActivePort 第一行
  const portFile = join(profile, 'DevToolsActivePort')
  let port = null
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(100)
    if (existsSync(portFile)) {
      try { port = Number((await readFile(portFile, 'utf8')).split(/\r?\n/)[0]) } catch {}
    }
  }
  if (!port) { try { child.kill() } catch {} ; throw new Error('Chrome 没有给出调试端口') }

  // 新建一个页面 target
  let wsUrl = null
  for (let i = 0; i < 50 && !wsUrl; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })
      const j = await res.json()
      wsUrl = j.webSocketDebuggerUrl
    } catch { await sleep(100) }
  }
  if (!wsUrl) { try { child.kill() } catch {} ; throw new Error('拿不到 CDP target') }

  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true })
  })

  let nextId = 1
  const pending = new Map()
  const events = []
  ws.addEventListener('message', (ev) => {
    let msg = null
    try { msg = JSON.parse(ev.data) } catch { return }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    } else if (msg.method) {
      events.push(msg.method)
    }
  })
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params: params || {} }))
  })

  try {
    await send('Page.enable')
    await send('Runtime.enable')
    return await fn({ send, events })
  } finally {
    try { ws.close() } catch {}
    try { child.kill() } catch {}
    await sleep(150)
    try { await rm(profile, { recursive: true, force: true }) } catch {}
  }
}

// ── 文本格式化：把几何翻成能读的东西 ──
const BAR = (n) => '█'.repeat(Math.max(0, Math.round(n)))

function fmtView(view, p) {
  const L = []
  L.push('')
  L.push('═'.repeat(96))
  L.push('视图：' + view.title + '   (' + view.id + ')')
  L.push('═'.repeat(96))

  // 概览
  const b = p.body || {}
  const overflow = b.scrollH && b.clientH ? b.scrollH - b.clientH : 0
  L.push('布局')
  L.push('  视口          ' + p.viewport.w + ' × ' + p.viewport.h)
  if (p.panel) L.push('  面板          ' + p.panel.w + ' × ' + p.panel.h + '  @ (' + p.panel.x + ',' + p.panel.y + ')')
  if (b.h) {
    L.push('  可滚动区      ' + b.w + ' × ' + b.clientH + '（内容高 ' + b.scrollH + '）')
    if (overflow > 0) {
      L.push('  ★ 需要滚动    ' + overflow + 'px ≈ ' + (b.scrollH / Math.max(1, b.clientH)).toFixed(1)
        + ' 屏 —— 这就是"太长"的量化')
    } else {
      L.push('  不需要滚动    内容全部放得下')
    }
  }

  // 页签与分段
  if (p.tabs.length) {
    L.push('')
    L.push('顶部页签      ' + p.tabs.map((t) => (t.active ? '[' + t.text + ']' : ' ' + t.text + ' ')).join('   '))
  }
  if (p.segments.length) {
    L.push('内部分段      ' + p.segments.map((t) => (t.active ? '[' + t.text + ']' : ' ' + t.text + ' ')).join('   ')
      + '   （工具/技能分段导航）')
  }

  // 各段
  if (p.sections.length) {
    L.push('')
    L.push('段（.lw-sec）')
    for (const s of p.sections) {
      L.push('  · ' + (s.title || '(无标题)').padEnd(12) + ' ' + s.rect.w + '×' + s.rect.h
        + (s.meta ? '   ' + s.meta.slice(0, 88) : ''))
    }
  }

  // 列布局
  if (p.columns.length) {
    L.push('')
    L.push('列布局（真实像素宽度）')
    let sum = 0
    p.columns.forEach((c, i) => {
      sum += c.w
      L.push('  [' + i + '] ' + String(c.w).padStart(5) + 'px  ' + (c.text || '(无表头)'))
    })
    if (b.w) {
      const slack = b.w - sum
      L.push('  合计 ' + sum + 'px / 可用 ' + b.w + 'px → 余 ' + slack + 'px'
        + (slack > 80 ? '  ★ 右侧空着 ' + slack + 'px（表格没吃满宽度）' : '（用满了）'))
    }
  }

  // 行
  if (p.rows.length) {
    L.push('')
    L.push('行（共 ' + p.rows.length + ' 行；下面前 10 行，y 为视口内纵坐标）')
    for (const r of p.rows.slice(0, 10)) {
      const tag = r.group ? '组 ' : '   '
      const cells = r.cells.map((c) => (c.clipped ? c.text + '…' : c.text))
      L.push('  y=' + String(r.y).padStart(4) + ' h=' + String(r.h).padStart(3) + ' ' + tag + '| ' + cells.join(' | ').slice(0, 150))
    }
    if (p.rows.length > 10) L.push('  … 余下 ' + (p.rows.length - 10) + ' 行')
  }

  // 截断
  L.push('')
  if (p.clippedCells.length) {
    L.push('★ 被 CSS 截断的单元格 ' + p.clippedCells.length + ' 处（文字没有完整显示出来）')
    for (const c of p.clippedCells.slice(0, 8)) {
      L.push('    隐藏 ' + String(c.hidden || 0).padStart(4) + 'px  ' + c.text.slice(0, 84))
    }
    if (p.clippedCells.length > 8) L.push('    … 余下 ' + (p.clippedCells.length - 8) + ' 处')
  } else {
    L.push('没有被截断的单元格')
  }

  if (p.notes.length) {
    L.push('')
    L.push('说明文字')
    for (const n of p.notes.slice(0, 3)) L.push('  · ' + n)
  }
  return L.join('\n')
}

// ── 跑 ──
const H = await loadHarness()
const M = H.build(true)
const state = statePath ? JSON.parse(await readFile(statePath, 'utf8')) : makeState()
const { css: tokens, note: tokenNote } = await loadTokens(mode)

await mkdir(outDir, { recursive: true })
const picked = only ? VIEWS.filter((v) => v.id === only || v.tab === only) : VIEWS
if (picked.length === 0) {
  console.log('没有匹配的视图。可选：' + VIEWS.map((v) => v.id).join(', '))
  process.exit(1)
}

// 先把每个视图的 HTML 写出来（探针与截图看的是同一份页面）
const pages = []
for (const view of picked) {
  // 与 ui-snapshot 保持同一套渲染：面板视图渲染整壳，component 视图渲染单个组件。
  // 两处必须一致，否则"量到的"和"截到的"就不是同一个东西。
  const markup = view.component
    ? H.renderToStaticMarkup(H.h('div', { style: { padding: '28px 24px', maxWidth: '780px' } },
        H.h(M.__components[view.component], view.props || {})))
    : H.renderToStaticMarkup(H.h(M.__components.Workbench, {
        state, initialTab: view.tab, initialSeg: view.seg, onClose: () => {},
      }))
  const htmlPath = join(outDir, 'probe-' + view.id + '.html')
  await writeFile(htmlPath, buildDocument({ view, markup, pluginCss: M.__css, tokens, tokenNote, mode }), 'utf8')
  pages.push({ view, htmlPath })
}

console.log('数据：' + (statePath || '内置夹具 makeState()'))
console.log('说明：几何来自无头 Chrome 的真实排版；控件外观仍是替身，不代表真实应用。')

const collected = []
await withChrome(async ({ send }) => {
  for (const { view, htmlPath } of pages) {
    await send('Page.navigate', { url: pathToFileURL(htmlPath).href })
    await sleep(400)
    const res = await send('Runtime.evaluate', {
      expression: PROBE, returnByValue: true, awaitPromise: false,
    })
    const value = res && res.result ? res.result.value : null
    if (!value) {
      console.log('')
      console.log('视图 ' + view.id + '：探针没有返回结果 — ' + JSON.stringify(res).slice(0, 300))
      continue
    }
    collected.push({ view, probe: value })
    console.log(fmtView(view, value))
  }
})

if (jsonOut) {
  await writeFile(jsonOut, JSON.stringify(collected, null, 2), 'utf8')
  console.log('')
  console.log('原始几何已写出：' + jsonOut)
}

console.log('')
console.log('─'.repeat(96))
console.log('这份输出**只**说明结构、密度、宽度、截断。颜色、圆角、层次感它量不出来，')
console.log('所以别拿它当"界面好不好看"的依据。原语是替身这一点依然成立。')
