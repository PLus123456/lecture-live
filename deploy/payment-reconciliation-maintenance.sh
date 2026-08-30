#!/usr/bin/env bash
# Restricted local maintenance server for the one-time Stripe history review queue.
set -euo pipefail

APP_DIR="/opt/lecturelive"
RUNTIME_DIR="/opt/lecturelive-maintenance"
WEB_SERVICE="lecturelive-web"
WS_SERVICE="lecturelive-ws"

MODE="serve"
if [[ ${1:-} == "reconcile" ]]; then
  MODE="reconcile"
  shift
elif [[ $# -gt 0 ]]; then
  echo "用法: lecturelive-payment-maintenance [reconcile [对账参数...]]" >&2
  exit 2
fi

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "请使用 sudo 运行此维护入口" >&2
  exit 1
fi

systemctl stop "$WEB_SERVICE" 2>/dev/null || true
systemctl stop "$WS_SERVICE" 2>/dev/null || true
if systemctl is-active --quiet "$WEB_SERVICE" || systemctl is-active --quiet "$WS_SERVICE"; then
  echo "无法确认正式服务已停止，拒绝启动维护入口" >&2
  exit 1
fi

for required in \
  "$APP_DIR/.env" \
  "$RUNTIME_DIR/server.js" \
  "$RUNTIME_DIR/.payment-maintenance-runtime-version" \
  "$RUNTIME_DIR/scripts/check-production-payment-config.mjs" \
  "$RUNTIME_DIR/scripts/payment-production-preflight-core.mjs" \
  "$RUNTIME_DIR/scripts/reconcile-stripe-history.mjs" \
  "$RUNTIME_DIR/scripts/stripe-history-reconciliation-core.mjs" \
  "$RUNTIME_DIR/scripts/stripe-key-mode.mjs"; do
  if [[ ! -f "$required" ]]; then
    echo "缺少维护入口依赖: $required" >&2
    exit 1
  fi
done
if ! grep -Fxq payment-reconciliation-maintenance-v1 \
  "$RUNTIME_DIR/.payment-maintenance-runtime-version"; then
  echo "维护运行产物缺少安全版本标记，拒绝启动旧 server.js" >&2
  exit 1
fi

cd "$RUNTIME_DIR"
if [[ $MODE == "reconcile" ]]; then
  exec runuser -u lecturelive -- /usr/bin/node --env-file="$APP_DIR/.env" \
    "$RUNTIME_DIR/scripts/reconcile-stripe-history.mjs" "$@"
fi

runuser -u lecturelive -- env PAYMENT_RECONCILIATION_MAINTENANCE=1 \
  /usr/bin/node --env-file="$APP_DIR/.env" \
  "$RUNTIME_DIR/scripts/check-production-payment-config.mjs" \
  --allow-reconciliation-maintenance

echo "受限支付复核维护服务将仅监听 127.0.0.1:3000。"
echo "仅 /api/auth/{login,logout,refresh} 与 /api/admin/recharge/reviews 可用；Ctrl-C 退出。"
exec runuser -u lecturelive -- env \
  PAYMENT_RECONCILIATION_MAINTENANCE=1 HOSTNAME=127.0.0.1 PORT=3000 \
  /usr/bin/node --env-file="$APP_DIR/.env" "$RUNTIME_DIR/server.js"
