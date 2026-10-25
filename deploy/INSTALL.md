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
> **LLM 出站边界：** 不设 origin 白名单，也没有对应的环境变量（自托管场景下管理员与能改
> .env 的是同一个人，白名单只增加运维成本、挡不住任何人）。仍然强制的是与配置无关的那部分
> （`src/lib/llm/outboundPolicy.ts`）：只走 HTTPS、地址不得带账号密码或查询串、不跟任何 3xx
> 重定向、DNS 结果钉住后再连（防重绑定）、私网/回环/链路本地地址一律拒绝。

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
- 在引导密钥缺失或过短时生成强随机 `SETUP_BOOTSTRAP_TOKEN`，只写入归 root、服务用户只读（`root:lecturelive 0640`）的部署 `.env`
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

模板里每个反代 `location`（`/api/auth/`、`/`、`/socket.io/`）都有这两行，**不能删，
也不能把 XFF 改成 `$proxy_add_x_forwarded_for`**：

```nginx
proxy_set_header X-Real-IP        $remote_addr;
proxy_set_header X-Forwarded-For  $remote_addr;
```

`proxy_set_header` 是**覆盖**语义——客户端自己带的同名头会被丢掉，应用只看到 Nginx 写入的
`$remote_addr`；`$proxy_add_x_forwarded_for` 则会把客户端提交的链原样往后传。应用在
`TRUSTED_PROXY_HOPS=1` 下取 XFF 最右一段，并要求 X-Real-IP（若有）与之一致。漏掉覆盖，这两个头
就由客户端决定：要么每次请求换一个值、换出一个全新的限流桶（`auth:login:ip`、`share:view` 等
IP 维度限流全部失效，审计日志与登录提醒里的 IP 也不可信），要么故意让两个头不一致，把请求挤进
所有人共用的 `unknown` 桶。只转发 XFF、不带 X-Real-IP 的代理在一跳时也能正确解析。

### 9.1 确认可信代理跳数（**必做**）

部署配置在 `/opt/lecturelive/.env`（源码目录里的 `.env.local` 只在首次安装时被复制过去一次）。
标准拓扑「公网 → 本机 Nginx → 回环 Web/WS」只有一跳：

```bash
TRUSTED_PROXY_HOPS=1
TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128
```

- `install.sh`、`upgrade.sh` 与托管 CLI 都会先跑 `deploy/ensure-security-env.sh`：缺省时写入上面两行；
  `TRUSTED_PROXY_HOPS=0` 或不在 1–8 之间时直接中止；跳数大于 1 却没有显式 `TRUSTED_PROXY_CIDRS` 时同样中止。
- 旧的 `TRUSTED_PROXY=true`、`TRUSTED_PROXY_IP_HEADER` 与管理后台的 `trusted_proxy` 开关都已作废，
  留在 env 或数据库里也不会改变拓扑。
- 拓扑是启动配置，修改后必须同时重启 Web 与 WS。Nginx 前面还有 CDN/LB 时见下文「可信代理与真实客户端 IP」。

前提是应用端口不对公网开放（见下方「端口说明」：3000/3001 只监听回环）。HTTP 侧拿不到可校验的
socket 对端，若把 3000 直接暴露给公网，攻击者直连并伪造代理头即可逃逸 IP 维度的限流。

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

托管安装（`sudo lecture-live install` 装的）用 `sudo lecture-live update`：先 `git pull --ff-only`
源码检出 `/opt/lecturelive/src`，再执行同一个 `deploy/upgrade.sh`。它只认 `/opt/lecturelive/src` 与
`/root/lecture-live`，不会去 `/home/*` 里找源码，而且这份检出必须只有 root 能改（见下方
[源码检出与备份的所有权](#源码检出与备份的所有权)）；源码放在自己家目录里的手工部署照上面的命令在源码目录执行
`sudo bash deploy/upgrade.sh`。

升级**全程停机**（不是热切换），按下面的顺序执行，任一步失败都保持 Web/WS 停止：

1. 校验并补齐部署 env（`ensure-security-env.sh`），停止两个服务；
2. 装上 fail-closed 启动闸（支付预检与 readiness 脚本），把现役 systemd unit 备份成
   `backups/systemd-<时间戳>.tar.gz` 后换上新 unit；装过托管 CLI 的机器同时刷新 `/usr/local/bin/lecture-live`；
3. 备份当前运行产物 `backups/app-<时间戳>.tar.gz`；
4. `npm ci` → `prisma generate` → 编译 Next.js 与 WS；
5. 准备支付对账维护运行时 `/opt/lecturelive-maintenance`，再跑数据库编排 `ensure-database --require-database`；
6. 部署新产物并写入 `.runtime-security-version`，启动两个服务，最后做深度就绪检查。

编译读的是 `/opt/lecturelive/.env`（`node --env-file`，与运行时同一份配置、同一个解析器），
不是源码目录里的 `.env.local`。`NEXT_PUBLIC_APP_URL` / `NEXT_PUBLIC_WS_URL` 在编译期内联进前端
与 CSP：改了它们必须重新执行升级，只重启服务不会生效。

---

## 回滚

```bash
# 回滚到最近一次备份（web + ws 一起回滚）
sudo bash deploy/rollback.sh

# 回滚到指定版本
sudo bash deploy/rollback.sh app-20260322_143000.tar.gz

# 托管安装也可以用交互入口：列出备份供选择，然后调用同一个 deploy/rollback.sh
# （托管检出里的 deploy/ 与 backups/ 都必须只有 root 能改，见「源码检出与备份的所有权」）
sudo lecture-live rollback

# 查看所有备份
ls -lh /opt/lecturelive/backups/
```

备份自动保留最近 5 个版本：产物 `app-<时间戳>.tar.gz` 与升级前的 systemd unit
`systemd-<时间戳>.tar.gz` 各 5 份，同一时间戳成对使用。

回滚先停两个服务，再恢复产物（保留 `data/`、`.env`、`backups/`、`scripts/` 与托管源码 `src/`），
启动前跑生产支付预检，启动后做深度就绪检查；任一步失败都保持 Web/WS 停止。按备份里有没有
`health-ready-v1` 运行时标记分两种情况：

- **有标记**：沿用现役 systemd unit（带 marker / 支付预检 / readiness 启动闸），就绪检查探受保护的
  `/api/health/ready`。
- **早于该标记**（首次升级到加固版本时生成；那次升级若中途失败，这是唯一能上线的目标）：只有同一
  时间戳的 `systemd-<时间戳>.tar.gz` 存在时才允许——unit 会一并退回那一代（不含上述启动闸），
  就绪检查改探该版本自己的 `/api/health`。缺少配套的 unit 备份时直接拒绝、保持停止。这只是临时
  退路：修好问题后尽快重新执行 `upgrade.sh` 前滚，不要长期停在旧版本，也不能手工伪造标记强行启动。

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

这两个值在编译期内联进前端 bundle 与 CSP，只重启服务不会生效，必须重新编译部署：

```bash
# 托管安装
sudo lecture-live update
# 手工部署：在源码目录里
sudo bash deploy/upgrade.sh
```

---

## 部署目录结构

```
/opt/lecturelive/          # root:lecturelive，无组/其他写
├── server.js              # Next.js standalone 入口
├── .next/static/          # 前端静态资源
├── public/                # 公共资源
├── .env                   # 环境变量；root:lecturelive 0640，服务只读
├── data/                  # 应用数据（转录、摘要等）
├── backups/               # 升级时自动备份：产物 app-*.tar.gz（web + ws 一起）+ systemd-*.tar.gz；归 root
├── src/                   # 仅托管安装：lecture-live 的源码检出；归 root
└── ws-server/             # WebSocket 服务器
    ├── websocket.js       # esbuild 编译的 JS（不再需要 ts-node）
    ├── package.json       # 精简依赖（只有 socket.io/prisma/ioredis 等）
    ├── node_modules/      # 约 30MB（对比完整 node_modules 500MB+）
    ├── prisma/
    ├── data -> ../data    # 软链接
    └── .env -> ../.env    # 软链接
```

除特别标注的几处外，目录里的东西都归服务用户 `lecturelive`。

### 源码检出与备份的所有权

这几处的内容之后会以 root 执行、读取或解包：`lecture-live update` / `install` 以 root 在 `src/` 里跑
`git pull`、`npm ci`、`next build` 与 `deploy/*.sh`，`lecture-live rollback` 以 root 执行
`src/deploy/rollback.sh`，`rollback.sh` 又以 root 把 `backups/systemd-*.tar.gz` 解进
`/etc/systemd/system`；`install.sh` / `upgrade.sh` 以 root 用 `node --env-file=/opt/lecturelive/.env`
编译、迁移数据库，而 node 会应用 `.env` 里的 `NODE_OPTIONS` 等运行时选项。服务用户能改其中任何一处，
就能拿到 root。所以：

- `/opt/lecturelive` 本身归 `root:lecturelive`、无组/其他写：服务用户能进入、读取，但不能在里面改名或
  替换条目（否则能把整个 `src/` 或 `backups/` 换成自己的）；
- `.env` 归 `root:lecturelive`、`0640`：服务只读；
- `backups/` 与托管源码检出 `src/` 归 root；其余（`data/`、`ws-server/`、运行产物）照旧归 `lecturelive`。

`.env` 与 `backups/` 必须是真实的文件/目录，`backups/` 里也只能有普通文件：遇到软链、子目录或多重硬链接，
脚本会拒绝并停下，免得以 root 照着它们去读、去解包别处的文件（root 名下的软链照样能指到服务用户可写的归档）。
备份要放在别的盘上，请用 bind mount 挂到 `/opt/lecturelive/backups`。

`setup.sh`、`install.sh`、`upgrade.sh`、`rollback.sh` 每次运行都会先经过 `deploy/ensure-root-ownership.sh`：
收紧 `/opt/lecturelive` 本身，把 `.env` 换成一份归 root 的新文件（内容照搬），并核对 `backups/`——里面有
root 以外的人能改的条目就拒绝。备份只核对、不替你收回：chown 证明不了旧归档没被改过。`src/` 由托管 CLI
自己把关：以 root 执行检出里的任何东西之前，它会检查整条路径与要执行的整棵目录树（回滚查 `deploy/` 与
`backups/`），有一项不归 root、或组/其他用户可写，就报出该项并拒绝，不做任何改动；新装的检出从克隆起就归 root。
手工部署的源码在谁的家目录里都可以，直接在源码目录执行 `sudo bash deploy/upgrade.sh` / `deploy/rollback.sh`，
不受 CLI 这项检查影响。

**从旧版本升级**：此前这四个脚本会把整个 `/opt/lecturelive`（含 `src/`、`backups/` 与 `.env`）交给 `lecturelive`。
新版脚本会因此拒绝旧的 `backups/`，托管 CLI 还会拒绝旧的 `src/`（同样因为这一点，旧版 `lecture-live update`
以 root 跑 `git pull` 时，git 2.35.2 起默认就会报 `detected dubious ownership` 而失败）。确认服务用户没有被
入侵过后收回一次即可。先停掉服务、确认已没有 `lecturelive` 进程，否则它事先打开的可写文件在 chown 之后照样能写：

```bash
sudo systemctl stop lecturelive-web lecturelive-ws
sudo pkill -u lecturelive; pgrep -u lecturelive || echo "已无 lecturelive 进程"
sudo chown root:lecturelive /opt/lecturelive && sudo chmod go-w /opt/lecturelive
sudo chown -R root:root /opt/lecturelive/backups && sudo chmod -R go-w /opt/lecturelive/backups
# 托管安装（有 /opt/lecturelive/src）再加上这一行：
sudo chown -R root:root /opt/lecturelive/src && sudo chmod -R go-w /opt/lecturelive/src
sudo lecture-live update   # 手工部署则在源码目录执行 sudo bash deploy/upgrade.sh
```

`.env` 不用手动处理：新版脚本在读它之前就会把它换成一份归 root 的新文件（内容照搬）。

拿不准时不要沿用旧检出与旧备份：照上面停服务、清掉 `lecturelive` 进程并收紧 `/opt/lecturelive` 之后，把它们挪走
（`sudo mv /opt/lecturelive/src /root/lecturelive-src.old`、`sudo mv /opt/lecturelive/backups /root/lecturelive-backups.old`），
`sudo git clone https://github.com/PLus123456/lecture-live.git /opt/lecturelive/src` 重新克隆后再 `sudo lecture-live update`。
`.env` 的内容同样要人工核对一遍，尤其是 `NODE_OPTIONS`、`LD_PRELOAD` 这类会让进程加载额外代码的变量，应用本身一个都不需要。

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
