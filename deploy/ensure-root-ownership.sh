#!/usr/bin/env bash
# 收紧部署目录里 root 之后会信任的那几处的所有权。setup/install/upgrade/rollback 共用，幂等。
#
#   $APP_DIR 本身    root:$APP_USER，去掉组/其他写：服务用户能进入、读取，但不能在里面改名或替换条目。
#                    改名只看父目录的写权限——能写 $APP_DIR，就能把整个 src/ 或 backups/ 换成自己的。
#   .env             root:$APP_USER 0640：服务只需要读。root 在 install/upgrade 里用 node --env-file 读它
#                    （prisma generate、next build、ensure-database），而 node 会应用其中的 NODE_OPTIONS
#                    等运行时选项——服务用户能写它，就能让 root 加载任意代码。
#   backups/         root 独占：rollback.sh 以 root 把其中的 app-*.tar.gz 解进 $APP_DIR、把
#                    systemd-*.tar.gz 解进 /etc/systemd/system，服务用户能写它们就等于能拿 root。
#   src/             托管 CLI 的源码检出，lecture-live update/install/rollback 以 root 执行其中的
#                    git、npm、next build 与 deploy/*.sh。只在调用方本身就是从这份检出运行时才收归
#                    root（第三个参数）：以 root 跑它的代码本来就已经在信任它，收归不会多信任任何东西；
#                    从别处运行时不碰它，免得把一份没人检查过的检出洗成「可信」。
#
# 旧布局下这几处都归服务用户，所以收回时不能信它们的「形状」：
#   · .env 是软链或还有别的硬链接时拒绝——照着它复制，会把它指向的内容（比如 /etc/shadow）变成服务用户可读；
#   · .env 换成 root 新建的文件，而不是原地 chown：服务用户事先打开的可写描述符在 chown/chmod 之后照样能写
#     旧 inode，换掉之后它们只剩一份已经 unlink 的旧文件；
#   · backups/ 是软链时拒绝——chown -R 会跟着它改别处的属主（指向 /usr/bin 会清掉 sudo 的 setuid 位）；
#   · src/ 是软链时不收归（托管 CLI 执行前照样会检查它指向的真实目录）。
# 旧 .env 的内容只能照搬；怀疑服务用户被入侵过时，要先人工核对它（见 deploy/INSTALL.md）。
#
# 其余顶层条目（运行产物、data、ws-server）仍由各脚本交给服务用户，交接时排除 src/、backups/ 与 .env。
# 托管 CLI 在以 root 执行检出里的东西之前会再查一遍（deploy/lecture-live 的 require_root_only）。
#
# 用法: bash deploy/ensure-root-ownership.sh <app-dir> <app-user> [<调用方所在的源码检出>]
set -euo pipefail

APP_DIR="${1:-}"
APP_USER="${2:-}"
RUNNING_SRC="${3:-}"
if [[ -z "$APP_DIR" || -z "$APP_USER" ]]; then
    echo "[ERROR] 用法: bash deploy/ensure-root-ownership.sh <app-dir> <app-user> [<source-checkout>]" >&2
    exit 1
fi

# 先收紧 $APP_DIR 本身：此后只有 root 能在里面增删、替换条目，下面的检查与修改之间不会被调包。
mkdir -p "$APP_DIR"
chown root:"$APP_USER" "$APP_DIR"
chmod u=rwx,g=rx,o-w "$APP_DIR"

for entry in .env backups; do
    if [[ -L "$APP_DIR/$entry" ]]; then
        echo "[ERROR] $APP_DIR/$entry 是软链：它会以 root 被读取或解包，必须是真实的文件/目录。" >&2
        echo "[ERROR] 核实它指向的内容后换成真实的文件/目录（备份放在别的盘上请改用 bind mount），再重试。" >&2
        exit 1
    fi
done
if [[ -f "$APP_DIR/.env" && -n "$(find "$APP_DIR/.env" -maxdepth 0 -links +1)" ]]; then
    echo "[ERROR] $APP_DIR/.env 还有别的硬链接：核实后换成一份独立的文件再重试。" >&2
    exit 1
fi

if [[ -f "$APP_DIR/.env" ]]; then
    rm -f "$APP_DIR/.env.new"
    (umask 077 && cat "$APP_DIR/.env" > "$APP_DIR/.env.new")
    chown root:"$APP_USER" "$APP_DIR/.env.new"
    chmod 640 "$APP_DIR/.env.new"
    mv -f "$APP_DIR/.env.new" "$APP_DIR/.env"
fi

# -R 默认不跟随树里的软链
if [[ -d "$APP_DIR/backups" ]]; then
    chown -R root:root "$APP_DIR/backups"
    chmod -R go-w "$APP_DIR/backups"
fi

if [[ -n "$RUNNING_SRC" && -d "$APP_DIR/src" && ! -L "$APP_DIR/src" ]] \
    && [[ "$(cd "$RUNNING_SRC" && pwd -P)" == "$(cd "$APP_DIR/src" && pwd -P)" ]]; then
    chown -R root:root "$APP_DIR/src"
    chmod -R go-w "$APP_DIR/src"
fi
