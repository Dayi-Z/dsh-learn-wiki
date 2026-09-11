process.on('uncaughtException', e => { console.log('UNCAUGHT: ' + (e && e.stack || e)); process.exit(2) })
try {
  const APP = 'file:///D:/Harness/dsh-desktop/resources/app/node_modules/@deepseek-ai'
  const cordis = await import(APP + '/cordis/lib/index.js')
  const skillMod = await import(APP + '/dsh-skill/lib/index.js')
  const fsProv = await import(APP + '/dsh-skill-filesystem/lib/index.js')
  const dshScope = await import(APP + '/dsh-scope/lib/index.js')
  const inv = await import('../lib/skills.js')

  const root = new cordis.Context()
  await root.plugin(skillMod.default)

  // 模拟 app：provider 挂在一个 agent 作用域内
  const scoped = dshScope.createScope(root, Symbol('agent-1'), {})
  await scoped.ctx.plugin(fsProv.default ?? fsProv)

  // 我的 scopeKeyOf 能否从 agent 风格的上下文里取出作用域键
  const fakeAgent = { ctx: scoped.ctx }
  const key = inv.scopeKeyOf(fakeAgent)
  console.log('scopeKeyOf(fakeAgent) = ' + String(key))
  console.log('与 dshScope.scopeOf 一致: ' + (key === dshScope.scopeOf(scoped.ctx)))

  const logs = []
  const snap1 = await inv.createSkillInventory({ ctx: root, log: (m) => logs.push(m) }).snapshot()
  console.log('')
  console.log('修复前（不传 getScope）: items=' + snap1.items.length)

  const snap2 = await inv.createSkillInventory({ ctx: root, log: (m) => logs.push(m), getScope: () => key }).snapshot()
  console.log('修复后（传 getScope）: items=' + snap2.items.length + ' totals=' + JSON.stringify(snap2.totals))
  if (snap2.items.length) {
    const f = snap2.items[0]
    console.log('  首个: ' + f.name + '  来源=' + f.source + '  常驻=' + f.catalogTokens + '  正文=' + f.bodyTokens)
    console.log('  描述: ' + String(f.description).slice(0, 70))
  }
  console.log('')
  console.log('日志:')
  for (const l of logs) console.log('  ' + l)
} catch (e) {
  console.log('CAUGHT: ' + (e && e.stack || e))
}
process.exit(0)
