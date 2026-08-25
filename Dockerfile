FROM node:24-alpine AS base

# Install dependencies
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY prisma ./prisma
# postinstall（package.json）会跑 scripts/patch-next-minify.mjs，必须在 npm ci 前就位，
# 否则 npm ci 在 postinstall 阶段因找不到脚本而非零退出、整个构建失败。
COPY scripts ./scripts
RUN npm ci

# Build the app
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build && npm run build:ws

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

# WebSocket 服务器编译产物
COPY --from=builder /app/dist/websocket.js ./ws-server/websocket.js

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
# ensure-database 的第 ⑦ 步（artifact 账本回填）会用 esbuild 现编 scripts/*.ts。
# runner 里缺它 → 回填脚本 exit 1 → entrypoint 的 `set -e` 在 Web/WS 启动前打死容器，
# 也就是每次启动都失败。只带 esbuild 自身与它的平台二进制包。
COPY --from=deps /app/node_modules/esbuild ./node_modules/esbuild
COPY --from=deps /app/node_modules/@esbuild ./node_modules/@esbuild

# 重建 prisma CLI 的 .bin 软链（npm 原本创建的 node_modules/.bin/prisma → ../prisma/build/index.js，
# 该文件带 `#!/usr/bin/env node` shebang，ensure-database.mjs 直接 spawn 它）
RUN mkdir -p /app/node_modules/.bin \
 && ln -sf ../prisma/build/index.js /app/node_modules/.bin/prisma \
 && chmod +x /app/node_modules/prisma/build/index.js \
 && ln -sf ../esbuild/bin/esbuild /app/node_modules/.bin/esbuild \
 && chmod +x /app/node_modules/esbuild/bin/esbuild \
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
