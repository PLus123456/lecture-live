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

# L7：原来只 `wait "$WEB_PID"` —— WS 进程崩掉时容器照常活着，Next 仍然 200，
# healthcheck 恒绿也不会触发重启策略，实时转录/直播分享整条链路静默失效直到有人报障。
# 改成「任一子进程退出即整体退出」，把重启交给 Docker restart policy。
#
# `wait -n` 是 bash 扩展，本脚本跑在 busybox ash 上，只能轮询两个 PID。
# 被 SIGTERM 打断时 sleep/wait 返回 143；set -e 下若不加守卫会当场退出，
# 跳过下面对 WS 的优雅停机等待（WS 会被 Docker 直接 SIGKILL，10s SERVER_SHUTDOWN 广播被截断）。
EXIT_CODE=0
while :; do
  if ! kill -0 "$WEB_PID" 2>/dev/null; then
    wait "$WEB_PID" || EXIT_CODE=$?
    break
  fi
  if ! kill -0 "$WS_PID" 2>/dev/null; then
    wait "$WS_PID" || EXIT_CODE=$?
    break
  fi
  sleep 2 || true
done

shutdown
wait "$WEB_PID" 2>/dev/null || true
wait "$WS_PID" 2>/dev/null || true

exit "$EXIT_CODE"
