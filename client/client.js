/**
 * dsh-learn-wiki —— 浏览器半。
 *
 * 零构建：手写 CJS，由 window.__ModuleLoader__ 装载；react 与 DSH 原语经
 * factory 的 require 注入。契约来自 DSH 自己的客户端插件
 * （@deepseek-ai/dsh-client-ui-agent-preset），不是猜的。
 *
 * 这一版重写的要点（结构：列固定、行是活的表）：
 *   1. 用 DSH 自己的 @deepseek-ai/dsh-client-ui-primitives —— Modal / Button /
 *      Pill / StateDot / MarkdownText / Input 和图标。这是"长得像 DSH"唯一
 *      诚实的做法：不是模仿它的皮，而是用它的组件。
 *   2. 颜色全部走真实存在的 --dsw-alias-* 变量。上一版用的
 *      --dsw-alias-bg-hover / -border / -bg-elevated / -text **四个都不存在**，
 *      因为有回退色，所以一直静默失效——界面上的硬编码色从没跟过主题。
 *   3. 技能第一次有了位置（能力页签），成本拆成两笔：常驻（目录摘要，每轮都付）
 *      与触发（正文，只有真调用才付）。混着算会把结论说反。
 *   4. 每条知识可以就地读全文：展开行内取正文，不再二次弹窗。
 */

window.__ModuleLoader__.load({
  id: 'dsh-learn-wiki',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useMemo = React.useMemo
    var useCallback = React.useCallback
    var useRef = React.useRef

    /**
     * DSH 原语。拿不到就退化，绝不抛。
     * 这个文件是插件的浏览器半——require 失败会让 UI **整个消失**，
     * 而不是变丑。宁可丑，不可无。
     */
    var P = {}
    try {
      P = require('@deepseek-ai/dsh-client-ui-primitives') || {}
    } catch (e) {
      if (typeof console !== 'undefined') console.error('[dsh-learn-wiki] DSH 原语不可用，退化为原生元素：', e)
    }

    var API = '/learn-wiki/api/state'
    var PAGE_API = '/learn-wiki/api/page'
    var TRIAGE_API = '/learn-wiki/api/triage'
    // 模型目录单独一条端点：列 provider/模型可能打网络，不能并进每 8 秒轮询的
    // /api/state。只在打开「模型」页签时取一次。
    var MODELS_API = '/learn-wiki/api/models'
    var LLM_API = '/learn-wiki/api/llm'
    var HARVEST_API = '/learn-wiki/api/harvest'

    /** DSH 图标；没有原语时返回 null（不画假的代替品）。 */
    function Ico(name, size) {
      var C = P[name]
      if (!C) return null
      return h(C, { size: size || 16 })
    }
    /** 按钮：原生 Button 优先。 */
    function Btn(props) {
      if (P.Button) return h(P.Button, props)
      return h('button', {
        type: 'button', className: props.className, onClick: props.onClick,
        disabled: props.disabled, title: props.title,
      }, props.icon || null, props.children)
    }
    /** 胶囊标签：原生 Pill 优先。 */
    function Chip(props) {
      if (P.Pill) return h(P.Pill, props)
      return h('span', { className: 'lw-chip' + (props.active ? ' lw-on' : '') + (props.className ? ' ' + props.className : '') }, props.children)
    }
    /** 状态点：原生 StateDot 优先。 */
    function Dot(props) {
      if (P.StateDot) return h(P.StateDot, props)
      return h('span', { className: 'lw-dot lw-dot-' + props.state })
    }
    /**
     * 输入框：原生 Input 优先。
     * 注意：原语的 className 落在外层 <span>，其余 props 才落在真 <input> 上
     * （源码里就是这么分的）。所以外层用 .lw-field 撑开，内层不掺和。
     */
    function Field(props) {
      if (P.Input) return h(P.Input, props)
      var cls = ('lw-input ' + (props.className || '')).trim()
      return h('input', Object.assign({}, props, { className: cls }))
    }
    /** Markdown：原生 MarkdownText 优先；退化时按纯文本显示，不假装会渲染。 */
    function Md(props) {
      var text = String(props.text || '')
      if (P.MarkdownText) return h(P.MarkdownText, { text: text })
      return h('pre', { className: 'lw-pre' }, text)
    }
    // ── 样式 ──────────────────────────────────────────────────────────────
    // 颜色一律用真实存在的 --dsw-alias-* 变量。回退色只为"变量缺失"兜底，
    // 不作主色——否则又回到上一版那种"看着像别人的皮肤"。
    var CSS = [
      '.lw-root{',
      '--lw-fg:var(--dsw-alias-label-primary,#e6e6e8);',
      '--lw-fg2:var(--dsw-alias-label-secondary,rgba(230,230,232,.72));',
      '--lw-fg3:var(--dsw-alias-label-tertiary,rgba(230,230,232,.5));',
      '--lw-fg4:var(--dsw-alias-label-caption,rgba(230,230,232,.4));',
      '--lw-line:var(--dsw-alias-border-l2,rgba(127,127,127,.22));',
      '--lw-line-soft:var(--dsw-alias-border-l1,rgba(127,127,127,.13));',
      '--lw-surface:var(--dsw-alias-bg-base,#1a1a1c);',
      '--lw-raise:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05));',
      '--lw-hover:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.10));',
      '--lw-active:var(--dsw-alias-interactive-bg-active,rgba(127,127,127,.16));',
      '--lw-brand:var(--dsw-alias-brand-primary,#4d6bfe);',
      '--lw-ok:var(--dsw-alias-state-success-primary,#3ecf8e);',
      '--lw-bad:var(--dsw-alias-state-error-primary,#ef6b6b);',
      '--lw-warn:var(--dsw-alias-state-warn-primary,#e0a34a);',
      '--lw-info:var(--dsw-alias-state-business-primary,#5b9dff);',
      // 字体统一挂在这里，其余全部继承。数值取自 DSH 自己的字体阶梯，
      // 不再各处手写 px——手写的结果就是 11/11.5/12/12.5/13 混在一个面板里。
      'font:var(--dsw-font-xs-13,13px/20px system-ui,sans-serif);',
      'color:var(--lw-fg);caret-color:var(--lw-brand)}',
      '.lw-root ::selection{background:var(--dsw-alias-bg-multi-select,rgba(77,107,254,.30))}',
      '.lw-root :focus-visible{outline:2px solid var(--lw-brand);outline-offset:1px;border-radius:6px}',
      '.lw-scroll{scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l1,rgba(127,127,127,.35)) transparent}',
      '.lw-scroll::-webkit-scrollbar{width:10px;height:10px}',
      '.lw-scroll::-webkit-scrollbar-track{background:transparent}',
      '.lw-scroll::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l1,rgba(127,127,127,.35));',
      'border-radius:99px;border:3px solid transparent;background-clip:content-box}',
      '.lw-scroll::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l1,rgba(127,127,127,.55));background-clip:content-box}',
      '.lw-mask{position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;',
      'background:var(--dsw-alias-bg-mask-drop,rgba(0,0,0,.45))}',
      // 面板自己管布局。这里刻意**不用 DSH 的 Modal 原语**：
      // 它的 .dialog 写死了 width:min(380px,100%)——那是给 RiskConfirmation
      // 这类确认框定的尺寸，把一张 1040px 的数据表塞进去会被压扁。
      // 原语该用在该用的地方：Button / Pill / StateDot / MarkdownText / 图标照用。
      '.lw-panel{width:min(1040px,94vw);height:min(760px,88vh);display:flex;flex-direction:column;overflow:hidden;',
      'padding:16px 18px 0;box-sizing:border-box;',
      'border-radius:14px;border:1px solid var(--lw-line);background:var(--lw-surface);',
      // 阴影也走 DSH 的 token。原来写死 rgba(0,0,0,.20/.36) —— 深色主题下
      // 黑色阴影几乎看不见，而浅色主题下它又偏重，两边都不跟主题。
      // 字面值退到 var() 的回退位里（那也是本文件里唯一允许出现字面色值的地方）。
      'box-shadow:var(--dsw-shadow-lv2,0 1px 2px rgba(0,0,0,.20),0 16px 48px rgba(0,0,0,.36))}',
      '.lw-shell{display:flex;flex-direction:column;flex:1;min-height:0;width:100%}',
      '.lw-head{display:flex;align-items:center;gap:9px;padding:0 0 12px}',
      '.lw-headicon{display:flex;align-items:center;color:var(--lw-fg2)}',
      '.lw-title{font:var(--dsw-font-s-strong-14,600 14px/22px system-ui,sans-serif)}',
      '.lw-path{margin-left:auto;font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);color:var(--lw-fg4);font-variant-numeric:tabular-nums;',
      'max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}',
      '.lw-tabs{display:flex;align-items:center;gap:6px;padding:0 0 10px;border-bottom:1px solid var(--lw-line-soft);flex-wrap:wrap}',
      '.lw-tabsum{margin-left:auto;font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);color:var(--lw-fg3);font-variant-numeric:tabular-nums}',
      '.lw-body{flex:1;min-height:0;overflow:auto;padding:12px 0 18px}',
      // 页签之下的第二级导航（能力页签里的 工具/技能）。
      // 用一条浅底把两段"焊"在一起，跟顶部页签一眼可分——否则两级导航长得一样，
      // 你分不清哪一层换的是整页、哪一层只换下半页。
      '.lw-seg{display:inline-flex;align-items:center;gap:2px;margin:0 0 14px;padding:2px;border-radius:9px;',
      'background:var(--lw-raise);border:1px solid var(--lw-line-soft)}',
      '.lw-seg>*{border:0!important}',
      '.lw-sec{margin:0 0 20px}',
      '.lw-sec-h{display:flex;align-items:baseline;gap:8px;margin:0 0 8px;flex-wrap:wrap}',
      '.lw-sec-t{font:var(--dsw-font-xxs-strong-12,600 12px/18px system-ui,sans-serif)}',
      '.lw-sec-n{font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);color:var(--lw-fg3);font-variant-numeric:tabular-nums}',
      '.lw-note{font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);line-height:1.6;color:var(--lw-fg3);margin:6px 0 0}',
      '.lw-table{width:100%;border-collapse:collapse;table-layout:fixed}',
      '.lw-th{position:sticky;top:0;z-index:2;text-align:left;font:var(--dsw-font-xxxs-strong-11,500 11px/16px system-ui,sans-serif);color:var(--lw-fg4);',
      'padding:6px 8px;background:var(--lw-surface);border-bottom:1px solid var(--lw-line);white-space:nowrap}',
      '.lw-th.r,.lw-td.r{text-align:right}',
      '.lw-td{padding:7px 8px;border-bottom:1px solid var(--lw-line-soft);vertical-align:middle;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.lw-tr.x{cursor:pointer}',
      '.lw-tr.x:hover>.lw-td{background:var(--lw-hover)}',
      '.lw-tr.x[aria-expanded="true"]>.lw-td{background:var(--lw-active)}',
      '.lw-td.detail{padding:0;white-space:normal;background:var(--lw-raise)}',
      '.lw-num{font-variant-numeric:tabular-nums;color:var(--lw-fg2)}',
      '.lw-id{font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace)}',
      '.lw-src{font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);color:var(--lw-fg3)}',
      // 双行单元格：主行是标识符，副行是用途。列仍然是固定的，只是行变高了。
      '.lw-2l{display:flex;flex-direction:column;gap:1px;min-width:0;white-space:normal}',
      '.lw-sub{font:var(--dsw-font-xxxs-11,11px/15px system-ui,sans-serif);color:var(--lw-fg4);',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      // 工具名 + 行内状态标记。状态写在行里，不靠位置表达——
      // 位置一旦随勾选变化，就没法连续点第二下了。
      '.lw-name{font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);',
      'display:inline-flex;align-items:center;gap:6px;min-width:0}',
      '.lw-off{font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);line-height:15px;padding:0 5px;',
      'border-radius:4px;border:1px solid var(--lw-line);color:var(--lw-fg4);flex:none}',
      // 族分组标题。族说一次就够，不必在每一行重复。
      '.lw-group>.lw-td{padding:12px 8px 4px;border-bottom:1px solid var(--lw-line);background:transparent;',
      'position:sticky;top:22px;z-index:1;background:var(--lw-surface)}',
      '.lw-group-name{font:var(--dsw-font-xxxs-strong-11,600 11px/16px system-ui,sans-serif);color:var(--lw-fg2);',
      'font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace)}',
      '.lw-group-n{margin-left:8px;font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);color:var(--lw-fg4)}',
      // 族标题是**真的按钮**：键盘可达、有 aria-expanded。
      // 折叠控件用 div 是常见的偷懒，代价是键盘用户用不了。
      '.lw-groupbtn{display:inline-flex;align-items:baseline;gap:2px;padding:2px 6px;margin:0 0 0 -6px;',
      'border:0;border-radius:6px;background:none;color:inherit;cursor:pointer;font:inherit;text-align:left}',
      '.lw-groupbtn:hover{background:var(--lw-hover)}',
      '.lw-groupbtn:focus-visible{outline:2px solid var(--lw-brand);outline-offset:1px}',
      '.lw-group-chev{flex:none;width:12px;color:var(--lw-fg3);font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif)}',
      // 展开控件：一个去掉了所有默认外观的 button。
      // 它必须**看得见焦点**——键盘用户靠它知道自己在哪一格上。
      '.lw-chevbtn{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;',
      'border:0;border-radius:5px;background:transparent;color:inherit;cursor:pointer;font:inherit}',
      '.lw-chevbtn:hover{background:var(--lw-hover)}',
      '.lw-chev{display:inline-flex;align-items:center;color:var(--lw-fg4);transition:transform .12s ease}',
      '.lw-chev.c{transform:rotate(-90deg)}',
      '.lw-dot{display:inline-block;width:8px;height:8px;border-radius:99px;background:var(--lw-fg4)}',
      '.lw-dot-done{background:var(--lw-ok)}.lw-dot-error{background:var(--lw-bad)}',
      '.lw-dot-ongoing{background:var(--lw-info)}.lw-dot-idle{background:var(--lw-fg4)}',
      '.c-ok{color:var(--lw-ok)}.c-bad{color:var(--lw-bad)}.c-warn{color:var(--lw-warn)}',
      '.c-info{color:var(--lw-info)}.c-dim{color:var(--lw-fg4)}.c-2{color:var(--lw-fg2)}.c-3{color:var(--lw-fg3)}',
      '.lw-exp{padding:12px 14px 16px;border-bottom:1px solid var(--lw-line-soft);line-height:1.65}',
      '.lw-meta{display:flex;flex-wrap:wrap;gap:5px 14px;font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);color:var(--lw-fg3);',
      'font-variant-numeric:tabular-nums;margin:0 0 10px}',
      '.lw-srclist{margin:10px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:5px}',
      '.lw-srclist li{display:flex;align-items:center;gap:6px;min-width:0}',
      '.lw-srclist a{color:var(--lw-info);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.lw-srclist a:hover{text-decoration:underline}',
      '.lw-pre{margin:0;white-space:pre-wrap;word-break:break-word;color:var(--lw-fg2);',
      'font:var(--dsw-font-markdown-code-block-small,12px/18px ui-monospace,monospace);max-height:340px;overflow:auto}',
      '.lw-bar{display:flex;align-items:center;gap:9px;margin:0 0 10px;flex-wrap:wrap}',
      '.lw-field{flex:1;min-width:150px;display:flex;align-items:center}',
      '.lw-input{box-sizing:border-box;flex:1;min-width:150px;padding:5px 9px;border-radius:7px;',
      'border:1px solid var(--lw-line);background:transparent;color:var(--lw-fg);font:inherit}',
      '.lw-input::placeholder{color:var(--lw-fg4)}',
      '.lw-chip{font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);padding:1px 7px;border-radius:99px;border:1px solid var(--lw-line);color:var(--lw-fg2);white-space:nowrap}',
      '.lw-chip.lw-on{border-color:var(--lw-brand);color:var(--lw-fg)}',
      '.lw-msg{font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif);line-height:1.5;padding:8px 10px;border-radius:8px;margin:0 0 12px}',
      '.lw-msg.ok{color:var(--lw-ok);border:1px solid var(--lw-line)}',
      '.lw-msg.err{color:var(--lw-bad);border:1px solid var(--lw-line)}',
      '.lw-empty{font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif);line-height:1.6;color:var(--lw-fg4);padding:14px 2px}',
      '.lw-list{display:flex;flex-direction:column;gap:7px}',
      '.lw-lrow{display:flex;align-items:center;gap:10px;font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif)}',
      '.lw-lname{width:140px;flex:none;color:var(--lw-fg2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.lw-track{flex:1;height:6px;border-radius:99px;background:var(--lw-line-soft);overflow:hidden}',
      '.lw-fill{height:100%;border-radius:99px;background:var(--lw-brand);opacity:.85}',
      '.lw-fill.warn{background:var(--lw-warn)}.lw-fill.bad{background:var(--lw-bad)}',
      '.lw-lval{width:58px;flex:none;text-align:right;font-variant-numeric:tabular-nums;color:var(--lw-fg2)}',
      // ── 侧边栏底栏入口（座位 sidebar.footer.action）──
      //
      // 这个座位是个**行**（.pKYZ4q_footerActions{display:flex}），而它的第一个
      // 使用者 —— cordis 面板 —— 声明了 flex:none;width:100%，一个人就把整行占满。
      // 宿主那行不换行，于是**任何**第二个使用者都会被挤出容器：实测单元格落在
      // x=228（容器是 12..228）、宽度被压到 83px、标签折成两行。
      // 让宿主那行允许换行，两个使用者就各占一行，谁都不必去抢别人的宽度。
      // 用 :has() 从我的单元格往上选，所以不依赖宿主那个构建期哈希类名；
      // 轨道态下容器是 width:auto，两个 36px 单元格本来就放得下，不会换行。
      '*:has(> .lw-fb-cell){flex-wrap:wrap}',
      // 单元格 = 宿主的 flex 子项。宽态给满，轨道态收成 36px 方格。
      '.lw-fb-cell{flex:none;width:100%;min-width:0;display:flex}',
      '.lw-fb-cell-rail{width:36px}',
      // 按钮照抄设置行（.Ri3YFq_trigger）的度量：高 34px、圆角 12px、
      // width:calc(100% + 8px) + margin:4px -4px 让它比列宽出 4px（设置行正是这么做的）。
      // 于是 padding-left 10px 减掉那 4px = 图标左沿距列边 6px —— 与设置行、
      // 与 cordis 单元格在同一条竖线上（那两处也都是 6px）。
      '.lw-fb{box-sizing:border-box;display:flex;align-items:center;gap:8px;',
      'width:calc(100% + 8px);height:34px;margin:4px -4px;padding:6px 2px 6px 10px;',
      'border:0;border-radius:12px;background:transparent;color:inherit;font:inherit;cursor:pointer;',
      'text-align:left;overflow:hidden}',
      '.lw-fb:hover{background:var(--lw-hover)}',
      // 标签必须能自己收窄，否则长文案会把整行顶宽。
      '.lw-fb-label{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      // 轨道态（wide=false，56px 栏）：和 cordis 单元格、设置圆钮一样是 36px 圆。
      // 标签让位 —— 36px 里塞不下字，同样的信息 title 里写着。
      '.lw-fb-rail{width:36px;height:36px;margin:0;padding:0;border-radius:50%;justify-content:center;gap:0;position:relative}',
      // 轨道态没有标签，待办数改成一个不越出圆的小点：收起侧边栏不该等于
      // "看不见有事在等"。数字仍在 title 里。
      '.lw-fb-rail .lw-fb-dot{position:absolute;top:6px;right:6px;min-width:6px;width:6px;height:6px;padding:0;font-size:0;line-height:0}',
      '.lw-fb-badge{margin-left:auto;font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);color:var(--lw-fg4);font-variant-numeric:tabular-nums}',
      // ── 待办计数角标 ──
      //
      // ★ 配色**必须**用 DSH 的按钮 token 成对出现，不能自己配 "#fff 压深色底"。
      //   原先写死 color:#fff 就是"字体与按钮同色、完全不可见"的原因：
      //   --dsw-alias-button-primary-fill 在浅色主题下不是深色，
      //   白字压上去等于没字。DSH 自己给的配对是
      //   background=button-primary-fill / color=label-primary-foreground。
      '.lw-fb-dot{flex:none;min-width:16px;height:16px;padding:0 5px;border-radius:99px;box-sizing:border-box;',
      'display:inline-flex;align-items:center;justify-content:center;',
      'background:var(--dsw-alias-button-primary-fill,var(--lw-brand));',
      'color:var(--dsw-alias-label-primary-foreground,#fff);',
      'font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);font-variant-numeric:tabular-nums}',
      // ── 输入框上方的待办条 ──
      //
      // 三层约束，缺一条都会"看着不对"：
      //
      // 1) **宽度**：座位 conversation.input.dock 是**整行宽**的
      //    （catalog 原话：a full-width row of its own —— 而且它点名 "a todo strip"
      //     就是这个用途）。所以要自己收到和输入框一样宽，否则会横跨整个对话区。
      //    780px 不是我拍的：DSH 自己的 --dsh-composer-card-max-width
      //    = --dsh-chat-content-width(748) + 32。直接用它的变量，它改我跟着改。
      // 2) **外观**：照抄 DSH 自己在这个位置的样式 ._5M8isa_notice
      //    （composer 卡片上方的一条提示）—— 同一位置、同一宽度、同一字号，
      //    没有理由另造一套。
      // 3) **按钮**：逐条照抄 DSH 的 Button CSS 模块（kz6gm），
      //    包括 primary 的配色配对与 disabled 的 opacity:.4。
      //    自己发明配色正是"按钮未与主题同步"的来源。
      //
      // ★ 另外：这个条子挂在 composer 里，离 .lw-root 很远 —— 而整套 --lw-* 变量是
      //   定义在 .lw-root 上的，不是 :root。所以组件上必须**同时带 lw-root 类**，
      //   否则这里每一个 var(--lw-*) 都是未定义（无回退值时整条声明失效）。
      // 宽度用的是**和输入框卡片完全相同的公式**，不是"差不多"：
      //   卡片 = min(容器宽 - 2*side-clearance, card-max-width)
      // 只写 max-width 的话，窄屏下条子会比卡片宽出两个 side-clearance（32px），
      // 而那正是"没对齐"看起来最刺眼的地方。
      '.lw-pend{box-sizing:border-box;width:calc(100% - 2 * var(--dsh-composer-side-clearance,16px));',
      'max-width:var(--dsh-composer-card-max-width,780px);',
      // 观感：**一行，不换行**。换行会让它变成两行灰块压在输入框上，很难看。
      // 文字过长就截断 —— 这条子只需要传达"有几个数字"，不负责展示长句。
      'display:flex;align-items:center;gap:6px;flex-wrap:nowrap;margin:0 auto 6px;padding:3px 8px;',
      'border-radius:8px;background:var(--dsw-alias-interactive-bg-hover);',
      'color:var(--dsw-alias-label-secondary,var(--lw-fg2));',
      // 字号走 DSH 的阶梯，不手写 —— 手写的结果就是 11/11.5/12/12.5/13 混在一个面板里
      'font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif)}',
      '.lw-pend-txt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.lw-pend b{color:var(--dsw-alias-label-primary,var(--lw-fg));font-variant-numeric:tabular-nums;font-weight:600}',
      // 计数是可点的入口，但**不要**做成虚线下划线 —— 一行里两条虚线下划线很吵。
      // 做成安静的小胶囊：平时看着就是文字，悬停才显出可点。
      '.lw-pend-chip{flex:none;padding:0 6px;margin:0;border:0;border-radius:6px;background:none;',
      'color:inherit;cursor:pointer;font:inherit;white-space:nowrap}',
      '.lw-pend-chip:hover{background:var(--dsw-alias-interactive-bg-hover);',
      'color:var(--dsw-alias-label-primary,var(--lw-fg))}',
      // Button(sm)：display/gap/height/padding/圆角/字号全部照 DSH 的 kz6gm 模块。
      // 分拣页签复用同一个类 —— 两处外观必须是同一套，否则又是一个"没同步"。
      '.lw-btn{flex:none;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;',
      'gap:4px;height:28px;padding:0 10px;border-radius:14px;cursor:pointer;',
      'border:1px solid var(--dsw-alias-border-l2);background:transparent;',
      'color:var(--dsw-alias-label-primary,var(--lw-fg));',
      'font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif)}',
      // ghost/outline 的悬停与按下
      '.lw-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.lw-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}',
      // primary：配对使用 fill / foreground，绝不自己配白字
      '.lw-btn.primary{border-color:transparent;',
      'background:var(--dsw-alias-button-primary-fill,var(--lw-brand));',
      'color:var(--dsw-alias-label-primary-foreground,#fff)}',
      '.lw-btn.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--lw-brand))}',
      '.lw-btn.primary:active:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--lw-brand))}',
      '.lw-btn:disabled{cursor:not-allowed;opacity:.4}',
      // ── 分拣 ──
      // 用卡片而不是表格：这一页的决策输入是**正文**（"这页我还要不要"），
      // 而正文塞不进表格列。表头在这里只会挤掉真正要看的东西。
      '.lw-tri{display:flex;flex-direction:column;gap:8px}',
      '.lw-tri-card{border:1px solid var(--lw-line);border-radius:10px;padding:10px 12px;background:var(--lw-raise)}',
      '.lw-tri-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
      '.lw-tri-title{flex:1;min-width:0;font-weight:600;color:var(--lw-fg);word-break:break-word}',
      '.lw-tri-meta{flex:none;font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);color:var(--lw-fg4);font-variant-numeric:tabular-nums}',
      // 两个来源的标签**配色要分得开**：已拒绝是"这条知识被判错"，回收站是
      // "这条暂存页不想要了" —— 语义不同，长得一样就得每次去读文字。
      '.lw-tri-tag{flex:none;padding:1px 7px;border-radius:6px;background:var(--lw-line-soft);',
      'font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);color:var(--lw-fg3);white-space:nowrap}',
      '.lw-tri-tag.rej{background:color-mix(in srgb,var(--lw-warn) 18%,transparent);color:var(--lw-warn)}',
      // 原因块：它是**决策输入**，所以不做成小字备注，而是卡片里第二显眼的东西。
      '.lw-tri-why{margin:8px 0 0;padding:7px 9px;border-radius:8px;border-left:3px solid var(--lw-warn);',
      'background:var(--lw-line-soft);color:var(--lw-fg2);word-break:break-word}',
      '.lw-tri-why .k{display:block;margin-bottom:3px;color:var(--lw-warn);',
      'font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);letter-spacing:.02em}',
      // 没记录原因时必须**看得出来是"没记录"**，而不是让人以为这页本来就没理由。
      '.lw-tri-why.none{border-left-color:var(--lw-line);color:var(--lw-fg4)}',
      '.lw-tri-why.none .k{color:var(--lw-fg4)}',
      '.lw-tri-exc{margin:6px 0 0;color:var(--lw-fg2);white-space:pre-wrap;word-break:break-word;',
      'max-height:9em;overflow:hidden}',
      '.lw-tri-full{margin:6px 0 0;color:var(--lw-fg2);white-space:pre-wrap;word-break:break-word}',
      '.lw-tri-acts{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px}',
      '.lw-tri-acts .lw-tri-ask{color:var(--lw-warn)}',
      '.lw-tri-more{flex:none;padding:0;border:0;background:none;color:var(--lw-fg3);cursor:pointer;font:inherit;',
      'text-decoration:underline;text-decoration-style:dotted;text-underline-offset:3px}',
      '.lw-hint{font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif);line-height:1.6;color:var(--lw-fg3);padding:0 2px 10px}',
      // ── 模型页签 + 提炼按键 ──
      //
      // 复用既有的 .lw-sec/.lw-table/.lw-msg，只加缺的那几个。新控件全部走
      // 已有的 --lw-* 与 --dsw-font-* 两级 token，不自己发明颜色和字号。
      '.lw-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 0}',
      '.lw-grow{flex:1 1 260px;min-width:0}',
      '.lw-savebar{margin-top:14px;padding-top:12px;border-top:1px solid var(--lw-line-soft)}',
      // 候选列表：用序号而不是圆点，因为**顺序就是语义**（轮换按它循环，
      // 单一模式用第一个）。序号让"谁是第一个"不用读文字就能看出来。
      '.lw-mlist{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-direction:column;gap:4px}',
      '.lw-mitem{display:flex;align-items:center;gap:8px;padding:5px 8px;border:1px solid var(--lw-line-soft);border-radius:8px;background:var(--lw-raise)}',
      '.lw-midx{flex:none;width:18px;text-align:right;font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);color:var(--lw-fg4);font-variant-numeric:tabular-nums}',
      '.lw-mname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--dsw-font-xs-13,13px/20px system-ui,sans-serif);color:var(--lw-fg)}',
      '.lw-mtag{flex:none;padding:1px 7px;border-radius:6px;background:var(--lw-line-soft);font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);color:var(--lw-fg3);white-space:nowrap}',
      '.lw-mact{flex:none;display:flex;gap:2px}',
      '.lw-mini{padding:1px 7px;border:1px solid var(--lw-line-soft);border-radius:6px;background:transparent;color:var(--lw-fg3);cursor:pointer;font:inherit;line-height:1.5}',
      '.lw-mini:hover:enabled{color:var(--lw-fg);border-color:var(--lw-line)}',
      '.lw-mini:disabled{opacity:.35;cursor:default}',
      '.lw-copy{margin-left:auto}',
      '.lw-sel{max-width:220px;padding:3px 6px;border:1px solid var(--lw-line-soft);border-radius:6px;',
      'background:var(--lw-surface);color:var(--lw-fg);font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif)}',
      '.lw-mledit{margin-top:2px}',
      '.lw-ml-t{flex:none;width:44px;color:var(--lw-fg3);font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif)}',
      '.lw-ml-note{color:var(--lw-fg4);font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);line-height:1.6}',
      // ── wiki_recall 的对话内卡片 ──
      // 刻意**不自带背景**：它嵌在宿主既有的工具行里，自己再铺一层底色
      // 会和宿主那一行的底打架（表现为一块突兀的色带）。只做排版与状态色。
      '.lw-recall{display:flex;flex-direction:column;gap:6px;padding:2px 0;min-width:0}',
      '.lw-recall-head{display:flex;align-items:center;gap:8px;min-width:0}',
      '.lw-recall-verdict{flex:none;font:var(--dsw-font-xxxs-strong-11,600 11px/16px system-ui,sans-serif)}',
      '.lw-recall-query{color:var(--lw-fg2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}',
      '.lw-recall-best{flex:none;font-variant-numeric:tabular-nums}',
      '.lw-recall-sum{font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);font-variant-numeric:tabular-nums}',
      '.lw-recall-list{display:flex;flex-direction:column;gap:2px;border-top:1px solid var(--lw-line-soft);padding-top:4px}',
      '.lw-recall-row{display:flex;flex-direction:column;gap:2px;padding:3px 0;min-width:0}',
      '.lw-recall-rowhead{display:flex;align-items:center;gap:7px;min-width:0}',
      '.lw-recall-dot{flex:none;font-size:var(--dsw-font-xxxs-11,11px)}',
      '.lw-recall-title{color:var(--lw-fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
      '.lw-recall-facts{display:flex;align-items:center;gap:5px;flex:none}',
      '.lw-recall-chip{font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);color:var(--lw-fg3);',
      'font-variant-numeric:tabular-nums;padding:0 5px;border:1px solid var(--lw-line-soft);border-radius:99px}',
      '.lw-recall-toggle{margin-left:auto;flex:none;cursor:pointer;background:none;border:0;padding:0 2px;',
      'color:var(--lw-fg3);font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif)}',
      '.lw-recall-toggle:hover{color:var(--lw-fg)}',
      '.lw-recall-detail{display:flex;flex-direction:column;gap:2px;padding:2px 0 4px 16px;',
      'font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);color:var(--lw-fg3);line-height:1.6}',
      '.lw-recall-note{font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);line-height:1.6}',
    ].join('')

    var styled = false
    function ensureStyle() {
      if (styled || typeof document === 'undefined') return
      var el = document.createElement('style')
      el.setAttribute('data-dsh-learn-wiki', '1')
      el.textContent = CSS
      document.head.appendChild(el)
      styled = true
    }

    /**
     * 读响应，但**不盲调 r.json()**。
     *
     * 为什么：实测踩过一次。路由注册成 kind:'exact' 之后，/api/page 根本到不了
     * handler，前端收到的是宿主的 404 HTML，.json() 抛出
     * 「Unexpected token '<' ... is not valid JSON」——这句话把真正的原因
     * （404 + HTML）完全盖住，我照着它查了半天前端代码。
     * 现在先把状态码和 content-type 摆出来，解析失败反而是最后才提的事。
     */
    function readJson(r) {
      var ct = (r.headers && r.headers.get && r.headers.get('content-type')) || ''
      return r.text().then(function (raw) {
        if (ct.indexOf('application/json') >= 0) {
          try { return { status: r.status, j: JSON.parse(raw), error: null } }
          catch (e) { return { status: r.status, j: null, error: 'JSON 解析失败：' + String((e && e.message) || e) } }
        }
        return {
          status: r.status,
          j: null,
          error: 'HTTP ' + r.status + '，返回的不是 JSON（content-type=' + (ct || '空') + '）：'
            + String(raw).replace(/\s+/g, ' ').slice(0, 160),
        }
      })
    }
    function fail(e) { return { status: 0, j: null, error: '请求失败：' + String((e && e.message) || e) } }

    function getJson(url) {
      return fetch(url, { headers: { accept: 'application/json' } }).then(readJson).catch(fail)
    }
    function post(path, body) {
      return fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(readJson).catch(fail)
    }
    // ── 小工具 ────────────────────────────────────────────────────────────
    function num(n) {
      var v = Number(n)
      if (!isFinite(v)) return '—'
      return v.toLocaleString('en-US')
    }
    function tok(n) {
      var v = Number(n)
      if (!isFinite(v) || v <= 0) return '—'
      return '~' + v.toLocaleString('en-US')
    }
    function when(iso) {
      if (!iso) return '—'
      var t = Date.parse(iso)
      if (!isFinite(t)) return String(iso).slice(0, 10)
      var d = Math.floor((Date.now() - t) / 86400000)
      if (d <= 0) return '今天'
      if (d === 1) return '昨天'
      if (d < 30) return d + ' 天前'
      return String(iso).slice(0, 10)
    }

    var CLS = {
      confirmed: { label: '已确认', state: 'done', cls: 'c-ok' },
      suspect: { label: '疑似有害', state: 'error', cls: 'c-bad' },
      'suspect-watch': { label: '观察中', state: 'ongoing', cls: 'c-warn' },
      new: { label: '新页', state: 'ongoing', cls: 'c-info' },
      unconfirmed: { label: '未确认', state: 'idle', cls: 'c-3' },
      dead: { label: '死知识', state: 'idle', cls: 'c-dim' },
    }
    function clsInfo(k) { return CLS[k] || { label: k || '—', state: 'idle', cls: 'c-dim' } }

    var SIG = {
      'edit-churn': '反复改同一文件',
      'repeat-identical': '重复相同调用',
      'repeat-failure': '连续失败',
      'recurring-error': '反复撞同一错误',
    }

    /** 展开箭头：有 DSH 图标就用，没有就用一个纯 CSS 三角。 */
    function Chev(props) {
      var c = Ico('IconChevronDownOutline14', 14)
      if (c) return h('span', { className: 'lw-chev' + (props.open ? '' : ' c') }, c)
      return h('span', { className: 'lw-chev' + (props.open ? '' : ' c'), 'aria-hidden': 'true' }, '▾')
    }

    /** 一条水平占比条。用于把"钱花在哪"变成一眼能比的东西。 */
    function BarRow(props) {
      var pct = props.max > 0 ? Math.max(1.5, Math.round((props.value / props.max) * 100)) : 0
      return h('div', { className: 'lw-lrow' },
        h('span', { className: 'lw-lname', title: props.name }, props.name),
        h('span', { className: 'lw-track' },
          h('span', { className: 'lw-fill' + (props.tone ? ' ' + props.tone : ''), style: { width: pct + '%' } })),
        h('span', { className: 'lw-lval' }, props.display != null ? props.display : num(props.value))
      )
    }
    // ── 视图逻辑：纯函数，不碰 DOM ────────────────────────────────────────
    //
    // 排序/分组/筛选从组件里提出来，是为了**能被离线断言**。
    // 之前它们长在 useMemo 里，只有真把 React 挂到浏览器上才跑得到，
    // 于是"分组对不对""筛选选得对不对"这类问题只能靠肉眼看——而肉眼刚刚
    // 已经放过一次 bug（三元少写 : null，整棵树渲染就炸）。
    // 现在：纯函数由 verify-render.mjs 穷举断言，组件只负责把结果画出来。
    //
    // 位置稳定仍然是第一原则：这两个函数的输出**不随证据/勾选变化**，
    // 变的只是"哪些行被筛进来了"。

    /** 工具表的行序：族 → 名字。两个字段都与勾选无关，所以行永远在原地。 */
    function toolGroups(items, q, filter) {
      var s = String(q || '').trim().toLowerCase()
      var list = items
      if (s) list = list.filter(function (i) { return String(i.name).toLowerCase().indexOf(s) >= 0 })
      if (filter === 'denied') list = list.filter(function (i) { return i.denied })
      if (filter === 'kept') list = list.filter(function (i) { return !i.denied })

      // 族的切分在宿主侧算（lib/capabilities.js）：成员够多的前缀才算族，
      // 其余归「核心」。这里只管排——核心在前，其余按字母，族内按名字。
      var sorted = list.slice().sort(function (a, b) {
        var fa = a.family || '核心'
        var fb = b.family || '核心'
        if (fa !== fb) {
          if (fa === '核心') return -1
          if (fb === '核心') return 1
          return fa < fb ? -1 : 1
        }
        return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)
      })

      var out = []
      var cur = null
      // ★ 组的下标必须单独记住，不能用 out[out.length - 1]。
      //   那是个真 bug（由 verify-render.mjs 第一次跑就抓到）：
      //   循环体先 push 行、下一轮再 push 组时，out 末尾已经是**行**了，
      //   于是 n++ 加到了行对象身上，而组标题里的计数恒为 1 ——
      //   界面上每个族都写着"1"，看着像"这些族各只有一条"，实际不是。
      var gi = -1
      for (var k = 0; k < sorted.length; k++) {
        var it = sorted[k]
        var fam = it.family || '核心'
        if (fam !== cur) { cur = fam; out.push({ kind: 'group', family: fam, n: 0, tokens: 0, denied: 0 }); gi = out.length - 1 }
        out[gi].n++
        // 折叠之后标题就是这一族**唯一**看得见的东西，所以它得自己把话说完：
        // 几条、多少 token、裁掉几条。少了这些，收起来等于什么都不知道。
        out[gi].tokens += Number(it.approxTokens) || 0
        if (it.denied) out[gi].denied++
        out.push({ kind: 'row', item: it })
      }
      return out
    }

    /**
     * 这一族现在是展开的吗？
     *
     * 默认**全部收起**。
     *
     * 一开始我让「核心」默认展开，量完才发现那个默认几乎没用：核心族是**最大**的
     * 一族（44 / 72 个工具），展开它等于没折 —— 6 屏变成 3.5 屏。
     * 收起全部之后一屏就能看全五族的条数与 token，要哪一族再点开。
     *
     * 收起不等于看不见：族标题自己带着（几个 / 多少 token / 裁掉几个），
     * 所以"先看全局再展开"这条路是通的，而不是"先看到一片空白"。
     */
    function familyOpen(fam, collapsed, forceOpen) {
      if (forceOpen) return true
      if (collapsed && Object.prototype.hasOwnProperty.call(collapsed, fam)) return collapsed[fam] === false
      return false
    }

    /**
     * 折叠后实际要渲染的行。**纯函数** —— 折叠逻辑不经过 React 也能被穷举断言。
     *
     * forceOpen（有搜索词或非默认筛选）时**一律展开**：
     * 搜到了却看不见，比不搜更糟 —— 人会以为"没有匹配"。
     */
    function toolRowsVisible(groups, opts) {
      var collapsed = (opts && opts.collapsed) || {}
      var forceOpen = !!(opts && opts.forceOpen)
      var out = []
      var cur = null
      for (var i = 0; i < groups.length; i++) {
        var g = groups[i]
        if (g.kind === 'group') { cur = g.family; out.push(g); continue }
        if (!familyOpen(cur, collapsed, forceOpen)) continue
        out.push(g)
      }
      return out
    }

    /** 知识表的筛选档。判据直接复用行内「证据」那一列的 cls —— 两处永远一致。 */
    var KFILTERS = [
      { id: 'all', label: '全部', test: function () { return true } },
      { id: 'confirmed', label: '已确认', test: function (p) { return p.cls === 'confirmed' } },
      { id: 'unconfirmed', label: '未确认', test: function (p) { return p.cls === 'unconfirmed' || p.cls === 'new' } },
      { id: 'suspect', label: '有反证', test: function (p) { return (p.suspect || 0) > 0 } },
      { id: 'quarantined', label: '已隔离', test: function (p) { return !!p.quarantined } },
    ]

    function filterById(list, id) {
      for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]
      return null
    }

    /**
     * 知识表的行序与筛选。
     *
     * ★ 排序键是 id，而 id 是页面身份——不随命中、不随确认、不随反证变。
     *   上一版按"需关注度"排（隔离 > 有嫌疑 > 未确认 > 其余），那四档全由
     *   证据决定，而证据每 8 秒轮询刷新一次：你展开一行读正文，下一轮询它
     *   就可能换位置。和工具表上修掉的是同一种病。
     */
    function knowledgeView(committed, filterId) {
      var sorted = committed.slice().sort(function (a, b) {
        var ia = String(a.id || ''), ib = String(b.id || '')
        return ia < ib ? -1 : (ia > ib ? 1 : 0)
      })
      var f = filterById(KFILTERS, filterId) || KFILTERS[0]
      return { sorted: sorted, shown: sorted.filter(f.test), filter: f }
    }

    /**
     * 页签的方向键移动。
     *
     * 列表很短，所以不做 roving tabindex —— 每个页签本身都能 Tab 到，
     * 方向键只是额外的加速路径（左右循环、Home/End 到两端）。
     * preventDefault 是必需的：否则方向键会顺带把整个面板滚一下，
     * 用户以为界面在抖。
     */
    function tabKeys(ids, current, select) {
      return function (e) {
        var i = ids.indexOf(current)
        if (i < 0) return
        var n = -1
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (i + 1) % ids.length
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (i - 1 + ids.length) % ids.length
        else if (e.key === 'Home') n = 0
        else if (e.key === 'End') n = ids.length - 1
        if (n < 0) return
        e.preventDefault()
        select(ids[n])
      }
    }

    // ── 能力：工具 + 技能 ─────────────────────────────────────────────────
    function ToolsSection(props) {
      // 折叠状态：族名 -> true 表示收起。用"记下被改过的那些"而不是记全部，
      // 因为默认规则是"只展开核心"，那是个规则不是一张表。
      var collapseState = useState({})
      var collapse = collapseState[0], setCollapse = collapseState[1]
      var cap = props.state.capabilities || {}
      var catalog = cap.catalog || {}
      var items = catalog.items || []
      var totals = cap.totals || {}
      var qState = useState('')
      var q = qState[0], setQ = qState[1]
      var busyState = useState(null)
      var busy = busyState[0], setBusy = busyState[1]
      var msgState = useState(null)
      var msg = msgState[0], setMsg = msgState[1]
      var filterState = useState('all')
      var filter = filterState[0], setFilter = filterState[1]
      // 乐观覆盖：name -> 期望的 denied。发请求**之前**就写进来，所以方框立刻翻。
      var optState = useState({})
      var opt = optState[0], setOpt = optState[1]

      var setOptKey = function (name, val) {
        setOpt(function (o) { var n = Object.assign({}, o); n[name] = val; return n })
      }
      var clearOptKey = function (name) {
        setOpt(function (o) {
          if (!Object.prototype.hasOwnProperty.call(o, name)) return o
          var n = Object.assign({}, o)
          delete n[name]
          return n
        })
      }

      // 勾选即写回 wiki.config.json。界面只动 explicitOnly 这一档，
      // diagnostics / deny 原样保留 —— 免得一次勾选把手工写好的精细配置冲掉。
      //
      // ★ 乐观更新：先把这一格翻过去，再发请求。
      //   之前是"等回来才翻"，于是每次点击的反馈延迟 = 一次网络往返。
      //   方向反过来之后：成功什么都不用做（轮询回来的真值与覆盖一致，
      //   覆盖由下面的 effect 自动撤销）；失败则撤销覆盖，并**说明这一格
      //   已经回滚** —— 不留一个骗人的勾。
      var toggle = function (name, keep) {
        var cur = (cap.configuredDeny || []).slice()
        var i = cur.indexOf(name)
        if (!keep && i < 0) cur.push(name)
        if (keep && i >= 0) cur.splice(i, 1)
        setBusy(name)
        setOptKey(name, !keep)
        post('/learn-wiki/api/capabilities', { enabled: true, explicitOnly: cur })
          .then(function (r) {
            setBusy(null)
            if (r.j && r.j.ok) { setMsg({ ok: true, text: '已写入 wiki.config.json — 下一次会话装配时生效' }); props.onChanged && props.onChanged() }
            else { clearOptKey(name); setMsg({ ok: false, text: '保存失败，这一格已回滚：' + (r.error || (r.j && r.j.error) || r.status) }) }
          })
          .catch(function (e) { setBusy(null); clearOptKey(name); setMsg({ ok: false, text: '保存失败，这一格已回滚：' + String((e && e.message) || e) }) })
      }

      // 覆盖一旦与轮询回来的真值一致就撤掉 ——
      // 否则它会永远盖着真值，别处（手改配置文件）的改动就再也看不见了。
      useEffect(function () {
        setOpt(function (o) {
          var next = null
          for (var k in o) {
            var it = null
            for (var j = 0; j < items.length; j++) if (items[j].name === k) { it = items[j]; break }
            if (it && !!it.denied === o[k]) { if (!next) next = Object.assign({}, o); delete next[k] }
          }
          return next || o
        })
      }, [items])

      // 分组 + 排序。
      //
      // ★ 顺序**不能随勾选变化**。上一版把裁掉的顶到最前面，于是你点一下
      //   方框，这一行就从指针底下消失了——点错了都找不回来。
      //   现在按 族 → 名字 排，这两个字段都不随勾选改变，所以行永远在原地。
      //   要强调"裁掉了"就靠行内状态和一个筛选器，不靠位置。
      //
      // 乐观覆盖**只在这一处**应用，然后整包交给纯函数：denied 不参与行序，
      // 所以勾选不会让任何一行换位置，变的只是"哪些行被筛进来"。
      var itemsEff = useMemo(function () {
        var any = false
        for (var k in opt) { any = true; break }
        if (!any) return items
        return items.map(function (i) {
          return Object.prototype.hasOwnProperty.call(opt, i.name)
            ? Object.assign({}, i, { denied: opt[i.name] })
            : i
        })
      }, [items, opt])

      var groups = useMemo(function () { return toolGroups(itemsEff, q, filter) }, [itemsEff, q, filter])
      var shownCount = groups.filter(function (g) { return g.kind === 'row' }).length
      // 有搜索词或非默认筛选时一律展开：搜到了却看不见，比不搜更糟 ——
      // 人会以为"没有匹配"，然后去改搜索词。
      // props.forceOpen 是**受控口子**（离线渲染/截图/测试用），与 PendingBar / TriageTab
      // 的受控模式同一套惯例。默认收起会让结构测试一行都渲染不出来。
      var forceOpen = !!(props && props.forceOpen) || !!q || filter !== 'all'
      var visibleGroups = useMemo(
        function () { return toolRowsVisible(groups, { collapsed: collapse, forceOpen: forceOpen }) },
        [groups, collapse, forceOpen],
      )
      var visibleRows = visibleGroups.filter(function (g) { return g.kind === 'row' }).length

      if (!catalog.capturedAt) {
        return h('div', { className: 'lw-sec' },
          h('div', { className: 'lw-sec-h' }, h('span', { className: 'lw-sec-t' }, '工具目录')),
          h('div', { className: 'lw-empty' },
            '目录快照还没捕获。能力包装配发生在会话创建时——开一次新会话，这里就会有数。'))
      }

      return h('div', { className: 'lw-sec' },
        h('div', { className: 'lw-sec-h' },
          h('span', { className: 'lw-sec-t' }, '工具'),
          h('span', { className: 'lw-sec-n' },
            '常驻 ' + num(totals.kept) + ' 个 · ' + tok(totals.keptTokens) + ' token'
            + '　裁掉 ' + num(totals.denied) + ' 个 · ' + tok(totals.deniedTokens) + ' token'),
          h('span', { className: 'lw-sec-n' }, '（共 ' + num(totals.total || items.length) + '）')
        ),
        h('div', { className: 'lw-bar' },
          h(Field, {
            className: 'lw-field',
            value: q,
            placeholder: '按名字筛工具…',
            onChange: function (e) { setQ(e && e.target ? e.target.value : '') },
            'aria-label': '筛选工具',
          }),
          q ? h(Btn, { size: 'sm', onClick: function () { setQ('') } }, '清除') : null
        ),
        // 全部展开 / 收起：默认全收起之后，想通览一遍的人需要一条路。
        // 没有它，"我要看全部"就只剩逐个点开五族。
        h('div', { className: 'lw-bar' },
          h(Btn, {
            size: 'sm',
            onClick: function () {
              setCollapse(function (c0) {
                var anyClosed = groups.some(function (g) {
                  return g.kind === 'group' && !familyOpen(g.family, c0, false)
                })
                var n = Object.assign({}, c0)
                for (var i = 0; i < groups.length; i++) {
                  if (groups[i].kind === 'group') n[groups[i].family] = anyClosed ? false : true
                }
                return n
              })
            },
          }, '全部展开 / 收起')
        ),
        // 用筛选器表达"我只看裁掉的"，而不是把裁掉的挪到最前面。
        // 位置一旦会动，你就再也点不准第二下了。
        h('div', { className: 'lw-bar' },
          [['all', '全部'], ['denied', '只看已裁'], ['kept', '只看常驻']].map(function (pair) {
            return h(Chip, {
              key: pair[0],
              active: filter === pair[0],
              onClick: function () { setFilter(pair[0]) },
            }, pair[1])
          }),
          h('span', { className: 'lw-sec-n', style: { marginLeft: 'auto' } },
            num(shownCount) + ' 行' + (visibleRows < shownCount ? '（收起中，显示 ' + num(visibleRows) + ' 行）' : ''))
        ),
        msg ? h('div', { className: 'lw-msg ' + (msg.ok ? 'ok' : 'err') }, msg.text) : null,
        h('table', { className: 'lw-table' },
          h('colgroup', null,
            h('col', { style: { width: '34px' } }),
            h('col', null),
            h('col', { style: { width: '92px' } })
          ),
          h('thead', null, h('tr', null,
            h('th', { className: 'lw-th' }, ''),
            h('th', { className: 'lw-th' }, '工具 / 用途'),
            h('th', { className: 'lw-th r' }, '约 token')
          )),
          h('tbody', null,
            groups.length
              ? visibleGroups.map(function (g, gi) {
                  if (g.kind === 'group') {
                    // 族提成组标题：说一次，而不是在每一行重复一遍。
                    // 顺带把那一列的宽度让给用途。
                    // 注意这里叫「族」不叫「来源」——DSH 的工具注册表不暴露归属插件
                    // （schemaOf 只投影 name/description/parameters），
                    // 命名族是从名字前缀推的，是事实但不是归属声明。
                    var shut = !familyOpen(g.family, collapse, forceOpen)
                    return h('tr', { key: 'g' + gi, className: 'lw-group' },
                      h('td', { className: 'lw-td', colSpan: 3 },
                        h('button', {
                          type: 'button',
                          className: 'lw-groupbtn',
                          'aria-expanded': shut ? 'false' : 'true',
                          // 折叠不是装饰：72 行 ≈ 6 屏，收起来才看得全。
                          title: shut ? '展开这一族' : '收起这一族',
                          onClick: function () {
                            setCollapse(function (c0) {
                              var n = Object.assign({}, c0)
                              n[g.family] = familyOpen(g.family, c0, false)   // 现在是开的 -> 收起
                              return n
                            })
                          },
                        },
                          h('span', { className: 'lw-group-chev' }, shut ? '▸' : '▾'),
                          h('span', { className: 'lw-group-name' }, g.family),
                          h('span', { className: 'lw-group-n' }, g.n + ' 个'),
                          h('span', { className: 'lw-group-n' }, tok(g.tokens)),
                          g.denied ? h('span', { className: 'lw-group-n' }, '已裁 ' + g.denied) : null)))
                  }
                  var i = g.item
                  return h('tr', { key: i.name, className: 'lw-tr' },
                    h('td', { className: 'lw-td' },
                      h('input', {
                        type: 'checkbox',
                        checked: !i.denied,
                        disabled: busy === i.name,
                        'aria-label': (i.denied ? '放回 ' : '裁掉 ') + i.name,
                        onChange: function () { toggle(i.name, i.denied) },
                      })),
                    h('td', { className: 'lw-td' },
                      h('div', { className: 'lw-2l' },
                        h('span', { className: 'lw-name' + (i.denied ? ' c-dim' : '') },
                          i.name,
                          // 状态用行内标记，不用位置。位置会动的话就没法连续操作了。
                          i.denied ? h('span', { className: 'lw-off' }, '已裁') : null),
                        i.purpose ? h('span', { className: 'lw-sub', title: i.purpose }, i.purpose) : null)),
                    h('td', { className: 'lw-td r' }, h('span', { className: 'lw-num' }, tok(i.approxTokens)))
                  )
                })
              : h('tr', null, h('td', { className: 'lw-td', colSpan: 3 },
                  h('span', { className: 'lw-empty' },
                    q ? '没有匹配「' + q + '」的工具'
                      : (filter === 'denied' ? '没有已裁的工具' : '没有常驻的工具')))))
        ),
        h('p', { className: 'lw-note' },
          '取消勾选 = 从默认工具表里裁掉，模型看不到它，也就不会再为它付 token。'
          + (cap.enabled ? '' : '（注意：能力包当前是关闭状态。）'))
      )
    }

    function SkillsSection(props) {
      var sk = props.state.skills || {}
      var items = sk.items || []
      var totals = sk.totals || {}
      var openState = useState(null)
      var open = openState[0], setOpen = openState[1]

      if (!sk.available) {
        return h('div', { className: 'lw-sec' },
          h('div', { className: 'lw-sec-h' }, h('span', { className: 'lw-sec-t' }, '技能')),
          h('div', { className: 'lw-empty' }, '读不到技能注册表：' + (sk.reason || '未知原因')))
      }

      var maxCat = items.reduce(function (m, i) { return Math.max(m, i.catalogTokens || 0) }, 0)
      var maxBody = items.reduce(function (m, i) { return Math.max(m, i.bodyTokens || 0) }, 0)

      // 「能读注册表，但一条也没有」曾经是最让人困惑的状态：
      // 它显示成一张空表，看起来像"你没装技能"。真实原因通常是**没带 agent 作用域**——
      // 技能 provider 挂在 preset 的作用域层，不带 scope 只看得见空的全局层。
      // 所以这个状态必须自己解释自己，不能静默。
      if (!items.length) {
        return h('div', { className: 'lw-sec' },
          h('div', { className: 'lw-sec-h' },
            h('span', { className: 'lw-sec-t' }, '技能'),
            h('span', { className: 'lw-sec-n' }, '0 个')
          ),
          h('div', { className: 'lw-empty' },
            '注册表答上来了，但里面一个技能也没有。',
            h('br', null),
            '这一页会扫描所有已注册的作用域层，所以不需要先开一次会话来"激活"它。',
            h('br', null),
            '技能从这些根目录读：项目内的 .dsh/skills 与 .agents/skills、',
            '以及用户级的 ~/.dsh/skills 与 ~/.agents/skills。')
        )
      }

      return h('div', { className: 'lw-sec' },
        h('div', { className: 'lw-sec-h' },
          h('span', { className: 'lw-sec-t' }, '技能'),
          h('span', { className: 'lw-sec-n' },
            num(totals.count) + ' 个 · 常驻目录 ' + tok(totals.catalogTokens) + ' token'
            + '　正文合计 ' + tok(totals.bodyTokens) + ' token'),
          // 顺序不写出来就会显得随意。这一页是按"每轮都在付的那笔"降序排的。
          h('span', { className: 'lw-sec-n' }, '按常驻成本降序')
        ),
        h('table', { className: 'lw-table' },
          h('colgroup', null,
            h('col', { style: { width: '26px' } }),
            h('col', null),
            h('col', { style: { width: '84px' } }),
            h('col', { style: { width: '84px' } }),
            h('col', { style: { width: '150px' } })
          ),
          h('thead', null, h('tr', null,
            h('th', { className: 'lw-th' }, ''),
            h('th', { className: 'lw-th' }, '技能'),
            h('th', { className: 'lw-th r' }, '常驻'),
            h('th', { className: 'lw-th r' }, '触发'),
            h('th', { className: 'lw-th' }, '来源')
          )),
          h('tbody', null, items.map(function (s) {
            var isOpen = open === s.name
            return [
              h('tr', {
                key: s.name,
                className: 'lw-tr x',
                'aria-expanded': isOpen,
                onClick: function () { setOpen(isOpen ? null : s.name) },
              },
                h('td', { className: 'lw-td' },
                  h('button', {
                    type: 'button',
                    className: 'lw-chevbtn',
                    'aria-expanded': isOpen,
                    'aria-label': (isOpen ? '收起技能 ' : '展开技能 ') + s.name,
                    onClick: function (e) { e.stopPropagation(); setOpen(isOpen ? null : s.name) },
                  }, h(Chev, { open: isOpen }))),
                h('td', { className: 'lw-td' },
                  h('div', { className: 'lw-2l' },
                    h('span', { className: 'lw-id' }, s.name),
                    s.description ? h('span', { className: 'lw-sub', title: s.description }, s.description) : null)),
                // 常驻 = 每轮都要背的目录摘要；触发 = 真正 skill() 调用时才付的正文。
                h('td', { className: 'lw-td r' }, h('span', { className: 'lw-num' }, tok(s.catalogTokens))),
                h('td', { className: 'lw-td r' }, h('span', { className: 'lw-num' }, s.bodyKnown ? tok(s.bodyTokens) : '—')),
                h('td', { className: 'lw-td' }, h('span', { className: 'lw-src', title: s.source }, s.source || '—'))
              ),
              isOpen ? h('tr', { key: s.name + ':d' }, h('td', { className: 'lw-td detail', colSpan: 5 },
                h('div', { className: 'lw-exp' },
                  h('div', { className: 'lw-meta' },
                    h('span', null, s.modelInvocable ? '模型可调用' : '模型不可调用'),
                    h('span', null, s.userInvocable ? '用户可调用' : '用户不可调用'),
                    h('span', null, '常驻 ' + tok(s.catalogTokens) + ' token'),
                    s.bodyKnown ? h('span', null, '正文 ' + tok(s.bodyTokens) + ' token') : null
                  ),
                  s.description ? h('div', { className: 'lw-note', style: { color: 'var(--lw-fg2)' } }, s.description) : null,
                  s.whenToUse ? h('div', { className: 'lw-note' }, '何时用：' + s.whenToUse) : null,
                  h('div', { style: { marginTop: '10px' } },
                    h('div', { className: 'lw-list' },
                      h(BarRow, { name: '常驻（每轮都付）', value: s.catalogTokens, max: maxCat, display: tok(s.catalogTokens) }),
                      h(BarRow, { name: '正文（调用才付）', value: s.bodyTokens, max: maxBody, display: s.bodyKnown ? tok(s.bodyTokens) : '未读到' })
                    )),
                  s.bodyError ? h('div', { className: 'lw-note c-bad' }, '正文读取失败：' + s.bodyError) : null,
                  s.bodyPreview
                    ? h('div', { style: { marginTop: '12px' } },
                        h('div', { className: 'lw-sec-n', style: { marginBottom: '4px' } }, '正文开头'),
                        h(Md, { text: s.bodyPreview }))
                    : null
                ))) : null
            ]
          }))
        ),
        h('p', { className: 'lw-note' },
          '常驻 = 技能名 + 描述，每一轮都在提示词里，不用也要付。触发 = SKILL.md 正文，'
          + '只有模型真的调用它才付一次。所以：描述写得长又从不用的技能，才是真正该改的那个。')
      )
    }

    /**
     * 能力页签的内部分段：工具／技能。
     *
     * 为什么分段：71 个工具 + 11 个技能首尾相接堆在一列里，得到的是一条
     * 很长的滚动条——而这两件事在**读的时候**从不同时有用：
     *   看工具 = "我该把哪个裁掉"（按族扫一遍，做的是减法）
     *   看技能 = "哪个技能的描述写太长"（按常驻成本降序，做的是归因）
     * 一次回答一个，两边都变短。
     *
     * 刻意不做成"折叠抽屉"：折叠会保留滚动位置，展开时你还得重新找自己在哪。
     * 分段是替换——切回来时位置由这一段的顶部重新开始，可预期。
     * 数字标在段上，所以不必点进去才知道另一边有多少。
     */
    function CapabilitiesTab(props) {
      var segState = useState((props && props.initialSeg) || 'tools')
      var seg = segState[0], setSeg = segState[1]
      var cap = props.state.capabilities || {}
      var sk = props.state.skills || {}
      var toolN = (cap.totals && cap.totals.total) || 0
      var skillN = (sk.totals && sk.totals.count) || 0
      var segs = [
        { id: 'tools', label: '工具 ' + num(toolN) },
        { id: 'skills', label: '技能 ' + num(skillN) },
      ]
      var segIds = segs.map(function (s) { return s.id })
      return h('div', null,
        h('div', {
          className: 'lw-seg', role: 'tablist', 'aria-label': '能力分段',
          onKeyDown: tabKeys(segIds, seg, setSeg),
        },
          segs.map(function (s) {
            return h(Chip, {
              key: s.id,
              active: seg === s.id,
              onClick: function () { setSeg(s.id) },
              // role/aria 显式写上：这是键盘用户唯一的"我在哪个分段"依据，
              // 光靠颜色在无样式渲染下什么也说明不了。
              role: 'tab',
              'aria-selected': seg === s.id,
            }, s.label)
          })
        ),
        seg === 'tools' ? h(ToolsSection, props) : h(SkillsSection, props)
      )
    }
    // ── 知识：可展开的活行 ────────────────────────────────────────────────
    function KnowledgeTab(props) {
      var k = props.state.knowledge || {}
      var committed = k.committed || []
      var staged = k.staged || []
      var openState = useState(null)
      var open = openState[0], setOpen = openState[1]
      var pagesState = useState({})
      var pages = pagesState[0], setPages = pagesState[1]
      var msgState = useState(null)
      var msg = msgState[0], setMsg = msgState[1]
      var busyState = useState(null)
      var busy = busyState[0], setBusy = busyState[1]
      var kfState = useState('all')
      var kFilter = kfState[0], setKFilter = kfState[1]

      var loadPage = useCallback(function (id) {
        setPages(function (p) {
          if (p[id]) return p
          var next = Object.assign({}, p)
          next[id] = { loading: true }
          return next
        })
        getJson(PAGE_API + '?id=' + encodeURIComponent(id))
          .then(function (r) {
            setPages(function (p) {
              var next = Object.assign({}, p)
              next[id] = (r.j && r.j.ok) ? { data: r.j } : { error: r.error || (r.j && r.j.error) || ('HTTP ' + r.status) }
              return next
            })
          })
          .catch(function (e) {
            setPages(function (p) {
              var next = Object.assign({}, p)
              next[id] = { error: String((e && e.message) || e) }
              return next
            })
          })
      }, [])

      var onRow = function (id) {
        var next = open === id ? null : id
        setOpen(next)
        if (next) loadPage(next)
      }

      // 乐观：点过"固化"就立刻把这条摆进「已固化」，标成"固化中…"。
      //
      // 固化要写文件再删 staged 文件，是这几处里最慢的一步；等它回来才动界面，
      // 感觉就像按钮没反应。所以先动界面 —— 但**不假装它已经完成**：
      // 它带着"固化中…"标记躺在表里，真值一到就换成真正的证据分类。
      // 失败则退回暂存并说明，不留一条假的已固化记录。
      var pendState = useState([])
      var pend = pendState[0], setPend = pendState[1]
      var dropPend = function (id) {
        setPend(function (l) { return l.filter(function (x) { return x !== id }) })
      }
      var commit = function (id) {
        setBusy(id)
        setPend(function (l) { return l.indexOf(id) >= 0 ? l : l.concat([id]) })
        post('/learn-wiki/api/commit', { id: id })
          .then(function (r) {
            setBusy(null)
            if (r.j && r.j.ok) { setMsg({ ok: true, text: '已固化 ' + id }); props.onChanged && props.onChanged() }
            else { dropPend(id); setMsg({ ok: false, text: '固化失败，已退回暂存：' + (r.error || (r.j && r.j.error) || r.status) }) }
          })
          .catch(function (e) { setBusy(null); dropPend(id); setMsg({ ok: false, text: '固化失败，已退回暂存：' + String((e && e.message) || e) }) })
      }

      // 把"固化中"的乐观行拼进已固化列表。
      // 真值一到，它**自动**消失——靠的是这里取差集（id 已在 committed 里就跳过），
      // 而不是"记得在某处删掉它"。忘了删的清理代码是 bug 的温床。
      var committedIds = {}
      for (var ci = 0; ci < committed.length; ci++) committedIds[committed[ci].id] = true
      var pendingRows = []
      for (var pi = 0; pi < pend.length; pi++) {
        var pid = pend[pi]
        if (committedIds[pid]) continue
        var sp = null
        for (var si = 0; si < staged.length; si++) if (staged[si].id === pid) { sp = staged[si]; break }
        if (!sp) continue
        pendingRows.push({
          id: sp.id, title: sp.title, category: sp.category,
          cls: 'unconfirmed', hits: 0, confirmed: 0, suspect: 0,
          sources: sp.sources, updated: null, created: null,
          quarantined: false, pending: true,
        })
      }
      var committedAll = committed.concat(pendingRows)
      var stagedShown = staged.filter(function (p) { return pend.indexOf(p.id) < 0 })

      // 已经出现在已固化里的 id 就从乐观集合里摘掉。
      // 摘不摘不影响上面那两条渲染（它们各自取差集），但会让 pend 无限长大 ——
      // 而一个永远不清理的集合，迟早会在某个没想到的地方咬人。
      useEffect(function () {
        setPend(function (l) {
          var keep = l.filter(function (id) { return !committedIds[id] })
          return keep.length === l.length ? l : keep
        })
      }, [committed])

      // 排序/筛选的实现在 knowledgeView（纯函数，见文件上方）——
      // 这样"顺序稳不稳""筛选选得对不对"可以被离线断言，不必靠肉眼看界面。
      var view = useMemo(function () { return knowledgeView(committedAll, kFilter) }, [committedAll, kFilter])
      var sorted = view.sorted
      var shown = view.shown
      var activeFilter = view.filter
      var counts = k.counts || {}
      var countOf = function (f) { return committedAll.filter(f.test).length }

      return h('div', null,
        h('div', { className: 'lw-sec' },
          h('div', { className: 'lw-sec-h' },
            h('span', { className: 'lw-sec-t' }, '已固化'),
            h('span', { className: 'lw-sec-n' }, num(committedAll.length) + ' 条 · 按 id 稳定排序'),
            h('span', { className: 'lw-sec-n' },
              Object.keys(counts).map(function (c) { return clsInfo(c).label + ' ' + counts[c] }).join(' · '))
          ),
          msg ? h('div', { className: 'lw-msg ' + (msg.ok ? 'ok' : 'err') }, msg.text) : null,
          // 筛选器把"我该先看哪些"变成一次点击，而不是一次重排。
          // 数字直接标在胶囊上——否则你得先点进去才知道那一档是空的。
          committed.length ? h('div', { className: 'lw-bar' },
            KFILTERS.map(function (f) {
              return h(Chip, {
                key: f.id,
                active: kFilter === f.id,
                onClick: function () { setKFilter(f.id) },
              }, f.label + ' ' + num(countOf(f)))
            }),
            h('span', { className: 'lw-sec-n', style: { marginLeft: 'auto' } }, num(shown.length) + ' 行')
          ) : null,
          shown.length ? h('table', { className: 'lw-table' },
            h('colgroup', null,
              h('col', { style: { width: '26px' } }),
              h('col', null),
              h('col', { style: { width: '96px' } }),
              h('col', { style: { width: '86px' } }),
              h('col', { style: { width: '58px' } }),
              h('col', { style: { width: '58px' } }),
              h('col', { style: { width: '58px' } })
            ),
            h('thead', null, h('tr', null,
              h('th', { className: 'lw-th' }, ''),
              h('th', { className: 'lw-th' }, '知识'),
              h('th', { className: 'lw-th' }, '证据'),
              h('th', { className: 'lw-th' }, '更新'),
              h('th', { className: 'lw-th r' }, '命中'),
              h('th', { className: 'lw-th r' }, '证实'),
              h('th', { className: 'lw-th r' }, '反证')
            )),
            h('tbody', null, shown.map(function (p) {
              var isOpen = open === p.id
              var ci = clsInfo(p.cls)
              var pg = pages[p.id]
              return [
                h('tr', {
                  key: p.id, className: 'lw-tr x', 'aria-expanded': isOpen,
                  onClick: function () { onRow(p.id) },
                },
                  // 展开控件是一个**真的 button**，不是"给 tr 挂个 onClick"。
                  // 行上的 onClick 只服务鼠标；键盘用户需要的是一个能 Tab 到、
                  // 能按 Enter/Space 的焦点目标 —— tr 不是。aria-expanded 挂在
                  // 它身上，于是"这一行是展开的还是收起的"对读屏也是可读的。
                  h('td', { className: 'lw-td' },
                    h('button', {
                      type: 'button',
                      className: 'lw-chevbtn',
                      'aria-expanded': isOpen,
                      'aria-label': (isOpen ? '收起 ' : '展开 ') + (p.title || p.id),
                      onClick: function (e) { e.stopPropagation(); onRow(p.id) },
                    }, h(Chev, { open: isOpen }))),
                  h('td', { className: 'lw-td', title: p.title },
                    h('span', null, p.title || p.id),
                    p.quarantined ? h('span', { className: 'lw-chip c-bad', style: { marginLeft: '8px' } }, '已隔离') : null),
                  // 乐观行不冒充已分类的证据：它是一个明确的过渡态。
                  h('td', { className: 'lw-td' },
                    p.pending
                      ? h('span', {
                          className: 'lw-chip c-warn',
                          title: '已提交，等宿主写出文件并确认——不是已经生效',
                        }, '固化中…')
                      : h('span', { className: ci.cls, style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
                          h(Dot, { state: ci.state, size: 8 }), ci.label)),
                  h('td', { className: 'lw-td' }, h('span', { className: 'lw-num' }, when(p.updated || p.created))),
                  h('td', { className: 'lw-td r' }, h('span', { className: 'lw-num' }, num(p.hits))),
                  h('td', { className: 'lw-td r' }, h('span', { className: 'lw-num c-ok' }, num(p.confirmed))),
                  h('td', { className: 'lw-td r' }, h('span', { className: 'lw-num' + (p.suspect > 0 ? ' c-bad' : '') }, num(p.suspect)))
                ),
                isOpen ? h('tr', { key: p.id + ':d' },
                  h('td', { className: 'lw-td detail', colSpan: 7 },
                    h('div', { className: 'lw-exp' }, h(PageDetail, { id: p.id, meta: p, page: pg, onRetry: function () { loadPage(p.id) } })))) : null
              ]
            }))
          ) : h('div', { className: 'lw-empty' },
            committedAll.length
              ? '当前筛选（' + activeFilter.label + '）下没有条目。' + num(committedAll.length) + ' 条已固化知识里没有符合这一档的——换个筛选看看。'
              : (stagedShown.length < staged.length
                  ? '正在固化——写文件完成后这条会出现在这里。'
                  : '还没有已固化的知识。'))
        ),
        h('div', { className: 'lw-sec' },
          h('div', { className: 'lw-sec-h' },
            h('span', { className: 'lw-sec-t' }, '暂存'),
            h('span', { className: 'lw-sec-n' }, num(stagedShown.length) + ' 条'),
            h('span', { className: 'lw-sec-n' }, '不参与自动召回，固化后才算数')
          ),
          stagedShown.length ? h('table', { className: 'lw-table' },
            h('colgroup', null,
              h('col', null),
              h('col', { style: { width: '92px' } }),
              h('col', { style: { width: '132px' } }),
              h('col', { style: { width: '96px' } })
            ),
            h('thead', null, h('tr', null,
              h('th', { className: 'lw-th' }, '知识'),
              h('th', { className: 'lw-th' }, '类别'),
              h('th', { className: 'lw-th' }, '缺口'),
              h('th', { className: 'lw-th r' }, '')
            )),
            h('tbody', null, stagedShown.map(function (p) {
              var blocked = (p.blockers || []).length > 0
              return h('tr', { key: p.id, className: 'lw-tr' },
                h('td', { className: 'lw-td', title: p.title },
                  h('span', null, p.title || p.id),
                  h('span', { className: 'lw-src', style: { marginLeft: '8px' } }, p.id)),
                h('td', { className: 'lw-td' }, h('span', { className: 'lw-num' }, p.category || '—')),
                h('td', { className: 'lw-td' },
                  blocked
                    ? h('span', { className: 'c-bad', title: (p.blockers || []).join('、') }, (p.blockers || [])[0])
                    : h('span', { className: 'c-3' }, (p.sources || 0) + ' 个来源')),
                h('td', { className: 'lw-td r' },
                  h(Btn, {
                    size: 'sm', variant: blocked ? 'ghost' : 'primary',
                    disabled: blocked || busy === p.id,
                    title: blocked ? '不满足固化条件：' + (p.blockers || []).join('、') : '升入已固化，开始参与召回',
                    onClick: function () { commit(p.id) },
                  }, busy === p.id ? '处理中' : '固化'))
              )
            }))
          ) : h('div', { className: 'lw-empty' }, '暂存区是空的。')
        )
      )
    }

    /** 展开行里的正文。按需取，取过就留着。 */
    function PageDetail(props) {
      var pg = props.page
      var m = props.meta || {}
      if (!pg || pg.loading) {
        return h('div', null, h('div', { className: 'lw-meta' }, h('span', null, '读取正文…')))
      }
      if (pg.error) {
        return h('div', null,
          h('div', { className: 'lw-meta' }, h('span', { className: 'c-bad' }, '读不到正文：' + pg.error)),
          h(Btn, { size: 'sm', onClick: props.onRetry }, '重试'))
      }
      var d = pg.data || {}
      var srcs = d.sources || []
      return h('div', null,
        h('div', { className: 'lw-meta' },
          h('span', { className: 'lw-id' }, d.id),
          h('span', null, d.category || '—'),
          d.confidence != null ? h('span', null, '置信 ' + d.confidence) : null,
          h('span', null, '创建 ' + String(d.created || '').slice(0, 10)),
          h('span', null, d.updated ? '更新 ' + String(d.updated).slice(0, 10) : null),
          h('span', null, '命中 ' + num(d.usage && d.usage.hits)
            + ' · 证实 ' + num(d.usage && d.usage.confirmed)
            + ' · 反证 ' + num(d.usage && d.usage.suspect)),
          m.factor != null ? h('span', null, '强化系数 x' + m.factor) : null
        ),
        h(Md, { text: d.body || '' }),
        srcs.length ? h('ul', { className: 'lw-srclist' }, srcs.map(function (u, i) {
          var href = /^https?:/i.test(String(u)) ? String(u) : null
          return h('li', { key: i },
            Ico('IconLinkOutline14', 14),
            href
              ? h('a', { href: href, target: '_blank', rel: 'noreferrer noopener', title: u }, u)
              : h('span', { className: 'lw-src', title: String(u) }, String(u)))
        })) : h('p', { className: 'lw-note c-bad' }, '这条知识没有来源。')
      )
    }
    // ── 补料 ──────────────────────────────────────────────────────────────
    /**
     * 「从会话提炼」—— wiki_harvest 的触发按键。
     *
     * ── 为什么需要一个按钮 ──
     *
     * 这个插件原本只有两个触发器，都是关于**我们自己失败**的信号（检索未命中、
     * 挣扎）。它们发现不了第三种、也是最值钱的一种：**我们刚刚想清楚了一件事**。
     * 实测过：一次会话里用户亲口说出了一条设计规则，一行都没被沉淀。
     *
     * 模型可以自己调 wiki_harvest，但那要求它**意识到**"刚才那句值得留" ——
     * 而那正是它最容易漏掉的判断。按钮把这个判断交回给人：人知道哪一段值得留。
     *
     * ── 它不动用任何特权 ──
     * 产出照样只落 staged/，固化仍然要人去「知识」页签点。按钮不是免检通道。
     */
    function HarvestSection(props) {
      var lm = (props.state && props.state.llm) || {}
      var last = lm.lastHarvest || null
      var focusState = useState('')
      var focus = focusState[0], setFocus = focusState[1]
      var busyState = useState(false)
      var busy = busyState[0], setBusy = busyState[1]
      var msgState = useState(null)
      var msg = msgState[0], setMsg = msgState[1]
      var used = (lm.lastUsed && lm.lastUsed.harvest) || null
      var siteCfg = (lm.sites && lm.sites.harvest) || null
      var mode = (siteCfg && siteCfg.mode) || lm.mode || 'single'
      var cands = (siteCfg && siteCfg.models) || lm.models || []
      var describe = function (m) { return m.provider + '/' + (m.model || '（该 provider 列出的第一个）') }
      // ★ 必须写出**具体哪个模型**，不能只写"单一模式"。
      //   这个按键按下去就是一次真实的模型调用（花钱、花时间），
      //   而"模式"回答不了"我会问谁"。轮换就把整圈候选都列出来。
      var willAsk = cands.length === 0
        ? '宿主默认模型'
        : (mode === 'rotate'
            ? '轮换 ' + cands.length + ' 个候选（' + cands.map(describe).join('、') + '）'
            : describe(cands[0]))

      var run = function () {
        setBusy(true); setMsg(null)
        post(HARVEST_API, { focus: focus })
          .then(function (r) {
            setBusy(false)
            if (!r.j || !r.j.ok) {
              setMsg({ ok: false, text: '提炼失败：' + (r.error || (r.j && r.j.error) || ('HTTP ' + r.status)) })
              return
            }
            if (r.j.skipped) {
              // 拒绝是**正常结果**，不是错误。措辞必须让人不觉得"失败了"，
              // 否则下一次他会为了凑出一页而去降低标准。
              setMsg({ ok: true, text: '没有值得长期保留的东西：' + r.j.reason + '（这是正常的，拒绝优于写一页没有依据的）' })
            } else {
              setMsg({
                ok: true,
                text: '提炼出 ' + r.j.staged.length + ' 页，已落暂存区'
                  + ((r.j.duplicates && r.j.duplicates.length) ? '，跳过 ' + r.j.duplicates.length + ' 条重复' : '')
                  + '。去「知识」页签固化 —— 固化前不参与召回。',
              })
            }
            props.onChanged && props.onChanged()
          })
      }

      return h('div', { className: 'lw-sec' },
        h('div', { className: 'lw-sec-h' },
          h('span', { className: 'lw-sec-t' }, '从会话提炼'),
          h('span', { className: 'lw-sec-n' }, '第三个触发器：前两个只能发现"我们失败了"，这个发现"我们刚想清楚了一件事"')
        ),
        h('div', { className: 'lw-row' },
          h(Field, {
            className: 'lw-grow',
            placeholder: '只提炼某个方面（可留空，留空则由模型自己判断哪句值得留）',
            value: focus,
            onChange: function (e) { setFocus(e.target.value) },
            disabled: busy,
          }),
          h(Btn, { onClick: run, disabled: busy }, busy ? '提炼中…' : '提炼这段会话')
        ),
        h('div', { className: 'lw-ml-note' },
          '会问：' + willAsk
          + (used ? '　上次实际用：' + used.provider + '/' + used.model : '')
          + '　（在「模型」页签里改）'
        ),
        last
          ? h('div', { className: 'lw-ml-note' },
              '上次：' + when(last.at) + ' · ' + (last.target || '—') + ' · '
              + (last.skipped ? ('未产出（' + (last.reason || '') + '）') : ('产出 ' + num(last.staged) + ' 页' + (last.duplicates ? '，重复 ' + num(last.duplicates) : ''))))
          : null,
        msg ? h('div', { className: 'lw-msg ' + (msg.ok ? 'ok' : 'err') }, msg.text) : null
      )
    }

    function SupplyTab(props) {
      var g = props.state.gaps || {}
      var st = props.state.struggles || {}
      var gc = g.counts || {}
      var sc = st.counts || {}
      var sigKeys = Object.keys(sc)
      var maxSig = sigKeys.reduce(function (m, k2) { return Math.max(m, sc[k2]) }, 0)
      var recent = g.recent || []

      return h('div', null,
        h(HarvestSection, props),
        h('div', { className: 'lw-sec' },
          h('div', { className: 'lw-sec-h' },
            h('span', { className: 'lw-sec-t' }, '挣扎信号'),
            h('span', { className: 'lw-sec-n' }, '共 ' + num(st.total) + ' 次记录'),
            // 子代理的那部分单独报。它们记在同一个文件里，但**不产生后果**：
            // 子代理是临时工，它卡住多半说明"我派活的提示词没写好"，
            // 不说明"项目知识不够用"。两者混进同一个数字会让人把结论搞反。
            st.subagent > 0
              ? h('span', {
                  className: 'lw-sec-n',
                  title: '子代理的挣扎只记录：不记嫌疑、不进 gap 队列、不触发联网',
                }, '其中子代理 ' + num(st.subagent) + ' 次（不产生后果）')
              : null,
            h('span', { className: 'lw-sec-n' }, '这才是补料的触发器')
          ),
          sigKeys.length
            ? h('div', { className: 'lw-list' }, sigKeys.map(function (k2) {
                return h(BarRow, {
                  key: k2,
                  name: SIG[k2] || k2,
                  value: sc[k2],
                  max: maxSig,
                  tone: (k2 === 'repeat-failure' || k2 === 'recurring-error') ? 'bad' : null,
                })
              }))
            : h('div', { className: 'lw-empty' }, '还没有挣扎记录。')
        ),
        h('div', { className: 'lw-sec' },
          h('div', { className: 'lw-sec-h' },
            h('span', { className: 'lw-sec-t' }, '缺口队列'),
            h('span', { className: 'lw-sec-n' },
              '待处理 ' + num(gc.pending) + ' · 已产出 ' + num(gc.done) + ' · 放弃 ' + num(gc.skipped))
          ),
          recent.length ? h('table', { className: 'lw-table' },
            h('colgroup', null,
              h('col', { style: { width: '84px' } }),
              h('col', null)
            ),
            h('thead', null, h('tr', null,
              h('th', { className: 'lw-th' }, '状态'),
              h('th', { className: 'lw-th' }, '查询')
            )),
            h('tbody', null, recent.map(function (x, i) {
              var tone = x.status === 'done' ? 'c-ok' : x.status === 'pending' ? 'c-warn' : 'c-dim'
              return h('tr', { key: i, className: 'lw-tr' },
                h('td', { className: 'lw-td' }, h('span', { className: tone }, x.status)),
                h('td', { className: 'lw-td', title: x.query }, x.query))
            }))
          ) : h('div', { className: 'lw-empty' }, '队列是空的。')
        ),
        h('div', { className: 'lw-sec' },
          h('div', { className: 'lw-sec-h' }, h('span', { className: 'lw-sec-t' }, '最近判定')),
          (st.recent || []).length
            ? h('table', { className: 'lw-table' },
                h('colgroup', null, h('col', { style: { width: '110px' } }), h('col', null)),
                h('thead', null, h('tr', null,
                  h('th', { className: 'lw-th' }, '时间'),
                  h('th', { className: 'lw-th' }, '信号'))),
                h('tbody', null, (st.recent || []).slice().reverse().map(function (r, i) {
                  return h('tr', { key: i, className: 'lw-tr' },
                    h('td', { className: 'lw-td' }, h('span', { className: 'lw-num' }, when(r.ts))),
                    h('td', { className: 'lw-td' }, (r.signals || []).map(function (s) { return SIG[s] || s }).join('、')))
                })))
            : h('div', { className: 'lw-empty' }, '（无）')
        )
      )
    }
    // ── 模型：谁在问哪个模型，以及轮换还是单一 ────────────────────────────
    //
    // 为什么值得单独一个页签：这个插件的**全部成本**就是模型调用（后台蒸馏 +
    // 会话提炼），而"它到底会问谁"以前是代码里的一个常量，改一次要重载插件。
    //
    // 界面显示两样东西，**刻意分开**：
    //   配置里"下一次会问谁"  ← 你点出来的
    //   上一次**实际**问了谁  ← 真的发生了的
    // 只看前者，一个写错 provider 名字的条目会让人以为轮换在用三个模型。

    /** 一份候选列表的编辑器：模式 + 有序候选 + 增删移。 */
    function ModelListEditor(props) {
      var sel = props.value || { mode: 'single', models: [] }
      var providers = props.providers || []
      var models = sel.models || []
      var addState = useState({ provider: '', model: '' })
      var add = addState[0], setAdd = addState[1]

      var emit = function (nextMode, nextModels) {
        props.onChange({ mode: nextMode || sel.mode, models: nextModels || models })
      }
      var move = function (i, d) {
        var n = models.slice()
        var j = i + d
        if (j < 0 || j >= n.length) return
        var t = n[i]; n[i] = n[j]; n[j] = t
        emit(null, n)
      }
      var drop = function (i) { var n = models.slice(); n.splice(i, 1); emit(null, n) }
      var push = function () {
        if (!add.provider) return
        var n = models.concat([{ provider: add.provider, model: add.model || '' }])
        emit(null, n)
        setAdd({ provider: add.provider, model: '' })
      }
      var cur = null
      for (var i = 0; i < providers.length; i++) if (providers[i].id === add.provider) cur = providers[i]
      var label = function (m) {
        return m.provider + '/' + (m.model || '（该 provider 列出的第一个）')
      }

      return h('div', { className: 'lw-mledit' },
        h('div', { className: 'lw-row' },
          h('span', { className: 'lw-ml-t' }, '模式'),
          h('span', { className: 'lw-seg' },
            h(Chip, { active: sel.mode !== 'rotate', onClick: function () { emit('single') } }, '单一'),
            h(Chip, { active: sel.mode === 'rotate', onClick: function () { emit('rotate') } }, '轮换')
          ),
          h('span', { className: 'lw-ml-note' }, sel.mode === 'rotate'
            ? '每次调用换下一个（按列表顺序循环）'
            : '每次都问列表里的第一个')
        ),
        models.length
          ? h('ol', { className: 'lw-mlist' }, models.map(function (m, i) {
              return h('li', { key: i, className: 'lw-mitem' },
                h('span', { className: 'lw-midx' }, String(i + 1)),
                h('span', { className: 'lw-mname', title: label(m) }, label(m)),
                // 轮换模式下"第一个"是单一模式的落点，值得标出来
                (sel.mode !== 'rotate' && i === 0) ? h('span', { className: 'lw-mtag' }, '单一模式用这个') : null,
                h('span', { className: 'lw-mact' },
                  h('button', { type: 'button', className: 'lw-mini', onClick: function () { move(i, -1) }, disabled: i === 0, title: '上移' }, '↑'),
                  h('button', { type: 'button', className: 'lw-mini', onClick: function () { move(i, 1) }, disabled: i === models.length - 1, title: '下移' }, '↓'),
                  h('button', { type: 'button', className: 'lw-mini', onClick: function () { drop(i) }, title: '移除' }, '×')
                )
              )
            }))
          : h('div', { className: 'lw-empty' }, '没有候选 —— 跟随宿主默认模型（DSH 当前的默认路由）。'),
        h('div', { className: 'lw-row' },
          h('span', { className: 'lw-ml-t' }, '添加'),
          h('select', {
            className: 'lw-sel',
            value: add.provider,
            onChange: function (e) { setAdd({ provider: e.target.value, model: '' }) },
          },
            h('option', { value: '' }, '选择 provider…'),
            providers.map(function (p) { return h('option', { key: p.id, value: p.id }, p.name || p.id) })
          ),
          h('select', {
            className: 'lw-sel',
            value: add.model,
            disabled: !add.provider,
            onChange: function (e) { setAdd({ provider: add.provider, model: e.target.value }) },
          },
            h('option', { value: '' }, (cur && cur.models && cur.models.length) ? '（第一个：' + cur.models[0].id + '）' : '（该 provider 默认）'),
            ((cur && cur.models) || []).map(function (m) { return h('option', { key: m.id, value: m.id }, m.name || m.id) })
          ),
          h(Btn, { onClick: push, disabled: !add.provider }, '加入候选')
        ),
        // 写错 provider 名字的条目会被运行时丢掉。**必须在这里说**，
        // 否则用户以为轮换在用三个模型，实际只有一个。
        (props.rejected && props.rejected.length)
          ? h('div', { className: 'lw-msg warn' }, '有 ' + props.rejected.length + ' 个候选被丢掉了：'
              + props.rejected.map(function (r) { return r.provider + '（' + r.why + '）' }).join('、'))
          : null
      )
    }

    /**
     * 草稿从**轮询回来的真值**起手，之后由用户编辑。
     *
     * 用惰性初始化而不是 useEffect：服务端渲染不跑 effect，用 effect 的话
     * 首帧永远是"读取中…"，界面上闪一下，而且离线渲染测试什么都测不到。
     * 没有草稿时显示的始终是服务端的值，所以手改配置文件也看得见。
     */
    function buildLlmDraft(st, sites) {
      var base = { mode: st.mode || 'single', onError: st.onError || 'next', sites: {} }
      for (var i = 0; i < sites.length; i++) {
        var s = st.sites && st.sites[sites[i].id]
        base.sites[sites[i].id] = {
          mode: (s && s.mode) || base.mode,
          models: ((s && s.models) || st.models || []).map(function (m) {
            return { provider: m.provider || '', model: m.model || '' }
          }),
        }
      }
      return base
    }

    function ModelsTab(props) {
      var st = (props.state && props.state.llm) || {}
      var sites = st.siteList || [
        { id: 'distill', label: '蒸馏（联网补料）' },
        { id: 'harvest', label: '提炼（会话）' },
      ]
      var draftState = useState(function () { return buildLlmDraft(st, sites) })
      var draft = draftState[0], setDraft = draftState[1]
      var catState = useState(null)   // { providers, routes } —— 按需拉，不进轮询
      var cat = catState[0], setCat = catState[1]
      var errState = useState(null)
      var err = errState[0], setErr = errState[1]
      var msgState = useState(null)
      var msg = msgState[0], setMsg = msgState[1]
      var busyState = useState(false)
      var busy = busyState[0], setBusy = busyState[1]

      var loadCat = useCallback(function () {
        getJson(MODELS_API).then(function (r) {
          if (r.j && r.j.ok) { setCat(r.j); setErr(null) } else setErr(r.error || (r.j && r.j.error) || ('HTTP ' + r.status))
        })
      }, [])
      useEffect(function () { loadCat() }, [loadCat])

      var setSite = function (id, v) {
        setDraft(function (d) {
          var n = Object.assign({}, d)
          n.sites = Object.assign({}, d.sites)
          n.sites[id] = v
          return n
        })
        setMsg(null)
      }
      var copyTo = function (from, to) {
        setDraft(function (d) {
          var n = Object.assign({}, d)
          n.sites = Object.assign({}, d.sites)
          n.sites[to] = { mode: d.sites[from].mode, models: d.sites[from].models.map(function (m) { return { provider: m.provider, model: m.model } }) }
          return n
        })
        setMsg(null)
      }
      var save = function () {
        setBusy(true)
        // 根块取第一个站点的内容当**默认**：以后新加的调用点不会落在一个谁也没配过的形状上。
        var first = draft.sites[sites[0].id] || { mode: 'single', models: [] }
        post(LLM_API, {
          mode: first.mode, models: first.models, onError: draft.onError, sites: draft.sites,
        }).then(function (r) {
          setBusy(false)
          if (r.j && r.j.ok) {
            setMsg({ ok: true, text: (r.j.note || '已保存') })
            setCat(function (c) { return c ? Object.assign({}, c, { routes: r.j.routes }) : c })
            props.onChanged && props.onChanged()
          } else setMsg({ ok: false, text: '保存失败：' + (r.error || (r.j && r.j.error) || r.status) })
        })
      }

      var providers = (cat && cat.providers) || []
      var routes = (cat && cat.routes) || {}

      return h('div', null,
        h('div', { className: 'lw-sec' },
          h('div', { className: 'lw-sec-h' },
            h('span', { className: 'lw-sec-t' }, '谁在问模型'),
            h('span', { className: 'lw-sec-n' }, '这个插件的全部成本就是模型调用')
          ),
          h('table', { className: 'lw-table' },
            h('colgroup', null,
              h('col', { style: { width: '150px' } }),
              h('col', { style: { width: '70px' } }),
              h('col', null)
            ),
            h('thead', null, h('tr', null,
              h('th', { className: 'lw-th' }, '环节'),
              h('th', { className: 'lw-th' }, '模式'),
              h('th', { className: 'lw-th' }, '上一次实际用的')
            )),
            h('tbody', null, sites.map(function (s) {
              var used = (st.lastUsed && st.lastUsed[s.id]) || null
              var d = draft.sites[s.id] || { mode: 'single', models: [] }
              return h('tr', { key: s.id, className: 'lw-tr' },
                h('td', { className: 'lw-td' }, s.label),
                h('td', { className: 'lw-td' }, h('span', { className: d.mode === 'rotate' ? 'c-info' : 'c-dim' }, d.mode === 'rotate' ? '轮换' : '单一')),
                h('td', { className: 'lw-td' }, used
                  ? h('span', { className: 'lw-num', title: '第 ' + (used.tries || 1) + ' 个候选成功' }, used.provider + '/' + used.model)
                  : h('span', { className: 'c-dim' }, '还没调用过'))
              )
            }))
          )
        ),

        h('div', { className: 'lw-sec' },
          h('div', { className: 'lw-sec-h' },
            h('span', { className: 'lw-sec-t' }, '失败怎么办'),
            h('span', { className: 'lw-sec-n' }, '一次后台补料失败就丢掉一次采集机会，所以默认往下试')
          ),
          h('div', { className: 'lw-seg' },
            h(Chip, { active: draft.onError !== 'fail', onClick: function () { setDraft(Object.assign({}, draft, { onError: 'next' })); setMsg(null) } }, '失败就换下一个'),
            h(Chip, { active: draft.onError === 'fail', onClick: function () { setDraft(Object.assign({}, draft, { onError: 'fail' })); setMsg(null) } }, '失败就认')
          )
        ),

        err ? h('div', { className: 'lw-msg err' }, '拿不到模型目录：' + err + '　（' + MODELS_API + '）') : null,

        sites.map(function (s, i) {
          var r = routes[s.id] || null
          return h('div', { key: s.id, className: 'lw-sec' },
            h('div', { className: 'lw-sec-h' },
              h('span', { className: 'lw-sec-t' }, s.label),
              r && r.next
                ? h('span', { className: 'lw-sec-n' }, '下一次：' + r.next.provider + '/' + r.next.model + (r.configured ? '' : '（跟随宿主默认）'))
                : null,
              i > 0
                ? h('button', {
                    type: 'button', className: 'lw-mini lw-copy',
                    onClick: function () { copyTo(sites[0].id, s.id) },
                    title: '把「' + sites[0].label + '」这份复制过来',
                  }, '同' + sites[0].label.slice(0, 2))
                : null
            ),
            h(ModelListEditor, {
              value: draft.sites[s.id],
              providers: providers,
              rejected: r && r.rejected,
              onChange: function (v) { setSite(s.id, v) },
            })
          )
        }),

        h('div', { className: 'lw-row lw-savebar' },
          h(Btn, { onClick: save, disabled: busy }, busy ? '保存中…' : '保存'),
          h('span', { className: 'lw-ml-note' }, '写进 wiki.config.json。下一次模型调用即生效，不需要重载插件。'),
          msg ? h('span', { className: 'lw-msg ' + (msg.ok ? 'ok' : 'err') }, msg.text) : null
        )
      )
    }

    // ── 外壳 ──────────────────────────────────────────────────────────────
    var TABS = [
      { id: 'capabilities', label: '能力' },
      { id: 'knowledge', label: '知识' },
      { id: 'triage', label: '分拣' },
      { id: 'supply', label: '补料' },
      { id: 'models', label: '模型' },
    ]

    function tabsSummary(tab, s) {
      if (!s) return ''
      if (tab === 'capabilities') {
        var t = (s.capabilities && s.capabilities.totals) || {}
        var sk = (s.skills && s.skills.totals) || {}
        return '工具 ' + num(t.kept) + '/' + num(t.total)
          + ' · ' + tok(t.keptTokens) + ' token'
          + '　技能 ' + num(sk.count)
      }
      if (tab === 'knowledge') {
        var k = s.knowledge || {}
        return '已固化 ' + num((k.committed || []).length)
          + ' · 暂存 ' + num((k.staged || []).length)
      }
      if (tab === 'triage') {
        var tr = s.triage || {}
        return '回收站 ' + num(tr.trash) + ' · 已拒绝 ' + num(tr.rejected)
      }
      if (tab === 'supply') {
        var g = s.gaps || {}
        return '缺口 ' + num(g.total) + ' · 挣扎 ' + num((s.struggles || {}).total)
      }
      if (tab === 'models') {
        var lm = s.llm || {}
        var u = (lm.lastUsed && lm.lastUsed.distill) || null
        return (lm.mode === 'rotate' ? '轮换' : '单一')
          + ' · ' + num((lm.models || []).length) + ' 个候选'
          + (u ? '　上次 ' + u.provider + '/' + u.model : '')
      }
      // ★ 未知页签返回空，**不要**落到某个默认分支上。
      //   原来这里直接 return 补料的数字，于是新加的"分拣"页签头上会写着
      //   "缺口 8 · 挣扎 50" —— 一个自信地显示错误数字的界面比空着更糟。
      return ''
    }

    function PanelBody(props) {
      // 受控模式：调用方直接给 state（离线渲染与截图用）。
      // 不给就照旧自己拉 —— 那条路径才是桌面里真正跑的。
      var controlled = !!(props && props.state)
      var tabState = useState((props && props.initialTab) || 'capabilities')
      var tab = tabState[0], setTab = tabState[1]
      var stState = useState(controlled ? props.state : null)
      var state = controlled ? props.state : stState[0]
      var setState = stState[1]
      var errState = useState(null)
      var err = errState[0], setErr = errState[1]

      var load = useCallback(function () {
        // 受控模式不发请求：离线渲染里没有 fetch，也不该去打扰真实端点。
        if (controlled) return
        getJson(API)
          .then(function (r) {
            if (!r.j || !r.j.ok) throw new Error(r.error || (r.j && r.j.error) || ('HTTP ' + r.status))
            setState(r.j); setErr(null)
          })
          .catch(function (e) { setErr(String((e && e.message) || e)) })
      }, [controlled])

      useEffect(function () {
        if (controlled) return
        load()
        // 只在可见时轮询：后台窗口每 8 秒打一次接口没有意义。
        var t = setInterval(function () {
          if (typeof document === 'undefined' || document.visibilityState !== 'hidden') load()
        }, 8000)
        return function () { clearInterval(t) }
      }, [load, controlled])

      return h('div', { className: 'lw-shell' },
        h('div', { className: 'lw-head' },
          h('span', { className: 'lw-headicon' }, Ico('IconSkillOutline16', 16)),
          h('span', { className: 'lw-title' }, 'learn-wiki'),
          // state 存在但 app 缺失是会发生的（接口半途出错、离线渲染）。
          // 直接取 state.app.wikiRoot 会当场抛，整棵树跟着完蛋。
          h('span', {
            className: 'lw-path',
            title: (state && state.app && state.app.wikiRoot) || '',
          }, (state && state.app && state.app.wikiRoot) || (state ? '（没有 wikiRoot）' : '连接中…'))
        ),
        h('div', {
          className: 'lw-tabs',
          role: 'tablist',
          'aria-label': 'learn-wiki 页签',
          onKeyDown: tabKeys(TABS.map(function (t) { return t.id }), tab, setTab),
        },
          TABS.map(function (t) {
            return h(Chip, {
              key: t.id,
              active: tab === t.id,
              onClick: function () { setTab(t.id) },
              role: 'tab',
              'aria-selected': tab === t.id,
            }, t.label)
          }),
          h('span', { className: 'lw-tabsum' }, tabsSummary(tab, state))
        ),
        h('div', { className: 'lw-body lw-scroll' },
          err
            ? h('div', { className: 'lw-msg err' }, '读不到状态：' + err + '　（/learn-wiki/api/state）')
            : !state
              ? h('div', { className: 'lw-empty' }, '读取中…')
              : tab === 'capabilities'
                ? h(CapabilitiesTab, { state: state, onChanged: load, initialSeg: props.initialSeg })
                : tab === 'knowledge' ? h(KnowledgeTab, { state: state, onChanged: load })
                  : tab === 'triage' ? h(TriageTab, { onChanged: load })
                    : tab === 'models' ? h(ModelsTab, { state: state, onChanged: load })
                      : h(SupplyTab, { state: state, onChanged: load })
        )
      )
    }

    /**
     * 面板外壳：自绘遮罩 + 自绘面板。
     *
     * 为什么不用 DSH 的 Modal 原语：它的 .dialog 写死 width:min(380px,100%)，
     * 是 RiskConfirmation 那一档确认框的尺寸。这张表要 1040px。硬覆盖它的
     * 宽度就得靠注入样式的先后顺序压过 CSS module，脆得很——不如各用各的。
     * 但面板内部一切控件仍用原语，所以看起来依然是 DSH 的一部分。
     */
    function Workbench(props) {
      ensureStyle()
      var ref = useRef(null)
      // 开着的时候把焦点收进来，关掉还回去——否则键盘用户会掉在页面的某个角落。
      useEffect(function () {
        var prev = document.activeElement
        try { ref.current && ref.current.focus && ref.current.focus() } catch (e) {}
        return function () { try { prev && prev.focus && prev.focus() } catch (e) {} }
      }, [])

      /**
       * 焦点圈：Tab 不许跑出这个面板。
       *
       * 之前只做了"进门时聚焦 + Esc 关闭"，Tab 仍能把焦点带到面板**背后**
       * 的聊天界面上去——那时面板还盖着屏幕，键盘用户却已经在对着看不见的
       * 控件按空格了。aria-modal="true" 是对读屏的承诺，这个循环是对键盘的兑现。
       * 承诺和兑现得是同一件事。
       */
      var onKeyDown = function (e) {
        if (e.key !== 'Tab') return
        var root = ref.current
        if (!root || typeof root.querySelectorAll !== 'function') return
        var sel = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),'
          + 'textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
        var nodes = []
        try { nodes = Array.prototype.slice.call(root.querySelectorAll(sel)) } catch (err) { return }
        // 滤掉不可见的（display:none 的元素 offsetParent 为 null）
        nodes = nodes.filter(function (n) { return n.offsetParent !== null })
        if (nodes.length === 0) { e.preventDefault(); try { root.focus() } catch (err) {} ; return }
        var first = nodes[0]
        var last = nodes[nodes.length - 1]
        var active = document.activeElement
        if (e.shiftKey && (active === first || active === root)) {
          e.preventDefault()
          try { last.focus() } catch (err) {}
        } else if (!e.shiftKey && active === last) {
          e.preventDefault()
          try { first.focus() } catch (err) {}
        }
      }

      return h('div', {
        className: 'lw-mask',
        onClick: function (e) { if (e.target === e.currentTarget) props.onClose() },
      }, h('div', {
        onKeyDown: onKeyDown,
        className: 'lw-panel lw-root',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': 'learn-wiki',
        tabIndex: -1,
        ref: ref,
        // state / initialTab / initialSeg 透传给 PanelBody：
        // 离线截图要画的是**这个外壳**里带数据的真实内容，
        // 而不是另搭一个长得像的壳。桌面运行时这几个 prop 都不存在，
        // 走的就是"自己拉数据"那条路。
        // ★ 三个 prop 都要**无条件**传下去。原来写成"受控才传"，
        //   而桌面运行时 props.state 是空的 —— 于是 initialTab 被静默丢掉，
        //   提示条点「处理」想跳到知识页签会跳到默认页签，看起来像没反应。
        //   PanelBody 自己用 state 是否存在来判断受控，不需要这里替它挡。
      }, h(PanelBody, {
        state: props.state,
        initialTab: props.initialTab,
        initialSeg: props.initialSeg,
      })))
    }

    /**
     * 分拣页签：回收站 / 已拒绝里的条目，逐条决定「恢复」还是「永久删除」。
     *
     * 这一页是补一个**我自己造出来的死胡同**：待办条上写着"12 个待分拣"，
     * 但面板里原先根本没有能处理它们的界面 —— 数字说有事，点进去没事。
     *
     * 两条设计铁律：
     *   1. 恢复**回 staged/**，绝不直接进 pages/。两段式的第一段是防投毒闸门，
     *      "从回收站捞回来"不该成为绕过它的后门。
     *   2. 永久删除是**不可逆**的，所以两段确认；服务端另有一道 confirm 守卫
     *      （前端这道是给人看的，服务端那道才是真的闸）。
     */
    function TriageTab(props) {
      ensureStyle()
      // 受控模式（离线渲染/截图）直接给 items，与 PanelBody / PendingBar 同一套惯例。
      var controlled = !!(props && props.items)
      var listState = useState(controlled ? props.items : null)
      var items = controlled ? props.items : listState[0]
      var setItems = listState[1]
      var errState = useState(null)
      var err = errState[0], setErr = errState[1]
      var segState = useState('all')
      var seg = segState[0], setSeg = segState[1]
      var openState = useState(null)
      var open = openState[0], setOpen = openState[1]
      var bodyState = useState({})
      var bodies = bodyState[0], setBodies = bodyState[1]
      var askState = useState(null)
      var ask = askState[0], setAsk = askState[1]
      var busyState = useState(null)
      var busy = busyState[0], setBusy = busyState[1]
      var msgState = useState(null)
      var msg = msgState[0], setMsg = msgState[1]

      var load = useCallback(function () {
        if (controlled) return
        getJson(TRIAGE_API).then(function (r) {
          if (r.j && r.j.ok) { setItems(r.j.items || []); setErr(null) }
          else setErr(r.error || (r.j && r.j.error) || ('HTTP ' + r.status))
        }).catch(function (e) { setErr(String((e && e.message) || e)) })
      }, [controlled])
      useEffect(function () { load() }, [load])

      var loadBody = function (rel) {
        setBodies(function (b) {
          if (b[rel]) return b
          var n = Object.assign({}, b); n[rel] = { loading: true }; return n
        })
        getJson(TRIAGE_API + '?rel=' + encodeURIComponent(rel)).then(function (r) {
          setBodies(function (b) {
            var n = Object.assign({}, b)
            n[rel] = (r.j && r.j.ok) ? { body: r.j.body } : { error: r.error || (r.j && r.j.error) || ('HTTP ' + r.status) }
            return n
          })
        }).catch(function (e) {
          setBodies(function (b) {
            var n = Object.assign({}, b); n[rel] = { error: String((e && e.message) || e) }; return n
          })
        })
      }

      var onToggle = function (rel) {
        var next = open === rel ? null : rel
        setOpen(next)
        if (next) loadBody(next)
      }

      var act = function (rel, action) {
        setBusy(rel); setMsg(null)
        // 不做乐观移除：恢复/删除都是本地文件操作，快到不需要它；
        // 而"先把它从列表里拿掉、失败再放回去"会让人看到条目闪一下，
        // 那种闪动本身就在传递"可能没成"的不确定感。
        var payload = action === 'discard' ? { rel: rel, action: action, confirm: true } : { rel: rel, action: action }
        post(TRIAGE_API, payload).then(function (r) {
          setBusy(null); setAsk(null)
          if (r.j && r.j.ok) {
            setMsg({
              ok: true,
              text: action === 'restore'
                ? '已恢复到 staged/ —— 它仍要过一遍固化闸门才会进召回。'
                : '已永久删除。',
            })
            setItems(function (l) { return (l || []).filter(function (x) { return x.rel !== rel }) })
            props.onChanged && props.onChanged()
          } else {
            setMsg({ ok: false, text: (r.error || (r.j && r.j.error) || ('HTTP ' + r.status)) })
          }
        }).catch(function (e) {
          setBusy(null); setAsk(null)
          setMsg({ ok: false, text: String((e && e.message) || e) })
        })
      }

      if (err) return h('div', { className: 'lw-msg err' }, '读不到分拣列表：' + err + '　（/learn-wiki/api/triage）')
      if (!items) return h('div', { className: 'lw-empty' }, '读取中…')

      var inTrash = items.filter(function (x) { return x.from === '.trash' }).length
      var inRej = items.filter(function (x) { return x.from === '.rejected' }).length
      var SEGS = [
        { id: 'all', label: '全部', n: items.length },
        { id: '.trash', label: '回收站', n: inTrash },
        { id: '.rejected', label: '已拒绝', n: inRej },
      ]
      var shown = seg === 'all' ? items : items.filter(function (x) { return x.from === seg })

      return h('div', null,
        h('div', { className: 'lw-seg', role: 'tablist', 'aria-label': '分拣筛选' },
          SEGS.map(function (s) {
            return h(Chip, {
              key: s.id, active: seg === s.id, role: 'tab', 'aria-selected': seg === s.id,
              onClick: function () { setSeg(s.id) },
            }, s.label + ' ' + s.n)
          })
        ),
        // 说清楚"恢复"到底恢复到哪里。用户以为是"还原成已固化"，
        // 实际是"回到待固化"—— 不写清楚，他会以为恢复之后立刻就生效了。
        h('div', { className: 'lw-hint' },
          '恢复 = 放回 staged/，仍要过固化闸门才会参与召回；永久删除不可撤销。'),
        msg ? h('div', { className: 'lw-msg ' + (msg.ok ? 'ok' : 'err') }, msg.text) : null,
        shown.length === 0
          ? h('div', { className: 'lw-empty' }, '这一类里没有条目。')
          : h('div', { className: 'lw-tri' },
              shown.map(function (it) {
                var isOpen = open === it.rel
                var b = bodies[it.rel]
                var confirming = ask === it.rel
                var isBusy = busy === it.rel
                return h('div', { key: it.rel, className: 'lw-tri-card' },
                  h('div', { className: 'lw-tri-head' },
                    h('span', {
                      className: 'lw-tri-tag ' + (it.from === '.rejected' ? 'rej' : 'tra'),
                    }, it.from === '.trash' ? '回收站' : '已拒绝'),
                    h('span', { className: 'lw-tri-title' }, it.title || it.id),
                    h('span', { className: 'lw-tri-meta' },
                      it.id
                      + (it.category ? ' · ' + it.category : '')
                      + (it.confidence != null ? ' · ' + it.confidence : '')
                      + ' · ' + it.sources + ' 来源 · ' + it.bodyChars + ' 字'
                      + (it.batch ? ' · 批次 ' + String(it.batch).replace(/^staged-/, '') : ''))
                  ),
                  // ── 为什么它在这 ──
                  //
                  // 解析不出来就**如实说没记录**，绝不编一个。编出来的理由会被
                  // 后来的人当成证据 —— 那比"没有理由"危险得多。
                  it.reason
                    ? h('div', { className: 'lw-tri-why' },
                        h('span', { className: 'k' },
                          (it.reason.kind === 'TRASHED' ? '回收原因' : '拒绝原因')
                          + (it.reason.date ? ' · ' + it.reason.date : '')),
                        it.reason.text)
                    : h('div', { className: 'lw-tri-why none' },
                        h('span', { className: 'k' }, '未记录原因'),
                        '移进来时没写理由。约定见 ' + it.from + '/README.md —— 没有理由，就只能靠读全文决定要不要它。'),
                  h('div', { className: 'lw-tri-exc' }, b && b.body != null ? b.body : it.excerpt),
                  h('div', { className: 'lw-tri-acts' },
                    h('button', { type: 'button', className: 'lw-tri-more', onClick: function () { onToggle(it.rel) } },
                      isOpen ? '收起全文' : '读全文'),
                    h('button', {
                      type: 'button', className: 'lw-btn', disabled: isBusy,
                      onClick: function () { act(it.rel, 'restore') },
                    }, '恢复'),
                    confirming
                      ? h('button', {
                          type: 'button', className: 'lw-btn primary', disabled: isBusy,
                          onClick: function () { act(it.rel, 'discard') },
                        }, isBusy ? '删除中…' : '确认永久删除')
                      : h('button', {
                          type: 'button', className: 'lw-btn',
                          onClick: function () { setAsk(it.rel) },
                        }, '永久删除'),
                    confirming
                      ? h('button', {
                          type: 'button', className: 'lw-btn', disabled: isBusy,
                          onClick: function () { setAsk(null) },
                        }, '取消')
                      : null,
                    confirming ? h('span', { className: 'lw-tri-ask' }, '删了就找不回来了。') : null
                  )
                )
              })
            )
      )
    }

    // ── 待办：谁在等、怎么把面板打开 ─────────────────────────────────────
    //
    // 这一块要解决的是一个**非技术**问题：staged 固化与 .trash 分拣全靠人工，
    // 但界面上没有任何东西告诉你"有东西在等"——侧边栏入口是个沉默图标，
    // 于是 6 页暂存能一直积压到有人想起来去看。
    //
    // 两个座位（侧边栏入口、输入框上方提示条）都要能开同一个面板，
    // 所以开关**不能**是某个组件的 useState —— 那样另一处够不着。
    // 用一个极小的订阅式 store：谁都能 set，谁订阅谁重渲染。

    var PENDING_API = '/learn-wiki/api/pending'

    function makeStore(initial) {
      var v = initial
      var subs = []
      return {
        get: function () { return v },
        set: function (next) {
          v = next
          for (var i = 0; i < subs.length; i++) { try { subs[i]() } catch (e) { /* 一个订阅者坏了不该拖垮其余 */ } }
        },
        subscribe: function (f) {
          subs.push(f)
          return function () { var i = subs.indexOf(f); if (i >= 0) subs.splice(i, 1) }
        },
        count: function () { return subs.length },
      }
    }

    /** 面板开关 + 打开时落在哪个页签。 */
    var benchStore = makeStore({ open: false, tab: null })
    function useBench() {
      var s = useState(benchStore.get())
      useEffect(function () { return benchStore.subscribe(function () { s[1](benchStore.get()) }) }, [])
      return s[0]
    }

    /**
     * 待办计数。**两个组件共用一个 store**，所以只轮询一次 ——
     * 各拉各的就会变成每 30 秒两条请求。
     *
     * 轮询间隔取 30 秒：这是"知识库攒了几页"这种尺度的事情，
     * 秒级刷新没有意义，只会白烧磁盘。不可见时一律不拉。
     */
    var pendingStore = makeStore({ data: null, err: null })
    var pendingTimer = null
    function loadPending() {
      return getJson(PENDING_API).then(function (r) {
        var prev = pendingStore.get()
        if (r.j && r.j.ok) pendingStore.set({ data: r.j, err: null })
        else pendingStore.set({ data: prev.data, err: r.error || (r.j && r.j.error) || ('HTTP ' + r.status) })
      })
    }
    function startPendingPolling() {
      if (pendingTimer) return
      loadPending()
      pendingTimer = setInterval(function () {
        if (typeof document === 'undefined' || document.visibilityState !== 'hidden') loadPending()
      }, 30000)
    }
    /**
     * 没人订阅了就停表。
     *
     * 为什么必须停：客户端插件是会被**重新装配**的（改配置就会），而模块级
     * 定时器不会随组件卸载消失 —— 每重载一次就多一个每 30 秒拉一次的定时器。
     * 攒几次就变成"明明没人看，磁盘却一直在响"，而且这类泄漏不报错、只累积。
     */
    function stopPendingIfIdle() {
      if (pendingStore.count() > 0) return
      if (pendingTimer) { clearInterval(pendingTimer); pendingTimer = null }
    }
    function usePending() {
      var s = useState(pendingStore.get())
      useEffect(function () {
        startPendingPolling()
        var un = pendingStore.subscribe(function () { s[1](pendingStore.get()) })
        return function () { un(); stopPendingIfIdle() }
      }, [])
      return s[0]
    }

    /** 待办总数。0 表示"没事等你"，界面据此决定要不要出现。 */
    function pendingTotal(d) {
      if (!d) return 0
      return (d.stagedTotal || 0) + (d.trash || 0) + (d.rejected || 0)
    }

    /**
     * 侧边栏底栏入口（座位：sidebar.footer.action）。
     *
     * ★ 必须吃 wide。座位契约写得很直白：
     *   「Whether the sidebar renders wide content (false = 56px rail)」。
     *   原先这个组件一个 props 都不接，于是侧边栏一收起，它还当着"图标 + 文字"
     *   的整行宽，而旁边的 cordis 单元格和下面的设置钮都收成了 36px 圆 —— 三者对不齐，
     *   这就是"标签没有与最下方设置平齐"。
     *
     * 外层以前是 display:contents 的壳子。现在换成 Fragment：壳子虽然不产生盒子，
     * 却是**单元格的 DOM 父节点**，而 CSS 要靠 *:has(> .lw-fb-cell) 从单元格往上
     * 选到宿主那一行（:has 走的是 DOM 树）。用 Fragment 让单元格的父节点就是宿主。
     */
    function FooterEntry(props) {
      ensureStyle()
      // 老调用点和测试会不传 props —— 缺省按"宽"渲染。
      var wide = !props || props.wide !== false
      var bench = useBench()
      var open = bench.open
      var p = usePending()
      useEffect(function () {
        if (!open) return
        var onKey = function (e) { if (e.key === 'Escape') benchStore.set({ open: false, tab: null }) }
        document.addEventListener('keydown', onKey)
        return function () { document.removeEventListener('keydown', onKey) }
      }, [open])
      var icon = Ico('IconSkillOutline16', 16)
      var n = pendingTotal(p.data)
      // 标题里把数字说全 —— 光一个角标不解释是什么在等。轨道态下标签不渲染，
      // 这条 title 就是唯一还能说明"这是什么、有几件事"的地方。
      var tip = n > 0
        ? 'learn-wiki —— ' + (p.data.stagedReady || 0) + ' 页可固化 / ' + (p.data.stagedTotal || 0) + ' 页暂存，' + ((p.data.trash || 0) + (p.data.rejected || 0)) + ' 个待分拣'
        : 'learn-wiki —— 能力 / 知识 / 补料'
      return h(React.Fragment, null,
        h('div', { className: 'lw-fb-cell' + (wide ? '' : ' lw-fb-cell-rail') },
          h('button', {
            type: 'button',
            className: 'lw-fb' + (wide ? '' : ' lw-fb-rail'),
            title: tip,
            // 轨道态没有可见标签，按钮的**可及名**只能靠这里。
            'aria-label': 'learn-wiki',
            'aria-expanded': open,
            onClick: function () { benchStore.set({ open: !open, tab: open ? null : null }) },
          },
            icon,
            wide ? h('span', { className: 'lw-fb-label' }, 'learn-wiki') : null,
            // 角标只在**真有事**时出现。永远显示一个 0 会训练人忽略它。
            // 轨道态只画点不写数字（36px 圆里放不下），数字留在 title 里。
            n > 0 ? h('span', { className: 'lw-fb-dot' }, wide ? String(n) : '') : null,
          )
        ),
        open ? h(Workbench, { initialTab: bench.tab || undefined, onClose: function () { benchStore.set({ open: false, tab: null }) } }) : null
      )
    }

    /**
     * 输入框上方的常驻提示条（座位：conversation.input.dock —— 它给的就是一行）。
     *
     * 设计取舍：
     *   * 计数为 0 时**整条不渲染**。一个永远写"0 待办"的条子只是噪音，
     *     而噪音会让人连"1 页待固化"也一起忽略。
     *   * 「全部固化」是**两段式**的：先问一句再动手。它一次写多个文件，
     *     误触的代价比多一次点击大。per-page 的固化入口仍在面板里。
     *   * 这里**不做**自动固化。staged 是防投毒闸门（LLM 蒸馏出来的东西
     *     一旦进 pages/ 就参与自动召回），拍板必须是人。这条条子只负责
     *     把该拍板的事推到眼前，不替人拍。
     */
    function PendingBar(props) {
      ensureStyle()
      var p = usePending()
      // 受控模式：调用方直接给数据（离线渲染与截图用）——与 PanelBody 同一套惯例。
      // 服务端渲染不跑 useEffect，不给这个口子就永远只能渲染出"空"，
      // 于是"这条子到底长什么样"没有任何自动化断言。
      if (props && props.pending) p = { data: props.pending, err: null }
      var confirming = useState(false)
      var ask = confirming[0], setAsk = confirming[1]
      var busy = useState(false)
      var working = busy[0], setWorking = busy[1]
      var noteState = useState(null)
      var note = noteState[0], setNote = noteState[1]

      var d = p.data
      var total = pendingTotal(d)
      if (!d || total === 0) return null

      var ready = d.stagedReady || 0
      var triage = (d.trash || 0) + (d.rejected || 0)

      var commitAll = function () {
        setWorking(true); setNote(null)
        var ids = (d.staged || []).filter(function (x) { return x.ready }).map(function (x) { return x.id })
        var okN = 0, failN = []
        var step = function (i) {
          if (i >= ids.length) {
            setWorking(false); setAsk(false)
            setNote(okN + ' 页已固化' + (failN.length ? '，' + failN.length + ' 页失败：' + failN.join('、') : ''))
            loadPending()
            return
          }
          post('/learn-wiki/api/commit', { id: ids[i] }).then(function (r) {
            if (r.j && r.j.ok) okN++ ; else failN.push(ids[i])
            step(i + 1)
          })
        }
        // 逐个提交而不是并发：每个页面各自过一次 commitReadiness 闸门，
        // 并发发起只会让失败信息互相盖住。
        step(0)
      }

      // 两个计数各自**可点**，各自开对应的页签。
      //
      // 之前只有一个笼统的「处理」按固定顺序挑一个页签 —— 而那意味着
      // "12 个待分拣"旁边那个按钮会把你送到知识页签，而那里根本没有分拣界面。
      // 数字和它点开的东西必须对得上，否则这个条子就是在骗人。
      var chips = []
      if (d.stagedTotal > 0) {
        chips.push(h('button', {
          key: 's', type: 'button', className: 'lw-pend-chip',
          title: '打开「知识」页签，逐页看再决定固化',
          onClick: function () { benchStore.set({ open: true, tab: 'knowledge' }) },
        }, h('b', null, String(d.stagedTotal)), ' 页待固化'))
      }
      if (triage > 0) {
        chips.push(h('button', {
          key: 't', type: 'button', className: 'lw-pend-chip',
          title: '打开「分拣」页签，恢复或永久删除',
          onClick: function () { benchStore.set({ open: true, tab: 'triage' }) },
        }, h('b', null, String(triage)), ' 个待分拣'))
      }

      return h('div', {
        // ★ lw-root 不能省：整套 --lw-* 变量定义在 .lw-root 上而不是 :root，
        //   而这条子挂在 composer 里，离 .lw-root 很远。
        className: 'lw-pend lw-root',
        role: 'status',
        'aria-live': 'polite',
      },
        h('span', { className: 'lw-pend-txt' },
          ask
            ? '确认固化这 ' + ready + ' 页？固化后它们立刻参与自动召回。'
            : (note ? note : chips.reduce(function (acc, x) { return acc.concat(acc.length ? [' · '] : [], [x]) }, []))
        ),
        ask ? h('button', {
          type: 'button', className: 'lw-btn primary', disabled: working,
          onClick: commitAll,
        }, working ? '固化中…' : '确认固化') : null,
        ask ? h('button', {
          type: 'button', className: 'lw-btn', disabled: working,
          onClick: function () { setAsk(false) },
        }, '取消') : null,
        !ask && ready > 0 ? h('button', {
          type: 'button', className: 'lw-btn primary',
          onClick: function () { setAsk(true); setNote(null) },
        }, '全部固化') : null,
        !ask && note ? h('button', {
          type: 'button', className: 'lw-btn',
          onClick: function () { setNote(null) },
        }, '知道了') : null
      )
    }

    /* ── wiki_recall 的对话内卡片 ───────────────────────────────────────────
     *
     * 为什么值得做：wiki_recall 的结论是三档判定（hit / weak / miss），而通用工具
     * 卡片把它渲染成一大坨 JSON —— 那正是这个插件最需要人一眼看懂的东西。
     *
     * 机制（核实过，不是想当然）：宿主 dsh-client-ui-tool 的 ToolCall 用
     *   renderSlot("tool.call.toolview", owner, { entryKey: toolName, fallback: GenericToolCard })
     * keyed 命中就**替换**通用行。而 toolName 对 PTC 模式下 run_code 里的嵌套调用
     * 同样是真实的（宿主把嵌套调用也渲染成 ToolResultNode），所以这个卡片在
     * 当前这种「一切走 run_code」的会话里也会生效，不是死代码。
     *
     * 两条硬约束，都来自这个项目自己的教训：
     *   1. **解析不了就返回 null**，让宿主回落到通用卡片。永远不要画一张半懂的卡片
     *      —— 一张说错话的卡片比一张难看的卡片坏得多。
     *   2. 样式只用既有 token 类（.lw-* / .c-*），与设置面板同一套变量。
     */

    /** 从 block 里取出这次调用的工具名与参数（形状与宿主一致：arguments 是 JSON 字符串）。 */
    function recallCallOf(block) {
      try {
        if (!block || typeof block !== "object") return null
        var content = block.content
        if (!Array.isArray(content)) return null
        for (var i = 0; i < content.length; i++) {
          var part = content[i]
          if (!part || part.type !== "tool-call") continue
          var args = part.arguments
          if (typeof args === "string") { try { args = JSON.parse(args) } catch (e) { args = null } }
          return { name: String(part.name || ""), args: args && typeof args === "object" ? args : {} }
        }
        return null
      } catch (e) { return null }
    }

    /** 结果文本：工具结果块里第一段 text。取不到返回空串。 */
    function recallResultText(block) {
      try {
        var content = block && block.content
        if (!Array.isArray(content)) return ""
        for (var i = 0; i < content.length; i++) {
          var part = content[i]
          if (part && part.type === "tool-result" && Array.isArray(part.content)) {
            for (var j = 0; j < part.content.length; j++) {
              var c = part.content[j]
              if (c && c.type === "text" && typeof c.text === "string") return c.text
            }
          }
        }
        return ""
      } catch (e) { return "" }
    }

    /**
     * 纯函数：block → 卡片模型，或 null（回落通用卡片）。
     *
     * 抽成纯函数是为了能被穷举断言 —— 这个文件里的组件很难在测试里点，
     * 但"给一段真实的工具结果，卡片该说什么"是可以逐条钉死的。
     */
    function recallCardModel(block) {
      var call = recallCallOf(block)
      if (!call || call.name !== "wiki_recall") return null
      var text = recallResultText(block)
      if (!text) return null          // 仍在运行：还没有结果，交给通用卡片去转圈
      var data = null
      try { data = JSON.parse(text) } catch (e) { return null }   // 解析不了就别猜
      if (!data || typeof data !== "object") return null
      var bucket = String(data.bucket || "")
      if (bucket !== "hit" && bucket !== "weak" && bucket !== "miss") return null
      var hit = Array.isArray(data.hit) ? data.hit : []
      var weak = Array.isArray(data.weak) ? data.weak : []
      var pages = hit.concat(weak).map(function (p) {
        return {
          id: String((p && p.id) || ""),
          title: String((p && p.title) || (p && p.id) || "(无标题)"),
          score: Number(p && p.score) || 0,
          confidence: Number(p && p.confidence) || 0,
          category: String((p && p.category) || ""),
          bucket: hit.indexOf(p) >= 0 ? "hit" : "weak",
          usageClass: String((p && p.usage && p.usage.class) || "new"),
          warning: (p && p.warning) || "",
          sourceCount: Array.isArray(p && p.sources) ? p.sources.length : 0,
          hasBody: !!(p && typeof p.body === "string" && p.body.length > 0),
        }
      })
      return {
        query: String((call.args && call.args.query) || ""),
        bucket: bucket,
        bestScore: Number(data.bestScore) || 0,
        hitCount: hit.length,
        weakCount: weak.length,
        totalRecallable: Number(data.totalRecallable) || 0,
        note: typeof data.note === "string" ? data.note : "",
        pages: pages,
      }
    }

    var RECALL_LABEL = {
      hit: { text: "命中 · 注入正文", cls: "c-ok" },
      weak: { text: "弱命中 · 只给标题", cls: "c-warn" },
      miss: { text: "未命中 · 无可用知识", cls: "c-bad" },
    }

    /** 一行胶囊：分数 / 分类 / 证据。全部来自工具结果本身，不额外请求。 */
    function RecallFacts(props) {
      var p = props.page
      var chips = [
        h("span", { key: "s", className: "lw-recall-chip" }, p.score.toFixed(3)),
        p.category ? h("span", { key: "c", className: "lw-recall-chip" }, p.category) : null,
        h("span", { key: "conf", className: "lw-recall-chip" }, "置信 " + p.confidence.toFixed(2)),
        p.sourceCount ? h("span", { key: "src", className: "lw-recall-chip c-dim" }, p.sourceCount + " 来源") : null,
        p.usageClass && p.usageClass !== "new" ? h("span", { key: "u", className: "lw-recall-chip c-dim" }, p.usageClass) : null,
      ].filter(Boolean)
      return h("span", { className: "lw-recall-facts" }, chips)
    }

    function RecallRow(props) {
      var p = props.page
      var openState = useState(false)
      var open = openState[0], setOpen = openState[1]
      return h("div", { className: "lw-recall-row" },
        h("div", { className: "lw-recall-rowhead" },
          h("span", { className: "lw-recall-dot " + (p.bucket === "hit" ? "c-ok" : "c-warn") }, "●"),
          h("span", { className: "lw-recall-title", title: p.id }, p.title),
          h(RecallFacts, { page: p }),
          p.warning ? h("span", { className: "lw-recall-chip c-bad", title: p.warning }, "⚠ 已隔离") : null,
          h("button", {
            type: "button",
            className: "lw-recall-toggle",
            "aria-expanded": open ? "true" : "false",
            onClick: function () { setOpen(!open) },
          }, open ? "收起" : "详情")
        ),
        open ? h("div", { className: "lw-recall-detail" },
          h("div", { className: "lw-recall-kv" }, h("span", { className: "c-dim" }, "id"), " ", p.id),
          h("div", { className: "lw-recall-kv" }, h("span", { className: "c-dim" }, "正文"), " ",
            p.hasBody ? "本次调用已带回（模型已看到）" : "未带回（没传 includeBody）"),
          p.warning ? h("div", { className: "lw-recall-kv c-bad" }, p.warning) : null
        ) : null
      )
    }

    /** 对话内卡片本体。数据全部来自这次调用的结果，不发任何请求。 */
    function RecallCard(props) {
      var model = useMemo(function () { return recallCardModel(props && props.block) }, [props && props.block])
      if (!model) return null
      var label = RECALL_LABEL[model.bucket] || RECALL_LABEL.miss
      return h("div", { className: "lw-root lw-recall" },
        h("div", { className: "lw-recall-head" },
          h("span", { className: "lw-recall-verdict " + label.cls }, label.text),
          h("span", { className: "lw-recall-query", title: model.query }, model.query || "(空查询)"),
          h("span", { className: "lw-recall-best c-dim" }, "best " + model.bestScore.toFixed(3))
        ),
        h("div", { className: "lw-recall-sum c-dim" },
          model.hitCount + " 命中 · " + model.weakCount + " 弱命中 · 可召回 " + model.totalRecallable + " 页"),
        model.pages.length > 0
          ? h("div", { className: "lw-recall-list" },
            model.pages.map(function (p) { return h(RecallRow, { key: p.id || p.title, page: p }) }))
          : h("div", { className: "lw-recall-note c-dim" }, model.note || "没有可召回的知识页。"),
        model.pages.length > 0 && model.note
          ? h("div", { className: "lw-recall-note c-dim" }, model.note)
          : null
      )
    }
    // ── 插件契约 ──
    var name = 'dsh-learn-wiki'
    var inject = ['slots', 'locale', 'theme']

    var ZH = { title: 'learn-wiki', capabilities: '能力', knowledge: '知识', supply: '补料' }
    var EN = { title: 'learn-wiki', capabilities: 'Capabilities', knowledge: 'Knowledge', supply: 'Supply' }

    function apply(ctx) {
      try {
        ctx.effect(function () { return ctx.locale.register(name, { zh: ZH, en: EN }) }, 'dsh-learn-wiki: dictionaries')
      } catch (e) { /* 字典注册失败不该挡住 UI */ }
      // ── 对话内的 wiki_recall 卡片 ──
      //
      // 座位规则同下：注册到**未声明**的插槽会抛，所以必须用 inject 包住。
      // 拿不到座位不影响面板 —— 卡片是附加品，不该有能力拖垮插件。
      try {
        ctx.slots.inject('tool.call.toolview', function () {
          return ctx.slots.register({
            name: 'tool.call.toolview',
            key: 'wiki_recall',
            locale: name,
          }, RecallCard)
        })
      } catch (e) {
        try { console.error('[dsh-learn-wiki] wiki_recall 卡片座位不可用：', e) } catch (err) {}
      }
      ctx.slots.inject('sidebar.footer.action', function () {
        return ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'dsh-learn-wiki-entry',
          order: 58,
          locale: name,
        }, FooterEntry)
      })
      // 输入框上方的待办提示条。座位给的就是"独占一整行"，正是这条子要的。
      //
      // 座位规则（来自 DSH 的 slot-catalog）：注册到**未声明**的插槽会抛异常，
      // 所以必须用 ctx.slots.inject 包住 —— 它在声明出现（或重新挂载）时才执行注册。
      // 另外**不要**传 priority：框架会给一个低于所有内置项的值，单格里就是自己渲染。
      try {
        ctx.slots.inject('conversation.input.dock', function () {
          return ctx.slots.register({
            name: 'conversation.input.dock',
            id: 'dsh-learn-wiki-pending',
            order: 40,
            locale: name,
          }, PendingBar)
        })
      } catch (e) {
        // 座位拿不到就不显示提示条，但**面板照旧可用**（侧边栏入口还在）。
        // 一个附加的提示不该有能力拖垮整个插件。
        try { console.error('[dsh-learn-wiki] 待办提示条座位不可用：', e) } catch (err) {}
      }
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply

    /**
     * 结构测试的接缝。
     *
     * 这些组件都是 factory 闭包里的私有函数，外部够不着——所以"把组件树渲染成
     * HTML，看看会不会炸"这件事，在补上这个导出之前根本做不到，只能靠肉眼看
     * 界面。而肉眼刚放过一次 bug（三元少写 ': null'，整棵树当场渲染失败）。
     *
     * 导出它们**不改变运行时契约**：DSH 只读 name / inject / apply，
     * 多一个字段对宿主是惰性的。
     */
    exports.__components = {
      PanelBody, Workbench, FooterEntry, PendingBar, TriageTab,
      CapabilitiesTab, ToolsSection, SkillsSection,
      KnowledgeTab, SupplyTab, PageDetail,
      ModelsTab, ModelListEditor, HarvestSection,
      RecallCard,
    }

    /**
     * 纯逻辑也一并交出去：排序、分组、筛选不经过 React 就能被穷举断言。
     * 渲染测试只负责证明"这些结果能画出来且不崩"，两件事分开测。
     */
    exports.__logic = {
      toolGroups, toolRowsVisible, familyOpen, knowledgeView, KFILTERS, tabKeys, pendingTotal, TABS,
      // 卡片的**判据**单独交出：给一段真实的工具结果，卡片该说什么 —— 这是可以
      // 逐条钉死的纯函数，而"卡片好不好看"不该混进测试里。
      recallCardModel, recallCallOf, recallResultText,
    }

    /**
     * 样式表原文。
     *
     * 给截图工具用：它把组件渲染成静态 HTML 之后，得把这份 CSS 一起贴进去
     * 才能看见真实的排版。没有它，截出来的图就是一堆无样式的裸标签——
     * 那种图会让人误判"界面坏了"，比不截图更糟。
     */
    exports.__css = CSS

    return module.exports
  },
})
