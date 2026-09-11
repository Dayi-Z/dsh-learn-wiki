// 技能盘点自检。
//
// 这一套存在的理由：技能目录是**新加的面**，而新面最容易出现"看着有数、
// 其实是编的"。所以这里挨个钉死几件事——
//   1. 拿不到注册表时必须说"不可用"，不能返回空列表冒充"一个技能都没有"。
//   2. 常驻（目录摘要）与触发（正文）必须是两笔独立的账。
//   3. 某一个技能读正文失败，不能把整张表带塌。
//   4. 缓存要真的生效，否则 UI 每次轮询都会去翻一遍磁盘。
import { createSkillInventory, estimateTokens } from '../lib/skills.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

// ── 1. token 估算：中文必须比英文贵，否则标定就白做了 ──
const zh = estimateTokens('这是一段中文内容，用来验证中文的估算系数是否生效。')
const en = estimateTokens('This is an English sentence used to verify the estimator.')
check('★ 中文密度被单独计算（同样的字符数，中文 token 更多）',
  estimateTokens('中文中文中文中文中文中文中文中文中文中文')
  > estimateTokens('abcdefghijabcdefghijabcdefghijabcdefghij'),
  'zh=' + estimateTokens('中文中文中文中文中文中文中文中文中文中文')
  + ' en=' + estimateTokens('abcdefghijabcdefghijabcdefghijabcdefghij'))
check('空串估 0', estimateTokens('') === 0 && estimateTokens(null) === 0)
check('估算值是有限正整数', Number.isFinite(zh) && zh > 0 && Number.isInteger(zh), String(zh))

// ── 2. 拿不到注册表 ──
{
  const inv = createSkillInventory({ ctx: {}, log: () => {} })
  const s = await inv.snapshot()
  check('★ 无 ctx.skills 时如实报告不可用（不是空列表）',
    s.available === false && s.items.length === 0 && /不可用/.test(s.reason), s.reason)
}

// ── 2b. Cordis 反射代理：访问未 inject 的服务会**抛错**，不是返回 undefined ──
// 这是实测踩到的：界面上显示 "读不到技能注册表：cannot get property \"skills\" without inject"。
// 直接读 ctx.skills 在真实宿主里必然抛错，所以必须走 ctx.reflect.get(name, false)。
{
  const throwing = {}
  Object.defineProperty(throwing, 'skills', {
    get() { throw new Error('cannot get property "skills" without inject') },
    enumerable: true,
  })
  const inv = createSkillInventory({ ctx: throwing, log: () => {} })
  let s = null, threw = null
  try { s = await inv.snapshot() } catch (e) { threw = e }
  check('★ ctx.skills 抛错时不崩溃，且如实报告不可用',
    threw === null && s && s.available === false && /不可用/.test(s.reason),
    threw ? '抛出了: ' + threw.message : s.reason)
}

// ── 2c. 走 reflect.get 的正规路径 ──
{
  let asked = null
  const ctx = {
    reflect: { get: (name, strict) => { asked = { name, strict }; return name === 'skills' ? { list: async () => [], get: async () => ({}) } : undefined } },
    // 故意让直接读抛错，证明走的是 reflect 那条路
    get skills() { throw new Error('cannot get property "skills" without inject') },
  }
  const inv = createSkillInventory({ ctx, log: () => {} })
  const s = await inv.snapshot()
  check('★ 走 ctx.reflect.get("skills", false) 而不是直接读',
    asked && asked.name === 'skills' && asked.strict === false && s.available === true,
    JSON.stringify(asked) + ' available=' + s.available)
}

// ── 3. 正常路径 ──
{
  let listCalls = 0, getCalls = 0
  const ctx = {
    skills: {
      list: async () => {
        listCalls++
        return [
          { name: 'alpha', description: 'a short one', invocation: { modelInvocable: true, userInvocable: true },
            locator: { path: 'C:/root/skills/alpha/SKILL.md' } },
          { name: 'beta', description: '这一条描述很长很长很长很长很长很长很长很长很长很长很长很长',
            whenToUse: '当需要 beta 的时候', invocation: { modelInvocable: true, userInvocable: false },
            locator: { path: 'D:/other/beta/SKILL.md' } },
          { name: 'broken', description: 'body 读不出来', invocation: { modelInvocable: true, userInvocable: true },
            locator: { path: 'D:/x/broken/SKILL.md' } },
        ]
      },
      get: async (name) => {
        getCalls++
        if (name === 'broken') throw new Error('SKILL.md 权限不足')
        return { name, content: 'BODY-' + name + ' ' + 'x'.repeat(300) }
      },
    },
  }
  const inv = createSkillInventory({ ctx, log: () => {}, ttlMs: 60000 })
  const s = await inv.snapshot()

  check('★ 可用时列出全部技能', s.available === true && s.items.length === 3, 'n=' + s.items.length)
  check('★ 常驻与触发是两笔独立的账',
    s.items.every(i => i.catalogTokens > 0)
    && s.items.filter(i => i.name !== 'broken').every(i => i.bodyTokens > 0)
    && s.items.filter(i => i.name !== 'broken').every(i => i.bodyTokens !== i.catalogTokens),
    JSON.stringify(s.items.map(i => i.name + ':' + i.catalogTokens + '/' + i.bodyTokens)))
  check('★ 汇总数与明细一致',
    s.totals.catalogTokens === s.items.reduce((n, i) => n + i.catalogTokens, 0)
    && s.totals.bodyTokens === s.items.reduce((n, i) => n + i.bodyTokens, 0),
    JSON.stringify(s.totals))
  check('★ 单个技能读正文失败不会带塌整张表',
    s.items.length === 3 && s.items.some(i => i.name === 'broken' && i.bodyKnown === false && /权限不足/.test(i.bodyError)),
    JSON.stringify(s.items.find(i => i.name === 'broken')))
  check('★ 调用策略原样透传（不是默认成 true 就算）',
    s.items.find(i => i.name === 'beta')?.userInvocable === false
    && s.totals.modelInvocable === 3,
    JSON.stringify(s.items.map(i => i.name + ':' + i.modelInvocable + '/' + i.userInvocable)))
  check('★ 按常驻成本降序（先看最贵的）',
    s.items[0].catalogTokens >= s.items[s.items.length - 1].catalogTokens,
    s.items.map(i => i.name + '=' + i.catalogTokens).join(' > '))
  check('来源被截成短路径（表格放得下）',
    s.items.every(i => !String(i.source).includes(':') || String(i.source).split('/').length <= 2),
    JSON.stringify(s.items.map(i => i.source)))
  check('正文预览随目录一起返回（展开行不必再往返）',
    s.items.find(i => i.name === 'alpha').bodyPreview.startsWith('BODY-alpha')
    && s.items.find(i => i.name === 'alpha').bodyPreview.length <= 600)

  // ── 4. 缓存 ──
  const before = listCalls
  await inv.snapshot()
  check('★ TTL 内命中缓存，不重复翻磁盘', listCalls === before, 'listCalls=' + listCalls)
  await inv.snapshot({ fresh: true })
  check('fresh=true 绕过缓存', listCalls === before + 1, 'listCalls=' + listCalls)
  check('get 确实被调用过（正文成本不是编的）', getCalls >= 3, 'getCalls=' + getCalls)
}

// ── 5. list() 自己炸掉 ──
{
  const inv = createSkillInventory({ ctx: { skills: { list: async () => { throw new Error('目录读取炸了') } } }, log: () => {} })
  const s = await inv.snapshot()
  check('★ list() 抛错时返回不可用并带上原因，而不是把异常抛给 UI',
    s.available === false && s.error === true && /目录读取炸了/.test(s.reason), s.reason)
}

// ── 6. list() 挂住 ──
{
  const inv = createSkillInventory({
    ctx: { skills: { list: () => new Promise(() => {}) } },
    log: () => {}, timeoutMs: 120,
  })
  const s = await inv.snapshot()
  check('★ 慢/挂死的 provider 会被超时切断（UI 不会被拖住）',
    s.available === false && /超时/.test(s.reason), s.reason)
}

console.log(failures === 0 ? '\nALL PASS — 技能盘点正确' : '\n' + failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
