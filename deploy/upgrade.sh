#!/usr/bin/env bash
# ============================================================
# LectureLive 升级脚本
# 在服务器上的源码目录中执行: sudo bash deploy/upgrade.sh
# 会自动: 备份 → 安装依赖 → 数据库迁移 → 编译 → 热切换服务 → 健康检查
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$(dirname "$SCRIPT_DIR")"
APP_DIR="/opt/lecturelive"
WS_DIR="/opt/lecturelive/ws-server"
APP_USER="lecturelive"
BACKUP_DIR="/opt/lecturelive/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

[[ $EUID -eq 0 ]] || error "请使用 sudo 运行此脚本"

# 确保系统用户和组存在
if ! id "$APP_USER" &>/dev/null; then
    error "系统用户 $APP_USER 不存在，请先运行: sudo bash deploy/setup.sh"
fi
if ! getent group "$APP_USER" &>/dev/null; then
    warn "用户组 $APP_USER 不存在，正在修复..."
    groupadd --system "$APP_USER"
    usermod -g "$APP_USER" "$APP_USER"
fi

cd "$SRC_DIR"

echo "========================================"
echo "  LectureLive 升级 — $TIMESTAMP"
echo "========================================"
echo ""

# ── 1. 备份当前版本（web + ws 一起备份）──
info "备份当前版本..."
mkdir -p "$BACKUP_DIR"
if [[ -f "$APP_DIR/server.js" ]]; then
    tar czf "$BACKUP_DIR/app-${TIMESTAMP}.tar.gz" \
        -C "$APP_DIR" --exclude=data --exclude=backups --exclude=.env .
    info "备份完成: $BACKUP_DIR/app-${TIMESTAMP}.tar.gz"
fi

# 只保留最近 5 个备份
ls -t "$BACKUP_DIR"/app-*.tar.gz 2>/dev/null | tail -n +6 | xargs rm -f 2>/dev/null || true

# ── 2. 安装依赖 ──
info "安装依赖..."
npm ci

# ── 3. Prisma 迁移 ──
info "同步数据库结构..."
npx prisma generate
npx prisma db push --skip-generate

# ── 4. 编译 Next.js ──
info "编译 Next.js..."
npm run build
[[ -d "$SRC_DIR/.next/standalone" ]] || error "编译失败，未生成 standalone 产物"

# ── 5. 编译 WebSocket 服务器 ──
info "编译 WebSocket 服务器..."
npm run build:ws
[[ -f "$SRC_DIR/dist/websocket.js" ]] || error "WebSocket 编译失败"

# ── 6. 停止服务 ──
info "停止服务..."
systemctl stop lecturelive-web 2>/dev/null || true
systemctl stop lecturelive-ws 2>/dev/null || true

# ── 7. 部署 Next.js standalone ──
info "部署 Next.js 产物..."
# -mindepth 1 避免删除 APP_DIR 本身
find "$APP_DIR" -mindepth 1 -maxdepth 1 \
    ! -name "data" ! -name ".env" ! -name "ws-server" ! -name "backups" \
    -exec rm -rf {} +

cp -a "$SRC_DIR/.next/standalone/." "$APP_DIR/"
mkdir -p "$APP_DIR/.next/static"
cp -a "$SRC_DIR/.next/static/." "$APP_DIR/.next/static/"
[[ -d "$SRC_DIR/public" ]] && cp -r "$SRC_DIR/public" "$APP_DIR/public"

# ── 8. 更新 WebSocket 服务器 ──
info "更新 WebSocket 服务器..."
rm -rf "$WS_DIR"
mkdir -p "$WS_DIR"

cp "$SRC_DIR/dist/websocket.js" "$WS_DIR/"
cp -r "$SRC_DIR/prisma" "$WS_DIR/"
cp "$SCRIPT_DIR/ws-package.json" "$WS_DIR/package.json"

(cd "$WS_DIR" && npm install --omit=dev && npx prisma generate)

ln -sfn "$APP_DIR/data" "$WS_DIR/data"
ln -sfn "$APP_DIR/.env" "$WS_DIR/.env"

# ── 9. 修复权限 ──
chown -R $APP_USER:$APP_USER "$APP_DIR"
chmod 600 "$APP_DIR/.env"

# ── 10. 更新 systemd 并启动 ──
info "启动服务..."
cp "$SCRIPT_DIR/lecturelive-web.service" /etc/systemd/system/
cp "$SCRIPT_DIR/lecturelive-ws.service" /etc/systemd/system/
systemctl daemon-reload
systemctl start lecturelive-web lecturelive-ws

# ── 11. 健康检查 ──
info "等待服务启动..."
sleep 3

WEB_OK=false
WS_OK=false
HEALTH_OK=false
systemctl is-active --quiet lecturelive-web && WEB_OK=true
systemctl is-active --quiet lecturelive-ws && WS_OK=true
curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1 && HEALTH_OK=true

echo ""
if $WEB_OK && $WS_OK && $HEALTH_OK; then
    info "升级成功！"
    echo "  Web:       $(systemctl is-active lecturelive-web)"
    echo "  WebSocket: $(systemctl is-active lecturelive-ws)"
    echo "  Health:    ok"
else
    warn "服务状态异常，请检查日志:"
    $WEB_OK || echo "  ✗ lecturelive-web: journalctl -u lecturelive-web -n 30 --no-pager"
    $WS_OK  || echo "  ✗ lecturelive-ws:  journalctl -u lecturelive-ws -n 30 --no-pager"
    $HEALTH_OK || echo "  ✗ healthcheck:    curl -fsS http://127.0.0.1:3000/api/health"
    echo ""
    warn "如需回滚: sudo bash deploy/rollback.sh"
fi
echo ""
