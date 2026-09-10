// 工具输出必须是 lossless JSON —— DSH 会拒绝含 undefined / NaN / Infinity 的返回值。
//
// 这一个坑我已经踩了四次（note:undefined、page:undefined、sessionId:undefined…），
// 每次都是"某个字段在某个数据形状下才是 undefined"，靠测试很难穷尽。
//
// 所以改成结构性防御：所有工具的输出统一过一遍清洗，并且**把被清理的东西记下来**。
// 清洗保证它一定能用；日志保证我不会因为清洗而看不见真正的 bug。

function isBad(x) {
  return x === undefined || (typeof x === 'number' && !Number.isFinite(x))
}

/**
 * 把值洗干净成 lossless JSON。
 * - undefined 的键 -> 直接删掉（保留 null 会造成"字段存在但为空"的假象）
 * - 数组里的 undefined -> null（删掉会改变索引语义）
 * - NaN / Infinity -> null
 * - Date -> ISO 字符串；Map/Set -> 数组
 * 返回 { value, fixes }，fixes 是"改了什么"的路径清单。
 */
export function sanitizeJson(input) {
  const fixes = []
  const seen = new WeakSet()

  const walk = (x, path) => {
    if (x === undefined) { fixes.push(path + ' = undefined'); return undefined }
    if (typeof x === 'number') {
      if (!Number.isFinite(x)) { fixes.push(path + ' = ' + String(x)); return null }
      return x
    }
    if (typeof x === 'bigint') { fixes.push(path + ' = bigint'); return String(x) }
    if (typeof x === 'function') { fixes.push(path + ' = function'); return undefined }
    if (x === null || typeof x !== 'object') return x
    if (x instanceof Date) return x.toISOString()
    if (seen.has(x)) { fixes.push(path + ' = circular'); return null }
    seen.add(x)

    if (Array.isArray(x)) {
      const out = []
      x.forEach((v, i) => {
        const r = walk(v, path + '[' + i + ']')
        out.push(r === undefined ? null : r)
      })
      return out
    }
    if (x instanceof Map) return walk(Object.fromEntries(x), path)
    if (x instanceof Set) return walk([...x], path)

    const out = {}
    for (const [k, v] of Object.entries(x)) {
      const r = walk(v, path + '.' + k)
      if (r !== undefined) out[k] = r
    }
    return out
  }

  const value = walk(input, '$')
  // 根就是 undefined 时给个空对象，避免整个调用因一个 null 而失败
  return { value: value === undefined ? null : value, fixes }
}

/**
 * 包一层工具执行器：先跑原 execute，再清洗返回值。
 * 有清洗发生时记日志 —— 清洗是兜底，不该成为常态。
 */
export function withSanitizedOutput(execute, log = () => {}, toolName = '?') {
  return async (...args) => {
    const raw = await execute(...args)
    const { value, fixes } = sanitizeJson(raw)
    if (fixes.length > 0) {
      log('json-safe: ' + toolName + ' 输出被清洗 ' + fixes.length + ' 处 -> ' + fixes.slice(0, 6).join(', '))
    }
    return value
  }
}
