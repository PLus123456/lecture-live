#!/usr/bin/env bash
# ============================================================
# LectureLive 编译产物安装脚本
# 将 build 产物复制到 /opt/lecturelive 并配置 systemd
# 用法: 在源码目录中执行 sudo bash deploy/install.sh
# ============================================================
set -euo pipefail

APP_DIR="/opt/lecturelive"
MAINTENANCE_DIR="/opt/lecturelive-maintenance"
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

# ── 检查 Node.js 版本 (要求 24 LTS) ──
NODE_VER=$(node -v | sed 's/v//')
NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
if [[ $NODE_MAJOR -lt 24 ]]; then
    error "Node.js >= 24 必须（当前: $NODE_VER）"
fi

info "停止现有服务 (如果存在)..."
systemctl stop lecturelive-web 2>/dev/null || true
systemctl stop lecturelive-ws 2>/dev/null || true
if systemctl is-active --quiet lecturelive-web || systemctl is-active --quiet lecturelive-ws; then
    error "无法确认旧服务已停止；拒绝进入安全安装流程"
fi

# 修复安装也可能从无 ExecStartPre 的旧版本进入。先安装启动闸，再执行会因历史
# Stripe test key 失败的数据库 preflight，确保失败后的任何 start 都仍 fail-closed。
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

# ── 部署 Next.js standalone 产物 ──
info "部署 Next.js standalone 到 $APP_DIR ..."
mkdir -p "$APP_DIR/data" "$APP_DIR/backups"

# 先处理部署环境，再触碰现有应用产物。这样新复制的 0644 .env 会立刻收紧，数据库
# 安全门失败时也能保留旧应用文件，服务虽已停止但仍可由运维回退启动。
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

# ── 首次引导与可信代理安全默认 ──
# 与托管 CLI/升级路径复用同一份初始化，避免某条入口在复制模板后提前 return，留下
# 空 bootstrap token、0644 .env 或不完整的多跳配置。
bash "$SCRIPT_DIR/ensure-security-env.sh" "$APP_DIR/.env"

# Stage the newly built, maintenance-isolated Web before any history preflight can stop the
# install. The old /opt/lecturelive/server.js is never used for reconciliation.
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

# The first production payment/history gate runs before /opt/lecturelive is replaced. Prove the
# staged CLI can resolve @prisma/client from its own standalone node_modules before touching DB
# state; running the copy under APP_DIR here would resolve against an old or absent runtime.
if ! runuser -u "$APP_USER" -- /usr/bin/node \
    "$MAINTENANCE_DIR/scripts/reconcile-stripe-history.mjs" --help >/dev/null; then
    error "支付对账维护运行时无法解析依赖，已停止部署"
fi

# ── 数据库最终态与安全约束 ──
# 必须在服务启动前、加载真实部署 .env 后执行；SEC-023 的数据库 CHECK 由统一编排器安装。
# 任一步非零退出都由这里显式终止安装，不能带着缺约束的 schema 启动服务。
info "同步数据库结构并安装安全约束..."
if ! (cd "$SRC_DIR" && node --env-file="$APP_DIR/.env" scripts/ensure-database.mjs --require-database); then
    error "数据库初始化或安全约束安装失败，已停止部署"
fi

# 清理旧的 standalone 文件（保留 data、.env、ws-server、backups、src）
# 注意: -mindepth 1 避免删除 APP_DIR 本身
# src：托管 CLI（deploy/lecture-live）把源码放在 $APP_DIR/src，不排除会连同刚编译产物一起删掉，
#      导致随后的 cp 无源可复制、set -e 中止（卸载命令 deploy/lecture-live 已排除 src，此处对齐）。
find "$APP_DIR" -mindepth 1 -maxdepth 1 \
    ! -name "data" ! -name ".env" ! -name "ws-server" ! -name "backups" ! -name "src" \
    -exec rm -rf {} +

# 复制 standalone 产物（用 /. 语法，确保隐藏目录 .next 也被复制）
cp -a "$SRC_DIR/.next/standalone/." "$APP_DIR/"

# systemd 的 ExecStartPre 在每次启动时都要执行支付配置检查。Next standalone 不会
# 自动包含这些运维脚本，因此显式随运行产物安装，避免后续 systemctl restart 绕过检查。
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
# 与编译产物一起发布的显式版本门。旧备份没有此文件，新 systemd unit 会在
# ExecStart 前拒绝它，避免旧匿名深度 health 路由在回滚窗口重新上线。
install -m 0644 "$SCRIPT_DIR/runtime-security-version" "$APP_DIR/.runtime-security-version"

# 复制静态文件
mkdir -p "$APP_DIR/.next/static"
cp -a "$SRC_DIR/.next/static/." "$APP_DIR/.next/static/"

# Next standalone 运行时需要可写的 .next/cache（ISR / fetch cache / 图片优化）；
# 它不在编译产物里，须显式创建，否则 systemd ProtectSystem=strict + ReadWritePaths 指向不存在目录，
# web 服务启动失败（或运行时写 cache 触发 EROFS）。
mkdir -p "$APP_DIR/.next/cache"

# 复制 public 目录
if [[ -d "$SRC_DIR/public" ]]; then
    cp -r "$SRC_DIR/public" "$APP_DIR/public"
fi

# 校验关键文件是否复制成功
[[ -f "$APP_DIR/server.js" ]]      || error "复制失败: server.js 不存在"
[[ -f "$APP_DIR/.next/BUILD_ID" ]] || error "复制失败: .next/BUILD_ID 不存在（隐藏目录可能未复制）"
info "Next.js 产物校验通过 (BUILD_ID: $(cat "$APP_DIR/.next/BUILD_ID"))"

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
# prisma 是 ws-package.json 的 devDependency，--omit=dev 不装它；裸 `npx prisma` 会联网拉最新大版本，
# 可能与 @prisma/client 5.x 不匹配。钉主版本 prisma@5 确保 generate 出的 client 与运行时一致。
(cd "$WS_DIR" && npm install --omit=dev && npx prisma@5 generate)

# 链接共享资源
ln -sfn "$APP_DIR/data" "$WS_DIR/data"
ln -sfn "$APP_DIR/.env" "$WS_DIR/.env"

# ── 修复权限 ──
info "设置文件权限..."
chown -R $APP_USER:$APP_USER "$APP_DIR"
chown -R $APP_USER:$APP_USER "$MAINTENANCE_DIR"
chmod 600 "$APP_DIR/.env"

# ── 安装 systemd 服务 ──
info "安装 systemd 服务..."
cp "$SCRIPT_DIR/lecturelive-web.service" /etc/systemd/system/
cp "$SCRIPT_DIR/lecturelive-ws.service" /etc/systemd/system/
systemctl daemon-reload
install -m 0755 "$SCRIPT_DIR/payment-reconciliation-maintenance.sh" \
    /usr/local/bin/lecturelive-payment-maintenance

# ── 启动服务 ──
info "启动服务..."
systemctl enable lecturelive-web lecturelive-ws
if ! systemctl start lecturelive-web lecturelive-ws; then
    systemctl stop lecturelive-web 2>/dev/null || true
    systemctl stop lecturelive-ws 2>/dev/null || true
    if systemctl is-active --quiet lecturelive-web || systemctl is-active --quiet lecturelive-ws; then
        error "服务启动失败，且无法确认失败实例已停止"
    fi
    error "服务启动失败，所有实例已保持停止"
fi

# ── 健康检查 ──
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
    echo ""
    echo "  首次管理员（仅在尚无管理员时）:"
    echo "    按 deploy/INSTALL.md 在服务器本机读取 $APP_DIR/.env，并用 curl 提交 step=admin"
else
    warn "服务未通过完整启动检查，正在隔离失败实例..."
    $WEB_OK || echo "  ✗ lecturelive-web 失败，查看: journalctl -u lecturelive-web -n 30 --no-pager"
    $WS_OK  || echo "  ✗ lecturelive-ws  失败，查看: journalctl -u lecturelive-ws -n 30 --no-pager"
    $HEALTH_OK || echo "  ✗ 深度就绪检查失败: node --env-file=$APP_DIR/.env $APP_DIR/scripts/check-readiness.mjs"
    systemctl stop lecturelive-web 2>/dev/null || true
    systemctl stop lecturelive-ws 2>/dev/null || true
    if systemctl is-active --quiet lecturelive-web || systemctl is-active --quiet lecturelive-ws; then
        error "启动检查失败，且无法确认服务已停止；请立即检查 systemd 状态"
    fi
    error "部署失败：未通过服务存活与深度就绪检查，服务已保持停止"
fi
echo ""
