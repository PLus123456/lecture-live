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

# 被 SIGTERM 打断时 wait 返回 143；set -e 下若不加守卫会当场退出，
# 跳过下面对 WS 的优雅停机等待（WS 会被 Docker 直接 SIGKILL，10s SERVER_SHUTDOWN 广播被截断）。
EXIT_CODE=0
wait "$WEB_PID" || EXIT_CODE=$?

shutdown
wait "$WS_PID" 2>/dev/null || true

exit "$EXIT_CODE"
