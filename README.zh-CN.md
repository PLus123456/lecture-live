<div align="center">

<img src="public/icon.svg" alt="LectureLive logo" width="120" height="120" />

# LectureLive

### 实时课堂转录与智能笔记平台

[![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=next.js)](https://nextjs.org/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-3.4-06B6D4?logo=tailwindcss)](https://tailwindcss.com/)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-4.8-010101?logo=socket.io)](https://socket.io/)
[![Prisma](https://img.shields.io/badge/Prisma-5-2D3748?logo=prisma)](https://www.prisma.io/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker)](https://www.docker.com/)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

[**English**](README.md) | [**中文**](README.zh-CN.md)

<br />

*将每一堂课变为可搜索、可分享、AI 增强的笔记 —— 实时。*

</div>

---

## 项目简介

LectureLive 是一个全栈 Web 应用，将实时语音识别、多语言翻译和 AI 智能摘要带入课堂。教师开启一个会话，学生通过分享链接加入，所有人都能获得实时转录文本，并可进行标注、摘要和导出。

<details>
<summary><strong>核心亮点</strong></summary>

- **实时转录** —— 通过 Soniox ASR 在浏览器中直接进行语音转文字流式传输
- **实时协作** —— 多人通过 WebSocket 同步查看同一份转录文本
- **AI 智能摘要** —— 支持接入 Claude、GPT、DeepSeek 或任何 OpenAI 兼容的 LLM
- **多语言翻译** —— 云端翻译或完全本地化（ONNX + WebGPU 浏览器端推理）
- **录音回放** —— 录制音频并关联转录文本，支持后续回放
- **智能文件夹** —— 自动提取关键词，智能组织会话
- **多格式导出** —— Markdown、SRT 字幕、JSON 报告
- **移动端优先** —— 响应式设计，专属移动端组件
- **自托管部署** —— Docker Compose 一键部署

</details>

## 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                         浏览器                               │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌───────────┐  │
│  │ Next.js  │  │ Soniox   │  │ Socket.IO │  │ 本地      │  │
│  │ React UI │  │ ASR SDK  │  │ 客户端    │  │ ONNX 翻译 │  │
│  └────┬─────┘  └────┬─────┘  └─────┬─────┘  └───────────┘  │
└───────┼──────────────┼──────────────┼───────────────────────┘
        │              │              │
        ▼              ▼              ▼
┌──────────────┐ ┌───────────┐ ┌───────────────┐
│  Next.js API │ │ Soniox    │ │  WebSocket    │
│  (端口 3000) │ │ 云端 ASR  │ │  (端口 3001)  │
└──────┬───────┘ └───────────┘ └───────┬───────┘
       │                               │
       ▼                               ▼
┌────────────┐  ┌─────────┐    ┌─────────────┐
│  MySQL 8.4 │  │ Redis 7 │    │  LLM 网关   │
│  (Prisma)  │  │         │    │  (多供应商)  │
└────────────┘  └─────────┘    └─────────────┘
```

## 技术栈

| 层级 | 技术方案 |
|:-----|:---------|
| 前端框架 | Next.js 15 (App Router) + React 18 + TypeScript |
| 样式 | Tailwind CSS 3.4（自定义奶油/炭灰/铁锈色主题） |
| 状态管理 | Zustand 5 |
| 实时通信 | Socket.IO 4.8（独立 WebSocket 服务器） |
| 数据库 | MySQL 8.4 + Prisma ORM 5 |
| 缓存 | Redis 7（令牌黑名单、速率限制） |
| 语音识别 | Soniox（浏览器直连流式传输） |
| 翻译 | Soniox Cloud + Helsinki-NLP ONNX（本地，Transformers.js） |
| LLM | 多供应商网关（Claude / GPT / DeepSeek / 自定义） |
| 文件存储 | Cloudreve（自托管） |
| 部署 | Docker Compose + Nginx |

## 快速开始

### 环境要求

- **Node.js** >= 20
- **MySQL** 8.x
- **Redis** 7.x
- **npm** 或 **pnpm**

### 本地开发

```bash
# 1. 克隆仓库
git clone https://github.com/PLus123456/lecture-live.git
cd lecture-live

# 2. 安装依赖
npm install

# 3. 配置环境变量
cp .env.example .env.local
# 编辑 .env.local —— 至少设置 DATABASE_URL、REDIS_URL、JWT_SECRET

# 4. 初始化数据库
npm run db:ensure

# 5. 启动开发服务器（需要两个终端）
npm run dev        # Next.js → http://localhost:3000
npm run dev:ws     # WebSocket → ws://localhost:3001
```

### Docker 部署

```bash
# 1. 配置环境变量
cp .env.example .env.local
# 设置 DB_PASSWORD、MYSQL_ROOT_PASSWORD、REDIS_PASSWORD、JWT_SECRET、ENCRYPTION_KEY

# 2. 启动所有服务
docker-compose up -d

# 3. 验证部署
curl http://localhost:3000/api/health
```

Docker 包含以下服务：**应用**（Next.js + WebSocket）、**MySQL 8.4**、**Redis 7** 和 **Cloudreve**（文件存储）。

## 功能特性

### 实时语音转录
浏览器直连 Soniox ASR 实现低延迟流式语音转文字，支持多语言和多区域端点。

### 实时协作
分享会话链接，所有参与者通过 WebSocket 实时同步查看转录更新、AI 摘要和关键词标签。

### AI 摘要与解读
通过统一网关接入多个 LLM 供应商，支持基于完整会话上下文的多轮对话，深入问答课程内容。

### 智能文件夹与关键词
将会话组织到层级文件夹中，关键词由 LLM 自动提取并按置信度排序，便于查找和交叉引用。

### 多格式导出
将转录文本导出为 **Markdown** 文档、**SRT** 字幕文件或结构化 **JSON** 报告。

### 配额与计费
内置使用量追踪，分级配额体系（免费版 / 专业版 / 管理员）。包含月度重置脚本和用量对账工具。

### 管理后台
管理用户、配置 LLM 供应商（API Key 加密存储）、监控使用量、调整系统设置 —— 全部通过 Web 界面操作。

## 项目结构

```
lecture-live/
├── src/
│   ├── app/                # Next.js App Router（页面 + API 路由）
│   │   ├── (auth)/         # 登录 / 注册
│   │   ├── (dashboard)/    # 首页、文件夹、设置、管理后台
│   │   ├── session/        # 录制与回放
│   │   ├── library/        # 共享会话
│   │   └── api/            # REST API 接口
│   ├── components/         # React 组件（含移动端变体）
│   ├── hooks/              # 自定义 Hooks（ASR、实时分享、认证等）
│   ├── lib/                # 核心逻辑（LLM、导出、配额、认证等）
│   ├── stores/             # Zustand 状态仓库
│   └── types/              # TypeScript 类型定义
├── server/
│   └── websocket.ts        # 独立 Socket.IO 服务器
├── prisma/
│   └── schema.prisma       # 数据库模型定义
├── scripts/                # 工具和维护脚本
├── tests/                  # Vitest 单元测试
├── e2e/                    # Playwright E2E 测试
├── docker-compose.yml
├── Dockerfile
└── deploy/                 # 部署配置
```

## 环境变量

完整列表请参阅 [`.env.example`](.env.example)，关键变量如下：

| 变量 | 说明 |
|:-----|:-----|
| `DATABASE_URL` | MySQL 连接字符串 |
| `REDIS_URL` | Redis 连接字符串 |
| `JWT_SECRET` | JWT 签名密钥（至少 32 字符） |
| `ENCRYPTION_KEY` | API Key 加密密钥 |
| `SONIOX_API_KEY` | Soniox ASR API 密钥（后备；推荐通过管理界面配置） |
| `NEXT_PUBLIC_APP_URL` | 应用地址（默认 `http://localhost:3000`） |
| `NEXT_PUBLIC_WS_URL` | WebSocket 地址（默认 `http://localhost:3001`） |

> **安全提示**：LLM 供应商 API Key 和 Soniox 凭证应通过管理后台配置，数据库中加密存储。环境变量仅作为后备方案。

## 常用命令

| 命令 | 说明 |
|:-----|:-----|
| `npm run dev` | 启动 Next.js 开发服务器 |
| `npm run dev:ws` | 启动 WebSocket 开发服务器 |
| `npm run build` | 生产环境构建 |
| `npm run test` | 运行单元测试（Vitest） |
| `npm run test:e2e` | 运行端到端测试（Playwright） |
| `npm run db:ensure` | 自动同步数据库结构 |
| `npm run db:studio` | 打开 Prisma Studio 可视化界面 |
| `npm run billing:reset-quotas` | 重置月度转录配额 |
| `npm run billing:reconcile` | 对账转录使用量 |

## 参与贡献

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建功能分支（`git checkout -b feature/amazing-feature`）
3. 提交更改（`git commit -m 'Add amazing feature'`）
4. 推送到分支（`git push origin feature/amazing-feature`）
5. 发起 Pull Request

## 开源协议

本项目基于 GNU General Public License v3.0 开源 —— 详见 [LICENSE](LICENSE) 文件。

## 致谢

- [Soniox](https://soniox.com/) —— 实时语音识别
- [Transformers.js](https://huggingface.co/docs/transformers.js) —— 浏览器端 ML 推理
- [Prisma](https://www.prisma.io/) —— 类型安全的数据库 ORM
- [Socket.IO](https://socket.io/) —— 实时双向通信
- [Cloudreve](https://cloudreve.org/) —— 自托管文件存储

---

<div align="center">

**如果这个项目对你有帮助，请给一个 Star！**

</div>
