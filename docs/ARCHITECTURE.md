# LectureLive Architecture & Data-Model Manifest

A deeper, more structured companion to the [README](../README.md). This is a one-stop
navigation reference for both human contributors and AI agents working in the codebase:
it maps the runtime processes, directory layout, database schema, key subsystems, API
surface, and deployment paths, with exact file/function names throughout.

- **Scope:** Next.js 15 (App Router) + TypeScript + Prisma (MySQL) + Redis + a standalone
  Socket.IO WebSocket process + Soniox realtime/async transcription + a multi-provider LLM
  gateway + Cloudreve object storage.
- **Convention:** paths are relative to the repository root. When this doc says "L1–L7" it
  refers to the chat-context degradation chain (see [Chat & LLM](#43-chat--llm)).

---

## 1. System Overview

LectureLive runs as **three cooperating processes** (the first two are mandatory):

| Process | Entry point | Port | Responsibility |
| :------ | :---------- | :--- | :------------- |
| **Next.js web** | `next start` / `next dev` (`src/app`) | 3000 | UI, all REST API routes (`src/app/api`), auth, billing, LLM gateway, storage orchestration, DB access. |
| **WebSocket server** | `server/websocket.ts` (dev: `dev:ws`, prod bundle: `dist/websocket.js`) | 3001 | Standalone Socket.IO process for live-share broadcast/viewer fan-out; keeps live snapshots in memory. Shares the DB (Prisma), Redis, and `.env` with the web process but runs independently. |
| **Cloudreve** (optional) | external container/service | 5212 | Self-hosted object storage for recordings, transcripts, summaries, reports, chat uploads, and site icons. When absent, artifacts fall back to local disk under `/app/data` (paths stored as `local:*`). |

Supporting infrastructure: **MySQL 8.4** (Prisma ORM) and **Redis 7** (JWT `jti` blacklist,
refresh-grace entries, rate-limit counters, interpret time anchors, response cache).

The browser does meaningful work too: it streams audio directly to Soniox (realtime ASR),
can run a local ONNX translation pipeline (Transformers.js/WebGPU), records audio locally
into IndexedDB while uploading draft chunks, and connects to the WS process as a live-share
broadcaster or viewer.

> **Docker note:** `docker-compose.yml` builds a single `app` image that runs *both* the web
> and WS processes inside one container (`docker-entrypoint.sh` starts `ws-server/websocket.js`
> and `server.js`), exposing 3000 + 3001. Cloudreve, MySQL, and Redis are separate services.
> Bare-metal deployment (see [Deployment](#8-deployment)) runs the two processes as separate
> systemd units.

---

## 2. Directory Navigation

| Path | Role |
| :--- | :--- |
| `src/app` | Next.js App Router. Route groups `(auth)` (login/register), `(dashboard)` (home, chat, folders, interpret, settings, admin, shared, conversations), `session/[id]` (record/view/playback), `library`, plus top-level `privacy` / `terms` / `setup`. `src/app/api` holds every REST endpoint. |
| `src/lib` | Server-side domain logic: auth, quota/billing, LLM gateway, Soniox clients, audio pipeline, live-share, storage (Cloudreve), export, reconciliation, job queue, i18n. The bulk of the system lives here. |
| `src/hooks` | Client React hooks: `useSoniox`, `useLiveShare`, `useChat`, `useInterpret`, `useTranslation`, `useSummary`, `useKeywords`, `useAuth`, `useExitAnimation`, mobile helpers. |
| `src/stores` | Zustand stores (one per concern): `authStore`, `transcriptStore`, `translationStore`, `summaryStore`, `keywordStore`, `chatStore`, `liveShareStore`, `settingsStore`, `viewerSettingsStore`, `sharedLinksStore`, `uploadJobsStore`, `toastStore`. |
| `src/components` | React UI, grouped by area: `admin`, `chat`, `session`, `viewer`, `folder`, `mobile`, `layout`, `global`, plus shared top-level components. |
| `src/types` | Shared TypeScript types. |
| `prisma` | `schema.prisma` (the single source of DB truth) + `migrations`. |
| `scripts` | Node/TS maintenance & ops scripts (DB ensure/migrate, quota reset, reconciliation, billing maintenance, key re-encryption, backfills). |
| `server` | `websocket.ts` — the standalone Socket.IO process. |
| `deploy` | Bare-metal install/upgrade/rollback scripts, `lecture-live` CLI, systemd units, nginx config, build shims, `INSTALL.md`. |
| `public` | Static assets: app icons, `fonts/NotoSansSC-Regular.ttf` (Noto Sans SC / 思源黑体, OFL, embedded into DOCX exports for CJK), README images. |
| `e2e` / `tests` / `**/__tests__` | Playwright E2E, shared test assets, and colocated Vitest unit tests. |

---

## 3. Data Model

Prisma schema: `prisma/schema.prisma` — **18 models**. Provider is MySQL; IDs are `cuid()`
unless noted. Enums: `UserRole` (ADMIN/PRO/FREE), `SessionStatus`
(CREATED→RECORDING→PAUSED→FINALIZING→COMPLETED→ARCHIVED), `LlmPurpose`
(CHAT / REALTIME_SUMMARY / FINAL_SUMMARY / KEYWORD_EXTRACTION / EMBEDDING).

### Model catalogue

| Model | Purpose | Key fields / relations |
| :---- | :------ | :--------------------- |
| **User** | Account, role, and per-user quota columns | `role`, `status` (1=active/0=disabled), `tokenVersion`, `originalRole`+`roleExpiresAt` (temporary group), `allowedModels` (CSV), `customGroupId`; quota: `transcriptionMinutesUsed/Limit`, `quotaResetAt`, `storageHoursUsed/Limit`, `storageBytesUsed/Limit`. Relations: `sessions[]`, `shareLinks[]`. |
| **Session** | One recording / upload | `status`, `durationMs`, server timing fields, `audioSource`, `sonioxRegion`, artifact paths (`recordingPath`/`transcriptPath`/`summaryPath`/`reportPath`), `translationMode`, lang fields, and the async-transcribe state (`sonioxFileId`, `sonioxTranscriptionId`, `asyncTranscribeStatus`, …). |
| **Folder** | User folder tree | self-relation `FolderTree` (`parentId`), `sessions[]` (via junction), `keywordPool[]`. |
| **FolderKeyword** | Per-folder keyword pool | `keyword`, `source` (`auto:{sessionId}` / `manual` / `file:{name}`), `confidence`, `usageCount`; unique `(folderId, keyword)`. |
| **FolderSession** | Folder↔Session junction | composite PK `(folderId, sessionId)`. |
| **ShareLink** | Share/live-share link | `token` (unique), `isLive`, `expiresAt`; relations to `session` and `creator`. |
| **AuditLog** | Admin/system audit trail | `action`, `detail`, `userId`+`userName` (redundant), `ip`, `createdAt`. |
| **ReconciliationRun** | A reconciliation execution | status, counts, `mismatches[]`. |
| **ReconciliationMismatch** | Per-user drift row | `recordedMinutes` vs `storedMinutes`, `driftMinutes`, `fixed`. |
| **InterpretUsage** | Simultaneous-interpretation billing ledger | `userId` (redundant column, no relation), `billedMinutes`, `durationMs`, `chargedAt`. One row per successful `/api/interpret/deduct`; feeds reconciliation so interpret minutes aren't reported as drift. |
| **SiteSetting** | Key-value store | `key` PK, `value` (TEXT). Holds site config, group definitions, Cloudreve OAuth tokens (encrypted), async-billing multiplier, etc. |
| **LlmProvider** | LLM vendor endpoint | `apiKey` (encrypted at rest), `apiBase`, `isAnthropic`, `models[]`. |
| **LlmModel** | A model under a provider | `modelId`, `purpose` (LlmPurpose), `isDefault`, `thinkingMode` (NONE/AUTO/FORCED/DEPTH), `thinkingDepth`, `supportsImage`, `maxTokens`, `contextWindow`, `temperature`. |
| **JobQueue** | Background job records | `type`, `status` (SUBMITTED→PENDING→PROCESSING→SUCCESS/FAILED), retry counters, `params`/`result`/`error`. |
| **Conversation** | A chat thread | `sessionId?`, `userId?` (owner; NULL = orphan → hidden/404), `title`, `endedAt` (null=active), `degradationLevel` (1–7, monotone), `archived`. Relations: `messages[]`, `attachments[]`, `sessions[]`. |
| **ConversationSession** | Conversation↔Session junction | composite PK; lets one chat span multiple recordings. |
| **ConversationMessage** | One chat message | `role`, `content` (TEXT), `transcriptOffsetMs?`, `degradationLevel?`, `inputTokens?`/`outputTokens?`, `seq` (global `@unique autoincrement` — stable ordering key). |
| **ChatAttachment** | Chat upload (image/doc/text) | `userId` (redundant), `kind`, `bytes` (quota basis), `cloudrevePath`, `extractedTextPath?`, `lastAccessedAt` (LRU cleanup). |

### Key relationships

```text
User 1──N Session 1──N ShareLink
User (quota columns only; InterpretUsage/ChatAttachment/Conversation.userId are
      redundant columns, NOT relations, to avoid User back-relation bloat)

Session 1──N Conversation 1──N ConversationMessage   (ordered by seq)
                          1──N ChatAttachment
                          M──N Session  (via ConversationSession — one chat, many recordings)

Folder ──self── Folder (tree)   Folder M──N Session (FolderSession)   Folder 1──N FolderKeyword

LlmProvider 1──N LlmModel (selected by purpose + isDefault)
ReconciliationRun 1──N ReconciliationMismatch
```

---

## 4. Key Subsystems & Request Flows

### 4.1 Realtime recording & transcription

Browser-driven capture with server-side draft backup and a single finalization/billing point.

1. **Capture** — `src/hooks/useSoniox.ts` drives `RecordingArchiveManager`
   (`src/lib/audio/recordingArchiveManager.ts`): acquires the mic/system-audio stream,
   records into IndexedDB in 250 ms slices, and opens a Soniox realtime WebSocket via a
   temporary key (`src/lib/soniox/client.ts`). `TokenProcessor`
   (`src/lib/soniox/tokenProcessor.ts`) turns streamed tokens into finalized transcript
   segments held in `transcriptStore`.
2. **Draft backup (record-as-you-go)** — each audio slice is uploaded to
   `POST /api/sessions/[id]/audio/draft/chunks` and persisted server-side by
   `persistRecordingDraftChunk` (`src/lib/recordingDraftPersistence.ts`). Transcript drafts
   go through `src/lib/transcriptDraftPersistence.ts`.
3. **Stop** — `RecordingArchiveManager.stop()` flushes remaining chunks, then
   `POST /api/sessions/[id]/audio/draft/finalize` merges them with `mergeRecordingDraftChunks`.
4. **Finalize (billing point)** — `POST /api/sessions/[id]/finalize` →
   `finalizeSession()` in `src/lib/sessionFinalization.ts`: takes a finalization lock,
   merges draft chunks, normalizes duration, persists audio + transcript artifacts, and —
   inside one Prisma `$transaction` — calls `deductTranscriptionMinutes()`
   (`getBillableMinutes(ms) = ceil(ms / 60000)`) and flips status to `COMPLETED`. Then
   kicks off background LLM tasks (keywords, report, title).

**Async file-upload transcription** (`asyncTranscribeStatus` state machine): for uploading an
existing audio/video file instead of live recording.

- Endpoints: `.../async-upload/init` → `.../chunks` → `.../finalize`; progress polled at
  `.../async-transcribe-status`.
- `init` does an atomic quota **reservation** (`reserveTranscriptionMinutes`); the background
  pipeline `processAsyncUpload()` (`src/lib/audio/asyncUploadProcessor.ts`) merges chunks,
  transcodes to MP3 via FFmpeg (`src/lib/audio/ffmpegTranscode.ts`), uploads to Soniox and
  creates a transcription job (`src/lib/soniox/asyncFile.ts`).
- On completion the poll (or the reclaim cron) atomically claims finalization and runs the
  shared `finalizeAsyncTranscription()` (`src/lib/audio/asyncTranscribeFinalize.ts`), which
  converts tokens to segments, persists the transcript, and **deducts billing** at
  `ceil(getBillableMinutes(durationMs) × asyncMultiplier)` (default multiplier **0.8**,
  configurable in admin settings).
- **State machine:** `uploading_chunks → transcoding → uploading_to_soniox → transcribing →
  finalizing → completed`; terminal error/cancel states `failed` / `canceled`.

### 4.2 Live-share WebSocket

Real-time fan-out of transcript/translation/summary to student viewers via the standalone WS
process.

- **Server** (`server/websocket.ts` + `src/lib/liveShare/server.ts`): validates `Origin`
  against `NEXT_PUBLIC_APP_URL`, caps connections per IP, and rate-limits messages (token
  bucket). Rooms are keyed `live:{sessionId}`. Keeps an in-memory `LiveSnapshot` per session
  (bounded), with a periodic sweep evicting stale, member-less snapshots.
- **Broadcaster** (`src/lib/liveShare/broadcaster.ts`, via `useLiveShare`): authenticates in
  the socket handshake with `{ token (JWT), sessionId, shareToken }`; the server verifies the
  JWT and that the `ShareLink` is live, unexpired, and owned by the caller. Sends full
  `sync_snapshot` (state replace) and incremental `broadcast` deltas
  (`transcript_delta` / `translation_delta` / `summary_update` / `status_update` /
  `preview_update`). Re-sends its cached snapshot on every reconnect.
- **Viewer** (`src/lib/liveShare/viewer.ts`, page `src/app/session/[id]/view/page.tsx`): joins
  with only `{ shareToken }`; receives `initial_state`, then relayed deltas and `viewer_count`.
- **Grace / reconnect recovery:** broadcaster disconnect starts a 15 s grace timer instead of
  going offline immediately; reconnect within the window cancels it and re-emits
  `status_update{SHARE_LIVE}`; expiry emits `SHARE_OFFLINE` and drops the snapshot.
- **Share link:** created at `POST /api/share/create` (`ShareLink.token`, `isLive`,
  optional `expiresAt`); public metadata read at `GET /api/share/view/[token]`.

### 4.3 Chat & LLM

Multi-provider gateway with a 7-level context-degradation chain and RAG over the transcript.

- **Gateway** (`src/lib/llm/gateway.ts`): resolves a provider/model from the DB
  (`LlmProvider`/`LlmModel`) by **purpose** (`getProviderForPurpose`), falling back to env
  vars. Emits Anthropic-native (`/v1/messages`, `x-api-key`, `thinking` blocks) or
  OpenAI-compatible (`/chat/completions`, Bearer, `reasoning_effort`) requests based on
  `isAnthropic`; supports streaming (`callLLMWithHistoryStream`). Thinking modes:
  NONE / AUTO / FORCED / DEPTH, with budget clamping.
- **Context builder** (`src/lib/llm/chatContextBuilder.ts`, `buildChatContext`): tries levels
  L1→L7 until the token estimate fits the input budget
  (`src/lib/llm/tokenBudget.ts` + `tokenizer.ts`):

  | Level | Transcript | History | Summary |
  | :---- | :--------- | :------ | :------ |
  | L1 | latest 5 turns | full | full |
  | L2 | 5→4→3 (largest that fits) | full | full |
  | L3 | latest 3 turns | full | full |
  | L4 | latest 3 turns | early history compressed + recent 5 | full |
  | L5 | latest 1 turn | compressed + recent 3 | full |
  | L6 | RAG top-K (50% budget) / tail 1000 tok | recent only | full |
  | L7 | RAG (50% budget) / tail 800 tok | recent only | truncated to 1500 tok |
  | EOL | — | — | throws `ChatContextEOLError` |

- **RAG** (`src/lib/llm/embedding/transcriptRag.ts`): chunks the transcript (~150 tok/chunk),
  embeds via the `EMBEDDING`-purpose model (`callEmbedding`), caches vectors per session (LRU),
  and returns cosine-top-K chunks that fit the budget. Used by L6–L7.
- **Compression** (`src/lib/llm/chatCompression.ts`): summarizes early history into a single
  system message tagged `<!-- lecture-live:compressed-through={id} -->`; used by L4+.
- **Managers**: `summaryManager.ts` (session summary), `reportManager.ts` (structured report),
  `conversationTitle.ts` (AI title); attachments via `chatAttachments.ts` /
  `chatImageStorage.ts` / `fileExtractor.ts`.
- **Data**: `src/lib/conversations.ts` ties `Conversation` ↔ `ConversationMessage`
  (ordered by `seq`) ↔ `ConversationSession` ↔ `ChatAttachment`; client via `useChat`.

### 4.4 Billing & quota

- **Counters** (`src/lib/quota.ts`): `transcriptionMinutesUsed` (deducted), `storageBytesUsed`
  (chat-upload bytes, live), and `storageHoursUsed` (recording hours — computed on read from
  `SUM(Session.durationMs)`, the column itself is not incremented). Monthly window via
  `quotaResetAt` + `ensureQuotaWindow`.
- **Deduction points**: `deductTranscriptionMinutes` (realtime finalize + async finalize),
  `reserveTranscriptionMinutes`/`releaseTranscriptionMinutes` (async upload pre-check),
  `addStorageBytes`/`releaseStorageBytes` (chat uploads/deletes).
- **Interpret ledger**: `/api/interpret/start` creates a server-side Redis time anchor
  (`src/lib/interpret/anchor.ts`); `/api/interpret/deduct` consumes it (wall-clock cap +
  tolerance), deducts minutes, and writes an `InterpretUsage` row via `recordInterpretUsage`.
- **Reconciliation** (`src/lib/reconciliation.ts` / `quota.ts`): recomputes expected usage =
  `Σ` billable minutes of COMPLETED sessions in the window (async × multiplier) `+` `Σ`
  `InterpretUsage.billedMinutes`, compares to `transcriptionMinutesUsed`, and records drift in
  `ReconciliationMismatch`. `reconcileStorageBytes` self-heals `storageBytesUsed` from
  `ChatAttachment` sums. Driven daily by `runBillingMaintenance`
  (`src/lib/billingMaintenance.ts`).

### 4.5 Storage (Cloudreve)

- **Client** (`src/lib/storage/cloudreve.ts`): builds/validates remote paths
  (`buildCloudreveRemotePath` / `validateRemotePath` — exactly `/{userId}/{category}/{file}`),
  and **SSRF-guards** the base URL (`validateCloudreveBaseUrl` rejects private/loopback/link-local
  IPv4+IPv6 and the `169.254.169.254` metadata address unless `CLOUDREVE_ALLOW_PRIVATE_HOST`).
- **Cross-process token refresh** (`cloudreveTokenRefresh.ts`): both the web and WS processes
  keep independent in-memory caches but always re-read the DB before refreshing; a single-flight
  guard coalesces concurrent refreshes; tokens are AES-GCM encrypted in `SiteSetting`. Auth
  rejections (`invalid_grant`/401) clear the stored grant; transient failures preserve it.
- **File ops**: `cloudreveFileDelete.ts` (best-effort deletes), `migration.ts`
  (`local:*` → Cloudreve migration + expired-local cleanup).

### 4.6 Authentication

- **JWT** (`src/lib/auth.ts`): claims `{ id, email, role, tokenVersion, sessionStartedAt,
  jti, exp }`, HS256 with `JWT_SECRET`. `verifyToken` checks signature, absolute session
  lifetime, `jti` blacklist (Redis, in-memory fallback), `tokenVersion` match, and
  `status === 1`.
- **Revocation**: logout/password-change revoke the `jti` (Redis key with TTL = token expiry)
  and can bump `tokenVersion`.
- **Refresh grace / idempotency** (`src/app/api/auth/refresh/route.ts`): a valid refresh rotates
  the token, records a short (~30 s) grace entry `oldJti → newToken`, and revokes the old `jti`.
  A concurrent tab hitting the now-blacklisted old token is served the same grace token instead
  of a 401 — preventing multi-tab logout races.
- **Client** (`src/components/AuthSessionMonitor.tsx`): on a 401 from a non-auth API route,
  clears `authStore` and redirects to login.

### 4.7 Admin backoffice

`src/app/(dashboard)/admin` + `src/app/api/admin/*` + `src/components/admin/*`. Panels:
Dashboard/stats, User management, User groups, Audit logs, Job queue, Reconciliation, Files &
Chat-files cleanup, Share links, Settings, LLM providers/models, and Cloudreve OAuth
(authorize/callback/status/revoke). Storage maintenance (`migrate`, `cleanup`) and Soniox key
management live here too.

---

## 5. API Route Map

Top-level groups under `src/app/api` (each is a folder of `route.ts` handlers):

| Group | Purpose |
| :---- | :------ |
| `auth/*` | login, register, logout, refresh (grace), me, change-password. |
| `sessions/*` | session CRUD, transcript, `finalize`, audio draft (`audio/draft/{chunks,finalize}`), async upload (`async-upload/{init,chunks,finalize}`), `async-transcribe-status`, `active-async`, export, move, title regen. |
| `conversations/*` | list/CRUD, `[id]/messages`, `[id]/recordings`, `[id]/generate-title`, `[id]/images/[name]`. |
| `llm/*` | `chat` (streaming), `chat/compress`, `summarize`, `report`, `extract-keywords`, `models`. (Plus legacy top-level `llm-summarize`.) |
| `interpret/*` | `start` (create time anchor), `deduct` (consume + ledger). |
| `share/*` | `create` (share link), `view/[token]` (+ `report`/`export-data`/`audio`/`transcript`) for public viewers. |
| `storage/*` | `upload`, `download` (Cloudreve-backed). |
| `chat-uploads/*` | chat attachment upload + `[id]` fetch/delete. |
| `folders/*` | folder CRUD, `batch`, `[id]/keywords`. |
| `translation/*` | `supported-pairs` for the local/cloud translation UI. |
| `soniox/*` | `ping`, `temporary-key` (short-lived realtime key). Also top-level `temporary-api-key`. |
| `export/*` | server-side export bundle. |
| `admin/*` | see [Admin backoffice](#47-admin-backoffice). |
| `user` / `users/*` | `user/background-tasks`, `users/quota`. |
| `assets/*` | serve uploaded icons. |
| `site-config`, `setup`, `health` | public site config, first-run setup, health probe. |

---

## 6. Background Jobs

`JobQueue.type` values (`src/lib/jobQueue.ts`): `keyword_extraction`, `report_generation`,
`quota_reset`, `stale_session_reclaim`, `reconciliation`, `storage_cleanup`,
`storage_migration`, `billing_maintenance`, `chat_files_cleanup`. Billing maintenance
(`src/lib/billingMaintenance.ts`) is the daily umbrella that reclaims stuck async sessions,
runs reconciliation, and triggers cleanups.

---

## 7. Local Development

Requires Node 24+, MySQL 8.x, Redis 7.x, and FFmpeg (for file-upload transcoding).

| Script | What it does |
| :----- | :----------- |
| `npm run dev` | Next.js dev server (port 3000). |
| `npm run dev:ws` | WebSocket dev server via `ts-node server/websocket.ts` (port 3001). Run alongside `dev`. |
| `npm run build` / `npm run build:ws` | Production build for web; esbuild bundle of the WS server → `dist/websocket.js`. |
| `npm run start` / `npm run start:ws` | Production start (each runs `ensure-database` first). |
| `npm run db:ensure` | Orchestrated DB readiness: data-aware migration → `prisma db push` → history backfill. Gated by `AUTO_DB_PUSH`. |
| `npm run db:push` / `db:studio` / `db:generate` | Prisma push / Studio / client generate. |
| `npm run db:backfill-conversation-user-id` | Backfill `Conversation.userId` for legacy rows. |
| `npm run billing:reset-quotas` | Reset expired monthly transcription windows. |
| `npm run billing:reconcile` | Standalone transcription-usage reconciliation. |
| `npm run billing:maintenance` | Run the full billing-maintenance pass. |
| `npm run security:reencrypt-llm-keys` | Re-encrypt stored LLM provider keys (e.g., after key rotation). |
| `npm run test` / `test:coverage` / `test:e2e` | Vitest unit tests / coverage / Playwright E2E. |

> **Tests on NAS/shared FS:** heavy parallel test runs can saturate NAS I/O — prefer serial
> execution in that environment.

---

## 8. Deployment

Two supported modes:

**Docker Compose** (`docker-compose.yml` + `Dockerfile` + `docker-entrypoint.sh`): builds one
`app` image running web + WS together, plus `db` (MySQL 8.4), `redis` (7-alpine), and
`cloudreve` services. App data persists in the `appdata` volume (`/app/data`). Health at
`GET /api/health`. `AUTO_DB_PUSH` controls automatic schema sync on boot.

**Bare-metal / systemd** (`deploy/`): `install.sh` / `upgrade.sh` / `rollback.sh` deploy the
source under `/opt/lecturelive/src` and register two units — `lecturelive-web.service` (3000)
and `lecturelive-ws.service` (3001) — fronted by `nginx-lecturelive.conf`. The `lecture-live`
CLI (`deploy/lecture-live`, installed to `/usr/local/bin`) wraps start/stop/restart/status/log/
update/rollback/env with an interactive menu. `ensure-database.mjs` runs on start via
`prestart`/`prestart:ws`. See [`deploy/INSTALL.md`](../deploy/INSTALL.md) for the full guide.

---

*This file is a one-stop navigation reference for both humans and AI agents. When code changes
land in the areas above, update the relevant section here so it stays trustworthy as a map.*
