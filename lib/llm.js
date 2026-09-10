// 对 ctx.llm 的最小封装：解析一个路由并做一次非流式 chat。
// 走 ctx.llm 而不是直连 HTTP，这样蒸馏用的模型跟随宿主配置（换模型无需改插件）。
export function createLlm(ctx, { provider, model } = {}) {
  const llm = ctx.llm
  let routePromise = null

  async function resolveRoute() {
    if (routePromise) return routePromise
    routePromise = (async () => {
      const providers = llm.listProviders()
      if (!providers || providers.length === 0) throw new Error('DSH 未注册任何 LLM provider')
      // 显式指定优先
      if (provider) {
        const p = providers.find(p => p.id === provider)
        if (p) return { provider: p.id, model: model || p.id }
      }
      for (const p of providers) {
        try {
          const listed = await llm.listModels(p.id)
          if (Array.isArray(listed) && listed.length > 0) {
            const m = model ? (listed.find(x => x.id === model) ?? listed[0]) : listed[0]
            return { provider: p.id, model: m.id }
          }
        } catch { /* 该 provider 列不出模型，试下一个 */ }
      }
      const first = providers[0]
      return { provider: first.id, model: model || first.id }
    })()
    return routePromise
  }

  return {
    async chat({ system, prompt, maxTokens = 2048, temperature = 0.2 }) {
      const r = await resolveRoute()
      const stream = llm.stream({
        provider: r.provider,
        model: r.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        system,
        temperature,
        maxTokens,
      })
      let text = ''
      for await (const chunk of stream) {
        if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      }
      return text
    },
  }
}

/** 从模型输出里抠出第一个 JSON 对象——容忍 ```json 围栏和前后废话。 */
export function extractJson(text) {
  const s = String(text ?? '')
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidates = []
  if (fenced) candidates.push(fenced[1])
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start !== -1 && end > start) candidates.push(s.slice(start, end + 1))
  for (const c of candidates) {
    try { const v = JSON.parse(c); if (v && typeof v === 'object') return v } catch { /* 试下一个 */ }
  }
  return null
}
