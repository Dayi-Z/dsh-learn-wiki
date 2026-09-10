/**
 * dsh-learn-wiki —— 浏览器半。
 *
 * 手写 CJS 而非用打包器：本插件目前是零构建（纯 ESM + 手写 JS），
 * 引入 tsdown/esbuild 只为一个 UI 不划算。契约来自 memoripo 的产物：
 * window.__ModuleLoader__.load({ id, factory }) ，react 等通过 factory 的
 * require 注入。
 *
 * 挂载点用 sidebar.footer.action（原生 slot，memoripo 验证过的路）——
 * **不抢右侧 frame 列**：那条路会挤占对话区，memoripo 已经把它退掉了。
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
    var useCallback = React.useCallback

    var NS = 'dsh-learn-wiki'
    var API = '/learn-wiki/api/state'

    // ── 样式：一次性注入 <style>，跟随 DSH 主题变量并带安全回退色 ──
    var CSS = [
      '.lw-btn{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;padding:6px 10px;',
      'border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer;opacity:.8;text-align:left}',
      '.lw-btn:hover{background:var(--dsw-alias-bg-hover,rgba(127,127,127,.12));opacity:1}',
      '.lw-mask{position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;',
      'background:rgba(0,0,0,.45);backdrop-filter:blur(2px)}',
      '.lw-modal{width:min(960px,92vw);height:min(720px,88vh);display:flex;flex-direction:column;overflow:hidden;',
      'border-radius:14px;border:1px solid var(--dsw-alias-border,rgba(127,127,127,.28));',
      'background:var(--dsw-alias-bg-elevated,#1b1b1f);color:var(--dsw-alias-text,#e8e8ea);',
      'box-shadow:0 24px 60px rgba(0,0,0,.5)}',
      '.lw-head{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--dsw-alias-border,rgba(127,127,127,.22))}',
      '.lw-title{font-weight:600;font-size:14px}',
      '.lw-sub{font-size:11px;opacity:.55}',
      '.lw-x{margin-left:auto;border:0;background:transparent;color:inherit;font-size:18px;cursor:pointer;opacity:.6;padding:0 6px}',
      '.lw-x:hover{opacity:1}',
      '.lw-tabs{display:flex;gap:2px;padding:8px 14px 0}',
      '.lw-tab{border:0;background:transparent;color:inherit;font:inherit;font-size:12px;padding:7px 13px;',
      'border-radius:8px 8px 0 0;cursor:pointer;opacity:.6}',
      '.lw-tab:hover{opacity:.9;background:var(--dsw-alias-bg-hover,rgba(127,127,127,.1))}',
      '.lw-tab.on{opacity:1;background:var(--dsw-alias-bg-hover,rgba(127,127,127,.14));font-weight:600}',
      '.lw-body{flex:1;overflow:auto;padding:14px 18px 20px}',
      '.lw-sec{margin:0 0 18px}',
      '.lw-sech{font-size:11px;letter-spacing:.06em;text-transform:uppercase;opacity:.5;margin:0 0 8px}',
      '.lw-row{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:8px;font-size:12px}',
      '.lw-row:nth-child(odd){background:rgba(127,127,127,.05)}',
      '.lw-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}',
      '.lw-chip{font-size:10px;padding:1px 7px;border-radius:99px;border:1px solid currentColor;opacity:.75;white-space:nowrap}',
      '.lw-grow{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.lw-num{font-variant-numeric:tabular-nums;opacity:.65;font-size:11px}',
      '.lw-c-confirmed{color:#4ade80}.lw-c-suspect{color:#f87171}.lw-c-dead{color:#a1a1aa}',
      '.lw-c-new{color:#60a5fa}.lw-c-unconfirmed{color:#fbbf24}.lw-c-watch{color:#fb923c}',
      '.lw-err{color:#f87171;font-size:12px;padding:12px}',
      '.lw-empty{opacity:.45;font-size:12px;padding:10px}',
      '.lw-kpi{display:flex;gap:18px;flex-wrap:wrap;margin:0 0 16px}',
      '.lw-kpi div{font-size:11px;opacity:.7}',
      '.lw-kpi b{display:block;font-size:19px;font-weight:600;opacity:1;font-variant-numeric:tabular-nums}',
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

    function post(path, body) {
      return fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j } }) })
    }

    var CLASS_COLOR = {
      confirmed: 'lw-c-confirmed', suspect: 'lw-c-suspect', 'suspect-watch': 'lw-c-watch',
      dead: 'lw-c-dead', new: 'lw-c-new', unconfirmed: 'lw-c-unconfirmed',
    }
    var CLASS_LABEL = {
      confirmed: '已确认', suspect: '疑似有害', 'suspect-watch': '观察中',
      dead: '死知识', new: '新页', unconfirmed: '未确认',
    }

    function Row(props) {
      var p = props.page
      return h('div', { className: 'lw-row' },
        h('span', { className: 'lw-grow' }, p.title || p.id),
        p.quarantined ? h('span', { className: 'lw-chip lw-c-suspect' }, '已隔离') : null,
        h('span', { className: 'lw-chip ' + (CLASS_COLOR[p.cls] || '') }, CLASS_LABEL[p.cls] || p.cls),
        h('span', { className: 'lw-num' }, 'hits ' + p.hits + ' / 确认 ' + p.confirmed + ' / 嫌疑 ' + p.suspect),
        h('span', { className: 'lw-num' }, 'x' + p.factor)
      )
    }

    function CapabilitiesTab(props) {
      var s = props.state
      var cap = s.capabilities || {}
      var items = (cap.catalog && cap.catalog.items) || []
      var deniedItems = items.filter(function (i) { return i.denied })
      var liveItems = items.filter(function (i) { return !i.denied })
      var approx = items.reduce(function (a, i) { return a + (i.approxTokens || 0) }, 0)

      // 勾选即写回 wiki.config.json。UI 只改 explicitOnly（"显式专用"那一档），
      // diagnostics/deny 保持不动 —— 免得界面一勾就把手写的精细配置冲掉。
      var busyState = useState(null)
      var busy = busyState[0], setBusy = busyState[1]
      var msgState = useState(null)
      var msg = msgState[0], setMsg = msgState[1]
      var toggle = function (name, nextDenied) {
        var cur = (cap.configuredDeny || []).slice()
        var idx = cur.indexOf(name)
        if (nextDenied && idx < 0) cur.push(name)
        if (!nextDenied && idx >= 0) cur.splice(idx, 1)
        setBusy(name)
        post('/learn-wiki/api/capabilities', { enabled: true, explicitOnly: cur })
          .then(function (r) {
            setBusy(null)
            setMsg(r.j && r.j.ok ? '已保存，下一次装配生效' : '保存失败：' + ((r.j && r.j.error) || r.status))
            props.onChanged && props.onChanged()
          })
          .catch(function (e) { setBusy(null); setMsg('保存失败：' + String(e.message || e)) })
      }

      return h('div', null,
        h('div', { className: 'lw-kpi' },
          h('div', null, '目录工具', h('b', null, cap.catalog ? cap.catalog.total : '—')),
          h('div', null, '已裁', h('b', null, cap.configuredDeny ? cap.configuredDeny.length : 0)),
          h('div', null, '保留', h('b', null, liveItems.length)),
          h('div', null, '目录 token 估算', h('b', null, approx ? '~' + approx : '—'))
        ),
        msg ? h('div', { className: 'lw-row lw-c-confirmed' }, msg) : null,
        cap.catalog && cap.catalog.capturedAt
          ? null
          : h('div', { className: 'lw-empty' }, '目录快照尚未捕获（需要先有一次会话，能力包装配时才会读到完整目录）'),
        h('div', { className: 'lw-sec' },
          h('div', { className: 'lw-sech' }, '按需裁掉（配置）'),
          (cap.configuredDeny || []).length
            ? (cap.configuredDeny || []).map(function (n) { return h('div', { className: 'lw-row', key: n }, h('span', { className: 'lw-mono lw-grow' }, n)) })
            : h('div', { className: 'lw-empty' }, '（无）')
        ),
        h('div', { className: 'lw-sec' },
          h('div', { className: 'lw-sech' }, '已裁工具（' + deniedItems.length + '）'),
          deniedItems.length
            ? deniedItems.map(function (i) { return h('div', { className: 'lw-row', key: i.name },
                h('span', { className: 'lw-mono lw-grow' }, i.name),
                h('span', { className: 'lw-num' }, '~' + i.approxTokens)) })
            : h('div', { className: 'lw-empty' }, '（无）')
        ),
        h('div', { className: 'lw-sec' },
          h('div', { className: 'lw-sech' }, '保留工具（' + liveItems.length + '）— 勾选即裁掉'),
          liveItems.slice(0, 120).map(function (i) {
            return h('label', { className: 'lw-row', key: i.name, style: { cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                checked: false,
                disabled: busy === i.name,
                onChange: function () { toggle(i.name, true) },
              }),
              h('span', { className: 'lw-mono lw-grow' }, i.name),
              h('span', { className: 'lw-num' }, '~' + i.approxTokens))
          })
        ),
        h('div', { className: 'lw-sec' },
          h('div', { className: 'lw-sech' }, '已裁工具 — 取消勾选即放回'),
          deniedItems.length
            ? deniedItems.map(function (i) {
                return h('label', { className: 'lw-row', key: i.name, style: { cursor: 'pointer' } },
                  h('input', {
                    type: 'checkbox',
                    checked: true,
                    disabled: busy === i.name,
                    onChange: function () { toggle(i.name, false) },
                  }),
                  h('span', { className: 'lw-mono lw-grow' }, i.name),
                  h('span', { className: 'lw-num' }, '~' + i.approxTokens))
              })
            : h('div', { className: 'lw-empty' }, '（无）')
        )
      )
    }

    function KnowledgeTab(props) {
      var s = props.state
      var k = s.knowledge || {}
      var busyState = useState(null)
      var busy = busyState[0], setBusy = busyState[1]
      var msgState = useState(null)
      var msg = msgState[0], setMsg = msgState[1]
      var doCommit = function (id) {
        setBusy(id)
        post('/learn-wiki/api/commit', { id: id })
          .then(function (r) {
            setBusy(null)
            setMsg(r.j && r.j.ok
              ? '已升入 L1：' + id
              : '被拒绝：' + (((r.j && r.j.blockers) || [(r.j && r.j.error) || r.status]).join('；')))
            props.onChanged && props.onChanged()
          })
          .catch(function (e) { setBusy(null); setMsg('失败：' + String(e.message || e)) })
      }
      var order = ['suspect', 'suspect-watch', 'confirmed', 'unconfirmed', 'new', 'dead']
      var committed = k.committed || []
      return h('div', null,
        h('div', { className: 'lw-kpi' },
          h('div', null, '已固化', h('b', null, committed.length)),
          h('div', null, '待审 staged', h('b', null, (k.staged || []).length)),
          h('div', null, '疑似有害', h('b', null, (k.counts && k.counts.suspect) || 0)),
          h('div', null, '已确认', h('b', null, (k.counts && k.counts.confirmed) || 0)),
          h('div', null, '死知识', h('b', null, (k.counts && k.counts.dead) || 0))
        ),
        h('div', { className: 'lw-sec' },
          h('div', { className: 'lw-sech' }, '命中阈值'),
          h('div', { className: 'lw-row' }, h('span', { className: 'lw-grow' },
            'hit >= ' + k.threshold.hit + '　weak >= ' + k.threshold.weak + '　低于 weak 才判 miss'))
        ),
        msg ? h('div', { className: 'lw-row lw-c-confirmed' }, msg) : null,
        (k.staged || []).length ? h('div', { className: 'lw-sec' },
          h('div', { className: 'lw-sech' }, '待审暂存（staged，不参与自动召回）— 无 sources 不许 commit'),
          (k.staged || []).map(function (p) { return h('div', { className: 'lw-row', key: p.id },
            h('span', { className: 'lw-grow' }, p.title || p.id),
            h('span', { className: 'lw-num' }, '来源 ' + p.sources),
            h('span', { className: 'lw-num' }, 'conf ' + p.confidence),
            h('button', {
              className: 'lw-x', style: { fontSize: '11px', opacity: 0.8 },
              disabled: busy === p.id,
              title: p.sources > 0 ? '升入 L1' : '无 sources，会被闸门拒绝',
              onClick: function () { doCommit(p.id) },
            }, busy === p.id ? '…' : 'commit')) })
        ) : null,
        h('div', { className: 'lw-sec' },
          h('div', { className: 'lw-sech' }, '已固化知识（按证据分类）'),
          committed.length
            ? order.reduce(function (acc, cls) {
                var group = committed.filter(function (p) { return p.cls === cls })
                if (!group.length) return acc
                acc.push(h('div', { key: cls, className: 'lw-sech', style: { marginTop: '10px' } },
                  (CLASS_LABEL[cls] || cls) + '（' + group.length + '）'))
                group.forEach(function (p) { acc.push(h(Row, { key: p.id, page: p })) })
                return acc
              }, [])
            : h('div', { className: 'lw-empty' }, '（还没有已固化知识）')
        )
      )
    }

    function SupplyTab(props) {
      var s = props.state
      var g = s.gaps || {}
      var st = s.struggles || {}
      var gc = g.counts || {}
      var sc = st.counts || {}
      var sigLabel = {
        'edit-churn': '反复改同一文件', 'repeat-identical': '重复相同调用',
        'repeat-failure': '连续失败', 'recurring-error': '反复撞同一错误',
      }
      return h('div', null,
        h('div', { className: 'lw-kpi' },
          h('div', null, '缺口总数', h('b', null, g.total || 0)),
          h('div', null, '待处理', h('b', null, gc.pending || 0)),
          h('div', null, '已产出', h('b', null, gc.done || 0)),
          h('div', null, '被拒', h('b', null, gc.skipped || 0)),
          h('div', null, '挣扎记录', h('b', null, st.total || 0))
        ),
        h('div', { className: 'lw-sec' },
          h('div', { className: 'lw-sech' }, '挣扎信号分布（这才是补料的触发源）'),
          Object.keys(sc).length
            ? Object.keys(sc).map(function (k) { return h('div', { className: 'lw-row', key: k },
                h('span', { className: 'lw-grow' }, sigLabel[k] || k),
                h('span', { className: 'lw-num' }, sc[k])) })
            : h('div', { className: 'lw-empty' }, '（还没有挣扎记录）')
        ),
        h('div', { className: 'lw-sec' },
          h('div', { className: 'lw-sech' }, '最近缺口'),
          (g.recent || []).length
            ? (g.recent || []).map(function (x, i) { return h('div', { className: 'lw-row', key: i },
                h('span', { className: 'lw-chip' }, x.status),
                h('span', { className: 'lw-grow' }, x.query)) })
            : h('div', { className: 'lw-empty' }, '（队列为空）')
        )
      )
    }

    var TABS = [
      { id: 'capabilities', label: '能力' },
      { id: 'knowledge', label: '知识' },
      { id: 'supply', label: '补料' },
    ]

    function Workbench(props) {
      var tabState = useState('capabilities')
      var tab = tabState[0], setTab = tabState[1]
      var stState = useState(null)
      var state = stState[0], setState = stState[1]
      var errState = useState(null)
      var err = errState[0], setErr = errState[1]

      var load = useCallback(function () {
        fetch(API, { headers: { accept: 'application/json' } })
          .then(function (r) { return r.json() })
          .then(function (j) {
            if (!j || !j.ok) throw new Error((j && j.error) || '接口返回异常')
            setState(j); setErr(null)
          })
          .catch(function (e) { setErr(String((e && e.message) || e)) })
      }, [])

      useEffect(function () {
        load()
        var t = setInterval(load, 5000)
        return function () { clearInterval(t) }
      }, [load])

      useEffect(function () {
        var onKey = function (e) { if (e.key === 'Escape') props.onClose() }
        document.addEventListener('keydown', onKey)
        return function () { document.removeEventListener('keydown', onKey) }
      }, [props.onClose])

      var body
      if (err) body = h('div', { className: 'lw-err' }, '读取失败：' + err)
      else if (!state) body = h('div', { className: 'lw-empty' }, '读取中…')
      else if (tab === 'capabilities') body = h(CapabilitiesTab, { state: state, onChanged: load })
      else if (tab === 'knowledge') body = h(KnowledgeTab, { state: state, onChanged: load })
      else body = h(SupplyTab, { state: state })

      return h('div', { className: 'lw-mask', onClick: function (e) { if (e.target === e.currentTarget) props.onClose() } },
        h('div', { className: 'lw-modal', role: 'dialog', 'aria-label': 'learn-wiki' },
          h('div', { className: 'lw-head' },
            h('div', null,
              h('div', { className: 'lw-title' }, '🌱 learn-wiki'),
              h('div', { className: 'lw-sub' }, state ? state.app.wikiRoot : '连接中…')
            ),
            h('button', { className: 'lw-x', onClick: props.onClose, title: '关闭 (Esc)' }, '×')
          ),
          h('div', { className: 'lw-tabs' },
            TABS.map(function (t) {
              return h('button', {
                key: t.id,
                className: 'lw-tab' + (tab === t.id ? ' on' : ''),
                onClick: function () { setTab(t.id) },
              }, t.label)
            })
          ),
          h('div', { className: 'lw-body' }, body)
        )
      )
    }

    function FooterEntry() {
      ensureStyle()
      var openState = useState(false)
      var open = openState[0], setOpen = openState[1]
      return h('div', { style: { display: 'contents' } },
        h('button', { className: 'lw-btn', onClick: function () { setOpen(function (o) { return !o }) }, title: 'learn-wiki 知识库 / 能力' },
          h('span', { style: { fontSize: '14px', lineHeight: 1 } }, '🌱'),
          h('span', null, 'learn-wiki')
        ),
        open ? h(Workbench, { onClose: function () { setOpen(false) } }) : null
      )
    }

    // ── 插件契约 ──
    var name = 'dsh-learn-wiki'
    var inject = ['slots', 'locale', 'theme']

    var ZH = {
      title: 'learn-wiki',
      capabilities: '能力', knowledge: '知识', supply: '补料',
    }
    var EN = {
      title: 'learn-wiki',
      capabilities: 'Capabilities', knowledge: 'Knowledge', supply: 'Supply',
    }

    function apply(ctx) {
      try { ctx.effect(function () { return ctx.locale.register(NS, { zh: ZH, en: EN }) }, 'dsh-learn-wiki: dictionaries') } catch (e) { /* 字典失败不该挡住 UI */ }
      ctx.slots.inject('sidebar.footer.action', function () {
        return ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'dsh-learn-wiki-entry',
          order: 58,
          locale: NS,
        }, FooterEntry)
      })
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
