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

/** 分拣页签的夹具。用真实的目录形态：回收站有批次子目录，已拒绝是散文件。 */
export const TRIAGE_FIXTURE = [
  {
    rel: '.trash/staged-2026-09-10T15-53-04-985Z/opencode-zen-api-endpoint.md',
    id: 'opencode-zen-api-endpoint', title: 'OpenCode Zen 的 base endpoint',
    category: 'fact', confidence: 0.7, sources: 2, from: '.trash',
    reason: null,
    batch: 'staged-2026-09-10T15-53-04-985Z', bytes: 1100,
    mtime: '2026-09-10T15:53:04.985Z', bodyChars: 611, truncated: true,
    excerpt: 'OpenCode Zen 的 base endpoint 为 https://opencode.ai/zen/v1，文档见 …（夹具摘录；真实内容由 /api/triage 提供）',
  },
  {
    rel: '.rejected/llm-wiki-v120-client-crash-upgrade.md',
    id: 'llm-wiki-v120-client-crash-upgrade', title: 'llm-wiki v1.2.0 客户端崩溃与升级',
    category: 'fact', confidence: 0.5, sources: 1, from: '.rejected',
    reason: { kind: 'REJECTED', date: '2026-09-11', text: '撞名误报，与本项目无关。这一页讲的是 npm 包 @syasas/llm-wiki 的客户端崩溃，5 条来源全部指向别的仓库。（夹具）' },
    batch: null, bytes: 2389, mtime: '2026-09-11T02:10:00.000Z', bodyChars: 2389, truncated: true,
    excerpt: '> REJECTED: 2026-09-11 —— 撞名误报，与本项目无关。（夹具摘录）',
  },
]

/**
 * 待办提示条的夹具。
 *
 * 刻意用**真实形态的数据**（6 页暂存、10 个回收站条目、2 个已拒绝），
 * 因为这条子的全部意义就是"数字准不准、够不够显眼"。
 */
export const PENDING_FIXTURE = {
  ok: true,
  staged: [
    { id: 'a', title: '不要依赖凭据文件回退取模型凭据', category: 'lesson', confidence: 0.9, sources: 5, ready: true, blockers: [] },
    { id: 'b', title: 'LLM 调用点必须在 JSON 解析失败时输出原始响应', category: 'decision', confidence: 0.85, sources: 3, ready: true, blockers: [] },
    { id: 'c', title: '检测器返回空结果时必须先用违规样本证明它能失败', category: 'howto', confidence: 0.7, sources: 5, ready: true, blockers: [] },
  ],
  stagedTotal: 6,
  stagedReady: 6,
  trash: 10,
  rejected: 2,
}

export const VIEWS = [
  { id: 'capabilities-tools', title: '能力 · 工具', tab: 'capabilities', seg: 'tools' },
  { id: 'capabilities-skills', title: '能力 · 技能', tab: 'capabilities', seg: 'skills' },
  { id: 'knowledge', title: '知识', tab: 'knowledge' },
  { id: 'supply', title: '补料', tab: 'supply' },
  // 待办提示条不是面板的一个页签（它挂在输入框上方），所以单独渲染。
  // 目的：让"这条子到底长什么样"不再是只能靠脑补的事。
  { id: 'pending-bar', title: '输入框上方的待办提示条', component: 'PendingBar', props: { pending: PENDING_FIXTURE } },
  // 分拣页签读的是 /api/triage 而不是 /api/state，塞不进 PanelBody 那条受控路径，
  // 只能自己喂夹具（受控模式与 PendingBar 同一套惯例）。
  { id: 'triage', title: '分拣（回收站 / 已拒绝）', component: 'TriageTab', props: { items: TRIAGE_FIXTURE } },
]

