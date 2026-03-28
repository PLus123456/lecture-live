# 计费系统待修复问题清单

## P0 - 上线前必修

### 1. 异常 Session 自动回收

**问题：** RECORDING / PAUSED 状态的 session 如果用户关闭浏览器，永远不会 finalize，quota 不扣费。

**涉及文件：**
- `src/app/api/sessions/[id]/finalize/route.ts`
- `src/lib/quota.ts`

**修复方案：**
- 新增定时任务（cron / 启动时扫描），查找 RECORDING 或 PAUSED 状态超过 N 小时（建议 4h）的 session
- 自动按服务端时长 `(now - serverStartedAt - serverPausedMs)` 计算 duration 并执行 finalize 流程
- 扣除对应 quota
- 记录日志标记为"系统自动回收"

---

### 2. 转录数据丢失时仍允许结算

**问题：** 客户端 sessionStorage 清空 + 服务端 draft 丢失时，finalize 报错"转录数据不存在"，导致用了服务但无法结算。

**涉及文件：**
- `src/app/api/sessions/[id]/finalize/route.ts`（约 157-168 行）

**修复方案：**
- 当转录数据不存在时，允许以空转录完成 finalize
- 仍按服务端时长扣费
- 标记该 session 为"转录缺失"供后续排查

---

## P1 - 尽快修复

### 3. 对账容差过大

**问题：** `reconcileTranscriptionUsage()` 过滤了 `|drift| <= 1` 分钟的偏差，系统性少算 1 分钟/session 时检测不到。

**涉及文件：**
- `src/lib/quota.ts`（第 275 行）

**修复方案：**
- 将过滤条件从 `> 1` 改为 `> 0`
- 或者保留 1 分钟容差用于自动修复，但所有 drift 都记录到 ReconciliationMismatch 表

---

### 4. 定期自动对账

**问题：** 目前对账需要管理员手动触发，无自动机制。

**涉及文件：**
- `src/app/api/admin/reconciliation/route.ts`

**修复方案：**
- 新增定时任务每天自动执行一次 reconciliation
- drift > 0 的记录写入数据库
- 可选：drift > N 分钟时发送告警通知

---

## P2 - 改进项

### 5. 时区统一为 UTC

**问题：** `getNextQuotaResetAt()` 用 `new Date()` 构造日期，依赖服务器本地时区，部署环境不同可能导致配额重置时间偏移。

**涉及文件：**
- `src/lib/billing.ts`（第 66-76 行）

**修复方案：**
- 改用 `Date.UTC()` 构造重置时间
- 或在部署配置中明确 `TZ=UTC`

---

### 6. 客户端 beforeunload 兜底

**问题：** 用户关闭浏览器时没有尝试触发 finalize。

**涉及文件：**
- `src/stores/transcriptStore.ts`
- 录音相关页面组件

**修复方案：**
- 在 `beforeunload` / `visibilitychange` 事件中用 `navigator.sendBeacon` 发送 finalize 请求
- 作为 P0 自动回收的补充，不作为唯一保障
