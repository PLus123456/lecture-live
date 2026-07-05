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

# 重建 prisma CLI 的 .bin 软链（npm 原本创建的 node_modules/.bin/prisma → ../prisma/build/index.js，
# 该文件带 `#!/usr/bin/env node` shebang，ensure-database.mjs 直接 spawn 它）
RUN mkdir -p /app/node_modules/.bin \
 && ln -sf ../prisma/build/index.js /app/node_modules/.bin/prisma \
 && chmod +x /app/node_modules/prisma/build/index.js \
 && chown -R nextjs:nodejs /app && chmod 755 /app/docker-entrypoint.sh

USER nextjs
EXPOSE 3000 3001
ENV PORT=3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["./docker-entrypoint.sh"]
