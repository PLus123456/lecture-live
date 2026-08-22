# LectureLive 裸机部署指南

适用于 Ubuntu 22.04 / Debian 12+ 服务器，不使用 Docker。

---

## 目录

- [系统要求](#系统要求)
- [首次部署](#首次部署)
- [后续升级](#后续升级)
- [回滚](#回滚)
- [常用运维命令](#常用运维命令)
- [HTTPS 配置](#https-配置)
- [部署目录结构](#部署目录结构)

---

## 系统要求

| 组件 | 版本 |
|------|------|
| OS | Ubuntu 22.04+ / Debian 12+ |
| Node.js | **24 LTS** |
| MySQL | 8.x |
| Redis | 7.x |
| Nginx | 任意 |
| FFmpeg | 任意近期版本（文件上传转录依赖，`setup.sh` 自动安装） |
| 内存 | 建议 2GB+ |

---

## 首次部署

### 1. 本地打包

```bash
cd lecture-live
bash deploy/pack.sh
# 生成 lecturelive-deploy.tar.gz
```

### 2. 上传到服务器

```bash
scp lecturelive-deploy.tar.gz user@your-server:~
```

### 3. 安装系统依赖

```bash
ssh user@your-server
tar xzf lecturelive-deploy.tar.gz
cd lecture-live
sudo bash deploy/setup.sh
```

这会自动安装 Node.js 24、MySQL 8、Redis、Nginx、FFmpeg，并配置防火墙
（ufw：放行 SSH / 80 / 443，拒绝 3000 / 3001 / 3306 / 6379）。

> **SSH 端口非 22 的注意：** 脚本会从 `sshd -T` 读出真实端口再放行，读不到才退回 22。
> 若你的 SSH 走的是非常规配置（例如只在 systemd socket 里指定端口），
> 请先 `LECTURELIVE_SKIP_FIREWALL=1` 跳过，装完再手动配置防火墙，避免把自己关在门外。

### 4. 配置 MySQL

```bash
sudo mysql <<'SQL'
CREATE DATABASE IF NOT EXISTS lecturelive
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'lecturelive'@'localhost'
  IDENTIFIED BY '你的数据库密码';
GRANT ALL ON lecturelive.* TO 'lecturelive'@'localhost';
FLUSH PRIVILEGES;
SQL
```

### 5. 配置 Redis 密码（推荐）

```bash
sudo sed -i 's/^# requirepass .*/requirepass 你的Redis密码/' /etc/redis/redis.conf
sudo systemctl restart redis-server
```

### 6. 配置环境变量

```bash
cp .env.example .env.local
vim .env.local
```

**必须修改的项：**

```ini
# 应用地址（改成你的域名或 IP）
NEXT_PUBLIC_APP_URL=https://your-domain.com
NEXT_PUBLIC_WS_URL=https://your-domain.com

# 数据库（密码与第 4 步一致，特殊字符需 URL 编码，见下方说明）
DATABASE_URL="mysql://lecturelive:你的数据库密码@localhost:3306/lecturelive"

# Redis（密码与第 5 步一致）
REDIS_URL=redis://:你的Redis密码@localhost:6379

# 安全密钥（每个都用 openssl rand -hex 32 生成）
JWT_SECRET=<生成的随机字符串>
ENCRYPTION_KEY=<生成的另一个随机字符串>

# 生产环境
NODE_ENV=production

# 可选：部署引导密钥。配了它，/api/setup 的匿名首次部署窗口就彻底关闭
# （详见下方「首次部署窗口的安全性」）。不配也可以，见那一节的默认行为。
# SETUP_BOOTSTRAP_TOKEN=<openssl rand -hex 32>
```

> **注意：** `.env` 文件中值可以用引号包裹（`KEY="value"`），`node --env-file` 会正确解析。
>
> **重要：** `DATABASE_URL` 和 `REDIS_URL` 是标准 URL 格式，如果密码中包含 `@`、`#`、`/`、`:` 等特殊字符，**必须进行 URL 编码**，否则 Prisma 会解析失败。常见编码：
>
> | 字符 | 编码 |
> |------|------|
> | `@` | `%40` |
> | `#` | `%23` |
> | `/` | `%2F` |
> | `:` | `%3A` |
>
> 例如密码为 `Pass@2026`，`DATABASE_URL` 应写为：
> ```ini
> DATABASE_URL="mysql://lecturelive:Pass%402026@localhost:3306/lecturelive"
> ```

### 7. 编译

```bash
npm ci
npx prisma generate
npm run build          # 编译 Next.js（生成 standalone 产物）
npm run build:ws       # 编译 WebSocket 服务器（esbuild → dist/websocket.js）
```

### 8. 安装并启动服务

```bash
sudo bash deploy/install.sh
```

这会：
- 将 Next.js standalone 产物复制到 `/opt/lecturelive`
- 将编译好的 `websocket.js` + 精简依赖部署到 `/opt/lecturelive/ws-server`
- 配置 systemd 服务并启动

### 9. 配置 Nginx 反代

```bash
sudo cp deploy/nginx-lecturelive.conf /etc/nginx/sites-available/lecturelive
sudo vim /etc/nginx/sites-available/lecturelive
# 把 server_name 改成你的域名
sudo ln -sf /etc/nginx/sites-available/lecturelive /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

模板里这两行**不能删也不能改成 `proxy_add_header`**：

```nginx
proxy_set_header X-Real-IP        $remote_addr;
proxy_set_header X-Forwarded-For  $proxy_add_x_forwarded_for;
```

`proxy_set_header` 是**覆盖**语义——客户端自己带的同名头会被丢掉。漏配任意一个，
该头就完全由客户端控制：每次请求换一个值即可换出一个全新的限流桶，
`auth:login:ip`、`share:view` 等 IP 维度的限流全部失效，审计日志与登录提醒里的 IP 也不可信。
只设置了其中一个头时，请在 `.env.local` 里用 `TRUSTED_PROXY_IP_HEADER` 钉死只信任那一个。

### 9.1 打开 TRUSTED_PROXY（**必做**）

Nginx 就位后，在 `/opt/lecturelive/.env.local` 里确认：

```bash
TRUSTED_PROXY=true
```

不打开的后果：应用拿不到真实客户端 IP，登录/注册的 IP 维度限流会整段跳过
（只剩「每邮箱 N 次」，拦不住「一个弱口令遍历海量邮箱」的横向密码喷洒），
通用限流也只能退到「登录用户 / 请求路径」维度。服务端日志会打一条
`请求带有 X-Forwarded-For / X-Real-IP 但 TRUSTED_PROXY 未开启` 提醒。

前提是应用端口不对公网开放（见下方「端口暴露面」一节：3000/3001 只监听回环）。
若你把 3000 直接暴露给公网，**不要**打开这个开关——攻击者直连并伪造该头即可逃逸限流。

### 10. 验证

浏览器访问 `http://your-domain.com`，看到登录页面即部署成功。

---

## 首次部署窗口的安全性

`/api/setup` 是**公开**端点（中间件不对它鉴权）——服务一起来到你建出第一个管理员之间，
这条路径对全网开放。默认行为：

| 状态 | 谁能调 `/api/setup` |
|------|---------------------|
| 库里还没有管理员 | 任何人（只能走 `step=admin`，且首个管理员的创建有唯一键 CAS，抢不出第二个） |
| 已有管理员 | 必须是**已登录的 ADMIN**（向导在 `step=admin` 之后自动带上该 cookie） |
| 设了 `SETUP_BOOTSTRAP_TOKEN` | 带 `x-setup-token: <该值>` 的请求，**或**已登录的 ADMIN |

结论：**先建管理员，再对外放开 80/443**。做不到的话，就在 `.env` 里设
`SETUP_BOOTSTRAP_TOKEN`，把匿名窗口彻底关掉，然后用 curl 走完向导：

```bash
TOKEN=$(grep '^SETUP_BOOTSTRAP_TOKEN=' /opt/lecturelive/.env | cut -d= -f2-)
curl -sS -X POST http://127.0.0.1:3000/api/setup \
  -H 'Content-Type: application/json' -H "x-setup-token: $TOKEN" \
  -d '{"step":"admin","email":"admin@example.com","password":"你的密码","displayName":"Admin"}'
```

> 注意：设了 `SETUP_BOOTSTRAP_TOKEN` 之后，浏览器里的 `/setup` 向导在**还没有管理员**时
> 会一直 401（页面不会带这个 header）。建好管理员并登录后，向导的后续步骤照常可用。

`step=llm` / `step=soniox` 填写的地址会做私网黑名单校验（与管理后台同一套），
`step=complete` 要求管理员已存在——避免匿名者抢先把实例标记为「已完成设置」而锁死。

`setup_complete` 全仓只写 `true`、从不写回 `false`，误置位只能连数据库改回来：

```sql
-- sudo mysql lecturelive
DELETE FROM SiteSetting WHERE `key` IN ('setup_complete', 'setup_admin_claimed');
```

---

## 后续升级

### 本地

```bash
cd lecture-live
bash deploy/pack.sh
scp lecturelive-deploy.tar.gz user@your-server:~
```

### 服务器

```bash
cd ~
tar xzf lecturelive-deploy.tar.gz
cd lecture-live
sudo bash deploy/upgrade.sh
```

升级脚本会自动完成：备份 → 安装依赖 → 数据库迁移 → 编译 Next.js + WS → 热切换服务 → 健康检查。

---

## 回滚

```bash
# 回滚到最近一次备份（web + ws 一起回滚）
sudo bash deploy/rollback.sh

# 回滚到指定版本
sudo bash deploy/rollback.sh app-20260322_143000.tar.gz

# 查看所有备份
ls -lh /opt/lecturelive/backups/
```

备份自动保留最近 5 个版本。

---

## 常用运维命令

### 服务管理

```bash
# 查看状态
sudo systemctl status lecturelive-web
sudo systemctl status lecturelive-ws

# 重启
sudo systemctl restart lecturelive-web lecturelive-ws

# 停止
sudo systemctl stop lecturelive-web lecturelive-ws

# 开机自启（install.sh 已配置，一般不需要手动执行）
sudo systemctl enable lecturelive-web lecturelive-ws
```

### 查看日志

```bash
# 实时日志
journalctl -u lecturelive-web -f
journalctl -u lecturelive-ws -f

# 最近 100 行
journalctl -u lecturelive-web -n 100 --no-pager

# 今天的日志
journalctl -u lecturelive-web --since today
```

### 数据库

```bash
# 进入 MySQL
sudo mysql lecturelive

# 手动同步数据库结构（数据感知迁移 → db push → 历史归属回填，幂等可重复）
cd ~/lecture-live
node scripts/ensure-database.mjs

# 说明：请勿在存量库上直接跑 `npx prisma db push`。对「给有数据的表加必填/自增列」等变更，
# 裸 db push 会提示 “need to reset / All data will be lost”——此时务必回答 no，
# 改用上面的 ensure-database.mjs（升级脚本内部也走它）。
```

---

## HTTPS 配置

推荐使用 Let's Encrypt 免费证书：

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

certbot 会自动修改 Nginx 配置并设置证书自动续期。

配好 HTTPS 后记得更新 `/opt/lecturelive/.env` 中的地址：

```ini
NEXT_PUBLIC_APP_URL=https://your-domain.com
NEXT_PUBLIC_WS_URL=https://your-domain.com
```

然后重启服务：

```bash
sudo systemctl restart lecturelive-web lecturelive-ws
```

---

## 部署目录结构

```
/opt/lecturelive/
├── server.js              # Next.js standalone 入口
├── .next/static/          # 前端静态资源
├── public/                # 公共资源
├── .env                   # 环境变量（chmod 600）
├── data/                  # 应用数据（转录、摘要等）
├── backups/               # 升级时自动备份（web + ws 一起）
└── ws-server/             # WebSocket 服务器
    ├── websocket.js       # esbuild 编译的 JS（不再需要 ts-node）
    ├── package.json       # 精简依赖（只有 socket.io/prisma/ioredis 等）
    ├── node_modules/      # 约 30MB（对比完整 node_modules 500MB+）
    ├── prisma/
    ├── data -> ../data    # 软链接
    └── .env -> ../.env    # 软链接
```

---

## 端口说明

| 端口 | 服务 | 实际监听 | 对外暴露 |
|------|------|----------|----------|
| 3000 | Next.js | 127.0.0.1（由 `lecturelive-web.service` 的 `Environment=HOSTNAME=127.0.0.1` 强制） | 否 |
| 3001 | Socket.IO | 127.0.0.1（由 `lecturelive-ws.service` 的 `Environment=WS_HOST=127.0.0.1` 强制） | 否 |
| 3306 | MySQL | 取决于 `bind-address`，Ubuntu 默认 127.0.0.1 | 否 |
| 6379 | Redis | 取决于 `bind`，Debian/Ubuntu 默认 127.0.0.1 | 否 |
| 80/443 | Nginx | 全部网卡 | 是 |

> **务必确认防火墙已生效。** `setup.sh` 会安装并启用 ufw（放行 SSH / 80 / 443，
> 显式拒绝 3000 / 3001 / 3306 / 6379）。3000 / 3001 现在都由 systemd 单元收敛到回环，
> 防火墙是第二道闸：单元文件没更新（老版本部署）时，公网可直连 3000/3001，绕过
> `nginx-lecturelive.conf` 里的 `client_max_body_size 100M`、超时以及后续在 nginx 层加的任何限流。
>
> Docker 部署不走这两个单元：`websocket.js` 默认监听 0.0.0.0（Docker 的端口转发连的是
> 容器 IP，不是容器内的 loopback），安全边界由 `docker-compose.yml` 把端口只发布在
> 宿主 `127.0.0.1` 上保证。
>
> 用云厂商安全组代替 ufw 时，可以用 `LECTURELIVE_SKIP_FIREWALL=1 sudo bash deploy/setup.sh`
> 跳过这一段，但请在安全组里做等价的限制。

检查当前监听情况：

```bash
sudo ss -tlnp | grep -E ':(3000|3001|3306|6379)\b'
sudo ufw status verbose
```

`3000` 与 `3001` 两行都应显示 `127.0.0.1:<端口>`。若显示 `0.0.0.0:` 或 `*:`，
说明 systemd 单元里的 `Environment=HOSTNAME=127.0.0.1`（web）/ `Environment=WS_HOST=127.0.0.1`（ws）
没生效（多为老版本单元文件），重新执行 `sudo bash deploy/install.sh` 覆盖单元后
`systemctl daemon-reload && systemctl restart lecturelive-web lecturelive-ws`。

---

## 架构说明

### 为什么 WS 服务器用 esbuild 编译？

原方案用 `ts-node` 直接在生产环境运行 TypeScript，但项目的 `tsconfig.json` 使用 `moduleResolution: "bundler"`（Next.js 需要），ts-node 不支持这个模式会直接报错。

现在用 `esbuild --bundle` 把 `server/websocket.ts` 及其本地依赖（含 socket.io）打包进一个约 250KB 的 `websocket.js`；仅少数重型/原生 npm 包（`@prisma/client`、`ioredis`、`jsonwebtoken`、`bcryptjs`、`bufferutil`、`utf-8-validate`）通过逐个 `--external:` 标记保留为运行时 require，由 `ws-server/node_modules` 提供。

好处：
- **不需要 ts-node / TypeScript**，生产环境只跑原生 JS
- **WS 服务器的 node_modules 从 ~500MB 降到 ~30MB**（不装 Next.js/React）
- **启动更快**，没有 TypeScript 编译开销
