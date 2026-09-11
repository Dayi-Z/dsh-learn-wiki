/**
 * 预览文档：真组件树 → 一份自包含的 HTML（真 CSS + 真主题 token）。
 *
 * ui-snapshot.mjs（截成 PNG 给人看）与 ui-probe.mjs（量出文本布局给 agent 读）
 * 共用这一个函数 —— 否则"看到的"和"量到的"会是两个不同的页面。
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

export const DEFAULT_TOKENS = process.env.DSH_TOKENS_CONTRACT || 'D:/Harness/dsw-tokens-contract.json'

/**
 * 把 token 契约展开成 CSS 变量。
 * 契约里每个 token 是 {light,dark,root} 或字符串，值常常又是另一个 static
 * token 的 var(...)。这里递归展开成字面量，免得预览里留下没人解析的悬空引用。
 */
export function tokenCss(contract, mode) {
  const raw = (name) => {
    const v = contract[name]
    if (v == null) return null
    if (typeof v === 'string') return v
    return v[mode] ?? v.root ?? v.light ?? v.dark ?? null
  }
  const resolve = (value, depth = 0) => {
    if (typeof value !== 'string' || depth > 6) return value
    const m = value.match(/^var\((--[\w-]+)\)$/)
    if (!m) return value
    const inner = raw(m[1])
    return inner == null ? value : resolve(inner, depth + 1)
  }
  const out = []
  for (const name of Object.keys(contract)) {
    const v = resolve(raw(name))
    if (typeof v === 'string' && v.length > 0) out.push(name + ':' + v + ';')
  }
  return out.join('\n')
}

export async function loadTokens(mode, path = DEFAULT_TOKENS) {
  if (!existsSync(path)) return { css: '', note: 'token 契约不可用，回落到插件自带的回退色' }
  try {
    const css = tokenCss(JSON.parse(await readFile(path, 'utf8')), mode)
    return { css, note: '配色取自 ' + path + '（' + mode + ' 模式）' }
  } catch (e) {
    return { css: '', note: 'token 契约读取失败：' + String(e && e.message) }
  }
}

export const FAKE_NOTE = '离线结构快照：真 React + 真组件树 + 真 CSS，但 DSH 原语是替身'
  + '（胶囊/按钮/状态点/图标的确切外观不代表真实应用）。数据是夹具。'

/** 预览专用的样式覆盖。只影响这张预览图，不影响应用本身。 */
export const PREVIEW_CSS = [
  'html,body{margin:0;padding:0;background:var(--dsw-alias-bg-base,#1a1a1c)}',
  '.snap-note{font:11px/16px system-ui,sans-serif;color:var(--dsw-alias-label-caption,#888);'
    + 'padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.13))}',
  '.snap-note b{color:var(--dsw-alias-label-secondary,#bbb);font-weight:600}',
  // 真应用里 .lw-mask 是 position:fixed 盖满视口的模态遮罩。预览要在上下各留一条说明，
  // 所以把它改成文档流里的普通块。这是**预览专用**的改动，应用里不存在。
  '.snap-body .lw-mask{position:static;inset:auto;display:block;background:transparent;padding:14px}',
  '.snap-body .lw-panel{width:100%;max-width:1040px;height:760px;margin:0 auto}',
  '.snap-foot{font:11px/16px system-ui,sans-serif;color:var(--dsw-alias-label-caption,#888);padding:2px 12px 14px}',
].join('')

export function buildDocument({ view, markup, pluginCss, tokens, tokenNote, mode = 'dark' }) {
  return [
    '<!doctype html>',
    '<html lang="zh" data-mode="' + mode + '">',
    '<head>',
    '<meta charset="utf-8">',
    '<title>learn-wiki — ' + view.title + '</title>',
    '<style>',
    tokens,
    pluginCss,
    PREVIEW_CSS,
    '</style>',
    '</head>',
    '<body class="snap-body">',
    '<div class="snap-note"><b>' + view.title + '</b> — ' + FAKE_NOTE + '</div>',
    markup,
    '<div class="snap-foot">' + tokenNote + ' · 由 scripts/ui-snapshot.mjs 生成</div>',
    '</body>',
    '</html>',
  ].join('\n')
}

export const VIEWS = [
  { id: 'capabilities-tools', title: '能力 · 工具', tab: 'capabilities', seg: 'tools' },
  { id: 'capabilities-skills', title: '能力 · 技能', tab: 'capabilities', seg: 'skills' },
  { id: 'knowledge', title: '知识', tab: 'knowledge' },
  { id: 'supply', title: '补料', tab: 'supply' },
]
