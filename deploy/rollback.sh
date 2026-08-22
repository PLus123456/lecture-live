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

# 同一时间戳的 systemd unit 备份（upgrade.sh 在替换 unit 前写入）。只在产物早于
# readiness 路由时才会用到，用来保证 unit 与产物永远同代退回。
BACKUP_STAMP="$(basename "$BACKUP_FILE")"
BACKUP_STAMP="${BACKUP_STAMP#app-}"
BACKUP_STAMP="${BACKUP_STAMP%.tar.gz}"
UNIT_BACKUP="$BACKUP_DIR/systemd-${BACKUP_STAMP}.tar.gz"

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
if systemctl is-active --quiet lecturelive-web || systemctl is-active --quiet lecturelive-ws; then
    error "无法确认旧服务已停止；拒绝覆盖运行中的回滚目标"
fi

# 清理并恢复（web + ws 一起，保留 data、.env、backups，以及 systemd ExecStartPre
# 必需的 fail-closed 脚本）。旧备份可能还没有 scripts/，不能让回滚把启动闸删掉。
# -mindepth 1 避免删除 APP_DIR 本身
find "$APP_DIR" -mindepth 1 -maxdepth 1 \
    ! -name "data" ! -name ".env" ! -name "backups" ! -name "scripts" \
    -exec rm -rf {} +

tar xzf "$BACKUP_FILE" -C "$APP_DIR"
chown -R $APP_USER:$APP_USER "$APP_DIR"
chmod 600 "$APP_DIR/.env"

RUNTIME_SECURITY_MARKER="$APP_DIR/.runtime-security-version"
if [[ ! -f "$RUNTIME_SECURITY_MARKER" ]] || \
   ! grep -Fxq 'health-ready-v1' "$RUNTIME_SECURITY_MARKER"; then
    # 该备份早于受保护 readiness 路由。禁止的是「旧产物 + 新 unit」这个组合——
    # 新 unit 的 ExecStartPre(marker/preflight) 与 ExecStartPost(readiness --wait)
    # 旧产物一概过不去，会卡成起不来又回不去。
    # 但只要能把 systemd unit 一并退回同一代，旧 unit + 旧产物本身是自洽的一代，
    # 升级失败时必须留这条退路，否则首次升级中途失败就没有任何可上线的目标。
    if [[ -f "$UNIT_BACKUP" ]]; then
        info "备份早于 readiness 路由，同代回退 systemd unit: $(basename "$UNIT_BACKUP")"
        tar xzf "$UNIT_BACKUP" -C /etc/systemd/system
        systemctl daemon-reload
        warn "已退回旧版 systemd unit：本次上线不含 readiness/支付预检启动闸，"
        warn "请尽快重新执行 upgrade.sh 前滚，不要长期停留在此状态。"
    else
        error "该备份早于受保护 readiness 路由，且缺少配套的 systemd unit 备份（$(basename "$UNIT_BACKUP")）无法同代回退；拒绝重新上线，服务已保持停止"
    fi
fi

# 恢复 ws-server 的软链接
if [[ -d "$WS_DIR" ]]; then
    ln -sfn "$APP_DIR/data" "$WS_DIR/data"
    ln -sfn "$APP_DIR/.env" "$WS_DIR/.env"
fi

PREFLIGHT_SCRIPT="$APP_DIR/scripts/check-production-payment-config.mjs"
[[ -f "$PREFLIGHT_SCRIPT" ]] || error "缺少生产支付启动检查脚本，拒绝启动回滚版本"
info "回滚启动前验证生产支付配置..."
if ! runuser -u "$APP_USER" -- /usr/bin/node --env-file="$APP_DIR/.env" "$PREFLIGHT_SCRIPT"; then
    error "生产支付配置未通过安全检查，回滚版本保持停止"
fi

info "启动服务..."
if ! systemctl start lecturelive-web lecturelive-ws; then
    systemctl stop lecturelive-web 2>/dev/null || true
    systemctl stop lecturelive-ws 2>/dev/null || true
    if systemctl is-active --quiet lecturelive-web || systemctl is-active --quiet lecturelive-ws; then
        error "回滚版本启动失败，且无法确认失败实例已停止"
    fi
    error "回滚版本启动失败，所有实例已保持停止"
fi

sleep 3
WEB_OK=false
WS_OK=false
HEALTH_OK=false
systemctl is-active --quiet lecturelive-web && WEB_OK=true
systemctl is-active --quiet lecturelive-ws && WS_OK=true
runuser -u "$APP_USER" -- /usr/bin/node --env-file="$APP_DIR/.env" \
    "$APP_DIR/scripts/check-readiness.mjs" --wait >/dev/null 2>&1 && HEALTH_OK=true
# readiness 期间任一 unit 都可能退出；成功判定前重新读取两项状态，不能复用探测前快照。
WEB_OK=false
WS_OK=false
systemctl is-active --quiet lecturelive-web && WEB_OK=true
systemctl is-active --quiet lecturelive-ws && WS_OK=true

echo ""
if $WEB_OK && $WS_OK && $HEALTH_OK; then
    info "回滚成功！所有服务已恢复运行"
else
    warn "回滚版本未通过完整启动检查，正在隔离失败实例:"
    $WEB_OK || echo "  ✗ lecturelive-web: journalctl -u lecturelive-web -n 30 --no-pager"
    $WS_OK  || echo "  ✗ lecturelive-ws:  journalctl -u lecturelive-ws -n 30 --no-pager"
    $HEALTH_OK || echo "  ✗ readiness: node --env-file=$APP_DIR/.env $APP_DIR/scripts/check-readiness.mjs"
    systemctl stop lecturelive-web 2>/dev/null || true
    systemctl stop lecturelive-ws 2>/dev/null || true
    if systemctl is-active --quiet lecturelive-web || systemctl is-active --quiet lecturelive-ws; then
        error "回滚检查失败，且无法确认失败实例已停止"
    fi
    error "回滚失败：未通过服务存活与深度就绪检查，服务已保持停止"
fi
echo ""
