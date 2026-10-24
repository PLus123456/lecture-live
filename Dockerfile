FROM node:24-alpine AS base
# Prisma 要靠 `openssl version` 判定该用哪个 query engine。当前 Alpine 镜像自带 libssl.so.3，却
# 不带 openssl 命令（库也已挪到 /usr/lib，Prisma 5 的目录探测找不到）→ 回落 openssl-1.1.x：
# deps 阶段生成的是要 libssl.so.1.1 的引擎，容器一启动 ensure-database 的第一条查询就报
# 「Error loading shared library libssl.so.1.1」。放在 base：生成（deps）与运行（runner）都要探测。
RUN apk add --no-cache openssl

# Install dependencies
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY prisma ./prisma
# postinstall（package.json）会跑 scripts/patch-next-minify.mjs，必须在 npm ci 前就位，
# 否则 npm ci 在 postinstall 阶段因找不到脚本而非零退出、整个构建失败。
COPY scripts ./scripts
RUN npm ci

# WebSocket 服务器的运行时依赖，与裸机 deploy/install.sh 同口径（deploy/ws-package.json +
# prisma generate）。dist/websocket.js 把 @prisma/client / ioredis / jsonwebtoken / bcryptjs 留作
# 运行时 require，Next standalone 的 node_modules 并不带它们：缺了它们 WS 一启动就
# MODULE_NOT_FOUND，entrypoint 随即让整个容器退出。
FROM base AS ws-deps
WORKDIR /ws
COPY deploy/ws-package.json ./package.json
COPY prisma ./prisma
RUN npm install --omit=dev --no-audit --no-fund && npx --yes prisma@5 generate

# Build the app
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# next build 会把 NEXT_PUBLIC_* 内联进浏览器 bundle（服务端 bundle 也内联构建期已定义的值）。
# 构建上下文排除了 .env*（.dockerignore），不经 build args 传入时客户端只能拿到 useLiveShare
# 的兜底 http://localhost:3001 —— 主播与观众都去连自己机器的 localhost，直播必挂；CSP 的
# connect-src 同样在构建期生成。由 docker-compose.yml 的 build.args 传入。
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_WS_URL
# 空值必须 unset，不能以空串进入 next build：Next 连「已定义的空串」也会内联进服务端
# bundle，运行时 env_file 里的真实值反而读不到（requestOrigin / publicAuth 按它判定来源）。
# next build 收集页面数据时会 import 服务端模块，而 serverSecrets.ts 在 import 时就校验
# JWT_SECRET / ENCRYPTION_KEY（缺失或弱值直接 FATAL）——构建上下文不带任何 .env，不给值镜像
# 根本建不出来。这里只给 next build 这一个进程注入一次性随机值：不进 ENV、不落任何层，
# next.config.js 也不内联它们；运行时的真实值照旧来自 env_file。
# 最后一步按与运行时同一套 esbuild 参数预编译 artifact 回填脚本（见 runner 阶段说明）。
RUN if [ -z "${NEXT_PUBLIC_APP_URL:-}" ]; then unset NEXT_PUBLIC_APP_URL; fi; \
    if [ -z "${NEXT_PUBLIC_WS_URL:-}" ]; then unset NEXT_PUBLIC_WS_URL; fi; \
    JWT_SECRET="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")" \
    ENCRYPTION_KEY="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")" \
    npm run build && npm run build:ws \
    && node scripts/backfill-stored-artifacts.mjs --build-only dist/backfill-stored-artifacts.mjs

# Production
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

# ffmpeg：用于文件上传转录（async file API）把视频抽音频 + 压成 mono 128kbps MP3。
# Alpine 包 ~30MB，包含 libavcodec / libavformat / libavutil。
RUN apk add --no-cache ffmpeg

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Next.js standalone 产物（已包含精简的 node_modules）
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# WebSocket 服务器编译产物 + 它的运行时依赖（见 ws-deps 阶段）
COPY --from=builder /app/dist/websocket.js ./ws-server/websocket.js
COPY --from=ws-deps /ws/node_modules ./ws-server/node_modules

# Prisma client（standalone 产物中可能不含完整 client）
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=deps /app/node_modules/@prisma ./node_modules/@prisma
# Prisma CLI：docker-entrypoint 启动时经 ensure-database.mjs 用 `prisma db push` 同步库结构。
# prisma 是 devDependency、且未被应用 import，Next standalone 追踪不到，须显式带入并重建 .bin 软链。
COPY --from=deps /app/node_modules/prisma ./node_modules/prisma

# 运行时辅助文件
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/docker-entrypoint.sh ./docker-entrypoint.sh
COPY --from=builder /app/deploy/shims ./deploy/shims
# ensure-database 的第 ⑦ 步（artifact 账本回填）：scripts/backfill-stored-artifacts.ts 依赖
# ../src/** 与 tsconfig 的 @/ 别名，runner 里两者都没有，现编必挂（exit 1 → entrypoint 的
# `set -e` 在 Web/WS 启动前打死容器，每次启动都失败）。builder 阶段已用同一套 esbuild 参数
# 预编译好；launcher 发现没有源码时直接执行这份产物（@prisma/client 仍从 /app/node_modules 解析）。
COPY --from=builder /app/dist/backfill-stored-artifacts.mjs ./dist/backfill-stored-artifacts.mjs

# 重建 prisma CLI 的 .bin 软链（npm 原本创建的 node_modules/.bin/prisma → ../prisma/build/index.js，
# 该文件带 `#!/usr/bin/env node` shebang，ensure-database.mjs 直接 spawn 它）。
# /app/data 必须在镜像里预建并归 nextjs 所有：docker-compose 把命名卷挂在这里，而命名卷首次
# 挂载时只有「镜像里已存在的目录」才会把属主/权限复制进卷；目录不存在则卷根是 root:root 0755，
# 以 nextjs(1001) 运行的应用写不进任何本地产物（草稿、录音、转录、上传分片……全部 EACCES）。
RUN mkdir -p /app/node_modules/.bin /app/data \
 && ln -sf ../prisma/build/index.js /app/node_modules/.bin/prisma \
 && chmod +x /app/node_modules/prisma/build/index.js \
 && chown -R nextjs:nodejs /app && chmod 755 /app/docker-entrypoint.sh

USER nextjs
EXPOSE 3000 3001
ENV PORT=3000
# L7：本镜像是单容器（entrypoint 同时拉起 Next 与 WS），WS 挂了整个容器就不该报健康。
# health.ts 见此变量才把 websocket down 从 degraded 升级成 down（→ /api/health/ready 回 503
# → 下面的 HEALTHCHECK 转红，编排器/负载均衡据此摘流量）。真正的重启由 entrypoint 负责：
# 任一子进程退出即整体退出，交给 restart policy——原生 docker 的 restart policy 只看退出，
# 不看 health 状态。分体部署不设本变量，避免 WS 抖动把 Web 摘出负载均衡。
ENV HEALTH_WS_REQUIRED=1
HEALTHCHECK --interval=30s --timeout=6s --start-period=20s --retries=3 CMD ["node", "scripts/check-readiness.mjs"]
CMD ["./docker-entrypoint.sh"]
