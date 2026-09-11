# Changelog

本文件记录本插件的显著变更。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 待办（见 README「状态」与 PRODUCT.md）

- `wiki lint`：死链 / 重复 / 过期检测
- 冲突检测与页面合并
- 命中率与补料收益度量
- 技能按 agent 粒度裁剪（做法已定：在 `agent/pre-step` 改写 `source.kind === 'skill-catalog'`
  那条消息的 `content`；**不要**动 `source.entries`，否则宿主的摘要比对会判定目录变化并每步重发）
- 「被纠正」触发器（Hermes 生态的 `/learn` 有这个入口；本项目目前只有「未命中」与「挣扎」两个触发器）
- 工具表按族折叠（`ui:probe` 实测工具段约 6 屏）
- 双版本 rc 回退（当前依赖 `@deepseek-ai/dsh-{tools,llm}@0.1.0-rc.8`）

## [0.1.0] — 2026-09-11

首个可用版本。host 半与 client 半均已完成并通过自检（16 个套件，全部离线可跑）。

### 学习闭环

- **L1 Markdown 知识库**：`pages/` 参与召回，`staged/` 永不参与（投毒防线），
  `commitReadiness()` 强制「无 sources 不 commit」。
- **自动注入**（`agent/pre-step`）：CRAG 三分桶（hit / weak / miss）。hit 注入正文，
  weak 只给标题索引。`injectOncePerSession` 保持 KV cache 友好。
- **后台补料**（`turn/end` 之后）：限流联网 → 蒸馏 → 落 staged。
  蒸馏器**允许拒绝**，且拒绝优于写一页弱的 —— 这是防止知识库被稀释的第一道闸。
- **三条学习触发器**：检索未命中 / 挣扎 / `wiki_harvest`（显式）。
- **使用证据与强化因子**：hits（liveness）、confirmed（弱正证据）、suspect（弱负证据）。
  降权可逆，删除不可逆。

### 能力包

- 按 agent 裁剪工具可见性：`ctx.tools.restrict`（deny 掩码，必须 agent 作用域）。
- `find_tools` 按关键词把裁掉的工具拉回来（用掩码生效**之前**缓存的完整目录搜索）。
- 技能盘点（只读）：常驻成本与触发成本分开算。

### 历史会话

- `wiki_sessions`：`list` / `brief`（接手简报）/ `walls`（跨会话反复撞的墙）/ `show`。
- `wiki_harvest session=<id>`：从历史会话提炼，取材规则与实时路径**共用同一份实现**。
- 会话文件是多帧 zstd；★ `zlib.createZstdDecompress()` 只解第一帧，必须按魔数切帧。
- 索引带 `(size, mtime)` 缓存、条数预算与 1.5 秒时间预算，每个会话之间显式让出事件循环。

### 界面

- 能力（工具 + 技能，分段导航）/ 知识（稳定排序 + 五档筛选）/ 补料 三页签。
- **位置不表达状态**：行序只由不随交互变化的键决定，需要关注的行靠筛选器浮出来。
- 乐观更新：勾选与固化先动界面，失败回滚并说明。
- 键盘可达：页签是 `role="tab"` 且可方向键移动；展开控件是真的 `<button>`；面板有焦点圈。
- 可离线自检与预览：结构级渲染测试（真 React + 原语替身）、文本探针（真实浏览器几何）、截图。

### 修复（开发期内发现并修正的判据失真）

- **失败判据曾对「命令失败」完全失明**：只认 `result.isError`，而那是 harness 层语义。
  实测 15868 条工具结果：`isError=true` 1228 条**全部**是接口误用；正文带
  `[exit code: N]`(N≠0) 的 588 条**没有一条**置了 isError。现在两类都算，
  且退出码判据**只对 shell 工具**成立（非 shell 工具里的标记是回显）。
- **`edit-churn` 把「努力」当成了「卡住」**：43 条记录里 35 条来自正常迭代，
  产出的唯一一页是关于另一个撞名项目的内容。现在要求与失败共现，且不再进入联网白名单
  （它的症状查询只有一个本地文件名，网上不存在这句话）。
- **症状查询不得撒谎**：原版对 edit-churn 硬编码「仍不成功」，而那个信号并不含失败证据。
- **查询不得随计数变化**：`repeat-failure` 的计数进了查询文本，导致同一堵墙在 gap 队列里
  躺成好几条（实测 5/6/7/8 四次）。现在用稳定的错误指纹。
- **并发写会丢更新**：`appendGap` / `saveUsage` 是整文件读-改-写，两个 agent 相隔 3ms
  各写一次，后写的把前一条整个覆盖。新增 `lib/lock.js` 串行化。
- **子代理会污染长期记忆**：临时工的挣扎曾被记成项目知识缺口并联网搜索。
  现在按 `session.header.delegationDepth > 0` 判定，子代理**照记但不产生后果**。
- **族标题计数恒为 1**：`out[out.length - 1].n++` 在 push 过行之后执行，计数加到了行对象上。
  由结构级渲染测试第一次跑时抓到。

### 无

首个版本，无可回溯的破坏性变更。
