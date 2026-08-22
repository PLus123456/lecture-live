#!/usr/bin/env bash
# 初始化部署侧安全环境。可在真正编译/启动前独立调用；不 source 不可信 .env，
# 只读写本脚本负责的固定键，且绝不把引导 token 打印到 stdout/stderr。
set -euo pipefail

ENV_FILE="${1:-}"
if [[ -z "$ENV_FILE" || ! -f "$ENV_FILE" ]]; then
    echo "[ERROR] 用法: bash deploy/ensure-security-env.sh <existing-env-file>" >&2
    exit 1
fi

read_env_value() {
    local name="$1"
    local value
    value=$(sed -n -E "s/^[[:space:]]*${name}=(.*)$/\1/p" "$ENV_FILE" | tail -n 1)
    value="${value#\"}"
    value="${value%\"}"
    value="${value#\'}"
    value="${value%\'}"
    printf '%s' "$value"
}

set_env_value() {
    local name="$1"
    local value="$2"
    if grep -q -E "^[[:space:]]*${name}=" "$ENV_FILE"; then
        # -i.bak 同时兼容 GNU/BSD sed；值均由本脚本生成或为固定安全默认，不含替换元字符。
        sed -i.bak -E "s|^[[:space:]]*${name}=.*$|${name}=${value}|" "$ENV_FILE"
        rm -f "${ENV_FILE}.bak"
    else
        printf '\n%s=%s\n' "$name" "$value" >> "$ENV_FILE"
    fi
}

ensure_env_default() {
    local name="$1"
    local value="$2"
    if [[ -z "$(read_env_value "$name")" ]]; then
        set_env_value "$name" "$value"
    fi
}

# 复制自 .env.example 的文件通常是 0644；在写入秘密前先收紧，写完再复核一次。
chmod 600 "$ENV_FILE"

BOOTSTRAP_TOKEN=$(read_env_value SETUP_BOOTSTRAP_TOKEN)
if [[ ${#BOOTSTRAP_TOKEN} -lt 32 ]]; then
    BOOTSTRAP_TOKEN=$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")
    set_env_value SETUP_BOOTSTRAP_TOKEN "$BOOTSTRAP_TOKEN"
    echo "[INFO] 已生成首次管理员引导密钥并保存到部署 .env（不会发送到浏览器）"
fi
unset BOOTSTRAP_TOKEN

# 托管 systemd 部署固定经过本机 nginx，禁止 hops=0。额外代理必须主动给出自己的 CIDR；
# 不能先填 loopback 默认再检查，否则 HOPS>1 的缺配置会被误判为合法。
ensure_env_default TRUSTED_PROXY_HOPS 1
PROXY_HOPS=$(read_env_value TRUSTED_PROXY_HOPS)
if ! [[ "$PROXY_HOPS" =~ ^[0-8]$ ]] || [[ "$PROXY_HOPS" == "0" ]]; then
    echo "[ERROR] 标准 nginx 部署要求 TRUSTED_PROXY_HOPS 为 1..8（当前: ${PROXY_HOPS:-空}）" >&2
    exit 1
fi

if [[ "$PROXY_HOPS" -eq 1 ]]; then
    ensure_env_default TRUSTED_PROXY_CIDRS '127.0.0.1/32,::1/128'
elif [[ -z "$(read_env_value TRUSTED_PROXY_CIDRS)" ]]; then
    echo "[ERROR] TRUSTED_PROXY_HOPS > 1 时必须显式配置 TRUSTED_PROXY_CIDRS" >&2
    exit 1
fi
unset PROXY_HOPS

chmod 600 "$ENV_FILE"
