// 宿主兼容性自检的自检。
//
// 三处最容易出错、且出错后不会有人发现的地方：
//   1. **prerelease 必须按数字比**。字符串比较会把 rc.12 判成小于 rc.8，
//      于是"宿主版本超出范围"这类结论会**正好判反** —— 而且看起来一切正常。
//   2. **"判不了"不许变成"没问题"**。拿不到宿主版本时 verdict 必须是 unknown，
//      不是 same。把未知当成一致，正是这个项目反复栽过的那类静默失效。
//   3. 报告里只许出现**模块**，不许把 app/path 这类字段混进"版本对不上"。
//      一份自己制造噪音的报告会训练人忽略它。
import { rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  parseVersion, compareVersions, satisfies, checkHostApis, compatReport,
  readHostVersions, hostCandidates, REQUIRED_APIS, WATCHED,
} from '../lib/compat.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

// ── 1. 版本解析与比较 ──
console.log('')
console.log('── 版本比较（prerelease 必须按数字）──')
{
  check('解析常规版本', JSON.stringify(parseVersion('0.1.0')) === JSON.stringify({ major: 0, minor: 1, patch: 0, pre: null }))
  check('解析 prerelease', parseVersion('0.1.0-rc.12').pre.join('.') === 'rc.12')
  check('解析不了就返回 null（不猜）', parseVersion('不是版本') === null && parseVersion('') === null)

  check('★ rc.8 < rc.12（字符串比较会判反）', compareVersions('0.1.0-rc.8', '0.1.0-rc.12') === -1,
    '字符串比较 "rc.8" > "rc.12"，结论会正好反掉')
  check('★ rc.12 > rc.8', compareVersions('0.1.0-rc.12', '0.1.0-rc.8') === 1)
  check('正式版 > 同号 prerelease', compareVersions('0.1.0', '0.1.0-rc.12') === 1)
  check('相同版本为 0', compareVersions('0.1.0-rc.8', '0.1.0-rc.8') === 0)
  check('主次修订号优先于 prerelease', compareVersions('0.2.0-rc.1', '0.1.0-rc.9') === 1)
  check('rc.9 < rc.10（数字而非字典序）', compareVersions('0.1.0-rc.9', '0.1.0-rc.10') === -1)
  check('解析不出来时比较返回 null（不是 0 —— 0 会被当成"相等"）',
    compareVersions('乱码', '0.1.0') === null)
}

// ── 2. 范围判定 ──
console.log('')
console.log('── 范围判定 ──')
const RANGE = '>=0.1.5-rc.1 <0.2.0-0'   // node-semver 对 peerDependencies 里 ^0.1.5-rc.1 的展开
{
  check('0.1.5-rc.1 本身在内（下界是闭的）', satisfies('0.1.5-rc.1', RANGE) === true)
  check('0.1.5-rc.2 在内（宿主当前在跑的那份）', satisfies('0.1.5-rc.2', RANGE) === true)
  check('0.1.5-rc.12 在内（宿主将来的 patch）', satisfies('0.1.5-rc.12', RANGE) === true)
  check('★ 0.1.0-rc.8 在外（0.1.0 元组 ≠ 0.1.5 —— 正是 pnpm 会另装旧副本的根源）', satisfies('0.1.0-rc.8', RANGE) === false)
  check('★ 0.1.0-rc.6 在外（同上的元组规则）', satisfies('0.1.0-rc.6', RANGE) === false)
  check('★ 0.1.5-rc.0 在外（下界是闭的，rc.0 < rc.1）', satisfies('0.1.5-rc.0', RANGE) === false)
  check('★ 0.1.4-rc.99 在外（元组在下界之下）', satisfies('0.1.4-rc.99', RANGE) === false)
  check('★ 0.2.0 在外（上界是 <0.2.0-0）', satisfies('0.2.0', RANGE) === false)
  check('★ 0.2.0-0 在外（上界对 prerelease 也闭）', satisfies('0.2.0-0', RANGE) === false)
  check('★ 0.2.0-alpha.1 在外（大于 0.2.0-0）', satisfies('0.2.0-alpha.1', RANGE) === false)
  check('★ 不支持的语法返回 null（"判不了"），不是猜一个答案',
    satisfies('0.1.0', '^0.1.0') === null && satisfies('0.1.0', '0.1.0 || 0.2.0') === null)
  check('空范围返回 null', satisfies('0.1.0', '') === null)
}

// ── 3. API 核对 ──
console.log('')
console.log('── 宿主 API 核对 ──')
{
  // 注意 llm / skills 是**服务对象**，不是函数 —— 第一版按"必须是函数"判，
  // 把存在的东西报成了缺失。那种报告会训练人忽略警告。
  const full = { tools: { register() {}, schemas() {}, restrict() {} }, llm: { listProviders() {} }, web: { search() {} }, webServer: { register() {} }, skills: { snapshot() {} }, agent: { inject() {} }, sessionQuery: { listSessions() {} } }
  const a = checkHostApis(full)
  check('全都在这时不报缺失', a.missing.length === 0 && a.optionalMissing.length === 0, JSON.stringify(a.present.length))
  check('★ 服务对象按"存在即可"判，不要求是函数（llm / skills / sessionQuery 都是对象）',
    a.present.includes('sessionQuery') && a.present.includes('llm') && a.present.includes('skills'),
    a.present.filter(p => ['sessionQuery', 'llm', 'skills'].includes(p)).join(', '))
  check('核对项数 = 清单长度', a.present.length === REQUIRED_APIS.length, a.present.length + ' vs ' + REQUIRED_APIS.length)

  const partial = { tools: { register() {}, schemas() {} }, llm: {}, web: { search() {} }, webServer: { register() {} } }
  const b = checkHostApis(partial)
  check('★ 缺必需项时报出来（不是静默跳过）',
    b.missing.some(m => m.path === 'tools.restrict'), JSON.stringify(b.missing.map(m => m.path)))
  check('★ 缺可选项时不混进 missing（可选 ≠ 必需，混在一起会让人误判严重性）',
    b.optionalMissing.some(m => m.path === 'skills') && !b.missing.some(m => m.path === 'skills'),
    'optional=' + JSON.stringify(b.optionalMissing.map(m => m.path)))
  check('每项都带 why（报告要能解释"缺了会怎样"）',
    REQUIRED_APIS.every(r => typeof r.why === 'string' && r.why.length > 0))
  check('空 ctx 不炸', Array.isArray(checkHostApis({}).missing))

  // ★ 会抛的上下文 —— 这一条是**真宿主里炸过之后**补的。
  //
  //   Cordis 对未声明的服务是**抛异常**而不是返回 undefined：
  //     ctx.sessionQuery -> Error: cannot get property "sessionQuery" without inject
  //   第一版 dig() 直接读，于是整个 compat 自检在真宿主里崩掉，
  //   而单测用的是普通对象（读不存在的键给 undefined）→ 测不出来。
  //   夹具必须复现**真实语义**，否则它测的是我们的想象。
  const throwingCtx = new Proxy({}, {
    get(_t, k) {
      if (k === 'then') return undefined          // 别把 probe 变成 thenable
      throw new Error('cannot get property "' + String(k) + '" without inject')
    },
  })
  const t = checkHostApis(throwingCtx)
  check('★ 会抛的上下文（Cordis 对未声明服务的真实语义）不能让核对崩掉',
    Array.isArray(t.missing) && t.missing.length === REQUIRED_APIS.filter(r => !r.optional).length,
    'missing=' + t.missing.length + ' optional=' + t.optionalMissing.length)
  check('★ 抛异常的宿主与返回 undefined 的宿主判得一样（对插件而言都只是"用不了"）',
    JSON.stringify(t.missing.map(m => m.path)) === JSON.stringify(checkHostApis({}).missing.map(m => m.path)),
    JSON.stringify(t.missing.map(m => m.path)))
}

// ── 4. 宿主版本探测：读不到就说读不到 ──
console.log('')
console.log('── 宿主版本探测 ──')
{
  const T = '.tmp-compat-test'
  await rm(T, { recursive: true, force: true })
  const appDir = join(T, 'resources', 'app')
  await mkdir(join(appDir, 'node_modules', '@deepseek-ai', 'dsh-tools'), { recursive: true })
  await mkdir(join(appDir, 'node_modules', '@deepseek-ai', 'dsh-llm'), { recursive: true })
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'app', version: '0.1.0-rc.12' }), 'utf8')
  await writeFile(join(appDir, 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json'), JSON.stringify({ version: '0.1.0-rc.12' }), 'utf8')
  await writeFile(join(appDir, 'node_modules', '@deepseek-ai', 'dsh-llm', 'package.json'), JSON.stringify({ version: '0.1.0-rc.12' }), 'utf8')

  // ★ execPath 造的候选是 <dir>/resources/app/package.json。夹具目录里
  //   正好也有 resources/app，所以"找不到"那条用例必须用一个**别的**目录 ——
  //   第一版就把它写在了 T 里，于是"找不到"其实找到了。
  const fakeExe = join(T, 'dsh-desktop.exe')
  const hv = await readHostVersions({ execPath: fakeExe })
  check('按打包形状找到宿主（resources/app）', hv.app === '0.1.0-rc.12', JSON.stringify(hv.app))
  check('读到宿主两个模块的版本',
    hv['@deepseek-ai/dsh-tools'] === '0.1.0-rc.12' && hv['@deepseek-ai/dsh-llm'] === '0.1.0-rc.12')

  // ★ 候选路径本身做成纯函数断言，不靠造目录来"证明找不到" ——
  //   第一版用 execPath 造候选，而第二个候选是 <dir>/../Resources/app，
  //   在 Windows 上**大小写不敏感**，它又指回了夹具的 resources/app，
  //   于是"找不到"那条其实找到了。
  const cands = hostCandidates('/x/y/dsh-desktop.exe')
  check('候选形状：Windows/Linux 打包 + macOS 两种',
    cands.length === 2 && /resources[\\/]app/.test(cands[0]) && /Resources[\\/]app/.test(cands[1]),
    JSON.stringify(cands))
  check('没有 execPath 时不给候选（不猜）', hostCandidates('').length === 0)

  const none = await readHostVersions({ candidates: [join(T, 'definitely-not-here.json')] })
  check('★ 候选都读不到时返回 null，**不编**一个版本', none.app === null && none.path === null, JSON.stringify(none))

  // 第一个候选读不到要试下一个
  let calls = 0
  const chain = await readHostVersions({
    candidates: [join(T, 'missing.json'), join(appDir, 'package.json')],
    read: async (p, enc) => { calls++; const { readFile } = await import('node:fs/promises'); return readFile(p, enc) },
  })
  check('第一个候选失败会继续试下一个', chain.app === '0.1.0-rc.12' && calls >= 2, 'calls=' + calls)
  await rm(T, { recursive: true, force: true })
}

// ── 5. 报告：诚实与噪音 ──
console.log('')
console.log('── 报告 ──')
{
  const r1 = compatReport({
    pluginVersions: { '@deepseek-ai/dsh-tools': '0.1.0-rc.8', '@deepseek-ai/dsh-llm': '0.1.0-rc.8' },
    hostVersions: { app: '0.1.5-rc.12', path: 'x', '@deepseek-ai/dsh-tools': '0.1.5-rc.12', '@deepseek-ai/dsh-llm': '0.1.5-rc.12' },
    range: RANGE,
  })
  check('★ 不一致被标出来', r1.differs.length === 2, JSON.stringify(r1.differs.map(d => d.name)))
  check('★ 报告里只有模块，app/path 不许混进来',
    r1.rows.every(x => WATCHED.includes(x.name)), JSON.stringify(r1.rows.map(x => x.name)))
  check('渲染里带 ★ 标记（日志是给人扫的）', /★/.test(r1.rendered))
  check('★ 范围判两次：插件自带那份 rc.8 是 0.1.0 元组 → 超出范围（旧副本被报出来了）',
    r1.inRange === false, 'rc.8 超出范围 -> false')
  check('★ 同时判宿主那份 —— 第一版漏了它，于是"宿主越界"根本看不见',
    r1.hostInRange === true, '宿主 0.1.5-rc.12 在范围内 -> true')
  check('声明范围写进渲染', r1.rendered.includes(RANGE))

  // ★ 未知不许当成一致
  const r2 = compatReport({ pluginVersions: { '@deepseek-ai/dsh-tools': '0.1.0-rc.8' }, hostVersions: { app: null, path: null } })
  const row = r2.rows.find(x => x.name === '@deepseek-ai/dsh-tools')
  check('★ 拿不到宿主版本时 verdict = unknown，**不是** same',
    row.verdict === 'unknown', JSON.stringify(row))
  check('★ 而且它不算进 differs（未知不等于"不一致"，两者都不能拿来做结论）',
    r2.differs.length === 0)
  check('判不了范围时 inRange = null，**不是** false 也不是 true',
    r2.inRange === null, String(r2.inRange))
  check('宿主版本拿不到时 hostInRange = null（未知不等于"没问题"）',
    r2.hostInRange === null, String(r2.hostInRange))

  const r3 = compatReport({
    pluginVersions: { '@deepseek-ai/dsh-tools': '0.1.5-rc.2' },
    hostVersions: { app: '0.1.5-rc.2', '@deepseek-ai/dsh-tools': '0.2.0' },
    range: RANGE,
  })
  check('★ 宿主越过上界时明确报出（rc 阶段的破坏性变更要在日志里被看见）',
    r3.hostInRange === false && /超出范围/.test(r3.rendered), r3.rendered.split('\n').pop())
  check('★ 而插件那份仍在范围内 —— 两个判定含义不同，不能混成一个',
    r3.inRange === true, '单看插件那份会得出"没问题"的结论')

  check('完全一致时 differs 为空', compatReport({
    pluginVersions: { '@deepseek-ai/dsh-tools': '0.1.0-rc.12' },
    hostVersions: { '@deepseek-ai/dsh-tools': '0.1.0-rc.12' },
  }).differs.length === 0)
}

console.log(failures === 0 ? '\n兼容自检全部通过' : '\n有 ' + failures + ' 项未通过')
process.exit(failures === 0 ? 0 : 1)
