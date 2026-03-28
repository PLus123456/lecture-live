#!/usr/bin/env bash
# ============================================================
# LectureLive 编译产物安装脚本
# 将 build 产物复制到 /opt/lecturelive 并配置 systemd
# 用法: 在源码目录中执行 sudo bash deploy/install.sh
# ============================================================
set -euo pipefail

APP_DIR="/opt/lecturelive"
WS_DIR="/opt/lecturelive/ws-server"
APP_USER="lecturelive"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$(dirname "$SCRIPT_DIR")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

[[ $EUID -eq 0 ]] || error "请使用 sudo 运行此脚本"

# ── 检查系统用户 ──
if ! id "$APP_USER" &>/dev/null; then
    warn "系统用户 $APP_USER 不存在，正在创建..."
    adduser --system --group --home "$APP_DIR" --no-create-home --shell /usr/sbin/nologin "$APP_USER"
    info "用户 $APP_USER 创建成功"
elif ! getent group "$APP_USER" &>/dev/null; then
    warn "用户组 $APP_USER 不存在（可能是旧版 useradd 遗留问题），正在修复..."
    groupadd --system "$APP_USER"
    usermod -g "$APP_USER" "$APP_USER"
    info "用户组已修复"
fi
info "运行用户: $(id $APP_USER)"

# ── 检查编译产物 ──
[[ -d "$SRC_DIR/.next/standalone" ]] || error "未找到 .next/standalone，请先运行 npm run build"
[[ -d "$SRC_DIR/.next/static" ]]     || error "未找到 .next/static，请先运行 npm run build"
[[ -f "$SRC_DIR/dist/websocket.js" ]] || error "未找到 dist/websocket.js，请先运行 npm run build:ws"

# ── 检查 Node.js 版本 (--env-file 需要 20.6+) ──
NODE_VER=$(node -v | sed 's/v//')
NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
NODE_MINOR=$(echo "$NODE_VER" | cut -d. -f2)
if [[ $NODE_MAJOR -lt 20 ]] || [[ $NODE_MAJOR -eq 20 && $NODE_MINOR -lt 6 ]]; then
    error "Node.js >= 20.6.0 必须（当前: $NODE_VER），--env-file 支持需要此版本"
fi

info "停止现有服务 (如果存在)..."
systemctl stop lecturelive-web 2>/dev/null || true
systemctl stop lecturelive-ws 2>/dev/null || true

# ── 部署 Next.js standalone 产物 ──
info "部署 Next.js standalone 到 $APP_DIR ..."
mkdir -p "$APP_DIR/data" "$APP_DIR/backups"

# 清理旧的 standalone 文件（保留 data、.env、ws-server、backups）
# 注意: -mindepth 1 避免删除 APP_DIR 本身
find "$APP_DIR" -mindepth 1 -maxdepth 1 \
    ! -name "data" ! -name ".env" ! -name "ws-server" ! -name "backups" \
    -exec rm -rf {} +

# 复制 standalone 产物（用 /. 语法，确保隐藏目录 .next 也被复制）
cp -a "$SRC_DIR/.next/standalone/." "$APP_DIR/"

# 复制静态文件
mkdir -p "$APP_DIR/.next/static"
cp -a "$SRC_DIR/.next/static/." "$APP_DIR/.next/static/"

# 复制 public 目录
if [[ -d "$SRC_DIR/public" ]]; then
    cp -r "$SRC_DIR/public" "$APP_DIR/public"
fi

# 校验关键文件是否复制成功
[[ -f "$APP_DIR/server.js" ]]      || error "复制失败: server.js 不存在"
[[ -f "$APP_DIR/.next/BUILD_ID" ]] || error "复制失败: .next/BUILD_ID 不存在（隐藏目录可能未复制）"
info "Next.js 产物校验通过 (BUILD_ID: $(cat "$APP_DIR/.next/BUILD_ID"))"

# 处理 .env
if [[ ! -f "$APP_DIR/.env" ]]; then
    if [[ -f "$SRC_DIR/.env.local" ]]; then
        cp "$SRC_DIR/.env.local" "$APP_DIR/.env"
        warn "已从 .env.local 复制环境配置，请检查并修改生产环境值"
    else
        error "未找到 $APP_DIR/.env 也没有 .env.local，请先创建环境配置"
    fi
else
    info ".env 已存在，保留原有配置"
fi

# ── 部署 WebSocket 服务器 ──
info "部署 WebSocket 服务器到 $WS_DIR ..."
rm -rf "$WS_DIR"
mkdir -p "$WS_DIR"

# 复制编译好的 JS 文件（不再需要 ts-node）
cp "$SRC_DIR/dist/websocket.js" "$WS_DIR/"

# Prisma 需要 schema 和生成的 client
cp -r "$SRC_DIR/prisma" "$WS_DIR/"

# 复制精简的 WS 依赖清单并安装
cp "$SCRIPT_DIR/ws-package.json" "$WS_DIR/package.json"

info "安装 WebSocket 服务器运行时依赖..."
(cd "$WS_DIR" && npm install --omit=dev && npx prisma generate)

# 链接共享资源
ln -sfn "$APP_DIR/data" "$WS_DIR/data"
ln -sfn "$APP_DIR/.env" "$WS_DIR/.env"

# ── 修复权限 ──
info "设置文件权限..."
chown -R $APP_USER:$APP_USER "$APP_DIR"
chmod 600 "$APP_DIR/.env"

# ── 安装 systemd 服务 ──
info "安装 systemd 服务..."
cp "$SCRIPT_DIR/lecturelive-web.service" /etc/systemd/system/
cp "$SCRIPT_DIR/lecturelive-ws.service" /etc/systemd/system/
systemctl daemon-reload

# ── 启动服务 ──
info "启动服务..."
systemctl enable --now lecturelive-web lecturelive-ws

# ── 健康检查 ──
sleep 3
WEB_OK=false
WS_OK=false
systemctl is-active --quiet lecturelive-web && WEB_OK=true
systemctl is-active --quiet lecturelive-ws && WS_OK=true

echo ""
if $WEB_OK && $WS_OK; then
    info "部署成功！"
    echo ""
    echo "  Next.js Web:   http://127.0.0.1:3000  ($(systemctl is-active lecturelive-web))"
    echo "  WebSocket:     http://127.0.0.1:3001  ($(systemctl is-active lecturelive-ws))"
    echo ""
    echo "  查看日志:"
    echo "    journalctl -u lecturelive-web -f"
    echo "    journalctl -u lecturelive-ws -f"
    echo ""
    echo "  管理服务:"
    echo "    sudo systemctl {start|stop|restart|status} lecturelive-web"
    echo "    sudo systemctl {start|stop|restart|status} lecturelive-ws"
else
    warn "部分服务启动异常！"
    $WEB_OK || echo "  ✗ lecturelive-web 失败，查看: journalctl -u lecturelive-web -n 30 --no-pager"
    $WS_OK  || echo "  ✗ lecturelive-ws  失败，查看: journalctl -u lecturelive-ws -n 30 --no-pager"
fi
echo ""
