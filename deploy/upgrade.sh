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
MAINTENANCE_DIR="/opt/lecturelive-maintenance"
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

# 进入升级流程后第一时间收紧/补齐生产环境；不要等 npm ci 完成后才修复旧 0644 文件。
[[ -f "$APP_DIR/.env" ]] || error "缺少生产环境配置: $APP_DIR/.env"
bash "$SCRIPT_DIR/ensure-security-env.sh" "$APP_DIR/.env"

# 从这一刻起升级中的任何失败都必须保持旧服务隔离。尤其是生产 Stripe 预检发现
# 历史 test key 时，不能退出升级却让仍在运行的旧版本继续接受测试付款。
info "停止服务并进入安全升级窗口..."
systemctl stop lecturelive-web 2>/dev/null || true
systemctl stop lecturelive-ws 2>/dev/null || true
if systemctl is-active --quiet lecturelive-web || systemctl is-active --quiet lecturelive-ws; then
    error "无法确认旧服务已停止；为避免继续处理不安全的支付配置，升级已中止"
fi

# 先于 npm、数据库迁移和编译安装不可回退的启动安全闸。这样从旧版本升级时，即使
# 后续因历史 Stripe test key 失败，再执行旧产物回滚也只能经过新 preflight，不能把
# 无闸门的旧 systemd unit 重新启动。
info "安装 fail-closed 生产启动闸..."
install -d -o "$APP_USER" -g "$APP_USER" -m 0755 "$APP_DIR/scripts"
install -o "$APP_USER" -g "$APP_USER" -m 0644 \
    "$SRC_DIR/scripts/check-production-payment-config.mjs" "$APP_DIR/scripts/"
install -o "$APP_USER" -g "$APP_USER" -m 0644 \
    "$SRC_DIR/scripts/payment-production-preflight-core.mjs" "$APP_DIR/scripts/"
install -o "$APP_USER" -g "$APP_USER" -m 0644 \
    "$SRC_DIR/scripts/stripe-history-reconciliation-core.mjs" "$APP_DIR/scripts/"
install -o "$APP_USER" -g "$APP_USER" -m 0755 \
    "$SRC_DIR/scripts/reconcile-stripe-history.mjs" "$APP_DIR/scripts/"
install -o "$APP_USER" -g "$APP_USER" -m 0644 \
    "$SRC_DIR/scripts/stripe-key-mode.mjs" "$APP_DIR/scripts/"
install -o "$APP_USER" -g "$APP_USER" -m 0644 \
    "$SRC_DIR/scripts/check-readiness.mjs" "$APP_DIR/scripts/"
install -m 0644 "$SCRIPT_DIR/lecturelive-web.service" /etc/systemd/system/
install -m 0644 "$SCRIPT_DIR/lecturelive-ws.service" /etc/systemd/system/
systemctl daemon-reload
install -m 0755 "$SCRIPT_DIR/payment-reconciliation-maintenance.sh" \
    /usr/local/bin/lecturelive-payment-maintenance

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
# ffmpeg：文件上传转录依赖它。早期 setup.sh 未安装 ffmpeg，这里幂等补装，
# 让旧部署在升级时自愈。
if ! command -v ffmpeg &>/dev/null; then
    info "补装 ffmpeg..."
    apt-get update -qq && apt-get install -y -qq ffmpeg
fi
npm ci

# Build the new security boundary before the DB preflight. If the one-time history gate stops
# this upgrade, operators must review through this staged build, never the old live server.
node --env-file="$APP_DIR/.env" scripts/run-prisma.mjs generate
npm run build
[[ -d "$SRC_DIR/.next/standalone" ]] || error "编译失败，未生成 standalone 产物"
npm run build:ws
[[ -f "$SRC_DIR/dist/websocket.js" ]] || error "WebSocket 编译失败"
rm -rf "$MAINTENANCE_DIR"
install -d -o "$APP_USER" -g "$APP_USER" -m 0755 "$MAINTENANCE_DIR"
cp -a "$SRC_DIR/.next/standalone/." "$MAINTENANCE_DIR/"
install -d -o "$APP_USER" -g "$APP_USER" -m 0755 "$MAINTENANCE_DIR/scripts"
install -o "$APP_USER" -g "$APP_USER" -m 0644 \
    "$SRC_DIR/scripts/check-production-payment-config.mjs" "$MAINTENANCE_DIR/scripts/"
install -o "$APP_USER" -g "$APP_USER" -m 0644 \
    "$SRC_DIR/scripts/payment-production-preflight-core.mjs" "$MAINTENANCE_DIR/scripts/"
install -o "$APP_USER" -g "$APP_USER" -m 0644 \
    "$SRC_DIR/scripts/stripe-history-reconciliation-core.mjs" "$MAINTENANCE_DIR/scripts/"
install -o "$APP_USER" -g "$APP_USER" -m 0755 \
    "$SRC_DIR/scripts/reconcile-stripe-history.mjs" "$MAINTENANCE_DIR/scripts/"
install -o "$APP_USER" -g "$APP_USER" -m 0644 \
    "$SRC_DIR/scripts/stripe-key-mode.mjs" "$MAINTENANCE_DIR/scripts/"
install -o "$APP_USER" -g "$APP_USER" -m 0644 \
    "$SCRIPT_DIR/payment-maintenance-runtime-version" \
    "$MAINTENANCE_DIR/.payment-maintenance-runtime-version"
chown -R "$APP_USER:$APP_USER" "$MAINTENANCE_DIR"

# Resolve the reconciliation CLI from the same standalone runtime that will host the restricted
# maintenance API. This check must precede ensure-database's production history gate.
if ! runuser -u "$APP_USER" -- /usr/bin/node \
    "$MAINTENANCE_DIR/scripts/reconcile-stripe-history.mjs" --help >/dev/null; then
    error "支付对账维护运行时无法解析依赖，已停止升级"
fi

# ── 3. Prisma 迁移 ──
# 走统一编排器（scripts/ensure-database.mjs）：数据感知迁移 → db push → 历史归属回填。
# 关键：裸调 `prisma db push` 对「有数据的表加必填自增列」等变更会要求 reset 整库（数据全失）；
# 编排器先用幂等数据脚本把这类变更铺好，db push 便无需破坏，且自动回填历史 userId。
info "同步数据库结构（数据感知迁移 → db push → 历史归属回填）..."
# 升级时 cwd 是源码目录（$APP_DIR/src），其中通常没有 .env，DATABASE_URL 也未导出；
# 真实生产配置在 $APP_DIR/.env（与 systemd ExecStart 一致，能正确处理引号）。
# 用 node --env-file 载入它，让 prisma generate（经 run-prisma 包装器）与 ensure-database.mjs
# 都拿得到 DATABASE_URL —— 否则 generate 会在缺连接串时静默 exit 0、ensure-database 静默跳过，schema 漂移。
# Client/build already completed above so the staged maintenance API is available on failure.
node --env-file="$APP_DIR/.env" scripts/ensure-database.mjs --require-database

# ── 4. 编译 Next.js ──
info "校验预先编译的 Next.js 维护/正式产物..."
[[ -d "$SRC_DIR/.next/standalone" ]] || error "编译产物不存在"

# ── 5. 编译 WebSocket 服务器 ──
info "校验预先编译的 WebSocket 服务器..."
[[ -f "$SRC_DIR/dist/websocket.js" ]] || error "WebSocket 编译产物不存在"

# ── 7. 部署 Next.js standalone ──
info "部署 Next.js 产物..."
# -mindepth 1 避免删除 APP_DIR 本身
# src：托管 CLI（deploy/lecture-live）把源码放在 $APP_DIR/src，不排除会连同刚编译产物一起删掉，
#      导致随后的 cp 无源可复制、set -e 中止（与卸载命令 deploy/lecture-live 保持一致）。
find "$APP_DIR" -mindepth 1 -maxdepth 1 \
    ! -name "data" ! -name ".env" ! -name "ws-server" ! -name "backups" ! -name "src" \
    -exec rm -rf {} +

cp -a "$SRC_DIR/.next/standalone/." "$APP_DIR/"
mkdir -p "$APP_DIR/scripts"
install -m 0644 "$SRC_DIR/scripts/check-production-payment-config.mjs" "$APP_DIR/scripts/"
install -m 0644 "$SRC_DIR/scripts/payment-production-preflight-core.mjs" "$APP_DIR/scripts/"
install -m 0644 "$SRC_DIR/scripts/stripe-history-reconciliation-core.mjs" "$APP_DIR/scripts/"
install -m 0755 "$SRC_DIR/scripts/reconcile-stripe-history.mjs" "$APP_DIR/scripts/"
install -m 0644 "$SRC_DIR/scripts/stripe-key-mode.mjs" "$APP_DIR/scripts/"
install -m 0644 "$SRC_DIR/scripts/check-readiness.mjs" "$APP_DIR/scripts/"
install -m 0644 "$SRC_DIR/scripts/document-parser-worker.mjs" "$APP_DIR/scripts/"
install -m 0644 "$SRC_DIR/scripts/document-parser-network-deny.cjs" "$APP_DIR/scripts/"
install -m 0644 "$SRC_DIR/scripts/document-archive-preflight.mjs" "$APP_DIR/scripts/"
install -m 0644 "$SCRIPT_DIR/runtime-security-version" "$APP_DIR/.runtime-security-version"
mkdir -p "$APP_DIR/.next/static"
cp -a "$SRC_DIR/.next/static/." "$APP_DIR/.next/static/"
# Next standalone 运行时需要可写的 .next/cache，编译产物不含，须显式创建
# （否则 systemd ProtectSystem=strict + ReadWritePaths 指向不存在目录，web 启动失败/写 cache 触发 EROFS）。
mkdir -p "$APP_DIR/.next/cache"
[[ -d "$SRC_DIR/public" ]] && cp -r "$SRC_DIR/public" "$APP_DIR/public"

# ── 8. 更新 WebSocket 服务器 ──
info "更新 WebSocket 服务器..."
rm -rf "$WS_DIR"
mkdir -p "$WS_DIR"

cp "$SRC_DIR/dist/websocket.js" "$WS_DIR/"
cp -r "$SRC_DIR/prisma" "$WS_DIR/"
cp "$SCRIPT_DIR/ws-package.json" "$WS_DIR/package.json"

# prisma 是 ws-package.json 的 devDependency，--omit=dev 不装它；裸 `npx prisma` 会联网拉最新大版本，
# 可能与 @prisma/client 5.x 不匹配。钉主版本确保 generate 出的 client 与运行时一致。
(cd "$WS_DIR" && npm install --omit=dev && npx prisma@5 generate)

ln -sfn "$APP_DIR/data" "$WS_DIR/data"
ln -sfn "$APP_DIR/.env" "$WS_DIR/.env"

# ── 9. 修复权限 ──
chown -R $APP_USER:$APP_USER "$APP_DIR"
chown -R $APP_USER:$APP_USER "$MAINTENANCE_DIR"
chmod 600 "$APP_DIR/.env"

# ── 10. 更新 systemd 并启动 ──
info "启动服务..."
cp "$SCRIPT_DIR/lecturelive-web.service" /etc/systemd/system/
cp "$SCRIPT_DIR/lecturelive-ws.service" /etc/systemd/system/
systemctl daemon-reload
install -m 0755 "$SCRIPT_DIR/payment-reconciliation-maintenance.sh" \
    /usr/local/bin/lecturelive-payment-maintenance
if ! systemctl start lecturelive-web lecturelive-ws; then
    systemctl stop lecturelive-web 2>/dev/null || true
    systemctl stop lecturelive-ws 2>/dev/null || true
    if systemctl is-active --quiet lecturelive-web || systemctl is-active --quiet lecturelive-ws; then
        error "服务启动失败，且无法确认失败实例已停止"
    fi
    error "服务启动失败，所有实例已保持停止"
fi

# ── 11. 健康检查 ──
info "等待服务启动..."
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
    info "升级成功！"
    echo "  Web:       $(systemctl is-active lecturelive-web)"
    echo "  WebSocket: $(systemctl is-active lecturelive-ws)"
    echo "  Health:    ok"
else
    warn "服务未通过完整启动检查，正在隔离失败实例:"
    $WEB_OK || echo "  ✗ lecturelive-web: journalctl -u lecturelive-web -n 30 --no-pager"
    $WS_OK  || echo "  ✗ lecturelive-ws:  journalctl -u lecturelive-ws -n 30 --no-pager"
    $HEALTH_OK || echo "  ✗ readiness: node --env-file=$APP_DIR/.env $APP_DIR/scripts/check-readiness.mjs"
    systemctl stop lecturelive-web 2>/dev/null || true
    systemctl stop lecturelive-ws 2>/dev/null || true
    if systemctl is-active --quiet lecturelive-web || systemctl is-active --quiet lecturelive-ws; then
        error "启动检查失败，且无法确认服务已停止；请立即检查 systemd 状态"
    fi
    error "升级失败：服务已保持停止；修复配置或回滚到带 health-ready-v1 标记的安全版本"
fi
echo ""
