# dsh-learn-wiki

DSH 的「边做边学」知识库插件：**工作前自动检索 → 未命中则后台限流联网补料 → 蒸馏落暂存 → 两段式 commit 升入知识库 → 下次自动命中**。

它把 CRAG（Corrective RAG）的纠错回路从"单次问答"搬到 agent 循环上：知识库检索不到就自己去学，学到的东西沉淀下来，下次就不用再学。

## 它解决什么问题

绝大多数"记忆插件"是**静态管道**——检索不到就检索不到，不会去学。结果就是同一个知识缺口在项目里反复踩，每次都要重新上网查。

本插件的增量只有一个，但是关键的那个：**检索未命中是一个信号，会触发补料并沉淀。**

## 三层知识架构

| 层 | 载体 | 角色 | 谁写 |
|---|---|---|---|
| **L1** | 独立 Markdown 仓库 | 精选知识页，强命中直接注入 | 本插件蒸馏 + 人工编辑 |
| **L2** | Hindsight | 原始情景记忆，语义召回 | Hindsight（由既有 hindsight 插件负责） |
| **L3** | 网络 | 兜底补料，限流 | 本插件经 `ctx.web` |

> **不重复实现 L2。** 既有 hindsight 插件已经负责每轮情景记忆召回；本插件只管 L1、未命中判定和 L3 补料，避免两套注入互相打架。

## 三条设计铁律

1. **自动的不阻塞，阻塞的必须显式。**
   自动注入走 `agent/pre-step`（每轮第一步）；自动补料走 `turn/end` 之后的后台 worker；
   真正"现在就要这个事实"时由模型显式调 `wiki_recall` —— 那一次阻塞天经地义。
   中途阻塞 5–30 秒联网会拖垮轮次、打断工具链，而同一个缺口通常后面几轮还会出现——
   所以"后台学、下轮用"才是"边做边学"的正确形态。

2. **`staged/` 永不参与召回。**
   自动产出必须经 `commit` 才升入 L1。投毒面被限制在暂存区。

3. **无 `sources` 不 commit。**
   每条知识必须可溯源到 URL / 文件。`commitReadiness()` 强制这条。

## 安装

```powershell
dsh plugin --profile web add link:D:/Harness/dsh-learn-wiki
# 重启 DSH 生效
```

## 配置

配置来源（后者覆盖前者）：代码内默认值 → `<wikiRoot>/wiki.config.json` → `apply(ctx, config)` 第二参数。

刻意不使用 Cordis 的 Config schema：rc 阶段要能容忍未知键，严格 schema 会把用户多写的一个键变成加载失败。

关键项（完整列表见 `lib/config.js`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `wikiRoot` | `D:\\Harness\\dsh-wiki` | L1 仓库根目录 |
| `autoContext` | `true` | 旋钮 A：每轮第一步自动注入 |
| `autoAcquire` | `true` | 旋钮 B2：未命中后后台补料（非阻塞） |
| `hitThreshold` | `0.20` | score ≥ 此值 → hit（注入正文） |
| `weakThreshold` | `0.13` | score ≥ 此值 → weak（只注入标题索引）；低于 → miss |
| `injectOncePerSession` | `true` | 内容不变则只注入一次（KV cache 友好） |
| `maxAcquisitionsPerRun` | `2` | 单次后台补料最多处理的缺口数 |
| `webMaxResults` | `5` | 每次联网取多少条结果 |

## 工具

| 工具 | 作用 |
|---|---|
| `wiki_recall` | 显式检索 L1，返回三分桶判定与页面正文 |
| `wiki_learn` | 显式沉淀一条知识（默认落 staged） |
| `wiki_review` | 查看 staged 暂存队列与 gaps 缺口队列 |
| `wiki_commit` | staged → pages（唯一升入 L1 的闸门） |

## 阈值标定（重要）

打分依赖语料规模，**阈值必须随语料重新标定**，不能跨语料复用：

```powershell
node scripts/calibrate.mjs
```

它会用一组标注查询实测分数分布并给出建议阈值。当前默认值来自 7 正例 / 5 负例的实测：
正例 0.152–0.541，负例 0.000–0.105。

### 一个踩过的坑

中文没有词边界，本插件用**字符二元组**分词，于是"协议的分帧"会产生 `议的` / `的分` / `帧和` 这类跨词边界的噪声二元组。而 `idf()` 对 `df=0` 的词返回的是**上界**（`ln(1+(N+0.5)/0.5)`，N=1 时约 1.386），语料内常见词只有约 0.288 —— **差 5 倍**。

结果：这些永远不可能命中的噪声词反而主导了分母，把每个自然语言查询的分数压到接近 0，几乎每轮都判 miss、反复触发联网。修复是给 `df=0` 的词**中性权重**（语料内词的平均 IDF），而不是最大 IDF。实测把"Widget 协议的分帧和魔数是什么"从 0.094（误判 miss）拉回 0.32（hit）。

## 自检

```powershell
node scripts/verify-core.mjs      # 解析 / 索引 / 打分 / 三分桶
node scripts/verify-loop.mjs      # 端到端闭环（含防投毒与 commit 闸门）
node scripts/verify-plugin.mjs    # 插件接线（mock ctx，无需重启 DSH）
```

`verify-plugin.mjs` 用 mock ctx 跑 `apply()`，能在不重启 DSH 的情况下抓出事件名拼错、
工具注册缺 `output` 声明这类错误——本插件开发中它实际抓到了一个阈值标定 bug。

## 状态

MVP（Phase 1）已完成并验证：host 半、无 UI、设置走 JSON 文件。

Phase 2 待办：
- 设置面板 + client 半（`platform: web`）
- wiki lint（死链 / 重复 / 过期）
- 冲突检测与页面合并
- 命中率与补料收益度量
- 双版本 rc 回退（当前依赖 `@deepseek-ai/dsh-{tools,llm}@0.1.0-rc.8`）
