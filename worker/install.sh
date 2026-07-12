#!/usr/bin/env bash
# ============================================================
# LectureLive 音频增强 worker 一键安装脚本
# 在独立的 worker 机器（如甲骨文 ARM 实例，Ubuntu/Debian）上执行：
#   sudo bash worker/install.sh
# 幂等：重复执行 = 升级 worker 脚本并重启服务，已生成的 token 保持不变。
# ============================================================
set -euo pipefail

APP_DIR="/opt/lecturelive-worker"
APP_USER="llworker"
SERVICE_NAME="lecturelive-enhance-worker"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKER_PORT="${AUDIO_WORKER_PORT:-8790}"
# deep-filter 预编译版本（Rikorose/DeepFilterNet 的 release tag）
DEEP_FILTER_VERSION="0.5.6"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

[[ $EUID -eq 0 ]] || error "请使用 sudo 运行此脚本"
[[ -f "$SCRIPT_DIR/audio-enhance-worker.mjs" ]] || error "未找到 audio-enhance-worker.mjs（请在仓库的 worker/ 目录下执行）"

# ── 1. 依赖：Node ≥ 20 ──
if ! command -v node &>/dev/null; then
    error "未找到 node。请先安装 Node.js ≥ 20，例如：
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs"
fi
NODE_BIN="$(command -v node)"
NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
[[ "$NODE_MAJOR" -ge 20 ]] || error "Node 版本过低（当前 $(node -v)），需要 ≥ 20"
info "Node: $(node -v) ($NODE_BIN)"

# ── 2. 依赖：ffmpeg（缺失且有 apt 时自动安装） ──
if ! command -v ffmpeg &>/dev/null; then
    if command -v apt-get &>/dev/null; then
        warn "未找到 ffmpeg，正在通过 apt 安装..."
        DEBIAN_FRONTEND=noninteractive apt-get update -qq
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg
    else
        error "未找到 ffmpeg，且系统无 apt。请自行安装 ffmpeg/ffprobe 后重试"
    fi
fi
info "ffmpeg: $(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}')"

# ── 3. 依赖：deep-filter（best-effort 自动下载；失败不阻塞，会自动兜底 afftdn） ──
if command -v deep-filter &>/dev/null; then
    info "deep-filter 已安装: $(command -v deep-filter)"
else
    ARCH="$(uname -m)"
    case "$ARCH" in
        aarch64|arm64) TARGETS=("aarch64-unknown-linux-gnu" "aarch64-unknown-linux-musl") ;;
        x86_64)        TARGETS=("x86_64-unknown-linux-musl" "x86_64-unknown-linux-gnu") ;;
        *)             TARGETS=() ;;
    esac
    DF_OK=""
    for TARGET in "${TARGETS[@]:-}"; do
        [[ -n "$TARGET" ]] || continue
        URL="https://github.com/Rikorose/DeepFilterNet/releases/download/v${DEEP_FILTER_VERSION}/deep-filter-${DEEP_FILTER_VERSION}-${TARGET}"
        info "尝试下载 deep-filter: $URL"
        if curl -fsSL --connect-timeout 15 -o /tmp/deep-filter.dl "$URL"; then
            install -m 0755 /tmp/deep-filter.dl /usr/local/bin/deep-filter
            rm -f /tmp/deep-filter.dl
            if deep-filter --version &>/dev/null || deep-filter --help &>/dev/null; then
                DF_OK=1
                info "deep-filter 安装成功: /usr/local/bin/deep-filter"
                break
            fi
            warn "下载的 deep-filter 无法执行（架构/libc 不匹配），移除并尝试下一个目标"
            rm -f /usr/local/bin/deep-filter
        fi
    done
    if [[ -z "$DF_OK" ]]; then
        warn "deep-filter 自动安装失败——worker 仍可运行，降噪将回落 ffmpeg afftdn（效果较弱）。"
        warn "可稍后手动安装（见 worker/README.md），装好后 systemctl restart ${SERVICE_NAME} 即可生效。"
    fi
fi

# ── 4. 系统用户与目录 ──
if ! id "$APP_USER" &>/dev/null; then
    info "创建系统用户 $APP_USER"
    useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER" 2>/dev/null \
        || adduser --system --group --home "$APP_DIR" --no-create-home --shell /usr/sbin/nologin "$APP_USER"
fi
mkdir -p "$APP_DIR/data"
install -m 0644 "$SCRIPT_DIR/audio-enhance-worker.mjs" "$APP_DIR/audio-enhance-worker.mjs"
chown -R "$APP_USER":"$(id -gn "$APP_USER")" "$APP_DIR"
info "worker 脚本已安装到 $APP_DIR"

# ── 5. 通信 token：已有单元里的真实 token 一律保留（幂等升级不换密钥） ──
TOKEN=""
if [[ -f "$UNIT_FILE" ]]; then
    TOKEN="$(grep -oP '(?<=AUDIO_WORKER_TOKEN=)\S+' "$UNIT_FILE" 2>/dev/null || true)"
    [[ "$TOKEN" == change-me-* ]] && TOKEN=""
fi
if [[ -n "$TOKEN" ]]; then
    info "沿用已有 token（不变更；如需轮换请删除 $UNIT_FILE 后重跑）"
else
    TOKEN="$(openssl rand -hex 32)"
    info "已生成新 token"
fi

# ── 6. systemd 单元 ──
cat > "$UNIT_FILE" <<UNIT
[Unit]
Description=LectureLive Audio Enhance Worker
After=network.target

[Service]
Type=simple
User=${APP_USER}
Group=$(id -gn "$APP_USER")
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} ${APP_DIR}/audio-enhance-worker.mjs
Restart=always
RestartSec=5

Environment=AUDIO_WORKER_TOKEN=${TOKEN}
Environment=AUDIO_WORKER_PORT=${WORKER_PORT}
Environment=AUDIO_WORKER_HOST=127.0.0.1
Environment=AUDIO_WORKER_DATA_DIR=${APP_DIR}/data
Environment=AUDIO_WORKER_CONCURRENCY=1

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${APP_DIR}/data
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
UNIT
chmod 600 "$UNIT_FILE"

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME" >/dev/null 2>&1 || systemctl restart "$SERVICE_NAME"
sleep 2

# ── 7. 健康检查 ──
HEALTH="$(curl -s -m 5 -H "Authorization: Bearer ${TOKEN}" "http://127.0.0.1:${WORKER_PORT}/healthz" || true)"
if [[ "$HEALTH" == *'"ok":true'* && "$HEALTH" == *'"engines"'* ]]; then
    info "worker 运行正常: $HEALTH"
else
    journalctl -u "$SERVICE_NAME" -n 20 --no-pager || true
    error "worker 健康检查失败（见上方日志）"
fi

# ── 8. 收尾指引 ──
echo
echo -e "${GREEN}============================================================${NC}"
echo -e "${GREEN} 安装完成！接下来两步：${NC}"
echo -e "${GREEN}============================================================${NC}"
echo
echo "1) 配置 nginx HTTPS 反代（worker 只监听 127.0.0.1:${WORKER_PORT}）——示例："
echo
cat <<NGINX
    server {
        listen 443 ssl;
        http2 on;
        server_name enhance.example.com;   # ← 换成你的域名
        ssl_certificate     /etc/letsencrypt/live/enhance.example.com/fullchain.pem;
        ssl_certificate_key /etc/letsencrypt/live/enhance.example.com/privkey.pem;
        client_max_body_size 2048m;
        location / {
            proxy_pass http://127.0.0.1:${WORKER_PORT};
            proxy_http_version 1.1;
            proxy_request_buffering off;
            proxy_buffering off;
            proxy_read_timeout  1800s;
            proxy_send_timeout  1800s;
            proxy_set_header Host \$host;
        }
    }
NGINX
echo
echo "2) 在 LectureLive 管理后台 → 设置 → 音频增强："
echo "   - Worker 地址：https://你的域名"
echo "   - Worker Token（下方值只显示这一次，请立即保存）："
echo
echo -e "   ${YELLOW}${TOKEN}${NC}"
echo
echo "   填好后点「测试连接」，再启用开关，并在「用户组」里为需要的组打开音频增强。"
echo
echo "常用命令：systemctl status ${SERVICE_NAME} / journalctl -u ${SERVICE_NAME} -f"
