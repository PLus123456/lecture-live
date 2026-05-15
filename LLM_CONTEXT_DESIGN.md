# LectureLive — LLM 上下文管理设计记录

> 本文是 PR #64 的"设计内核"——把所有讨论过、但代码里不容易看出来的决策固化下来，给后续接手的工程师（或下个 Claude Code 会话）做认知背景。
>
> 风格：[ADR](https://adr.github.io/)（Architecture Decision Record）—— 每个决策含 _上下文 / 决定 / 取舍 / 推翻成本_。30 分钟读完后应该能继续开发。
>
> 版本：v1，写于 2026-05-15。
>
> **状态对照**（截至文档发出时 main 已合并的相关 PR）：
> - #64 LLM 上下文管理 7 级降级链改造（本文记录的主体）
> - #65 prebuild prisma generate 钩子
> - #66 修复 npm audit 8 个漏洞
> - #67 上下文预算 sanity check + admin contextWindow 字段 + EOL 显示 —— **§7 Bug 1/2/4 已在此修复**
> - #70 chat context overflow 处理修复
>
> 阅读 §7 时请优先看代码现状，本文保留作为决策记录而非 TODO 清单。

---

## 0. 一句话目标

让 LectureLive 的所有 LLM 调用路径（最终摘要 / 关键词提取 / 意义评估 / Chat 对话 / 标题生成）从"按字符硬截断 → token-aware 预算管理 + 渐进降级 + 历史持久化"，使长录音 / 长对话不再丢内容、不再撞 API 上下文上限。

## 1. 总览：影响的 7 条 LLM 调用路径

| 路径 | 调用频次 | 改造前的问题 | 改造后的策略 |
| :- | :- | :- | :- |
| 最终摘要 (FINAL_SUMMARY) | 录音结束 1 次 | transcript `.slice(0,15000)` 字符截断 | 估算 token：≤ 预算直传，> 预算走 **map-reduce** |
| 关键词提取 (KEYWORD_EXTRACTION) | 用户主动 / 录音后 | `.slice(0,8000)` 字符截断 | 短文本直传，长文本 map-reduce + LLM 合并去重，失败回退字面去重 |
| 意义评估 | 录音结束 1 次 | `.slice(0,6000)` 字符截断 | 改为 token 截断（~4500 token，等价但更准确） |
| 标题生成 | 录音结束 1 次 | `.slice(0,8000)` 字符截断 | 改 token 截断（~6000 token） |
| 增量摘要 (REALTIME_SUMMARY) | 每 ~12 句一次 | 已有 runningContext 增量传递 | 不动 |
| **Chat 对话** | 用户每次发消息 | 100 条 / 100K 字符硬上限，超就报 400 | **7 级降级链 + 反应式 retry + 持久化** |
| 嵌入 (EMBEDDING) | 仅 Chat L6 RAG 用 | 不存在 | 新增 `LlmPurpose.EMBEDDING`，复用 LlmProvider 调云端 `/embeddings` |

辅助路径：
- **Cloudreve OAuth token 刷新** —— 独立 fix，不算 LLM，但同 PR 里做了：启动主动刷新 + 关键失败写 AuditLog。

---

## 2. 决策记录（ADR）

### ADR-001：用 cl100k_base 一种 tokenizer 覆盖所有供应商

**上下文**：项目接了 5 个 LLM 供应商（豆包 / Kimi / GLM / DeepSeek / Minimax），各自分词器不公开或不一致。

**决定**：只引入一个 `gpt-tokenizer` (~60KB)，用 cl100k_base 编码估算所有供应商的 token 数。

**取舍**：cl100k_base 对非英文存在 ±15% 误差。但本项目仅用估算做**预防式降级触发**，真实超限由 LLM API 返回 `context_length_exceeded` 反应式兜底。误差可接受。

**推翻成本**：低。每个供应商各加一个分词器 = 重新写 `tokenizer.ts`，包大小 ×3-5、首次加载慢、维护贵。当前判断不值。

**实现**：[src/lib/llm/tokenizer.ts](src/lib/llm/tokenizer.ts)

---

### ADR-002：新增 `contextWindow` 字段，不复用 `maxTokens`

**上下文**：`LlmModel.maxTokens` 在改造前被 `gateway.ts` 当作 OpenAI/Anthropic API 调用的 `max_tokens`（**输出上限**）。但用户在 admin UI 里填的值（如 256000）实际是想表达"模型能接受多大输入" —— **字段名歧义**，且 API 端通常会 clamp，行为意外 OK。

**决定**：加新字段 `LlmModel.contextWindow Int @default(8192)`，专门表示输入窗口。`maxTokens` 保留并保持"输出上限"语义。Migration 把现有值复制：`UPDATE LlmModel SET contextWindow = maxTokens`。

**取舍**：
- 用户升级后会发现两个字段值相同（如都是 256000）。如果没改 maxTokens，预算公式 `(contextWindow - maxTokens) × 0.8 = 0`，Chat 必爆 —— **这是 PR #64 上线后的真实事故**，见 §7 Bug 1。
- 没在 migration 里强制 clamp maxTokens 是因为不想擅自动用户数据。事实证明应该 clamp，§7 已记录。

**推翻成本**：低。把 `contextWindow` 删掉，所有引用回退到 `maxTokens`。但分隔两个语义对用户更友好。

**实现**：[prisma/schema.prisma](prisma/schema.prisma) + [src/lib/llm/gateway.ts](src/lib/llm/gateway.ts)（`LLMProviderConfig.contextWindow`）

---

### ADR-003：Map-reduce 默认 3 并发

**上下文**：长 transcript 走 map-reduce 时，map 阶段对每个 chunk 各跑一次 LLM。串行慢、全并发可能打爆 API quota。

**决定**：3 并发。"map 失败"返回空 JSON（不杀整体），下游 reduce 接受空段。

**取舍**：
- 1 并发：成本最低、最稳，但 2 小时课程 10 段 ≈ 长时长
- 全并发：最快，但触发上游 rate limit 风险
- **3 是经验值**：大部分 LLM API 都允许 3-5 并发，剩下的留给同期发生的其他调用

**推翻成本**：低，改 `MAP_REDUCE_CONCURRENCY` 常量一行。

**实现**：[src/lib/llm/reportManager.ts](src/lib/llm/reportManager.ts) `runMapStage` + [extract-keywords/route.ts](src/app/api/llm/extract-keywords/route.ts) `extractKeywordsFromChunks`

---

### ADR-004：意义评估保持截断（但单位改 token）

**上下文**：意义评估是判断"录音值不值得生成报告"，本身只需要 transcript 的代表性片段，不需要全量。

**决定**：保持原有截断逻辑，但把"6000 字符"→"4500 token"。`truncateToTokensFromEnd` 取尾部。

**取舍**：取尾部假设最后说的话最有代表性（lecture 末尾通常是总结）；如果开头才是关键（如 keynote），评估可能误判。但这是个 90/10 的取舍 —— 大部分录音"末尾代表性"假设成立。

**推翻成本**：极低，改一行截断方向（头/尾/中间采样）。

**实现**：[src/lib/llm/prompts.ts](src/lib/llm/prompts.ts) `buildSignificanceEvaluationPrompt`

---

### ADR-005：关键词走"map-reduce + LLM 合并"路径（A），不做 embedding 同义词去重（B）

**上下文**：长 transcript 的关键词提取超 8000 字符截断会丢内容。两个方案：A. map-reduce LLM 分段提取 + LLM 合并去重。B. 加 embedding 模型做语义去重（"FFT" / "Fast Fourier Transform" 合并）。

**决定**：只做 A。

**取舍**：
- A 工作量小，立刻能解决"长 transcript 关键词不全"
- B 是锦上添花，需要本地加载 30MB embedding 模型（移动端慢）
- "同义词去重"实际收益小 —— 用户复看 transcript 时多看到几个变体不痛

**推翻成本**：中。要做 B 需要复用 ADR-008 的 embedding 子系统，路径已经铺好。

**实现**：[src/app/api/llm/extract-keywords/route.ts](src/app/api/llm/extract-keywords/route.ts) `extractKeywordsFromChunks` + `mergeKeywordLists`，LLM 合并失败回退字面去重。

---

### ADR-006：Chat 7 级降级链 + 单调降级（方案 B）

**上下文**：长 chat 对话会撞 LLM 上下文上限。需要一个"自动缩内容"的策略。

**讨论过的方案演化**：
- 初版：先压历史 → 再压 transcript → 再压 summary
- 用户矫正："最占 token 的是 transcript 而不是历史对话"
- 最终版：先缩 transcript 窗口 → 再压历史 → 最后才动 summary

**决定 7 级**：

| 级别 | Transcript | History | Summary | 触发 |
| :- | :- | :- | :- | :- |
| L1 默认 | 近 5 轮对话期间的 transcript | 全部 | 完整 | tokens < 80% 预算 |
| L2 缩窗口（动态 3/4/5） | 选最大且能塞下的窗口 | 全部 | 完整 | tokens ≥ 80% |
| L3 锁 3 轮窗口 | 固定 3 轮 | 全部 | 完整 | L2 仍超 |
| L4 压历史 | 3 轮 | 早期压成 1 条 system 摘要，保留最近 5 轮 | 完整 | L3 仍超 |
| L5 单轮 + 滚动压 | 1 轮 | 保留最近 3 轮，距上次压缩 > 5 轮再压 | 完整 | L4 仍超 |
| L6 Transcript RAG | embedding 检索 top-K 相关片段 | 滚动压（与 L5 相同） | 完整 | L5 仍超 |
| L7 RAG + 压 summary | RAG | 滚动压 | 截到 1500 token | L6 仍超 |
| EOL | — | — | — | L7 仍超 → 提示新建对话 |

**单调降级（方案 B）**：本次 chat 已经降到 L3 之后，下次发消息从 L3 起算，不回升到 L1。理由：transcript 只会越录越长，token 用量物理单调递增；让它"回升"必撞墙。Conversation 表的 `degradationLevel` 字段持久化最低值。

**双触发机制**：
- **预防式**：估算 token ≥ 80% 预算 → 在 chatContextBuilder 里向下走一级
- **反应式**：LLM API 返回 context_length_exceeded → 在 chat/route.ts 里 catch 并向下走一级 retry

反应式不设步长上限（最多自然降到 EOL）—— 因为预防式估算应该已经覆盖大部分情况，反应式只是兜底。

**推翻成本**：中。增减级别要改 `chatContextBuilder.ts` 的 switch 和 `DEGRADATION_MAX_LEVEL` 常量。Schema 字段是 Int，扩展性 OK。

**实现**：[src/lib/llm/chatContextBuilder.ts](src/lib/llm/chatContextBuilder.ts)

---

### ADR-007：时间锚点 system 消息 always-on

**上下文**：transcript 被截后，LLM 不知道用户的对话发生在录音的什么时刻，长会话语义会丢。

**决定**：每次 chat 发送时，在 system prompt 后追加一条文本块，列出"第 N 轮用户消息发生在 transcript HH:MM:SS"。所有级别都启用，不只 L6+。

**取舍**：占 50-200 token 永远塞着，但是个**廉价的全局定位锚**。L6 RAG 检索时还能用时间锚点 + 语义检索做 hybrid。

**推翻成本**：极低，删 `buildTimeAnchor()` 调用即可。

**实现**：[src/lib/llm/chatContextBuilder.ts](src/lib/llm/chatContextBuilder.ts) `buildTimeAnchor`

**未做的优化**：把"第 N 轮"格式改成更精简的"轮 1: 00:12, 轮 2: 00:18, ..." 节省 token。当前格式偏啰嗦，可以后续优化。

---

### ADR-008：Embedding 复用 LlmProvider + LlmPurpose.EMBEDDING，不建独立表

**上下文**：L6 RAG 需要 embedding 模型。两种接入：
- A. 新建 `EmbeddingProvider` 表 + admin UI
- B. 在 `LlmPurpose` 枚举加 `EMBEDDING`，复用 LlmProvider 配置体系

**决定**：B。OpenAI 兼容的 `/v1/embeddings` 端点跟 chat 协议同一套（Authorization Bearer / JSON / model 字段），国内豆包/GLM/Kimi/DeepSeek/Minimax 都支持。

**取舍**：
- B 不需要新表 / 新 admin UI / 新 gateway 代码 —— 最省事
- 缺点：Anthropic 没原生 embedding，如果用户只接 Anthropic，会被强制接第三方（Voyage 等）单独搞一个 LlmProvider
- 没有原生 Anthropic 用户的场景下 B 完胜

**推翻成本**：中。要换 A 需要新表 + admin UI + gateway 新 callEmbedding 路径。

**实现**：[src/lib/llm/gateway.ts](src/lib/llm/gateway.ts) `callEmbedding`

**实施缺口**：见 §7 Bug 3 —— Admin UI 的 `VALID_PURPOSES` 数组没加 'EMBEDDING'，用户在前端看不到这个用途的勾选框。**核心 bug**，必须补。

---

### ADR-009：Embedding cache 走 session-LRU 内存，**不持久化**

**上下文**：transcript 切块后每块要 embed，下次 chat 不希望重新跑。三种缓存方案：
- A. 内存 LRU（per-process），进程重启 / 多实例不共享
- B. 数据库表 `TranscriptEmbedding`（持久化但每次查 DB）
- C. IndexedDB 客户端缓存 + Server 端用 client 推上来的向量

**决定**：A。Map<sessionId, RagState>，上限 10 个 session 的 LRU。

**取舍**：
- A 实现最简单（~80 行）
- 进程重启后第一次 chat 重新 embed（成本 = 一次 batch API 调用，慢 1-2 秒可接受）
- 多实例下每个 instance 独立 cache（同 user 切换实例多算一次）
- B / C 是工程化方向，初版不做

**推翻成本**：低-中。换 B 加新表 + crud；换 C 加客户端 transformers.js 加载逻辑。

**实现**：[src/lib/llm/embedding/transcriptRag.ts](src/lib/llm/embedding/transcriptRag.ts) 模块级 `sessionCache: Map`

**已知短板**：transcript 长度变化时**整段重切**（line 159 needsRebuild）—— 不算增量。但 chunk text 的 key 相同的复用了 vectors。理论上若 transcript 只追加，重切的成本主要在 chunk 计算（estimateTokens × N），不重 embed。

---

### ADR-010：Transcript 按 segments + token 累积切块（不按字符）

**上下文**：transcript 有 segments（带 startMs/endMs），不是单个 string。两种切块策略：
- A. 把 segments join 成 string，再按句子 + token 切（`chunking.ts` 的方式）
- B. 直接 segments 累积，每达到 ~150 token 切一块（`transcriptRag.ts` 的方式）

**决定**：两个都用。B 用于 RAG（每块自然带 startMs/endMs 时间标签，检索后可显示时间），A 用于摘要 map-reduce（不关心时间维度，只关心句法边界）。

**实现**：
- A: [src/lib/llm/chunking.ts](src/lib/llm/chunking.ts) `chunkText`
- B: [src/lib/llm/embedding/transcriptRag.ts](src/lib/llm/embedding/transcriptRag.ts) `chunkSegments`

---

### ADR-011：主动 `/compress` 持久化 system 摘要，被动降级压缩**临时**不持久化

**上下文**：用户主动 `/compress` 和降级链 L4+ 自动压缩，两种压缩的处理方式应该一致还是分开？

**决定**：分开。

- **主动 `/compress`**：写入一条 `role='system'` 的 ConversationMessage（持久化）。下次 chat/route.ts 组装 history 时找最近 system 消息作为切割点，之前的 user/assistant 折叠（前端 `archivedMessages`，UI 可展开看原文）。
- **被动 L4+ 降级**：chatContextBuilder 内部即时压缩历史，不入 DB。每次新消息可能重新压（成本：每次发消息多一次 LLM 调用，但**只在 L4+ 才会发生**，且 chatContextBuilder 有 `compressedHistory` 缓存在单次 build 流程内复用）。

**取舍**：
- 主动持久化：用户预期"我压缩了，下次还是压缩状态"
- 被动不持久化：让用户随时通过提升 contextWindow 或新建对话"撤销"降级状态，避免被锁死在某个级别

**推翻成本**：低。如果想让被动也持久化，把 `compressedHistory` 写到 ConversationMessage 即可。

**实现**：
- 主动: [src/app/api/llm/chat/compress/route.ts](src/app/api/llm/chat/compress/route.ts)
- 被动: [src/lib/llm/chatContextBuilder.ts](src/lib/llm/chatContextBuilder.ts) `compressHistory`

---

### ADR-012：Compression 失败不让用户重试，直接提示新建对话

**上下文**：用户提议"压缩失败时让用户手动重试 `/compress`"。被驳回：压缩失败 = LLM API 调用失败（quota / 网络 / 配置），手动跑还是一样会失败。

**决定**：压缩失败 → 返回错误 → 前端在 UI 给出"建议新建对话"提示 + 一键新建按钮。错误原因（API 报错 / quota 用尽 / 网络超时）写在响应里供用户诊断。

**实现**：[src/app/api/llm/chat/compress/route.ts](src/app/api/llm/chat/compress/route.ts) 错误返回 + [src/components/session/ChatTab.tsx](src/components/session/ChatTab.tsx) 红色横幅 + "新建对话"按钮

---

### ADR-013：Conversation 模型 + 单调 `degradationLevel` 持久化

**上下文**：改造前所有 chat 状态都在 zustand chatStore 内存里，刷新页面全丢。

**决定**：

- 新增 `Conversation`（一节录音可有多个）+ `ConversationMessage` 表
- 每条 message 带 `transcriptOffsetMs`（时间锚点 ADR-007 用）+ `degradationLevel`（命中哪一级）
- Conversation 顶层有 `degradationLevel` 字段：本对话已降到的最低级别，**单调下降**（DB 写时 `MAX(原值, 新值)`）

**取舍**：
- 表数据增长：每条 chat 消息一行，长期看可接受（admin 后续可加清理）
- 查询性能：`(conversationId, createdAt)` 索引覆盖主要查询

**未做**：
- Conversation 标题（AI 生成）—— 表里留了 `title String?` 字段但没生成逻辑
- 单独的对话历史浏览页面 —— 见 §7 Feature B

**实现**：[prisma/schema.prisma](prisma/schema.prisma) + [src/app/api/conversations/](src/app/api/conversations/) + [src/app/api/conversations/[id]/messages/](src/app/api/conversations/[id]/messages/)

---

### ADR-014：新对话清空 history，保留 transcript/summary

**上下文**：用户主动"新建对话"或 EOL 提示新建时，前一对话怎么处理？

**决定**：
- 上一个活跃 conversation `endedAt = now()` 关闭（不删除，UI 切回可只读查看）
- 新建一个 endedAt=null 的 conversation 作为当前活跃
- session 本身（录音）不变，transcript / summary / keywords 全部保留
- 主动调用 `invalidateRagCache(sessionId)`（虽然 sessionId 不变，但作为新对话的清洁状态）

**推翻成本**：低。如果不想清 RAG cache，删一行即可。

**实现**：[src/app/api/conversations/route.ts](src/app/api/conversations/route.ts) POST handler

---

### ADR-015：i18n 暂不全面化

**上下文**：ChatTab 改造加了大量中文文本（"上下文用量"、"已折叠 N 条消息"、"压缩失败"、详情卡里的所有字段）。要不要全走 i18n 系统？

**决定**：保持硬编码中文。理由：
- ChatTab 现有的 placeholder（"Ask about the lecture..."）、空状态 ("Ask questions about the lecture") 等也是硬编码
- 项目当前 i18n 系统只覆盖 admin 面板 / 通用控件 / 部分页面，不是全站
- 全面 i18n 是独立的清理工作，混进 PR #64 会让 review 失焦
- 用户明确同意（"i18n 留下个 PR"）

**推翻成本**：中。需要遍历 ChatTab.tsx 把所有硬编码字符串换成 `t('chatTab.xxx')` + 在 zh/en locale 加键值对。约 40-60 处。

**Cloudreve token 部分的 i18n 已做**（auditLog.cloudreveRefreshSuccess 等 3 个 key）—— 那块是改 AuditLogPanel，它本身走 i18n。

---

### ADR-016：Cloudreve OAuth 启动主动刷新 + 写 AuditLog（替代"账号集成自动登录"）

**上下文**：用户原本提议"把 Cloudreve 账号密码集成在系统里，自动登录"。被驳回：
- 存账号密码即使加密也是降级，攻击面大
- 用户改密 / 启用 2FA / 邮箱变更全废
- Cloudreve 无官方"密码换 token"端点，得模拟登录表单，升级 Cloudreve 就崩
- access_token 1 小时过期是 OAuth 标准，refresh_token 才是正解

**决定**：
- WS 进程内启动主动刷一次（同时验证 refresh 链路健康）
- 之后每 30 分钟检查，距过期 < 15 分钟主动刷
- 失败时写明确的 AuditLog 让 admin 一眼分辨根因（ENCRYPTION_KEY 不匹配 vs refresh_token 被对端撤）

**推翻成本**：低。删 `cloudreveTokenRefresh.ts` 退回被动刷新即可。

**实现**：[src/lib/storage/cloudreveTokenRefresh.ts](src/lib/storage/cloudreveTokenRefresh.ts) + [src/lib/storage/cloudreve.ts](src/lib/storage/cloudreve.ts) `refreshCloudreveTokenProactively`

---

## 3. Chat 一次请求的完整数据流

```
[前端] useChat.sendMessage(question, segments, summary, totalMs)
   │
   │ 1. 添加 user message 到 messages（乐观更新）
   │ 2. 前端 estimateChatUsage 算 token breakdown，更新小圈
   │
   ▼
POST /api/llm/chat
   │ Body: { conversationId, question, transcript: Segment[],
   │          totalTranscriptMs, summaryContext, model?, thinkingDepth? }
   │
[后端 chat/route.ts]
   │ 1. verifyAuth → user.id
   │ 2. enforceApiRateLimit
   │ 3. 验证 conversation 归属 + 拒收已 endedAt 的
   │ 4. 找最近 role='system' 消息（主动压缩切割点）
   │    splitIndex 之后的 user/assistant 是"有效 history"
   │ 5. resolveAuthorizedLlmSelection → provider + finalDepth
   │ 6. computeContextBudget(provider, contextWindow) → inputBudget
   │ 7. 构造 history: ConversationTurn[]（含 transcriptOffsetMs）
   │ 8. baseSystemPrompt = buildChatPrompt('', summary, depth)
   │    + （若有 system 摘要）拼"[Earlier conversation summary]:..."
   │ 9. makeRagRetrieverForSession(sessionId) → ragRetrieve
   │
   ▼ 主循环：从 conversation.degradationLevel 起步
   │
   ┌──[while currentLevel <= 7]
   │   │
   │   │ buildChatContext({ history, userInput, transcript, summary,
   │   │                    totalMs, minLevel=currentLevel, inputBudget,
   │   │                    baseSystemPrompt, callLLM, language, ragRetrieve })
   │   │   │
   │   │   ▼ 内部 for level in [minLevel..7]
   │   │       - 估算时间锚点 timeAnchor
   │   │       - 若 level >= 4 且 compressedHistory 还没算：调 compressHistory
   │   │       - 调 buildAtLevel(level, state, budget) 组装一次
   │   │       - 若 totalTokens <= budget：return（找到合适级别）
   │   │   返回 { systemPrompt, messages, level, breakdown }
   │   │
   │   ├─ 若 buildChatContext throws ChatContextEOLError
   │   │   → return 413 + { error: 'context_full', message: '...' }
   │   │
   │   │ callLLMWithHistory(systemPrompt, messages, { ... })
   │   │
   │   ├─ 若 isContextLengthError(err)（嗅探 'context_length' 等关键词）
   │   │   ├─ 若 currentLevel < 7: currentLevel++, continue
   │   │   └─ 若 currentLevel >= 7: return 413
   │   │
   │   ├─ 其他错误：throw
   │   │
   │   └─ 成功 → break with llmResponse
   │
   ▼ Prisma transaction：
   │   - insert user ConversationMessage（transcriptOffsetMs = totalMs）
   │   - insert assistant ConversationMessage（含 degradationLevel）
   │   - update conversation.degradationLevel = MAX(原值, effectiveLevel)
   │
   ▼ return { reply, thinking, model, thinkingDepth, level }
   │
[前端] useChat 收到响应
   │ - 若 status 413: setContextFull(true), addMessage('上下文已满...')
   │ - 否则: addMessage(assistant), setTokenUsage(preEstimate with level)
   │
   ▼ ChatTab 重渲染：小圈颜色 / L 级别 / Conversation list 数量
```

**关键不变量**：

1. `conversation.degradationLevel` 单调不降（DB 写时 MAX）
2. `currentLevel` 在反应式 retry 循环里只递增
3. 持久化只发生在 LLM 调用成功之后（失败的尝试不污染 DB）
4. EOL 不写 message，让用户主动新建对话

---

## 4. 数据模型关系

```
Session ───────┬──── Folders (多对多)
   │           ├──── ShareLinks (一对多)
   │           └──── Conversations (一对多)        ← 新增
   │                     │
   │                     └──── ConversationMessages (一对多)  ← 新增
   │                              role: 'user' | 'assistant' | 'system'
   │                              transcriptOffsetMs: Int?  (时间锚点 ADR-007)
   │                              degradationLevel: Int?    (仅 assistant)
   │                              inputTokens / outputTokens: Int?
   │
   └──── (transcripts / recordings / summaries / reports 仍走文件)
```

**与前端 zustand `chatStore` 的关系**：
- `chatStore` 只持久化 `selectedModel` / `selectedDepth`（user 偏好）到 localStorage
- 运行时状态（`messages` / `conversations` / `archivedMessages` / `tokenUsage` / `contextFull`）每次进入 chat tab 从 API 重新拉
- 这样跨设备 / 跨标签都能看到最新对话数据

---

## 5. 7 级降级链的"轮窗口"机制细节

**ADR-006 提到的"近 N 轮 transcript 窗口"** 的精确定义：

```typescript
function transcriptWindowByTurns(transcript, history, windowTurns) {
  const userTurns = history.filter(t => t.role === 'user');
  if (userTurns.length <= windowTurns) {
    // 对话还不足 N 轮 → 给全部 transcript
    return transcript.map(s => s.text).join(' ');
  }
  // 取倒数第 N 条 user 消息的 transcriptOffsetMs 作为起点
  const cutoffMs = userTurns[userTurns.length - windowTurns].transcriptOffsetMs;
  // 保留 transcript 中 startMs >= cutoffMs 的部分
  return transcript.filter(s => s.startMs >= cutoffMs).map(s => s.text).join(' ');
}
```

**边界情况**：
- 用户在录音 30 分钟后才打开 chat → 前 30 分钟 transcript 没有任何对话锚点 → "近 5 轮"= 全部对话开始之前到现在 → 包含前 30 分钟 + 5 轮间的录音
- 用户只发了 1 条 chat 消息 → 不足 5 轮 → 给全部 transcript
- 用户的对话历史包含 system 摘要消息 → 已被 chat/route.ts 滤掉，不进 ConversationTurn[]

---

## 6. 已识别但未处理的边界情况

| 情况 | 当前行为 | 期望行为 |
| :- | :- | :- |
| `maxTokens >= contextWindow`（用户配错） | inputBudget 算出 0 或负数，chat 立即 EOL | sanity clamp 自动按 1/4 contextWindow 算预算 ← §7 Bug 1 |
| Embedding LLM 没配 | L6 RAG 调 callEmbedding 失败 → makeRagRetrieverForSession 返回空串 → buildAtLevel L6 退化到 truncateToTokensFromEnd 1000 token | 已处理（降级而非崩溃），但 admin UI 缺勾选导致用户**根本配不上** ← §7 Bug 3 |
| Anthropic 模型 + EMBEDDING 用途 | callEmbedding 抛错"Anthropic 不支持 embeddings 端点" | 已处理（admin 配置时就该避免） |
| 进程重启后 RAG cache 丢失 | 第一次 L6 chat 重新 embed | 已处理，慢一次可接受。长期可加 TranscriptEmbedding 表（ADR-009） |
| Compression LLM 调用慢（>10s） | 整个 chat 请求被拖慢 | 未处理。可能需要 abortable + timeout |
| Conversation 数无上限 | 一个 session 可能有几十个 conversation | 未处理。需要 admin 清理或 UI 折叠 |
| Cloudreve refresh_token 被服务端 rotation 但写回失败 | 已处理（同步 await 写回），但若 DB 写挂仍可能旧 token 被废 | 已记录在 AuditLog 'admin.cloudreve.refresh.failed' |
| 同 session 多 Tab chat 并发发消息 | 都用同一 active conversation，messages 顺序由 createdAt 决定 | 未压测，可能有竞争但 DB 主键保证不重复 |
| `/compress` 在对话只有 1 轮时 | compressHistory 返回 null，API 返回 `compressed: false, reason: 'history shorter than keepTurns'` | 已处理，前端显示理由 |
| 时间锚点表里包含 50+ 轮 | system prompt 暴长（每轮 ~10 token × 50 = 500 token） | 未处理。可压缩格式（ADR-007 提到的"轮 1: 00:12"精简） |
| 反应式 retry 6 次都失败 | 自然降到 EOL 提示新建对话 | 已处理。但 6 次失败 = 6 次 LLM API 调用，慢 + 费 token —— 需观察实际频率 |

---

## 7. PR #64 后续工作（接手必读）

### ⚠️ 已发现的 Bug

#### Bug 1：**预算公式 sanity check**（核心，必须最先修）

升级后用户的 5 个模型 contextWindow = maxTokens（迁移把同值复制过去），预算 `(X - X) × 0.8 = 0`，所有 chat 立刻 EOL。

**修法**（`src/lib/llm/tokenBudget.ts` `computeContextBudget`）：

```typescript
const outputMaxTokens = Math.max(
  1,
  Math.min(
    provider.maxTokens || 4096,
    Math.floor(contextWindow / 4),
    8192
  )
);
```

即"输出上限不超 contextWindow 的 1/4，且不超 8192"。这样即使用户没改 admin UI，预算也算得出来。

**配套**：写一个新 migration `20260515_clamp_max_tokens.sql`：

```sql
UPDATE LlmModel SET maxTokens = LEAST(maxTokens, 8192) WHERE maxTokens > 8192;
```

#### Bug 2：**Admin LLM 模型表单缺 `contextWindow` 字段**

文件：
- `src/components/admin/SettingsPanel.tsx` 模型表单（line 162-235 + 618-637）
- `src/app/api/admin/llm-providers/[id]/models/route.ts` POST（line 36 + 81）
- `src/app/api/admin/llm-providers/[id]/models/[modelId]/route.ts` PUT（line 56）

加 input + API 接收 + 验证 `contextWindow >= maxTokens`。i18n key `adminSettings.modelContextWindow` + 说明 "上下文窗口（输入 token 上限）"。

#### Bug 3：**Admin LLM 用途勾选缺 `EMBEDDING`（向量引擎）**

文件：
- 两个 API 文件的 `VALID_PURPOSES` 数组都缺 'EMBEDDING'
- `SettingsPanel.tsx` line 132 `getPurposeLabel` switch 缺分支
- `sortModelPurposes` 排序数组也要加

i18n key `adminSettings.purposeEmbedding` zh "嵌入" / en "Embedding"。

#### Bug 4：**小圈 L 级别在 413 后不更新**

`src/hooks/useChat.ts` 的 413 分支只 setContextFull(true) 没改 tokenUsage.level。把 level 设成 7（或加 EOL 特殊状态）。

#### Bug 5：**服务器 `npm run build` 报 PrismaClient 缺 conversation**

PR #65 加了 `prebuild: prisma generate` 钩子修复。如果合并后还有问题：
```bash
rm -rf node_modules .next package-lock.json && npm install && npm run build
```

### 📌 未实现的 Feature

- **Feature A**：回放页验证 ChatTab（数据层 OK，未实测）—— `src/app/session/[id]/playback/page.tsx`
- **Feature B**：单独的"对话历史"浏览页面，新路由 `/sessions/[id]/conversations`
- **Feature C**：ChatTab i18n 全面化（约 40-60 处硬编码）
- **Feature D**：Admin 表单 inline warning "你填的 maxTokens 看起来是上下文窗口"
- **Feature E**：长 Conversation 自动清理 / 折叠（admin 设置上限 / UI 折叠）
- **Feature F**：Conversation `title` AI 生成（首条 user 消息提取 8 字标题）

---

## 8. 给未来改动的提示

### 想换 / 加 LLM 供应商

只要供应商兼容 OpenAI API 协议（`/chat/completions` + `/embeddings`），添加方式不变：admin → 新建 LlmProvider + 模型。不兼容的（Anthropic 原生）走 `isAnthropic: true` 分支。

### 想加新的降级级别（如 L8 - 把 transcript 整段塞 PDF 附件）

1. `chatContextBuilder.ts` 加 `case 8` 到 `buildAtLevel`
2. `DEGRADATION_MAX_LEVEL` 改 8
3. 类型 `DegradationLevel` 加 8
4. 如果需要新的资源（如 PDF 工具），在 `ChatContextInput` 加可选回调
5. Prisma `Conversation.degradationLevel` 是 Int 不用改

### 想做 client-side RAG（IndexedDB 缓存 + WebGPU embed）

- 复用 `src/lib/translation/` 现有的 Transformers.js + ONNX 栈
- 加载 `Xenova/bge-small-zh-v1.5`（~30MB）
- IndexedDB 缓存 transcript chunks + vectors
- 把 chunks 序列化推给后端 chat API，后端不再调云端 callEmbedding 而是用 client 给的
- ChatTab 加首次加载进度 UI

工作量约 1-2 周。

### 想做"对话历史"独立页面（Feature B）

- 新路由 `src/app/(dashboard)/conversations/page.tsx`
- 列出当前用户所有 session 的所有 conversation（按时间倒序）
- 复用 `/api/conversations?sessionId=` 已有的 API
- 复用 ChatTab 组件渲染选中的 conversation 只读视图

### 想换 token 估算方式（如改用各供应商原生 tokenizer）

`src/lib/llm/tokenizer.ts` 是唯一入口，重写它的 `estimateTokens` 即可。但要注意：
- `chunking.ts` 切块用它
- `tokenBudget.ts` breakdown 算它
- `chatContextBuilder.ts` 内部反复调它

测试改动：`tokens.test.ts`（未来如果加）应该覆盖中英混杂 / 代码块 / emoji 等典型 transcript。

---

## 9. 提交规范回顾

近 20 个 commit 风格：

```
feat: 中文功能描述 — 关键细节 (#PR)
fix:  中文修复描述 — 影响范围 (#PR)
style: 主题
```

通常一个 PR 修一类问题，commit body 详述。PR #64 本身是大改造特例，分了 2 个 commit 体（Cloudreve refresh + LLM 上下文管理）。后续小改动应回到单 commit 一类问题的节奏。

---

## 10. 致谢

PR #64 的设计在 2026-05 由 Plus Chen + Claude Opus 4.7 (1M context) 在多轮对话中迭代完成。多次重要决策反转（最大的是 ADR-006 中"先压历史"→"先缩 transcript 窗口"的颠覆）都因为用户对自己产品数据特性的洞察。

文档本身的目的是让后续工作不需要重新走一遍这个迭代 —— 如果你接手时发现有"为什么这么做？"的疑问，先查这里。
