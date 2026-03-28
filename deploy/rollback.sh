#!/usr/bin/env bash
# ============================================================
# LectureLive 回滚脚本
# 用法: sudo bash deploy/rollback.sh [备份文件名]
# 不指定文件名时回滚到最近一次备份
# 同时回滚 web + ws-server
# ============================================================
set -euo pipefail

APP_DIR="/opt/lecturelive"
WS_DIR="/opt/lecturelive/ws-server"
BACKUP_DIR="/opt/lecturelive/backups"
APP_USER="lecturelive"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

[[ $EUID -eq 0 ]] || error "请使用 sudo 运行此脚本"

# 找备份文件
if [[ -n "${1:-}" ]]; then
    BACKUP_FILE="$BACKUP_DIR/$1"
else
    BACKUP_FILE=$(ls -t "$BACKUP_DIR"/app-*.tar.gz 2>/dev/null | head -1)
fi

[[ -n "$BACKUP_FILE" && -f "$BACKUP_FILE" ]] || error "未找到备份文件。可用备份: $(ls "$BACKUP_DIR"/app-*.tar.gz 2>/dev/null || echo '无')"

info "回滚到: $(basename "$BACKUP_FILE")"

# 列出备份内容概要
echo ""
echo "  备份包含:"
tar tzf "$BACKUP_FILE" | head -20
echo "  ..."
echo ""

read -rp "确认回滚? [y/N] " confirm
[[ "$confirm" =~ ^[yY]$ ]] || { echo "已取消"; exit 0; }

info "停止服务..."
systemctl stop lecturelive-web 2>/dev/null || true
systemctl stop lecturelive-ws 2>/dev/null || true

# 清理并恢复（web + ws 一起，保留 data、.env、backups）
# -mindepth 1 避免删除 APP_DIR 本身
find "$APP_DIR" -mindepth 1 -maxdepth 1 \
    ! -name "data" ! -name ".env" ! -name "backups" \
    -exec rm -rf {} +

tar xzf "$BACKUP_FILE" -C "$APP_DIR"
chown -R $APP_USER:$APP_USER "$APP_DIR"
chmod 600 "$APP_DIR/.env"

# 恢复 ws-server 的软链接
if [[ -d "$WS_DIR" ]]; then
    ln -sfn "$APP_DIR/data" "$WS_DIR/data"
    ln -sfn "$APP_DIR/.env" "$WS_DIR/.env"
fi

info "启动服务..."
systemctl start lecturelive-web lecturelive-ws

sleep 3
WEB_OK=false
WS_OK=false
systemctl is-active --quiet lecturelive-web && WEB_OK=true
systemctl is-active --quiet lecturelive-ws && WS_OK=true

echo ""
if $WEB_OK && $WS_OK; then
    info "回滚成功！所有服务已恢复运行"
else
    warn "回滚后部分服务异常:"
    $WEB_OK || echo "  ✗ lecturelive-web: journalctl -u lecturelive-web -n 30 --no-pager"
    $WS_OK  || echo "  ✗ lecturelive-ws:  journalctl -u lecturelive-ws -n 30 --no-pager"
fi
echo ""
