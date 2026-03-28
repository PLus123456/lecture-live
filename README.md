<div align="center">

<img src="public/icon.svg" alt="LectureLive logo" width="120" height="120" />

# LectureLive

### Real-time Classroom Transcription & Intelligent Note-taking Platform

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

*Turn every lecture into searchable, shareable, AI-enhanced notes — in real time.*

</div>

---

## Overview

LectureLive is a full-stack web application that brings real-time speech recognition, multilingual translation, and AI-powered summarization into the classroom. Instructors start a session, students join via a share link, and everyone gets a live transcript that can be annotated, summarized, and exported.

<details>
<summary><strong>Key Highlights</strong></summary>

- **Live transcription** via Soniox ASR — speech-to-text streams directly in the browser
- **Real-time collaboration** — multiple users see the same transcript simultaneously via WebSocket
- **AI summarization** — plug in Claude, GPT, DeepSeek, or any OpenAI-compatible LLM
- **Multilingual translation** — cloud-based or fully local (ONNX + WebGPU in-browser)
- **Recording & playback** — record audio alongside transcripts, replay later
- **Smart folders** — organize sessions with auto-extracted keywords
- **Multi-format export** — Markdown, SRT subtitles, JSON reports
- **Mobile-first** — responsive design with dedicated mobile components
- **Self-hostable** — Docker Compose one-command deployment

</details>

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser                              │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌───────────┐  │
│  │ Next.js  │  │ Soniox   │  │ Socket.IO │  │ Local     │  │
│  │ React UI │  │ ASR SDK  │  │ Client    │  │ ONNX NMT  │  │
│  └────┬─────┘  └────┬─────┘  └─────┬─────┘  └───────────┘  │
└───────┼──────────────┼──────────────┼───────────────────────┘
        │              │              │
        ▼              ▼              ▼
┌──────────────┐ ┌───────────┐ ┌───────────────┐
│  Next.js API │ │ Soniox    │ │  WebSocket    │
│  (port 3000) │ │ Cloud ASR │ │  (port 3001)  │
└──────┬───────┘ └───────────┘ └───────┬───────┘
       │                               │
       ▼                               ▼
┌────────────┐  ┌─────────┐    ┌─────────────┐
│  MySQL 8.4 │  │ Redis 7 │    │  LLM Gateway│
│  (Prisma)  │  │         │    │  (Multi-vendor)
└────────────┘  └─────────┘    └─────────────┘
```

## Tech Stack

| Layer | Technology |
|:------|:-----------|
| Frontend | Next.js 15 (App Router) + React 18 + TypeScript |
| Styling | Tailwind CSS 3.4 (custom cream/charcoal/rust theme) |
| State | Zustand 5 |
| Real-time | Socket.IO 4.8 (independent WebSocket server) |
| Database | MySQL 8.4 + Prisma ORM 5 |
| Cache | Redis 7 (token blacklist, rate limiting) |
| ASR | Soniox (browser-direct streaming) |
| Translation | Soniox Cloud + Helsinki-NLP ONNX (local, via Transformers.js) |
| LLM | Multi-vendor gateway (Claude / GPT / DeepSeek / custom) |
| File Storage | Cloudreve (self-hosted) |
| Deployment | Docker Compose + Nginx |

## Getting Started

### Prerequisites

- **Node.js** >= 20
- **MySQL** 8.x
- **Redis** 7.x
- **npm** or **pnpm**

### Quick Start (Local Development)

```bash
# 1. Clone the repo
git clone https://github.com/PLus123456/lecture-live.git
cd lecture-live

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env.local
# Edit .env.local — at minimum set DATABASE_URL, REDIS_URL, JWT_SECRET

# 4. Initialize database
npm run db:ensure

# 5. Start development servers (two terminals)
npm run dev        # Next.js → http://localhost:3000
npm run dev:ws     # WebSocket → ws://localhost:3001
```

### Docker Deployment

```bash
# 1. Configure environment
cp .env.example .env.local
# Set DB_PASSWORD, MYSQL_ROOT_PASSWORD, REDIS_PASSWORD, JWT_SECRET, ENCRYPTION_KEY

# 2. Launch all services
docker-compose up -d

# 3. Verify
curl http://localhost:3000/api/health
```

The Docker stack includes: **App** (Next.js + WS), **MySQL 8.4**, **Redis 7**, and **Cloudreve** (file storage).

## Features

### Real-time Transcription
Connect to Soniox ASR directly from the browser for low-latency, streaming speech-to-text. Supports multiple languages and regional endpoints.

### Live Collaboration
Share a session link — all participants see transcript updates, AI summaries, and keyword tags in real time via WebSocket.

### AI Summarization & Interpretation
Integrate with multiple LLM providers through a unified gateway. Supports multi-turn conversation with full session context for deeper Q&A about lecture content.

### Smart Folders & Keywords
Organize sessions into hierarchical folders. Keywords are auto-extracted via LLM and ranked by confidence scores, making sessions easy to find and cross-reference.

### Multi-format Export
Export transcripts as **Markdown** documents, **SRT** subtitle files, or structured **JSON** reports.

### Quota & Billing
Built-in usage tracking with tiered quotas (Free / Pro / Admin). Includes monthly reset scripts and reconciliation tools.

### Admin Dashboard
Manage users, configure LLM providers (with encrypted API key storage), monitor usage, and adjust system settings — all from the web UI.

## Project Structure

```
lecture-live/
├── src/
│   ├── app/                # Next.js App Router (pages + API routes)
│   │   ├── (auth)/         # Login / Register
│   │   ├── (dashboard)/    # Home, Folders, Settings, Admin
│   │   ├── session/        # Recording & Playback
│   │   ├── library/        # Shared sessions
│   │   └── api/            # REST API endpoints
│   ├── components/         # React components (+ mobile variants)
│   ├── hooks/              # Custom hooks (ASR, live share, auth, etc.)
│   ├── lib/                # Core logic (LLM, export, quota, auth, etc.)
│   ├── stores/             # Zustand state stores
│   └── types/              # TypeScript type definitions
├── server/
│   └── websocket.ts        # Independent Socket.IO server
├── prisma/
│   └── schema.prisma       # Database schema
├── scripts/                # Utility & maintenance scripts
├── tests/                  # Vitest unit tests
├── e2e/                    # Playwright E2E tests
├── docker-compose.yml
├── Dockerfile
└── deploy/                 # Deployment configs
```

## Environment Variables

See [`.env.example`](.env.example) for the full list. Key variables:

| Variable | Description |
|:---------|:------------|
| `DATABASE_URL` | MySQL connection string |
| `REDIS_URL` | Redis connection string |
| `JWT_SECRET` | JWT signing secret (min 32 chars) |
| `ENCRYPTION_KEY` | Encryption key for stored API keys |
| `SONIOX_API_KEY` | Soniox ASR API key (fallback; prefer admin UI) |
| `NEXT_PUBLIC_APP_URL` | Application URL (default: `http://localhost:3000`) |
| `NEXT_PUBLIC_WS_URL` | WebSocket URL (default: `http://localhost:3001`) |

> **Security Note**: LLM provider API keys and Soniox credentials should be configured through the Admin Dashboard, where they are stored encrypted in the database. Environment variables serve only as fallback.

## Scripts Reference

| Command | Description |
|:--------|:------------|
| `npm run dev` | Start Next.js dev server |
| `npm run dev:ws` | Start WebSocket dev server |
| `npm run build` | Production build |
| `npm run test` | Run unit tests (Vitest) |
| `npm run test:e2e` | Run E2E tests (Playwright) |
| `npm run db:ensure` | Auto-sync database schema |
| `npm run db:studio` | Open Prisma Studio GUI |
| `npm run billing:reset-quotas` | Reset monthly transcription quotas |
| `npm run billing:reconcile` | Reconcile transcription usage |

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the GNU General Public License v3.0 — see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- [Soniox](https://soniox.com/) — Real-time speech recognition
- [Transformers.js](https://huggingface.co/docs/transformers.js) — In-browser ML inference
- [Prisma](https://www.prisma.io/) — Type-safe database ORM
- [Socket.IO](https://socket.io/) — Real-time bidirectional communication
- [Cloudreve](https://cloudreve.org/) — Self-hosted file storage

---

<div align="center">

**If this project helps you, please consider giving it a star!**

</div>
