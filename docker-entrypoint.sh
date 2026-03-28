#!/bin/sh
set -eu

# 同步数据库结构
node scripts/ensure-database.mjs

# 启动 WebSocket 服务器（后台）
node ws-server/websocket.js &
WS_PID=$!

# 启动 Next.js（后台），由当前 shell 统一转发退出信号
node server.js &
WEB_PID=$!

shutdown() {
  kill -TERM "$WEB_PID" 2>/dev/null || true
  kill -TERM "$WS_PID" 2>/dev/null || true
}

trap 'shutdown' INT TERM

wait "$WEB_PID"
EXIT_CODE=$?

shutdown
wait "$WS_PID" 2>/dev/null || true

exit "$EXIT_CODE"
