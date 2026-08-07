#!/usr/bin/env bash
# ============================================================
# LectureLive 裸机部署脚本
# 适用于 Ubuntu 22.04 / Debian 12+ 服务器
# 用法: sudo bash deploy/setup.sh
# ============================================================
set -euo pipefail

APP_DIR="/opt/lecturelive"
WS_DIR="/opt/lecturelive/ws-server"
APP_USER="lecturelive"
NODE_VERSION="24"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ── 检查 root ──
[[ $EUID -eq 0 ]] || error "请使用 sudo 运行此脚本"

echo "========================================"
echo "  LectureLive 裸机部署"
echo "========================================"
echo ""

# ── 1. 系统依赖 ──
# ffmpeg：文件上传转录靠它抽音频 / 压 MP3。Docker 在 Dockerfile 里 apk add，
# 裸机部署必须在这里装，否则上传转录会报 "Cannot detect audio duration"。
info "安装系统依赖..."
apt-get update -qq
apt-get install -y -qq curl gnupg2 build-essential nginx ffmpeg

# ── 2. Node.js 24 ──
if ! command -v node &>/dev/null || [[ $(node -v | cut -d. -f1 | tr -d v) -lt $NODE_VERSION ]]; then
    info "安装 Node.js ${NODE_VERSION}.x ..."
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
    apt-get install -y -qq nodejs
fi
info "Node.js $(node -v), npm $(npm -v)"

# ── 3. MySQL 8 ──
if ! command -v mysql &>/dev/null; then
    info "安装 MySQL 8..."
    apt-get install -y -qq mysql-server
    systemctl enable --now mysql
fi

# ── 4. Redis ──
if ! command -v redis-server &>/dev/null; then
    info "安装 Redis..."
    apt-get install -y -qq redis-server
    systemctl enable --now redis-server
fi

# ── 5. 创建系统用户和组 ──
# Ubuntu 上 useradd --system 不会自动创建同名 group，
# 必须用 adduser --system --group 或先手动建组
if ! id "$APP_USER" &>/dev/null; then
    info "创建系统用户 $APP_USER ..."
    # adduser 是 Ubuntu/Debian 推荐的方式，--group 会同时创建同名用户组
    adduser --system --group --home /opt/lecturelive --no-create-home --shell /usr/sbin/nologin "$APP_USER"
    info "用户 $APP_USER 创建成功 (uid=$(id -u $APP_USER), gid=$(id -g $APP_USER))"
else
    info "用户 $APP_USER 已存在 (uid=$(id -u $APP_USER), gid=$(id -g $APP_USER))"
    # 确保同名 group 存在（修复之前 useradd --system 遗留的问题）
    if ! getent group "$APP_USER" &>/dev/null; then
        warn "用户组 $APP_USER 不存在，正在创建并修复..."
        groupadd --system "$APP_USER"
        usermod -g "$APP_USER" "$APP_USER"
        info "用户组已修复"
    fi
fi

# 验证用户和组
id "$APP_USER" || error "用户 $APP_USER 创建/验证失败"
getent group "$APP_USER" || error "用户组 $APP_USER 创建/验证失败"

# ── 6. 创建应用目录 ──
info "准备应用目录..."
mkdir -p "$APP_DIR" "$WS_DIR" "$APP_DIR/data" "$APP_DIR/backups"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ── 7. 防火墙（P6-1）──
# 应用端口本该只对 nginx 可见：web 与 ws 现在都由各自 systemd 单元收敛到 127.0.0.1
#（HOSTNAME / WS_HOST）。这里是网络层的第二道闸 —— 单元没更新（老版本部署）或有人手工
# 起进程时仍能兜住，顺带挡住可能对外监听的 MySQL(3306) / Redis(6379)。
#
# 先放行 SSH 再 enable，顺序反了会把自己关在门外；非标准 SSH 端口从 sshd 配置里读。
# 用 LECTURELIVE_SKIP_FIREWALL=1 可整段跳过（例如云厂商安全组已经做了同样的事）。
if [[ "${LECTURELIVE_SKIP_FIREWALL:-0}" == "1" ]]; then
    warn "已按 LECTURELIVE_SKIP_FIREWALL=1 跳过防火墙配置"
    warn "请自行确保 3000 / 3001 / 3306 / 6379 不对公网开放"
else
    info "配置防火墙 (ufw)..."
    command -v ufw &>/dev/null || apt-get install -y -qq ufw

    # 收集所有 sshd 正在监听的端口；读不到就退回 22
    SSH_PORTS="$(sshd -T 2>/dev/null | awk '/^port /{print $2}' || true)"
    [[ -n "$SSH_PORTS" ]] || SSH_PORTS="$(awk '/^[[:space:]]*Port[[:space:]]+/{print $2}' /etc/ssh/sshd_config 2>/dev/null || true)"
    # socket 激活（Ubuntu 22.10+ 默认 ssh.socket）时端口既不在 sshd -T 也不在 sshd_config，
    # 而在 unit 的 ListenStream 里 —— 漏掉它就是把自己关在门外。
    [[ -n "$SSH_PORTS" ]] || SSH_PORTS="$(systemctl show ssh.socket sshd.socket -p ListenStream --value 2>/dev/null \
        | grep -oE '[0-9]+$' || true)"
    # 最后一道保险：本次 SSH 会话真正连着的服务端端口（$SSH_CONNECTION 第 4 段）。
    # 前面几条都靠"配置说什么"，这条靠"事实是什么"，是唯一不可能猜错的来源。
    CURRENT_SSH_PORT="$(awk '{print $4}' <<<"${SSH_CONNECTION:-}" 2>/dev/null || true)"
    [[ "$CURRENT_SSH_PORT" =~ ^[0-9]+$ ]] && SSH_PORTS="$SSH_PORTS
$CURRENT_SSH_PORT"
    SSH_PORTS="$(tr ' ' '\n' <<<"$SSH_PORTS" | grep -E '^[0-9]+$' | sort -un || true)"
    [[ -n "$SSH_PORTS" ]] || SSH_PORTS="22"
    for SSH_PORT in $SSH_PORTS; do
        info "放行 SSH 端口 ${SSH_PORT}"
        ufw allow "${SSH_PORT}/tcp" >/dev/null
    done

    ufw allow 80/tcp  >/dev/null
    ufw allow 443/tcp >/dev/null
    # 显式拒绝，避免以后有人把默认策略改成 allow 时应用端口又裸奔
    for CLOSED_PORT in 3000 3001 3306 6379; do
        ufw deny "${CLOSED_PORT}/tcp" >/dev/null
    done

    ufw default deny incoming  >/dev/null
    ufw default allow outgoing >/dev/null
    ufw --force enable >/dev/null
    info "防火墙已启用：仅放行 SSH(${SSH_PORTS//$'\n'/,}) / 80 / 443"
fi

echo ""
info "系统依赖安装完成！"
echo ""
echo "  用户:  $(id $APP_USER)"
echo "  目录:  $APP_DIR"
echo ""
echo "========================================"
echo "  接下来的手动步骤"
echo "========================================"
echo ""
echo "1) 配置 MySQL 数据库:"
echo "   sudo mysql -e \"CREATE DATABASE IF NOT EXISTS lecturelive CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\""
echo "   sudo mysql -e \"CREATE USER IF NOT EXISTS 'lecturelive'@'localhost' IDENTIFIED BY 'YOUR_DB_PASSWORD';\""
echo "   sudo mysql -e \"GRANT ALL ON lecturelive.* TO 'lecturelive'@'localhost';\""
echo ""
echo "2) 配置 Redis 密码 (可选但推荐):"
echo "   编辑 /etc/redis/redis.conf，添加: requirepass YOUR_REDIS_PASSWORD"
echo "   sudo systemctl restart redis-server"
echo ""
echo "3) 编译并部署应用 (在源码目录中执行):"
echo "   cd /path/to/lecture-live"
echo "   cp .env.example .env.local   # 编辑填入实际配置"
echo "   npm ci"
echo "   npm run db:generate          # 经 run-prisma 包装器读取 .env.local"
echo "   npm run build                # 编译 Next.js"
echo "   npm run build:ws             # 编译 WebSocket 服务器"
echo ""
echo "4) 安装编译产物并启动服务:"
echo "   sudo bash deploy/install.sh"
echo ""
echo "5) 配置 Nginx:"
echo "   sudo cp deploy/nginx-lecturelive.conf /etc/nginx/sites-available/lecturelive"
echo "   # 编辑修改 server_name 为你的域名"
echo "   sudo ln -sf /etc/nginx/sites-available/lecturelive /etc/nginx/sites-enabled/"
echo "   sudo nginx -t && sudo systemctl reload nginx"
echo ""
echo "详细说明见 deploy/INSTALL.md"
echo ""
