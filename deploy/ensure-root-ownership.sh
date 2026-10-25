#!/usr/bin/env bash
# 收紧并核对部署目录里 root 之后会信任的那几处。setup/install/upgrade/rollback 共用，幂等。
#
#   $APP_DIR 本身    收紧为 root:$APP_USER、去掉组/其他写：服务用户能进入、读取，但不能在里面改名或替换
#                    条目。改名只看父目录的写权限——能写 $APP_DIR，就能把整个 src/ 或 backups/ 换成自己的。
#   .env             换成 root 新建的 root:$APP_USER 0640 文件：服务只需要读。root 在 install/upgrade 里用
#                    node --env-file 读它（prisma generate、next build、ensure-database），而 node 会应用其中的
#                    NODE_OPTIONS 等运行时选项——服务用户能写它，就能让 root 加载任意代码。不原地 chown：
#                    服务用户事先打开的可写描述符在 chown/chmod 之后照样能写旧 inode，换掉之后只剩已 unlink 的旧文件。
#   backups/         只核对、不收归：rollback.sh 以 root 把其中的 app-*.tar.gz 解进 $APP_DIR、把
#                    systemd-*.tar.gz 解进 /etc/systemd/system。新布局下备份都由 root 创建；旧布局下它归服务
#                    用户，chown 一下并不能证明里面的归档没被改过，所以有 root 以外的人能改的条目就拒绝。
#   src/             托管 CLI 的源码检出，这里不碰：托管 CLI 以 root 执行其中的东西之前自己会查
#                    （deploy/lecture-live 的 require_root_only），新装的检出从克隆起就归 root。
#
# .env、backups/ 是软链、或 .env 还有别的硬链接时拒绝：照着它们复制或解包，会把它们指向的内容（比如
# /etc/shadow）变成服务用户可读，或让 root 去读服务用户放在别处的文件。
# 旧 .env 的内容只能照搬；怀疑服务用户被入侵过时，要先人工核对它（见 deploy/INSTALL.md）。
# 其余顶层条目（运行产物、data、ws-server）仍由各脚本交给服务用户，交接时排除 src/、backups/ 与 .env。
#
# 归属的判定写成「root 或当前用户」：本脚本总以 root 运行，二者是一回事；契约测试靠它以普通用户运行。
#
# 用法: bash deploy/ensure-root-ownership.sh <app-dir> <app-user>
set -euo pipefail

APP_DIR="${1:-}"
APP_USER="${2:-}"
if [[ -z "$APP_DIR" || -z "$APP_USER" ]]; then
    echo "[ERROR] 用法: bash deploy/ensure-root-ownership.sh <app-dir> <app-user>" >&2
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

if [[ -d "$APP_DIR/backups" ]]; then
    # 里面只该有 root 自己打的普通文件。软链、子目录、多重硬链接一律不认：旧布局下服务用户能在这里放
    # 指向别处的软链，chown -R 收回时只会改软链自身的属主，rollback.sh 却会跟着它去解包别处的文件。
    BAD="$(find "$APP_DIR/backups" \( ! \( -uid 0 -o -uid "$EUID" \) -o -perm -020 -o -perm -002 \) \
        -print -quit)"
    [[ -n "$BAD" ]] || BAD="$(find "$APP_DIR/backups" -mindepth 1 \( ! -type f -o -links +1 \) -print -quit)"
    if [[ -n "$BAD" ]]; then
        echo "[ERROR] $APP_DIR/backups 里有不可信的条目（root 以外的人能改，或是软链/子目录/硬链接）：$(ls -ld "$BAD")" >&2
        echo "[ERROR] 这些备份会以 root 解包。旧版脚本把 backups/ 交给了服务用户，chown 并不能证明里面的归档" >&2
        echo "[ERROR] 没被改过：确认可信后按 deploy/INSTALL.md「源码检出与备份的所有权」收回，或把旧备份挪走，再重试。" >&2
        exit 1
    fi
fi

if [[ -f "$APP_DIR/.env" ]]; then
    rm -f "$APP_DIR/.env.new"
    (umask 077 && cat "$APP_DIR/.env" > "$APP_DIR/.env.new")
    chown root:"$APP_USER" "$APP_DIR/.env.new"
    chmod 640 "$APP_DIR/.env.new"
    mv -f "$APP_DIR/.env.new" "$APP_DIR/.env"
fi
