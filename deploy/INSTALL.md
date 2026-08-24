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
# 正式安装会在服务启动前同步 schema 并安装数据库安全 CHECK，不允许关闭
AUTO_DB_PUSH=true

# Redis（密码与第 5 步一致）
REDIS_URL=redis://:你的Redis密码@localhost:6379

# 安全密钥（每个都用 openssl rand -hex 32 生成）
JWT_SECRET=<生成的随机字符串>
ENCRYPTION_KEY=<生成的另一个随机字符串>

# 首次进入 LLM 配置步骤前必填：逐个填写实际 provider 的精确 origin，逗号分隔
# 只写协议 + 主机 + 非默认端口，不写路径、查询串、通配符，也不会自动放行子域

# 可信代理拓扑（标准部署：公网 -> 本机 Nginx -> 回环 Web/WS）
TRUSTED_PROXY_HOPS=1
TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128

# 生产环境
NODE_ENV=production

# 首次管理员引导密钥（至少 32 字节）
# install.sh 在缺失或过短时会自动生成，并只保存到 /opt/lecturelive/.env。
# 也可在安装前手工生成：openssl rand -hex 32
SETUP_BOOTSTRAP_TOKEN=<openssl rand -hex 32>
```

> **注意：** `.env` 文件中值可以用引号包裹（`KEY="value"`），`node --env-file` 会正确解析。
>
> **LLM 出站边界：** 不设 origin 白名单（自托管场景下管理员与能改 .env 的是同一个人，
> 白名单只增加运维成本、挡不住任何人）。仍然强制的是与配置无关的那部分：只走 HTTPS、
> 不跟任何 3xx 重定向、DNS 结果钉住后再连（防重绑定）、私网/回环/链路本地地址一律拒绝。

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
- 在引导密钥缺失或过短时生成强随机 `SETUP_BOOTSTRAP_TOKEN`，只写入权限为 600 的部署 `.env`
- 加载部署 `.env` 运行统一数据库编排并安装安全约束；缺连接串、禁用同步或迁移失败时停止启动
- 配置 systemd 服务并启动

### 9. 配置 Nginx 反代

```bash
sudo cp deploy/nginx-lecturelive.conf /etc/nginx/sites-available/lecturelive
sudo vim /etc/nginx/sites-available/lecturelive
# 把 server_name 改成你的域名
sudo ln -sf /etc/nginx/sites-available/lecturelive /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 10. 验证

浏览器访问 `http://your-domain.com`，看到登录页面即部署成功。

---

## 首次部署窗口的安全性

`/api/setup` 是中间件放行的引导端点，但写操作在路由内按实例状态**关闭失败**：

| 状态 | 谁能调 `/api/setup` |
|------|---------------------|
| 库里还没有管理员 | 必须提供至少 32 字节的服务端 `SETUP_BOOTSTRAP_TOKEN`，且该令牌**只能**调用 `step=admin` |
| 引导密钥缺失或过短 | 所有首次管理员认领请求返回 503，不会回退到匿名模式 |
| 已有管理员 | 只接受**已登录的 ADMIN**；引导令牌立即且永久失去授权能力 |

安装脚本不会把密钥打印进日志或交给浏览器。请在服务器本机读取部署 `.env`，用 curl
原子认领首位管理员；不要把密钥放进 URL、浏览器本地存储、截图或聊天记录：

```bash
TOKEN=$(sudo sed -n 's/^SETUP_BOOTSTRAP_TOKEN=//p' /opt/lecturelive/.env | tail -n 1)
TOKEN=${TOKEN#\"}; TOKEN=${TOKEN%\"}
TOKEN=${TOKEN#\'}; TOKEN=${TOKEN%\'}
curl -sS -X POST http://127.0.0.1:3000/api/setup \
  -H 'Content-Type: application/json' -H "x-setup-token: $TOKEN" \
  -d '{"step":"admin","email":"admin@example.com","password":"replace-with-a-unique-strong-password-2026","displayName":"Admin"}'
unset TOKEN
```

成功响应会设置管理员会话 cookie。由于命令行 curl 不会自动把 cookie 交给浏览器，请随后
在浏览器正常登录这个管理员账号，再完成数据库检查、LLM、Soniox 和完成标记。浏览器里的
`/setup` 在尚无管理员时返回 401 是预期行为；它绝不会读取部署引导密钥。

`step=llm` 填写的地址必须是 HTTPS、不带 query，并通过 DNS/私网校验；
`step=soniox` 也会做私网黑名单校验，
`step=complete` 要求管理员已存在——避免匿名者抢先把实例标记为「已完成设置」而锁死。

`setup_complete` 只会由**已认证 ADMIN 明确提交 `step=complete`**写成 `true`；首页和
公开状态接口都只读、不会自动封门。该标记从不自动写回 `false`，误置位只能连数据库改回来：

```sql
-- sudo mysql lecturelive
DELETE FROM SiteSetting WHERE `key` IN ('setup_complete', 'setup_admin_claimed');
```

---

## 可信代理与真实客户端 IP

标准部署的安全边界是“公网客户端 → 本机 Nginx → 回环 Web/WS”。模板同时保证：

- Web 与 WS 端口只绑定宿主回环，公网不能绕过 Nginx；
- Nginx 用 `$remote_addr` **覆盖**客户端提交的 `X-Forwarded-For` / `X-Real-IP`；
- 应用固定从右侧剥离 `TRUSTED_PROXY_HOPS=1` 跳，并让两个头不一致时关闭失败；
- Nginx 同时执行每 IP 和站点全局的请求/连接预算。

不要把 3000/3001 直接暴露到公网。仅在完全不使用反向代理的本地开发模式把
`TRUSTED_PROXY_HOPS=0`；此时 HTTP 请求没有可信的 socket peer，IP 型限流会退化为
`unknown`，不适合作为生产拓扑。

如果 Nginx 前还有 CDN/LB，必须在部署前显式描述链路，例如两跳：

```ini
TRUSTED_PROXY_HOPS=2
TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128,203.0.113.0/24
```

其中 CIDR 只能填写实际受控代理网段，并同步调整 Nginx，让它在校验上游来源后传递完整、
可预测的链；`X-Real-IP` 必须等于 XFF 最右侧的直接外部代理。跳数超过 1 但没有显式
CIDR、CIDR 非法、两个头不一致或跳数超过 8 时，WS 会拒绝连接或进程拒绝启动；
HTTP 端则把无法验证的链解析为 `unknown`。拓扑变更后必须重启 Web 和 WS。管理后台旧版
`trusted_proxy` 开关不再改变安全边界，实际配置只认上述环境变量。

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

回滚只允许恢复带 `health-ready-v1` 运行时标记的安全版本。早于受保护深度就绪端点的
旧备份会被拒绝并保持 Web/WS 停止，避免重新上线匿名依赖探测；此时应修复当前版本，
或先把旧代码移植安全补丁后重新构建，不能手工伪造标记强行启动。

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

首次从旧版升级且数据库已有 Stripe 成功订单时，生产启动闸会保持服务停止，直到历史退款/拒付完成一次性审计。脚本只调用 Stripe 官方 REST API，不保存 API key、签名或原始响应；默认是只读 dry-run：

```bash
# 对账 CLI 与受限复核服务统一从 /opt/lecturelive-maintenance 的自包含
# standalone runtime 运行，不依赖此时可能尚未替换的 /opt/lecturelive/node_modules。

# 1. 从最早本地 Stripe 订单前一天扫到命令启动时刻；完整分页，任何中断都不会发布完成 marker
sudo lecturelive-payment-maintenance reconcile

# 2. 人工核对 dry-run 的 account id、覆盖时间、Refund/Dispute 与对象映射后再导入
sudo lecturelive-payment-maintenance reconcile \
  --apply \
  --confirm=IMPORT_HISTORICAL_STRIPE_REVERSALS \
  --reason="首次安全升级：已核对 Stripe Dashboard 与覆盖起点"

# 3. 导入只进入 durable inbox/review；部分退款、非 lost dispute、冲突/未映射项不会被猜测处理。
#    正式 web/ws 仍保持停止。启动受限维护服务（前台运行；另开一个 SSH 会话操作 API）：
sudo lecturelive-payment-maintenance

#    维护模式只允许登录/刷新/登出和 ADMIN 支付复核 API；普通用户、钱包、支付回调、
#    setup/share/translation 等全部 503，Stripe 会在恢复正式服务后重投。
#    通过 /api/admin/recharge/reviews 逐项 map/retry、退款或理由化处置，并解除相应 hold。
#    处置完按 Ctrl-C 退出维护服务。
#    所有 history:* inbox=processed、case 已关闭且历史 hold 已解除后，显式发布完成 marker：
sudo lecturelive-payment-maintenance reconcile \
  --finalize \
  --confirm=FINALIZE_REVIEWED_STRIPE_HISTORY \
  --reason="历史 Stripe 复核队列与冻结均已处置完毕"
```

脚本把 marker 绑定到 `/v1/account` 返回的 `acct_*`、live/default 命名空间、扫描起止时间和当前 key 指纹。更换 key、扫描被截断、仍有 review/hold、历史 test 或 Connect 订单时启动继续失败；不得用手工伪造 SiteSetting 绕过。

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
