#!/usr/bin/env bash
# ============================================================
# 打包 LectureLive 源码用于服务器部署
# 用法: bash deploy/pack.sh
# 输出: lecturelive-deploy.tar.gz
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT="$SRC_DIR/lecturelive-deploy.tar.gz"

GREEN='\033[0;32m'
NC='\033[0m'
info() { echo -e "${GREEN}[INFO]${NC} $*"; }

cd "$SRC_DIR"

info "正在打包 LectureLive 源码..."

tar czf "$OUTPUT" \
    --exclude='node_modules' \
    --exclude='.next' \
    --exclude='dist' \
    --exclude='.env.local' \
    --exclude='.env' \
    --exclude='tsconfig.tsbuildinfo' \
    --exclude='next-env.d.ts' \
    --exclude='prisma/dev.db' \
    --exclude='data/*' \
    --exclude='.DS_Store' \
    --exclude='security-audit-*.md' \
    --exclude='.claude' \
    --exclude='lecturelive-deploy.tar.gz' \
    -C "$(dirname "$SRC_DIR")" \
    "$(basename "$SRC_DIR")"

SIZE=$(du -sh "$OUTPUT" | cut -f1)
info "打包完成: $OUTPUT ($SIZE)"
echo ""
echo "部署步骤:"
echo "  1. scp lecturelive-deploy.tar.gz user@server:~"
echo "  2. tar xzf lecturelive-deploy.tar.gz"
echo "  3. cd lecture-live"
echo "  4. sudo bash deploy/setup.sh       # 安装系统依赖 (首次)"
echo "  5. cp .env.example .env.local       # 配置环境变量"
echo "  6. npm ci                           # 安装 Node 依赖"
echo "  7. npx prisma generate && npm run build && npm run build:ws"
echo "  8. sudo bash deploy/install.sh      # 安装到 /opt 并启动服务"
echo ""
echo "详细说明见 deploy/INSTALL.md"
echo ""
