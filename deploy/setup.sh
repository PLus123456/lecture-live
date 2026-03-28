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
NODE_VERSION="20"

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
info "安装系统依赖..."
apt-get update -qq
apt-get install -y -qq curl gnupg2 build-essential nginx

# ── 2. Node.js 20 ──
if ! command -v node &>/dev/null || [[ $(node -v | cut -d. -f1 | tr -d v) -lt $NODE_VERSION ]]; then
    info "安装 Node.js ${NODE_VERSION}.x ..."
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
    apt-get install -y -qq nodejs
fi
info "Node.js $(node -v), npm $(npm -v)"

# 检查 Node 版本 >= 20.6（--env-file 支持）
NODE_VER=$(node -v | sed 's/v//')
NODE_MINOR=$(echo "$NODE_VER" | cut -d. -f2)
if [[ $(echo "$NODE_VER" | cut -d. -f1) -eq 20 && $NODE_MINOR -lt 6 ]]; then
    warn "Node.js $NODE_VER < 20.6.0，建议升级以支持 --env-file"
    warn "运行: sudo apt-get update && sudo apt-get install -y nodejs"
fi

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
echo "   npx prisma generate"
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
