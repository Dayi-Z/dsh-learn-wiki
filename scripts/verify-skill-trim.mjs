// 技能按 agent 粒度裁剪的自检。
//
// ── 这一块最重要的一条断言 ──
//
// **绝不动 source.entries。** 宿主 dsh-tool-skill 的 digest 覆盖 entries
// 而不是渲染后的正文（这是它 README 的原话），所以：
//   改 content[].text -> 宿主不认为目录变了，不重发   ✅ 我们要的
//   改 source.entries -> digest 变 -> 宿主判定目录变化 -> 每一步重发一遍  ❌
// 这条断言是本模块存在的前提。它错了，功能就从"省 token"变成"烧 token"。
import { agentKeyOf, allowedSkillNames, trimCatalogText, applySkillTrim } from '../lib/skills-trim.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

const CATALOG = [
  '<system-reminder>',
  'A skill is a reusable set of task-specific instructions. The following skills are available in this session:',
  '',
  '<available_skills>',
  '- \`alpha\`: 干甲的活',
  '- \`beta\`: 干乙的活',
  '- \`gamma\`: 干丙的活',
  '</available_skills>',
  '',
  'If the user names a skill, call the \`skill\` tool with the exact skill name.',
  '</system-reminder>',
].join('\n')

const msg = (text, names) => ({
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'skill-catalog', form: 'catalog', entries: names.map(n => ({ name: n, description: n + ' 的说明' })) },
})

// ── 1. agent 身份键 ──
console.log('')
console.log('── agent 身份键 ──')
{
  check('根会话用 agentPreset',
    agentKeyOf({ session: { header: { agentPreset: 'code', delegationDepth: 0 } } }) === 'code')
  check('★ 子代理统一归到 subagent（临时工和正式工需要的东西不一样）',
    agentKeyOf({ session: { header: { agentPreset: 'code', delegationDepth: 1 } } }) === 'subagent')
  check('没有 header 时退化到 default 而不是抛',
    agentKeyOf({}) === 'default' && agentKeyOf(null) === 'default')
}

// ── 2. 名单计算（含安全闸）──
console.log('')
console.log('── 名单计算 ──')
{
  const all = ['alpha', 'beta', 'gamma']
  check('未启用时原样返回', allowedSkillNames({ allNames: all, cfg: {} }).names.length === 3)
  check('deny 生效',
    JSON.stringify(allowedSkillNames({ allNames: all, cfg: { skills: { enabled: true, deny: ['beta'] } } }).names) === '["alpha","gamma"]')
  check('perAgent allow 生效',
    JSON.stringify(allowedSkillNames({ allNames: all, key: 'code', cfg: { skills: { enabled: true, perAgent: { code: ['alpha'] } } } }).names) === '["alpha"]')
  check('没有该 agent 的名单时显示全部',
    allowedSkillNames({ allNames: all, key: 'other', cfg: { skills: { enabled: true, perAgent: { code: ['alpha'] } } } }).names.length === 3)

  // ★ 安全闸
  const bad = allowedSkillNames({ allNames: all, key: 'code', cfg: { skills: { enabled: true, perAgent: { code: ['名字写错了'] } } } })
  check('★ allow 一个都没匹配上时**不清空**目录（否则整块能力静默消失）',
    bad.names.length === 3 && bad.trimmed === false, JSON.stringify(bad.names))
  check('★ 并且说明为什么没裁（否则这就是一次静默 no-op）',
    /一个都没匹配上/.test(bad.why), bad.why)

  const empty = allowedSkillNames({ allNames: all, key: 'code', cfg: { skills: { enabled: true, perAgent: { code: [] } } } })
  check('★ allow 显式写成空数组时也不清空（同样是"几乎肯定写错了"）',
    empty.names.length === 3, JSON.stringify(empty.names))
}

// ── 3. 文本裁剪 ──
console.log('')
console.log('── 文本裁剪 ──')
{
  const r = trimCatalogText(CATALOG, ['alpha', 'gamma'])
  check('只删不该出现的那些行', r.changed && r.removed === 1, 'removed=' + r.removed)
  check('保留该出现的', r.text.includes('\`alpha\`') && r.text.includes('\`gamma\`'))
  check('删掉了不该出现的', !r.text.includes('\`beta\`'))
  check('★ 保留宿主自己的使用说明（不代它改写措辞）',
    r.text.includes('If the user names a skill') && r.text.includes('<available_skills>') && r.text.includes('</available_skills>'))
  check('没得删时 changed=false（避免无谓地替换整个 messages 数组）',
    trimCatalogText(CATALOG, ['alpha', 'beta', 'gamma']).changed === false)
  check('没有 available_skills 段时原样返回，不炸',
    trimCatalogText('随便一段文本', ['alpha']).changed === false)
  check('全部允许时一个都不删', trimCatalogText(CATALOG, ['alpha', 'beta', 'gamma']).removed === 0)
}

// ── 4. ★ source.entries 不许动 ──
console.log('')
console.log('── 发布事实（entries）不许动 ──')
{
  const m = msg(CATALOG, ['alpha', 'beta', 'gamma'])
  const before = JSON.stringify(m.source.entries)
  const r = applySkillTrim([m], {
    cfg: { skills: { enabled: true, perAgent: { code: ['alpha'] } } }, agentKey: 'code',
  })
  check('确实裁了', r.changed && r.removed === 2, 'removed=' + r.removed)
  const out = r.messages[0]
  check('★ source.entries **逐字节未变**（动了它宿主会每一步重发目录）',
    JSON.stringify(out.source.entries) === before, JSON.stringify(out.source.entries))
  check('★ source.kind / form 也未变',
    out.source.kind === 'skill-catalog' && out.source.form === 'catalog')
  check('渲染文本里只剩允许的那个',
    out.content[0].text.includes('\`alpha\`') && !out.content[0].text.includes('\`beta\`'))
  check('★ 不改原对象（返回新对象，避免悄悄改到别处仍在引用的消息）',
    m.content[0].text.includes('\`beta\`'))
  check('非 skill-catalog 的消息原样透传',
    applySkillTrim([{ role: 'user', content: [{ type: 'text', text: '普通消息' }], source: { kind: 'user' } }],
      { cfg: { skills: { enabled: true } }, agentKey: 'code' }).messages[0].content[0].text === '普通消息')
  check('未启用时完全不动', applySkillTrim([m], { cfg: {}, agentKey: 'code' }).changed === false)
  check('entries 为空的消息跳过（没有发布事实就不裁）',
    applySkillTrim([msg(CATALOG, [])], { cfg: { skills: { enabled: true, perAgent: { code: ['alpha'] } } }, agentKey: 'code' }).changed === false)
}

// ── 5. 端到端：两个 agent 看到不同的目录 ──
console.log('')
console.log('── 端到端 ──')
{
  const cfg = { skills: { enabled: true, perAgent: { code: ['alpha', 'beta'], subagent: ['gamma'] } } }
  const a = applySkillTrim([msg(CATALOG, ['alpha', 'beta', 'gamma'])], { cfg, agentKey: 'code' }).messages[0].content[0].text
  const b = applySkillTrim([msg(CATALOG, ['alpha', 'beta', 'gamma'])], { cfg, agentKey: 'subagent' }).messages[0].content[0].text
  check('主代理看到 alpha/beta', a.includes('\`alpha\`') && a.includes('\`beta\`') && !a.includes('\`gamma\`'))
  check('子代理看到 gamma', b.includes('\`gamma\`') && !b.includes('\`alpha\`'))
  check('两种情况都保留使用说明', a.includes('If the user names a skill') && b.includes('If the user names a skill'))
}

console.log(failures === 0 ? '\n技能裁剪自检全部通过' : '\n有 ' + failures + ' 项未通过')
process.exit(failures === 0 ? 0 : 1)
