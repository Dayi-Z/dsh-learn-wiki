// 模型路由自检。
//
// 这一层是**所有模型调用的唯一入口**，它错了的后果不是界面难看，
// 而是后台补料静默失败、或者悄悄用上一个用户从没配过的模型。所以要钉住的
// 不是"能不能跑"，而是下面这几条：
//
//   1. 单一 / 轮换 两种模式的**选择语义**（谁被问、下一个是谁）。
//   2. 按站点覆盖 —— 蒸馏与提炼可以各配一份。
//   3. 配置**每次调用重读**：改了 wiki.config.json 立刻生效，不用重载。
//      （这条是回归测试：以前路由只解析一次并永久缓存。）
//   4. 写错 provider 名字的条目**必须被报出来**，不能静默消失 ——
//      否则用户以为轮换在用三个模型，实际只有一个。
//   5. onError=next 时失败了要往下试；fail 时只问一个。
//   6. 配置读不懂时退回安全形状，而不是抛异常。
import { createLlm, normalizeLlmConfig, parseModelSpec, SITES, SITE_LABEL } from '../lib/llm.js'
import { DEFAULTS, loadConfig } from '../lib/config.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

// ── 一个假的宿主 ctx.llm ──
// 记录**每次调用**用了谁，这样"轮换"和"失败换下一个"都是可断言的，
// 而不是靠肉眼读日志。
//   silent：只回 reasoning、正文一个字不给的候选（实测踩到过，见 chat() 里的注释）
function fakeCtx({ providers = ['p1', 'p2'], models = { p1: ['m1a', 'm1b'], p2: ['m2a'] }, fail = {}, silent = {} } = {}) {
  const calls = []
  return {
    calls,
    llm: {
      listProviders: () => providers.map(id => ({ id, name: id.toUpperCase() })),
      listModels: async (id) => (models[id] ?? []).map(m => ({ provider: id, id: m, name: m })),
      stream(opts) {
        calls.push(opts.provider + '/' + opts.model)
        const key = opts.provider + '/' + opts.model
        const boom = fail[key]
        const mute = silent[key]
        return (async function* () {
          if (boom) throw new Error(boom)
          if (mute) {
            // 宿主的流有独立的 reasoning 通道，类型是 'reasoning-delta'
            // （见 dsh-llm 的 assembler.js / assistant-stream.js）。
            yield { type: 'reasoning-delta', text: '让我先想想……'.repeat(40) }
            return
          }
          yield { type: 'text-delta', text: 'OK:' + key }
        })()
      },
    },
  }
}

const mkLlm = async (cfg, opts) => {
  const fake = fakeCtx(opts)
  const llm = createLlm({ llm: fake.llm }, { getCfg: async () => cfg, log: () => {} })
  return { llm, calls: fake.calls }
}

console.log('=== 1. 模型条目的三种写法 ===')
{
  check('"provider/model"', JSON.stringify(parseModelSpec('a/b')) === JSON.stringify({ provider: 'a', model: 'b' }))
  check('只有 provider -> model 留空（运行时取该 provider 第一个）',
    JSON.stringify(parseModelSpec('a')) === JSON.stringify({ provider: 'a', model: '' }))
  check('对象写法', JSON.stringify(parseModelSpec({ provider: 'a', model: 'b' })) === JSON.stringify({ provider: 'a', model: 'b' }))
  check('空串 / null / 数字 -> null（丢掉，不抛）',
    parseModelSpec('') === null && parseModelSpec(null) === null && parseModelSpec(7) === null)
}

console.log('')
console.log('=== 2. 配置归一化：读不懂就退回安全形状 ===')
{
  const n1 = normalizeLlmConfig(undefined)
  check('没有配置 -> single + 空候选（跟随宿主默认）',
    n1.mode === 'single' && n1.models.length === 0 && n1.onError === 'next')
  const n2 = normalizeLlmConfig({ mode: 'ROTATE' })
  check('★ mode 拼错 -> 退回 single（轮换是主动选择，不该因拼错而悄悄开始轮换）',
    n2.mode === 'single', n2.mode)
  const n3 = normalizeLlmConfig({ mode: 'rotate', onError: 'whatever' })
  check('onError 认不出来 -> 退回 next（默认往下试）', n3.onError === 'next', n3.onError)
  const n4 = normalizeLlmConfig({ mode: 'rotate', models: [{ provider: 'a', model: 'b' }] })
  check('rotate 被认下来', n4.mode === 'rotate' && n4.models.length === 1)
  const n5 = normalizeLlmConfig({ models: 'not-an-array' })
  check('models 不是数组 -> 当作空，不抛', n5.models.length === 0)
  const n6 = normalizeLlmConfig({ models: [{ provider: 'a', model: 'b' }, null, '', 3] })
  check('候选里的垃圾条目被丢掉、好的留下', n6.models.length === 1, JSON.stringify(n6.models))
  // 旧键
  const n7 = normalizeLlmConfig({}, { provider: 'legacy', model: 'old' })
  check('★ 旧键 llmProvider/llmModel 仍然认（不让已有配置文件静默失效）',
    n7.models.length === 1 && n7.models[0].provider === 'legacy', JSON.stringify(n7.models))
  const n8 = normalizeLlmConfig({ models: [{ provider: 'new', model: 'x' }] }, { provider: 'legacy', model: 'old' })
  check('★ 显式写了 models 就以 models 为准（旧键不再掺和）',
    n8.models.length === 1 && n8.models[0].provider === 'new', JSON.stringify(n8.models))
  // 站点只覆盖写了的部分
  const n9 = normalizeLlmConfig({ mode: 'rotate', onError: 'fail', models: ['a/x'], sites: { harvest: { models: ['b/y'] } } })
  check('★ 站点块只覆盖它写了的部分 —— 只指定一个模型，不必把 mode/onError 再抄一遍',
    n9.sites.harvest.models.length === 1 && n9.sites.harvest.mode === undefined && n9.sites.harvest.onError === undefined,
    JSON.stringify(n9.sites))
}

console.log('')
console.log('=== 3. 单一模式：每次都问列表第一个 ===')
{
  const cfg = { llm: { mode: 'single', models: [{ provider: 'p2', model: 'm2a' }] } }
  const { llm, calls } = await mkLlm(cfg)
  await llm.chat({ site: 'distill', prompt: 'x' })
  await llm.chat({ site: 'distill', prompt: 'x' })
  await llm.chat({ site: 'distill', prompt: 'x' })
  check('★ 三次调用都问同一个模型', calls.join(',') === 'p2/m2a,p2/m2a,p2/m2a', calls.join(','))
}

console.log('')
console.log('=== 4. 轮换模式：按列表顺序循环 ===')
{
  const cfg = { llm: { mode: 'rotate', models: [{ provider: 'p1', model: 'm1a' }, { provider: 'p2', model: 'm2a' }] } }
  const { llm, calls } = await mkLlm(cfg)
  for (let i = 0; i < 5; i++) await llm.chat({ site: 'distill', prompt: 'x' })
  check('★ 5 次调用按 p1→p2→p1→p2→p1 循环',
    calls.join(',') === 'p1/m1a,p2/m2a,p1/m1a,p2/m2a,p1/m1a', calls.join(','))
}

console.log('')
console.log('=== 5. 站点各配各的：轮换游标互不干扰 ===')
{
  const cfg = {
    llm: {
      mode: 'rotate',
      models: [{ provider: 'p1', model: 'm1a' }, { provider: 'p2', model: 'm2a' }],
      sites: { harvest: { mode: 'single', models: [{ provider: 'p2', model: 'm2a' }] } },
    },
  }
  const { llm, calls } = await mkLlm(cfg)
  await llm.chat({ site: 'distill', prompt: 'x' })   // p1
  await llm.chat({ site: 'harvest', prompt: 'x' })   // p2（站内单一）
  await llm.chat({ site: 'harvest', prompt: 'x' })   // p2
  await llm.chat({ site: 'distill', prompt: 'x' })   // p2（蒸馏游标继续走）
  check('★ 蒸馏轮换、提炼单一，各走各的',
    calls.join(',') === 'p1/m1a,p2/m2a,p2/m2a,p2/m2a', calls.join(','))
}

console.log('')
console.log('=== 6. 配置热生效：改完立刻用新模型，不用重载 ===')
{
  const fake = fakeCtx()
  let cfg = { llm: { mode: 'single', models: [{ provider: 'p1', model: 'm1a' }] } }
  const llm = createLlm({ llm: fake.llm }, { getCfg: async () => cfg, log: () => {} })
  await llm.chat({ site: 'distill', prompt: 'x' })
  cfg = { llm: { mode: 'single', models: [{ provider: 'p2', model: 'm2a' }] } }
  await llm.chat({ site: 'distill', prompt: 'x' })
  check('★ 换了配置之后下一次调用就用新的（以前路由解析一次就永久缓存）',
    fake.calls.join(',') === 'p1/m1a,p2/m2a', fake.calls.join(','))
}

console.log('')
console.log('=== 7. 写错 provider 名字：必须报出来，不能静默消失 ===')
{
  const cfg = { llm: { mode: 'rotate', models: [{ provider: 'nope', model: 'x' }, { provider: 'p2', model: 'm2a' }] } }
  const { llm, calls } = await mkLlm(cfg)
  const r = await llm.route('distill')
  check('★ 未注册的 provider 出现在 rejected 里，并说明原因',
    r.rejected.length === 1 && r.rejected[0].provider === 'nope' && /未注册/.test(r.rejected[0].why),
    JSON.stringify(r.rejected))
  check('★ 剩下的那个仍然是候选（不是整份配置作废）', r.candidates.length === 1, JSON.stringify(r.candidates))
  await llm.chat({ site: 'distill', prompt: 'x' })
  check('调用落在幸存的候选上', calls.join(',') === 'p2/m2a', calls.join(','))
}

console.log('')
console.log('=== 8. onError：next 往下试，fail 只问一个 ===')
{
  const cfg = { llm: { mode: 'single', onError: 'next', models: [{ provider: 'p1', model: 'm1a' }, { provider: 'p2', model: 'm2a' }] } }
  const a = await mkLlm(cfg, { fail: { 'p1/m1a': 'boom' } })
  const text = await a.llm.chat({ site: 'distill', prompt: 'x' })
  check('★ onError=next：第一个失败后问第二个，并把结果返回',
    a.calls.join(',') === 'p1/m1a,p2/m2a' && text === 'OK:p2/m2a', a.calls.join(',') + ' / ' + text)

  const cfg2 = { llm: { mode: 'single', onError: 'fail', models: [{ provider: 'p1', model: 'm1a' }, { provider: 'p2', model: 'm2a' }] } }
  const b = await mkLlm(cfg2, { fail: { 'p1/m1a': 'boom' } })
  let threw = ''
  try { await b.llm.chat({ site: 'distill', prompt: 'x' }) } catch (e) { threw = String(e.message) }
  check('★ onError=fail：只问一个，失败就抛（不偷偷换模型）',
    b.calls.join(',') === 'p1/m1a' && /所有候选模型都失败了/.test(threw), b.calls.join(',') + ' / ' + threw)

  const c = await mkLlm(cfg, { fail: { 'p1/m1a': 'boom', 'p2/m2a': 'boom2' } })
  let threw2 = ''
  try { await c.llm.chat({ site: 'distill', prompt: 'x' }) } catch (e) { threw2 = String(e.message) }
  check('★ 全都失败时错误里带上每一次的原因（可诊断，不是一句"失败了"）',
    /m1a: boom/.test(threw2) && /m2a: boom2/.test(threw2), threw2)
}

console.log('')
console.log('=== 9. 空候选 -> 跟随宿主默认 ===')
{
  const cfg = { llm: { mode: 'single', models: [] } }
  const { llm, calls } = await mkLlm(cfg)
  await llm.chat({ site: 'distill', prompt: 'x' })
  check('★ 没配任何模型时取第一个 provider 列出的第一个模型',
    calls.join(',') === 'p1/m1a', calls.join(','))
  const r = await llm.route('distill')
  check('并且明确标出这是"跟随宿主默认"而不是用户配的', r.configured === false && r.next.auto === true, JSON.stringify(r.next))
}

console.log('')
console.log('=== 10. 只有 provider、没有 model ===')
{
  const cfg = { llm: { mode: 'single', models: ['p2'] } }
  const { llm, calls } = await mkLlm(cfg)
  await llm.chat({ site: 'distill', prompt: 'x' })
  check('★ 写 "p2" 时取该 provider 列出的第一个模型', calls.join(',') === 'p2/m2a', calls.join(','))
}

console.log('')
console.log('=== 11. 站点清单与配置默认值 ===')
{
  check('★ 站点清单是显式的（加一个调用点必须来这里加一行）', SITES.join(',') === 'distill,harvest', SITES.join(','))
  check('每个站点都有人话名字（界面直接显示，不各自翻译一份）',
    SITES.every(s => typeof SITE_LABEL[s] === 'string' && SITE_LABEL[s]))
  check('★ 默认配置里就有 llm 块且形状正确',
    DEFAULTS.llm && DEFAULTS.llm.mode === 'single' && Array.isArray(DEFAULTS.llm.models) && DEFAULTS.llm.onError === 'next',
    JSON.stringify(DEFAULTS.llm))
}

console.log('')
console.log('=== 12. loadConfig 会把 llm 收敛成可执行形状 ===')
{
  const cfg = await loadConfig('D:/nonexistent-wiki-root-for-test', {})
  check('★ loadConfig 出来的 cfg.llm 一定是归一化过的（两处各解一遍就会漂）',
    cfg.llm && cfg.llm.mode === 'single' && Array.isArray(cfg.llm.models) && typeof cfg.llm.sites === 'object',
    JSON.stringify(cfg.llm))
}

console.log('')
console.log('=== 13. 空回复 = 失败（不是空成功）===')
{
  // 实测（2026-09-17 重启后）：harvest 拿到 len=0 的输出，报「模型没有返回合法 JSON」，
  // 真相是那个候选把预算全花在 reasoning 上、正文一个字没给。旧代码把它当成功返回，
  // 于是轮换白配（不会去试下一个候选）。
  const cfg = { llm: { mode: 'single', onError: 'next', models: ['p1/m1a', 'p2/m2a'] } }
  {
    const { llm, calls } = await mkLlm(cfg, { silent: { 'p1/m1a': true } })
    const text = await llm.chat({ site: 'distill', prompt: 'x' })
    check('★ 只回 reasoning 的候选被跳过，改用下一个候选', text === 'OK:p2/m2a', text)
    check('★ 确实问过两个（没有把空回复当成功就收手）', calls.join(',') === 'p1/m1a,p2/m2a', calls.join(','))
  }
  {
    // 所有候选都空 -> 必须抛，且理由点明是空回复、带上证据
    const { llm } = await mkLlm({ llm: { mode: 'single', onError: 'next', models: ['p1/m1a'] } }, { silent: { 'p1/m1a': true } })
    let err = null
    try { await llm.chat({ site: 'distill', prompt: 'x' }) } catch (e) { err = e }
    check('★ 全部空回复时抛错（不许静默返回空串）', !!err && /空回复/.test(err.message), err ? err.message.slice(0, 120) : 'no error')
    check('★ 错误里带证据：reasoning 字符数与 chunk 类型',
      !!err && /reasoning/.test(err.message) && /reasoning-delta/.test(err.message),
      err ? err.message.slice(0, 160) : 'no error')
  }
}

console.log('')
if (failures === 0) console.log('ALL PASS — 单一/轮换、按站点覆盖、热生效、失败降级都有断言')
else console.log(failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
