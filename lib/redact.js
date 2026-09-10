// 密钥脱敏。
//
// 为什么需要：实测发生过 —— 用户消息里带着一个 API key 和一个 URL，
// 因为它"检索未命中"就被记成 gap，然后**带着 key 去联网搜索了**。
// 查询会进搜索历史、进 SQLite 缓存、进第三方搜索引擎的日志。
//
// 这条路径上任何一环都不该看到密钥，所以脱敏必须发生在
// 「记 gap」和「联网」之前，而不是之后。

const PATTERNS = [
  // sk- 开头的各类密钥（OpenAI/DeepSeek/OpenCode…）
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_KEY]'],
  // Bearer / Authorization 头
  [/\b(Bearer|token|apikey|api_key|api-key)\s*[:=]?\s*[A-Za-z0-9._\-]{16,}/gi, '$1 [REDACTED]'],
  // 常见具名 secret
  [/\b[A-Za-z0-9_]*(?:API_KEY|ACCESS_TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*\s*[:=]\s*\S+/gi, '[REDACTED_SECRET]'],
  // JWT
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]'],
  // GitHub token
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED_GH]'],
]

/** 返回脱敏后的文本。永不抛异常——它跑在关键路径上。 */
export function redact(text) {
  try {
    let out = String(text ?? '')
    for (const [re, rep] of PATTERNS) out = out.replace(re, rep)
    return out
  } catch {
    return String(text ?? '')
  }
}

/** 文本里是否含疑似密钥（用于决定要不要放弃这条查询）。 */
export function looksSecret(text) {
  const s = String(text ?? '')
  return PATTERNS.some(([re]) => { re.lastIndex = 0; return re.test(s) })
}
