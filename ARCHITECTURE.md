# LectureLive 系统架构文档

## 1. 项目概述

LectureLive 是一个**实时课堂转录与智能笔记平台**（v0.2.0），为大学课堂场景设计。核心功能包括：

- 实时语音转文字（ASR）
- 多语言实时翻译（云端 + 本地浏览器端）
- AI 驱动的实时摘要与笔记生成
- 多人实时共享（Live Share）
- 录音回放与导出
- 文件夹管理与关键词提取
- 文档解析（PDF / DOCX）
- 移动端自适应（响应式 + PWA）

---

## 2. 技术栈总览

| 层级 | 技术 |
|------|------|
| **前端框架** | Next.js 15 (App Router) + React 18 + TypeScript |
| **样式** | Tailwind CSS 3.4（cream/charcoal/rust 自定义色板） |
| **状态管理** | Zustand 5 |
| **实时通信** | Socket.IO 4.8（独立 WebSocket 服务器） |
| **数据库** | MySQL 8.4 + Prisma ORM 5.22 |
| **缓存/消息** | Redis 7（令牌黑名单、速率限制） |
| **语音识别** | Soniox ASR（浏览器直连，后端发放临时 API Key） |
| **翻译** | Soniox 云端翻译 / Helsinki-NLP ONNX 本地浏览器翻译（Transformers.js 3.4） |
| **LLM** | 多供应商网关（Claude、GPT、DeepSeek 等，OpenAI 兼容 + Anthropic 原生） |
| **文档解析** | mammoth（DOCX）/ pdf-parse（PDF） |
| **文件存储** | Cloudreve（自托管对象存储） |
| **国际化** | 自研 i18n（中/英） |
| **部署** | Docker Compose + Nginx 反向代理 + systemd |

---

## 3. 系统架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                     客户端（浏览器 / PWA）                         │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌───────────────┐  │
│  │ React UI │  │ Zustand  │  │ Soniox    │  │ Local         │  │
│  │ 组件层    │  │ Store 层 │  │ ASR 直连   │  │ Translator    │  │
│  │(桌面+移动)│  │          │  │ (WebSocket)│  │ (ONNX/WebGPU) │  │
│  └────┬─────┘  └────┬─────┘  └─────┬─────┘  └───────────────┘  │
│       │              │              │                            │
│       └──────┬───────┘              │                            │
│              │                      │                            │
│    ┌─────────▼─────────┐   ┌───────▼────────┐                   │
│    │  Socket.IO Client │   │ IndexedDB      │                   │
│    │  (Live Share)     │   │ (草稿持久化)    │                   │
│    └─────────┬─────────┘   └────────────────┘                   │
└──────────────┼──────────────────────┼────────────────────────────┘
               │                      │
               │ :3001                │ Soniox Cloud
               ▼                      ▼
┌──────────────────────┐    ┌──────────────────┐
│  WebSocket Server    │    │  Soniox ASR API  │
│  (server/websocket.ts│    │  (外部服务)       │
│   Socket.IO)         │    └──────────────────┘
│  - Live Share 广播   │
│  - 房间管理          │
│  - 连接限流          │
└──────────┬───────────┘
           │ Prisma
           ▼
┌──────────────────────────────────────────────────────────────┐
│                    Next.js App (:3000)                        │
│                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────┐ │
│  │ App Router  │  │ API Routes   │  │ Middleware           │ │
│  │ Pages (SSR) │  │ /api/*       │  │ - JWT 鉴权           │ │
│  │             │  │              │  │ - Origin 校验        │ │
│  │ (auth)      │  │ /api/auth/*  │  │ - 路径穿越检查        │ │
│  │ (dashboard) │  │ /api/sessions│  │ - Cookie→Header 注入 │ │
│  │ /session/*  │  │ /api/llm/*   │  │ - 安全 Headers       │ │
│  │ /setup      │  │ /api/admin/* │  └─────────────────────┘ │
│  └─────────────┘  │ /api/share/* │                           │
│                   │ /api/storage/│                           │
│                   │ /api/soniox/*│                           │
│                   │ /api/folders/│                           │
│                   │ /api/export  │                           │
│                   │ /api/users/* │                           │
│                   └──────┬───────┘                           │
│                          │                                   │
│  ┌───────────────────────▼───────────────────────────────┐   │
│  │                   核心业务层 (src/lib/)                 │   │
│  │                                                       │   │
│  │  ┌─────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │   │
│  │  │ LLM     │ │ Auth     │ │ Storage  │ │ Live     │  │   │
│  │  │ Gateway │ │ (JWT/    │ │(Cloudreve)│ │ Share    │  │   │
│  │  │ (多供应商)│ │ bcrypt)  │ │          │ │          │  │   │
│  │  ├─────────┤ ├──────────┤ ├──────────┤ ├──────────┤  │   │
│  │  │ Summary │ │ Rate     │ │ Export   │ │ Keywords │  │   │
│  │  │ Manager │ │ Limiter  │ │ (MD/SRT/ │ │ Extract  │  │   │
│  │  │         │ │          │ │  JSON)   │ │          │  │   │
│  │  ├─────────┤ ├──────────┤ ├──────────┤ ├──────────┤  │   │
│  │  │ Crypto  │ │ Quota    │ │ Audit    │ │ i18n     │  │   │
│  │  │ (加密)   │ │ (配额)   │ │ Log      │ │          │  │   │
│  │  ├─────────┤ ├──────────┤ ├──────────┤ ├──────────┤  │   │
│  │  │ Report  │ │ File     │ │ Draft    │ │ Feature  │  │   │
│  │  │ Manager │ │ Parser   │ │ Persist  │ │ Flags    │  │   │
│  │  └─────────┘ └──────────┘ └──────────┘ └──────────┘  │   │
│  └───────────────────────────────────────────────────────┘   │
└──────────────────────┬───────────────────────────────────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
   ┌──────────┐ ┌──────────┐ ┌──────────────┐
   │ MySQL 8.4│ │ Redis 7  │ │ Cloudreve    │
   │ (Prisma) │ │ (缓存/   │ │ (文件存储)    │
   │          │ │  黑名单)  │ │ :5212        │
   │ :3306    │ │ :6379    │ │              │
   └──────────┘ └──────────┘ └──────────────┘
```

---

## 4. 进程模型

系统运行两个独立进程，由 Nginx 统一对外暴露：

| 进程 | 端口 | 职责 |
|------|------|------|
| **Next.js App** | `:3000` | HTTP 页面渲染 + REST API |
| **WebSocket Server** | `:3001` | Socket.IO 实时通信（Live Share） |

Nginx 路由规则：
- `/` → Next.js App（`:3000`）
- `/socket.io/` → WebSocket Server（`:3001`，升级为 WebSocket 连接）

---

## 5. 数据模型

```
User (用户)
 ├── role: ADMIN | PRO | FREE
 ├── avatarPath: 用户头像路径
 ├── roleExpiresAt: 角色过期时间
 ├── 配额: transcriptionMinutes / storageHours / allowedModels
 ├── sessions: Session[]
 └── shareLinks: ShareLink[]

Session (录音会话)
 ├── status: CREATED → RECORDING → PAUSED → FINALIZING → COMPLETED → ARCHIVED
 ├── audioSource: microphone | system_audio
 ├── sonioxRegion: us | eu | jp | auto
 ├── 存储路径: recordingPath / transcriptPath / summaryPath / reportPath
 ├── 语言: sourceLang / targetLang / llmProvider
 ├── shareLinks: ShareLink[]
 └── folders: FolderSession[] (多对多)

Folder (文件夹，支持树形嵌套)
 ├── parent/children: 自引用树
 ├── sessions: FolderSession[]
 └── keywordPool: FolderKeyword[]

FolderKeyword (文件夹级关键词库)
 ├── source: auto:{sessionId} | manual | file:{fileName}
 ├── confidence: 0-1 (LLM 评分)
 └── usageCount: 被引用次数

ShareLink (分享链接)
 ├── token: 唯一分享令牌
 ├── isLive: 是否实时分享
 └── expiresAt: 过期时间

LlmProvider (供应商配置)
 ├── apiKey: AES 加密存储
 ├── apiBase: 自定义 API 地址
 ├── isAnthropic: 是否使用 Anthropic 原生 API
 ├── sortOrder: 排序权重
 └── models: LlmModel[]

LlmModel (模型配置)
 ├── purpose: CHAT | REALTIME_SUMMARY | FINAL_SUMMARY | KEYWORD_EXTRACTION
 ├── thinkingDepth: low | medium | high (Extended Thinking)
 ├── maxTokens / temperature: 模型参数
 └── isDefault: 各用途下的默认模型

SiteSetting (Key-Value 站点配置)
AuditLog (审计日志: action / detail / userId / userName / ip)
```

---

## 6. 核心模块详解

### 6.1 语音识别（ASR）

采用 **Soniox Direct Stream** 架构：
1. 后端通过 `/api/soniox/temporary-key` 发放临时 API Key
2. 浏览器使用临时 Key **直连** Soniox WebSocket 服务
3. 音频采集由 `BrowserAudioInputSource` 处理（支持麦克风 / 系统音频）
4. 支持多区域（US/EU/JP/Auto），管理员可配置区域级 API Key
5. 内置连接健康检查（clientPing）

关键文件：
- `src/lib/soniox/client.ts` — Soniox 会话配置构建
- `src/lib/soniox/tokenProcessor.ts` — 令牌处理与文本段组装
- `src/lib/soniox/keywordMerger.ts` — 关键词合并
- `src/lib/soniox/audioSource.ts` — 音频源检测
- `src/lib/soniox/clientPing.ts` — 连接健康检查
- `src/lib/soniox/env.ts` — 环境配置
- `src/lib/soniox/microphoneManager.ts` — 麦克风设备选择
- `src/lib/audio/browserAudioInputSource.ts` — 浏览器音频源
- `src/lib/audio/audioCapture.ts` — 音频采集管道
- `src/lib/audio/audioChunkStore.ts` — IndexedDB 录音块存储
- `src/hooks/useSoniox.ts` — React Hook 封装
- `src/hooks/useMicrophoneMonitor.ts` — 音频电平监控

### 6.2 翻译系统

双模式翻译：

| 模式 | 实现 | 特点 |
|------|------|------|
| **Soniox 云端** | Soniox API 内置翻译 | 低延迟，需网络 |
| **本地浏览器** | Helsinki-NLP ONNX 模型 + Transformers.js 3.4 | 离线可用，WebGPU/WASM 加速 |

支持语言对：en↔zh、en↔ja、en↔ko、en↔fr、en↔de、en↔es 等。

关键文件：
- `src/lib/translation/localTranslator.ts` — 浏览器端 ONNX 翻译
- `src/lib/translation/scheduler.ts` — 翻译调度器
- `src/hooks/useTranslation.ts` — React Hook

### 6.3 LLM 网关

多供应商统一网关，支持 OpenAI 兼容 API 与 Anthropic 原生 API：

```
请求 → resolveProvider(purpose) → 数据库配置优先 / 环境变量 fallback → 调用上游 API
```

- **用途分离**：不同任务（对话、实时摘要、最终摘要、关键词提取）可配置不同模型
- **Extended Thinking**：支持 low/medium/high 三档思维深度
- **安全**：API Key 使用 AES 加密存储，支持密钥轮换脚本，响应错误截断防泄露
- **配额管理**：按用户角色限制可用模型
- **访问控制**：独立的 access 模块管理模型访问权限

关键文件：
- `src/lib/llm/gateway.ts` — 网关核心
- `src/lib/llm/access.ts` — 访问控制与配额检查
- `src/lib/llm/defaults.ts` — 默认模型配置
- `src/lib/llm/summaryManager.ts` — 增量摘要管理器
- `src/lib/llm/prompts.ts` — Prompt 模板
- `src/lib/llm/folderKeywords.ts` — 文件夹关键词提取
- `src/lib/llm/reportManager.ts` — 报告生成
- `src/lib/llm/providerAdmin.ts` — 供应商管理（CRUD）
- `src/lib/llm/security.ts` — API Key 加密/解密

### 6.4 实时共享（Live Share）

基于 Socket.IO 的实时协作：

```
广播者 (Broadcaster)
  │  emit: transcript_delta / translation_delta / summary_update / status_update
  ▼
WebSocket Server (房间管理)
  │  broadcast to room
  ▼
观看者 (Viewer) × N
  - 通过 ShareLink token 加入
  - 新加入时接收完整 snapshot
  - 之后接收增量 delta
```

安全措施：
- Origin 校验防止跨站 WebSocket 劫持
- 每 IP 最大 10 连接
- 消息大小限制 100KB
- JWT 认证（广播者）/ ShareLink Token 认证（观看者）

关键文件：
- `server/websocket.ts` — WebSocket 服务器入口
- `src/lib/liveShare/server.ts` — 服务端房间逻辑
- `src/lib/liveShare/broadcaster.ts` — 客户端广播逻辑
- `src/lib/liveShare/viewer.ts` — 客户端观看逻辑

### 6.5 认证与安全

| 机制 | 实现 |
|------|------|
| **密码** | bcrypt 哈希 |
| **令牌** | JWT HS256，7天过期，30天绝对会话寿命 |
| **令牌传递** | Authorization Header 优先，Cookie 兜底（Middleware 自动注入） |
| **令牌撤销** | Redis 黑名单 + 内存 Map 双层 |
| **API Key 加密** | AES 对称加密，支持密钥轮换（`scripts/reencrypt-llm-provider-keys.mjs`） |
| **服务端密钥** | 统一由 `serverSecrets.ts` 管理 |
| **中间件** | Origin 校验、路径穿越检查、安全 Headers (X-Frame-Options, CSP 等) |
| **速率限制** | 基于 IP 的令牌桶算法 |
| **审计日志** | 关键操作写入 AuditLog 表 |

### 6.6 文件存储

- **开发环境**：本地文件系统（`data/` 目录），按类别存放 recordings / transcripts / summaries / recording-drafts
- **生产环境**：Cloudreve 自托管对象存储，路径格式 `/{userId}/{category}/{fileName}`
- 上传/下载通过 `/api/storage/upload` 和 `/api/storage/download` 代理

### 6.7 草稿持久化

录音过程中数据通过 IndexedDB 实时持久化，防止意外中断导致数据丢失：

- `src/lib/audio/audioChunkStore.ts` — 音频块 IndexedDB 存储
- `src/lib/recordingDraftPersistence.ts` — 录音草稿持久化
- `src/lib/transcriptDraftPersistence.ts` — 转录草稿持久化
- 服务端草稿 API：`/api/sessions/[id]/audio/draft`、`/api/sessions/[id]/audio/draft/chunks`、`/api/sessions/[id]/audio/draft/finalize`、`/api/sessions/[id]/transcript/draft`

### 6.8 文档解析

支持解析外部文档用于关键词提取和上下文增强：

- `src/lib/fileParser.ts` — 统一文档解析入口
- 支持格式：PDF（pdf-parse）、DOCX（mammoth）

---

## 7. 前端架构

### 7.1 页面路由（App Router）

```
/                        — 首页（Landing）
/login, /register        — 认证页面 (auth group)
/home                    — 仪表板首页 (dashboard group, 需登录)
/folders                 — 文件夹管理
/folders/[id]            — 文件夹详情
/folders/unarchived      — 未归档会话
/shared                  — 共享链接管理
/settings                — 用户设置
/admin                   — 管理员后台
/session/new             — 新建录音会话
/session/[id]            — 录音中页面
/session/[id]/view       — 只读查看
/session/[id]/playback   — 录音回放
/setup                   — 首次安装向导
/library                 — 资源库
/privacy, /terms         — 法律页面
```

### 7.2 API 路由

```
/api/auth/*              — 认证（register / login / logout / me / refresh / change-password）
/api/sessions            — 会话 CRUD
/api/sessions/[id]       — 单个会话（GET / PUT / DELETE）
/api/sessions/[id]/audio — 音频上传
/api/sessions/[id]/audio/draft — 草稿音频（保存 / 分块 / 合并）
/api/sessions/[id]/transcript — 转录数据
/api/sessions/[id]/transcript/draft — 转录草稿
/api/sessions/[id]/finalize — 结束会话
/api/sessions/[id]/export — 导出
/api/sessions/[id]/move  — 移动到文件夹
/api/folders             — 文件夹 CRUD
/api/folders/batch       — 批量操作
/api/folders/[id]/keywords — 文件夹关键词
/api/llm/chat            — LLM 对话
/api/llm/models          — 可用模型列表
/api/llm/summarize       — 最终摘要
/api/llm/extract-keywords — 关键词提取
/api/llm/report          — 报告生成
/api/share/create        — 创建分享链接
/api/share/view/[token]  — 查看分享（含 /transcript）
/api/storage/upload      — 文件上传
/api/storage/download    — 文件下载
/api/soniox/temporary-key — Soniox 临时 Key
/api/soniox/ping         — Soniox 健康检查
/api/admin/users         — 用户管理
/api/admin/groups        — 用户组/角色管理
/api/admin/llm-providers — LLM 供应商 CRUD（含子路由 /[id]/models）
/api/admin/settings      — 站点设置
/api/admin/logs          — 审计日志
/api/admin/stats         — 仪表板统计
/api/admin/soniox        — Soniox 配置
/api/admin/upload-icon   — 自定义图标上传
/api/site-config         — 公共站点配置
/api/setup               — 初始安装向导
/api/users/quota         — 用户配额查询
/api/export              — 通用导出
/api/assets/icons/[fileName] — 自定义图标访问
```

### 7.3 状态管理（Zustand Stores）

| Store | 职责 |
|-------|------|
| `authStore` | 用户登录态、Token |
| `transcriptStore` | 转录文本段落 |
| `translationStore` | 翻译结果 |
| `summaryStore` | AI 摘要状态 |
| `chatStore` | AI 对话 |
| `keywordStore` | 关键词 |
| `settingsStore` | 用户偏好（语言、主题、侧边栏等） |
| `liveShareStore` | 实时共享状态 |
| `sharedLinksStore` | 分享链接管理 |
| `viewerSettingsStore` | 观看者设置 |

### 7.4 核心组件

**通用组件：**

| 组件 | 用途 |
|------|------|
| `TranscriptPanel` | 实时转录面板 |
| `TranslationPanel` | 翻译面板 |
| `SummaryPanel` | AI 摘要面板 |
| `ControlBar` | 录音控制栏 |
| `Sidebar` | 侧边栏导航 |
| `ExportModal` | 导出对话框（MD/SRT/JSON） |
| `SessionCard` | 会话卡片 |
| `NewSessionModal` | 新建会话对话框 |
| `SettingsDrawer` | 设置抽屉 |
| `ConnectionStatus` | 连接状态指示器 |
| `AuthSessionMonitor` | 会话有效性监控 |
| `ThemeProvider` | 主题（深色/浅色）供应器 |

**会话组件（`session/`）：**

| 组件 | 用途 |
|------|------|
| `AiPanel` | AI 对话/关键词/摘要 Tab 容器 |
| `ChatTab` | AI 对话界面 |
| `KeywordTab` | 关键词展示 |
| `SummaryTab` | 摘要展示 |
| `AudioLevelBar` | 音频电平可视化 |
| `MicSelector` | 麦克风设备选择器 |
| `LiveShareBadge` | 实时分享状态徽章 |
| `PipReferenceTool` | 画中画参考工具 |
| `SessionFinalizingOverlay` | 会话结束进度遮罩 |

**移动端组件（`mobile/`）：**

| 组件 | 用途 |
|------|------|
| `MobileSessionLayout` | 移动端会话布局 |
| `MobileSessionHeader` | 移动端会话头部 |
| `MobileControlBar` | 移动端控制栏 |
| `MobileContentTabs` | 移动端内容标签页 |
| `BottomTabBar` | 底部导航栏 |
| `BottomSheet` | 底部弹出面板 |
| `ActionSheet` | 移动端操作菜单 |
| `MobileDrawer` | 移动端侧边抽屉 |

**管理后台组件（`admin/`）：**

| 组件 | 用途 |
|------|------|
| `DashboardPanel` | 管理员仪表板 |
| `UserManagementPanel` | 用户管理 |
| `UserGroupsPanel` | 用户组管理 |
| `SettingsPanel` | 站点设置 |
| `AuditLogPanel` | 审计日志查看器 |

### 7.5 自定义 Hooks

| Hook | 用途 |
|------|------|
| `useAuth` | 认证与用户管理 |
| `useSoniox` | Soniox ASR 客户端集成 |
| `useTranslation` | 翻译调度与状态 |
| `useSummary` | 摘要生成状态 |
| `useChat` | LLM 对话集成 |
| `useKeywords` | 关键词提取与管理 |
| `useLiveShare` | 实时分享广播 |
| `useMicrophoneMonitor` | 音频电平监控 |
| `useIsMobile` | 移动端断点检测（768px） |
| `useKeyboardHeight` | 虚拟键盘高度适配 |
| `useSwipeGesture` | 触摸滑动手势识别 |

---

## 8. 部署架构

```
                    ┌──────────┐
                    │  Nginx   │
                    │  :80/443 │
                    └────┬─────┘
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
    ┌──────────────────┐  ┌──────────────────┐
    │ Next.js App      │  │ WebSocket Server │
    │ (lecturelive-web)│  │ (lecturelive-ws) │
    │ :3000            │  │ :3001            │
    └────────┬─────────┘  └────────┬─────────┘
             │                     │
    ┌────────┴─────────────────────┴────────┐
    │           Docker Internal Network      │
    ├──────────┬──────────┬─────────────────┤
    │ MySQL 8.4│ Redis 7  │ Cloudreve       │
    │ :3306    │ :6379    │ :5212           │
    └──────────┴──────────┴─────────────────┘
```

部署方式：
- **Docker Compose**：一键启动所有服务（`docker-compose.yml`），多阶段构建（`Dockerfile`），入口脚本 `docker-entrypoint.sh` 负责数据库同步与进程启动
- **裸机部署**：systemd 服务（`lecturelive-web.service` + `lecturelive-ws.service`）
- 部署脚本：`deploy/setup.sh`（首次安装）、`deploy/upgrade.sh`（升级）、`deploy/rollback.sh`（回滚）
- 打包脚本：`deploy/pack.sh`（生成 `lecturelive-deploy.tar.gz`）
- Nginx 配置：`deploy/nginx-lecturelive.conf`
- 安装指南：`deploy/INSTALL.md`
- 工具脚本：`scripts/ensure-database.mjs`（数据库同步）、`scripts/reencrypt-llm-provider-keys.mjs`（API Key 密钥轮换）

---

## 9. 数据流

### 9.1 录音会话完整流程

```
1. 用户点击"开始录音"
   → 创建 Session (status: CREATED)
   → 获取 Soniox 临时 API Key
   → 浏览器采集音频，直连 Soniox WebSocket

2. 实时转录中 (status: RECORDING)
   → Soniox 返回 token → tokenProcessor 组装文本段
   → 翻译：Soniox 云端翻译 或 本地 ONNX 模型
   → 摘要：SummaryManager 每 12 句 / 3 分钟触发 LLM 增量摘要
   → 录音块暂存 IndexedDB（audioChunkStore）
   → 转录/录音草稿实时持久化（Draft Persistence）
   → 可选：LiveShare 广播给观看者

3. 结束录音 (status: FINALIZING)
   → SessionFinalizingOverlay 展示进度
   → 合并录音块为 WebM → 修复 duration 元数据
   → 上传录音/转录/摘要至 Cloudreve（或本地存储）
   → 更新 Session 路径字段
   → status → COMPLETED

4. 会后
   → 查看/回放/导出（Markdown / SRT / JSON）
   → AI 对话（基于转录内容提问）
   → 关键词提取 → 写入 FolderKeyword
   → 生成报告
```

---

## 10. 安全边界

| 边界 | 防护措施 |
|------|----------|
| 浏览器 → Next.js API | JWT 认证 + Middleware 拦截 + Origin 校验 + CORS |
| 浏览器 → WebSocket | Origin 校验 + JWT/ShareToken + IP 连接限制 |
| 浏览器 → Soniox | 临时 API Key（由后端发放，短期有效） |
| Next.js → 数据库 | Prisma 参数化查询（防 SQL 注入） |
| Next.js → LLM API | API Key AES 加密存储 + 密钥轮换 + 错误信息截断 |
| Next.js → Cloudreve | 私有网络内通信 + 路径清理（sanitizePath） |
| 用户输入 | 路径穿越检查 + SVG 清理 + 输入验证 |

---

## 11. 目录结构

```
lecture-live/
├── server/
│   └── websocket.ts              # 独立 WebSocket 服务器
├── src/
│   ├── app/                      # Next.js App Router 页面 & API
│   │   ├── (auth)/               # 登录/注册
│   │   ├── (dashboard)/          # 需登录的仪表板页面
│   │   │   ├── home/             # 仪表板首页
│   │   │   ├── folders/          # 文件夹管理（含 [id] / unarchived）
│   │   │   ├── shared/           # 共享链接
│   │   │   ├── settings/         # 用户设置
│   │   │   └── admin/            # 管理后台
│   │   ├── api/                  # REST API 路由（50+ 端点）
│   │   ├── session/              # 录音会话相关页面
│   │   ├── setup/                # 首次安装向导
│   │   └── library/              # 资源库
│   ├── components/               # React 组件
│   │   ├── admin/                # 管理后台组件
│   │   ├── session/              # 会话页面组件
│   │   ├── mobile/               # 移动端专用组件
│   │   ├── folder/               # 文件夹组件
│   │   ├── viewer/               # 观看者组件
│   │   └── layout/               # 布局组件
│   ├── hooks/                    # React Custom Hooks（11 个）
│   ├── lib/                      # 核心业务逻辑
│   │   ├── audio/                # 音频采集/存储/上传/草稿
│   │   ├── export/               # 导出（MD/SRT/JSON）
│   │   ├── i18n/                 # 国际化（中/英）
│   │   ├── keywords/             # 关键词管理
│   │   ├── liveShare/            # 实时共享（服务端+客户端）
│   │   ├── llm/                  # LLM 网关 & 摘要/关键词/报告/访问控制
│   │   ├── soniox/               # Soniox ASR 客户端（7 个模块）
│   │   ├── storage/              # Cloudreve 存储
│   │   └── translation/          # 翻译（本地+调度）
│   ├── stores/                   # Zustand 状态管理（10 个 Store）
│   └── types/                    # TypeScript 类型定义
├── prisma/
│   └── schema.prisma             # 数据模型定义（10 个模型）
├── scripts/
│   ├── ensure-database.mjs       # 数据库 Schema 同步
│   └── reencrypt-llm-provider-keys.mjs  # API Key 密钥轮换
├── deploy/                       # 部署脚本 & 配置
│   ├── setup.sh                  # 首次安装
│   ├── upgrade.sh                # 升级
│   ├── rollback.sh               # 回滚
│   ├── pack.sh                   # 打包
│   ├── nginx-lecturelive.conf    # Nginx 配置
│   ├── lecturelive-web.service   # systemd 服务（Web）
│   ├── lecturelive-ws.service    # systemd 服务（WebSocket）
│   ├── ws-package.json           # WebSocket 独立依赖
│   ├── shims/                    # 构建 shim
│   └── INSTALL.md                # 安装指南
├── data/                         # 本地开发数据存储
│   ├── recordings/               # WebM 录音文件
│   ├── transcripts/              # 转录 JSON
│   ├── summaries/                # 摘要 JSON
│   └── recording-drafts/         # 录音草稿
├── docker-compose.yml
├── Dockerfile                    # 多阶段构建
├── docker-entrypoint.sh          # 容器入口脚本
├── next.config.js
├── tailwind.config.ts
└── package.json
```
