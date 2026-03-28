# 计时计费系统问题清单

> 生成日期: 2026-03-27
> 目标: 逐项修复以下问题，使计时系统达到可用于真实计费的可靠程度

---

## 一、会导致平台亏钱的问题

### 1. 录制中不强制最大时长，仅在 finalize 时 clamp

- **文件**: `src/lib/sessionFinalization.ts:231-234`（clampSessionDurationMs 调用）
- **文件**: `src/lib/billing.ts:7-18`（角色时长上限定义：FREE 2h / PRO 4h / ADMIN 无限）
- **现状**: 用户可以录 10 小时，服务端全程处理音频和转录，但结算时只收 4 小时的钱
- **修复方向**: 在录制过程中实时检查已用时长，到达上限自动结束会话。前端 `ControlBar` 倒计时提醒 + 后端 API 拒绝超时 session 的状态更新

### 2. 静音录制不触发空闲检测

- **文件**: `src/hooks/useSoniox.ts:1016-1029`（idle 检测逻辑）
- **现状**: idle detection 依赖 `lastAudioActivityAt`，只在音量超过阈值时更新。用户关麦录空白音频，永远不会触发 idle 暂停
- **修复方向**: 补充检测维度 — 如果连续 N 分钟音频电平为 0（或转录无新内容），也应触发自动暂停

### 3. 对账发现偏差但不自动修正

- **文件**: `src/lib/reconciliation.ts:26-37`（偏差写入 ReconciliationMismatch 表但不修正）
- **现状**: 每日对账只记录 drift，需要管理员手动干预
- **修复方向**: 对于小偏差（如 <=5 分钟），自动调整 `transcriptionMinutesUsed`；大偏差仍告警人工处理

---

## 二、会导致用户多付钱的问题

### 4. 断网重连期间暂停时间可能被计费

- **文件**: `src/hooks/useSoniox.ts:644, 842`（disconnect 时调用 pauseForInterruption）
- **文件**: `src/lib/audio/recordingDuration.ts:48-65`（服务端时长计算）
- **现状**: 网络中断 → 前端调用 pauseForInterruption('disconnect') → 但服务端的 `serverPausedAt` 可能未及时设置（因为网络断了请求发不出去）→ 重连后恢复，中间的断网时间被算入计费时长
- **修复方向**: 重连时将断网时段作为暂停时间补偿到 `serverPausedMs`；或在 finalize 时用 transcript 实际时间戳推算有效时长

### 5. 取最大值策略导致任何一个源偏高都会拉高账单

- **文件**: `src/lib/sessionFinalization.ts:225-230`（resolvedDurationMs = max(...)）
- **现状**: `max(durationMs, transcriptDurationMs, serverDurationMs, legacyFallback)` — 只要有一个源异常偏高（如服务器时钟漂移），就会多收费
- **修复方向**: 改为优先使用 transcript 时长（最可靠），server 时长作为兜底；或当多源差异超过阈值时取中位数

### 6. 向上取整到分钟对短会话不公平

- **文件**: `src/lib/billing.ts:36-46`（Math.ceil(durationMs / 60_000)）
- **现状**: 录了 1 秒也扣 1 分钟配额
- **修复方向**: 考虑设置最小计费阈值（如 <10 秒不计费），或改为按秒计费再向上取整到 0.1 分钟

---

## 三、系统稳定性 / 数据一致性问题

### 7. Finalize 锁竞争可能导致重复扣费

- **文件**: `src/lib/sessionFinalization.ts:144-160`（finalizeLockedAt 检查）
- **现状**: 用时间戳做锁，15 分钟过期后并发请求可能同时进入 finalize 流程，导致 `transcriptionMinutesUsed` 被 increment 两次
- **修复方向**: 用数据库事务级锁（SELECT ... FOR UPDATE）或在 session 上加 `finalizedAt` 字段做幂等检查 — 已有 `durationMs > 0` 则跳过

### 8. 配额重置竞态条件

- **文件**: `src/lib/quota.ts:102-111`（ensureQuotaWindow 的 optimistic locking）
- **现状**: 月初边界两个请求同时检测到 `quotaResetAt <= now`，都读到旧值，可能重置两次或跳过重置
- **修复方向**: 使用 `UPDATE ... WHERE quotaResetAt = oldValue`（CAS 操作）确保只有一个请求成功重置

### 9. 客户端/服务端时长不一致只记日志

- **文件**: `src/lib/sessionFinalization.ts:237-244`（mismatch warning log）
- **现状**: 偏差 >= 1 分钟只打 warning，不做任何纠正
- **修复方向**: 结合第 5 点的修复，当偏差超过阈值时选择更可靠的时长源（transcript），并记录选择原因

---

## 四、建议修复优先级

| 优先级 | 编号 | 问题 | 理由 |
|--------|------|------|------|
| P0 | #7 | Finalize 锁竞争 | 可能直接导致重复扣费 |
| P0 | #4 | 断网暂停不计费 | 用户体验和计费公平性 |
| P1 | #1 | 录制中强制最大时长 | 防止资源浪费 |
| P1 | #5 | 时长取值策略优化 | 计费准确性核心 |
| P1 | #8 | 配额重置竞态 | 数据一致性 |
| P2 | #3 | 对账自动修正 | 减少人工运维 |
| P2 | #2 | 静音空闲检测 | 边缘场景但影响成本 |
| P2 | #9 | 时长不一致处理 | 被 #5 部分覆盖 |
| P3 | #6 | 最小计费阈值 | 体验优化，非紧急 |

---

## 五、相关文件索引

| 文件 | 职责 |
|------|------|
| `src/lib/sessionFinalization.ts` | 会话结算主逻辑 |
| `src/lib/billing.ts` | 计费规则、角色时长上限、billableMinutes 计算 |
| `src/lib/audio/recordingDuration.ts` | 服务端时长计算 |
| `src/lib/quota.ts` | 配额管理、月度重置 |
| `src/lib/reconciliation.ts` | 每日对账 |
| `src/lib/billingMaintenance.ts` | 后台维护任务（过期会话回收、配额重置、对账触发） |
| `src/hooks/useSoniox.ts` | 前端录音 hook（idle 检测、断线处理） |
| `src/components/ControlBar.tsx` | 前端计时器 UI |
| `src/stores/transcriptStore.ts` | 前端计时状态管理 |
