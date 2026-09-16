/**
 * 客户端界面的**离线装载台**：真 React + 自写的原语替身。
 *
 * 为什么需要它：client/client.js 是 DSH 的**浏览器半**，它靠
 * window.__ModuleLoader__ 装载、靠 factory 的 require 注入 react 与 DSH 原语。
 * 在 Node 里没有这套运行时，所以想"离线把组件树画出来"就必须自己搭一个。
 * verify-render.mjs（断言结构）和 ui-snapshot.mjs（截图给人/给 agent 看）
 * 共用这一个装载台 —— 否则两边的夹具会各自漂移，测过的和截出来的不是同一个东西。
 *
 * ── 诚实的边界 ──
 * · 原语是**替身**，不是 DSH 真原语。样式/主题/层级一概没在这里验证。
 *   每个替身元素都带 data-stub="<原名>"，出来的 HTML 里一眼能看出哪段是替身。
 * · 夹具是照着 index.js 真实发出的形状造的，但它毕竟是夹具。
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const HERE = fileURLToPath(new URL('.', import.meta.url))
export const PLUGIN_ROOT = fileURLToPath(new URL('../../', import.meta.url))
export const CLIENT_PATH = fileURLToPath(new URL('../../client/client.js', import.meta.url))

/**
 * DSH 的 node_modules —— react / react-dom 从**宿主自己**那份取，不另装一份。
 *
 * ★ 路径要写**真实装的样子**。这里原先写的是
 *   `D:/Harness/dsh-desktop/resources/app/node_modules`
 *   而应用实际在 `D:/Harness/dsh-desktop/DSH Desktop/resources/app/node_modules`
 *   —— 中间那个**带空格的子目录**。于是 hasReact() 恒为假，渲染测试打了
 *   "SKIP 无法做渲染测试" 就退出了：诚实，但等于**三个渲染断言套件从来没跑过**。
 *   （同一个错误在 scripts/verify-client-tokens.mjs 里也犯过一次，那次是 token 核对
 *     静默跳过；这两处是同一天发现的，所以都摆在这里说明白。）
 *
 * 现在按顺序找第一个真实存在的，找不到就**红**（不假装通过）。
 */
const APP_MODULE_CANDIDATES = [
  process.env.DSH_APP_MODULES,
  'D:/Harness/dsh-desktop/DSH Desktop/resources/app/node_modules',
  join(process.env.APPDATA || '', '..', 'Local', 'Programs', 'dsh-desktop', 'resources', 'app', 'node_modules'),
  join(process.env.APPDATA || '', '..', 'Local', 'Programs', 'DSH Desktop', 'resources', 'app', 'node_modules'),
].filter(Boolean)

export const APP_MODULES = APP_MODULE_CANDIDATES.find((p) => existsSync(join(p, 'react')))
  || APP_MODULE_CANDIDATES[0]

/** 找过哪些路径 —— 失败时把候选列出来，否则只有一句"找不到"没法排查。 */
export const APP_MODULE_CANDIDATES_TRIED = APP_MODULE_CANDIDATES

export function hasReact() {
  return existsSync(join(APP_MODULES, 'react')) && existsSync(join(APP_MODULES, 'react-dom'))
}

let cached = null

/** 载入真 React 与 react-dom/server，并捕获客户端模块的 factory。 */
export async function loadHarness() {
  if (cached) return cached
  if (!hasReact()) {
    throw new Error('DSH 的 node_modules 里没有 react/react-dom：' + APP_MODULES
      + '（可以用 DSH_APP_MODULES 指定别的路径）')
  }
  const req = createRequire(join(APP_MODULES, 'index.js'))
  const React = req('react')
  const { renderToStaticMarkup } = req('react-dom/server')

  let factory = null
  const prevWindow = globalThis.window
  globalThis.window = {
    ...(prevWindow || {}),
    __ModuleLoader__: { load: (def) => { factory = def.factory; return def } },
  }
  await import(pathToFileURL(CLIENT_PATH).href)
  if (typeof factory !== 'function') {
    throw new Error('没能从 window.__ModuleLoader__ 捕获 factory —— 客户端模块的装载契约变了？')
  }

  cached = {
    React,
    h: React.createElement,
    renderToStaticMarkup,
    version: React.version,
    factory,
    /** 每个 withPrimitives 值各建一套闭包；同一套复用，避免状态串味。 */
    build: memoizedBuild(factory, React),
  }
  return cached
}

function memoizedBuild(factory, React) {
  const cache = new Map()
  return (withPrimitives) => {
    const key = !!withPrimitives
    if (cache.has(key)) return cache.get(key)
    const M = factory((name) => {
      if (name === 'react') return React
      if (name === '@deepseek-ai/dsh-client-ui-primitives') {
        // 退化路径：真实世界里这个 require 会失败（版本漂移 / 没装），
        // 客户端必须照常画出界面，而不是让 UI 整个消失。
        if (!key) throw new Error('（测试）原语模块不可用')
        return primStub
      }
      throw new Error('（测试）意外的 require：' + name)
    })
    cache.set(key, M)
    return M
  }
}

/**
 * 原语替身。照 dsh-client-ui-primitives 当前实现写的最小等价物：
 *   Pill      有 onClick → button；否则 span
 *   Button    button，带 disabled/title
 *   StateDot  aria-hidden 的标记元素，带 data-state
 *   Input     className 落在外层 span，其余落在真 input
 *   MarkdownText  原样输出文本
 * 图标只给一个，剩下故意不给 —— 走 Ico() 的退化分支。
 */
export const primStub = {
  Button: (p) => wrap('Button', 'button', {
    type: 'button', className: p.className, onClick: p.onClick,
    disabled: p.disabled, title: p.title,
  }, [p.icon != null ? p.icon : null, p.children]),
  Pill: (p) => (p.onClick
    ? wrap('Pill', 'button', {
        type: 'button', className: p.className, onClick: p.onClick,
        role: p.role, 'aria-selected': p['aria-selected'],
      }, [p.children])
    : wrap('Pill', 'span', { className: p.className }, [p.children])),
  StateDot: (p) => wrap('StateDot', 'span', {
    'data-state': p.state, 'aria-hidden': 'true', className: p.className,
  }, []),
  Input: (p) => wrap('Input', 'span', { className: p.className }, [
    wrap('InputInner', 'input', {
      value: p.value, placeholder: p.placeholder,
      onChange: p.onChange, 'aria-label': p['aria-label'],
    }, []),
  ]),
  MarkdownText: (p) => wrap('MarkdownText', 'div', {}, [String(p.text || '')]),

  // ★ 图标替身必须**带上尺寸**。
  //   踩过一次：不带 width/height 的 <svg> 会拿到浏览器的默认替换元素尺寸
  //   **300×150**，于是 26px 宽的展开列被撑到 105px 高，整张知识表看起来
  //   像"行太胖"。那是我替身的假象，不是界面的问题 —— 真原语的图标组件
  //   都是 <svg width={size} height={size}>，客户端也确实传了 size。
  //   教训：替身漏掉一个属性，量出来的"问题"就是替身自己的问题。
  IconChevronDownOutline14: (p) => wrap('IconChevronDownOutline14', 'svg', {
    width: (p && p.size) || 16, height: (p && p.size) || 16, viewBox: '0 0 16 16',
  }, []),
}

function wrap(stub, tag, props, children) {
  return primStub._h(tag, { 'data-stub': stub, ...props }, ...children)
}

// 需要 React 才能建元素，但 primStub 是模块级常量 —— 在 loadHarness 里补上 _h。
primStub._h = (...args) => {
  if (!cached) throw new Error('primStub 在 loadHarness 之前被使用了')
  return cached.h(...args)
}

// ── 夹具：照着 index.js 真实发出的形状造 ──
//
// 用具名函数生成而不是手写常量：夹具必须和宿主发出来的**同形**，
// 否则测的是"我想要的接口"，不是"真实的接口"。

/** 工具：族由前缀推出，成员 >= 3 才算族，其余归「核心」——与 lib/capabilities.js 同规则。 */
export function makeTools() {
  const specs = [['hindsight', 9], ['web', 8], ['github', 6], ['wiki', 5]]
  const core = [
    'run_code', 'read', 'write', 'edit', 'glob', 'grep', 'pwsh', 'todo_write',
    'ask_user_question', 'create_goal', 'get_goal', 'update_goal', 'job_list',
    'job_output', 'job_kill', 'list_agents', 'send_message', 'subagent',
    'subagent_fork', 'interrupt_agent', 'mcp_search', 'mcp_call', 'find_tools',
    'find_dsh_plugin', 'context_audit', 'skill', 'exit_plan_mode',
    'web_search', 'web_fetch_pro', 'web_snapshot', 'web_deps', 'web_history',
    'web_rule', 'web_cache_clear', 'web_backend_status', 'web_search_stats',
    'web_exa_contents', 'web_search_pro', 'web_platform_search', 'wiki_recall',
    'wiki_learn', 'wiki_commit', 'wiki_review', 'wiki_struggle',
  ]
  const items = []
  for (const [fam, n] of specs) {
    for (let i = 0; i < n; i++) {
      items.push({
        name: fam + '_tool' + String(i).padStart(2, '0'),
        denied: i % 4 === 0,
        approxTokens: 40 + i * 7,
        purpose: fam + ' 家族的第 ' + i + ' 个工具，一句话说明它做什么。',
        family: fam,
      })
    }
  }
  for (const name of core) {
    items.push({
      name,
      denied: name === 'context_audit' || name === 'web_snapshot',
      approxTokens: 30 + (name.length * 3),
      purpose: name + ' 的用途说明，通常是一句英文描述截断到这里。',
      family: '核心',
    })
  }
  return items
}

export function makeSkills() {
  const names = ['ui-ux-pro-max', 'impeccable', 'design-taste-frontend', 'design', 'design-system',
    'brand', 'banner-design', 'slides', 'react-bits', 'ui-styling', 'karpathy-guidelines']
  return names.map((n, i) => ({
    name: n,
    description: n + ' 的触发描述，写得很长，因为它要覆盖所有触发场景。',
    source: '~/.dsh/skills/' + n + '/SKILL.md',
    catalogTokens: 120 + i * 37,
    bodyTokens: 900 + i * 410,
    bodyKnown: i !== 3,
    modelInvocable: true,
    userInvocable: true,
    whenToUse: '当用户要求 ' + n + ' 的时候。',
    bodyPreview: '# ' + n + '\n\n正文开头。',
    bodyError: null,
  }))
}

export function makePages(n) {
  const cls = ['confirmed', 'unconfirmed', 'suspect', 'suspect-watch', 'new', 'dead']
  const out = []
  for (let i = 0; i < n; i++) {
    const c = cls[i % cls.length]
    out.push({
      id: 'page-' + String(i).padStart(3, '0'),
      title: '第 ' + i + ' 条知识',
      category: ['fact', 'decision', 'lesson', 'howto'][i % 4],
      confidence: 0.5,
      created: '2026-08-01T00:00:00.000Z',
      updated: '2026-09-0' + ((i % 9) + 1) + 'T00:00:00.000Z',
      sources: 2,
      cls: c,
      hits: i * 3,
      confirmed: c === 'confirmed' ? 5 : 0,
      suspect: (c === 'suspect' || c === 'suspect-watch') ? 3 : 0,
      factor: 1,
      quarantined: c === 'suspect',
    })
  }
  return out
}

export function makeState(over = {}) {
  const items = over.items || makeTools()
  const kept = items.filter((i) => !i.denied)
  return {
    ts: '2026-09-11T00:00:00.000Z',
    app: { wikiRoot: 'D:/Harness/dsh-wiki', version: '0.1.0' },
    capabilities: {
      enabled: true,
      configuredDeny: items.filter((i) => i.denied).map((i) => i.name),
      catalog: {
        items,
        total: items.length,
        capturedAt: over.capturedAt !== false,
        fromDisk: false,
      },
      totals: {
        total: items.length,
        kept: kept.length,
        denied: items.length - kept.length,
        keptTokens: kept.reduce((n, i) => n + i.approxTokens, 0),
        deniedTokens: items.reduce((n, i) => n + (i.denied ? i.approxTokens : 0), 0),
      },
    },
    skills: over.skills || {
      available: true,
      items: makeSkills(),
      totals: { count: 11, catalogTokens: 3300, bodyTokens: 20000 },
    },
    knowledge: over.knowledge || {
      committed: makePages(15),
      staged: [
        { id: 'staged-1', title: '暂存页一', category: 'decision', confidence: 0.6, sources: 2, blockers: [] },
        { id: 'staged-2', title: '暂存页二（无来源）', category: 'fact', confidence: 0.4, sources: 0, blockers: ['no sources (每条知识必须可溯源)'] },
      ],
      counts: { confirmed: 3, unconfirmed: 2, suspect: 1, 'suspect-watch': 1, new: 1, dead: 7 },
      threshold: { hit: 0.2, weak: 0.13 },
    },
    gaps: {
      counts: { pending: 4, done: 9, skipped: 1 },
      total: 14,
      recent: [
        { query: '怎么配 pg0 的连接串', status: 'pending' },
        { query: 'widget 协议的分帧和魔数', status: 'done' },
      ],
    },
    struggles: {
      total: 6,
      counts: { 'edit-churn': 3, 'repeat-failure': 2, 'recurring-error': 1 },
      recent: [{ ts: '2026-09-10T10:00:00.000Z', signals: ['edit-churn'] }],
    },
  }
}
