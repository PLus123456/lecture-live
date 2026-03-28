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
| Node.js | **20.6+**（需要 `--env-file` 支持） |
| MySQL | 8.x |
| Redis | 7.x |
| Nginx | 任意 |
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

这会自动安装 Node.js 20、MySQL 8、Redis、Nginx。

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

### 10. 验证

浏览器访问 `http://your-domain.com`，看到登录页面即部署成功。

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

# 手动同步 Prisma schema
cd ~/lecture-live
npx prisma db push
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

| 端口 | 服务 | 说明 |
|------|------|------|
| 3000 | Next.js | Web 应用，仅监听 127.0.0.1 |
| 3001 | Socket.IO | WebSocket 实时通信，仅监听 127.0.0.1 |
| 80/443 | Nginx | 对外反代 |

所有应用端口只监听 localhost，由 Nginx 统一对外暴露。

---

## 架构说明

### 为什么 WS 服务器用 esbuild 编译？

原方案用 `ts-node` 直接在生产环境运行 TypeScript，但项目的 `tsconfig.json` 使用 `moduleResolution: "bundler"`（Next.js 需要），ts-node 不支持这个模式会直接报错。

现在用 `esbuild` 把 `server/websocket.ts` 及其所有本地依赖打包成一个 20KB 的 `websocket.js`，外部 npm 包（socket.io、prisma 等）通过 `--packages=external` 保留为 require，由 `ws-server/node_modules` 提供。

好处：
- **不需要 ts-node / TypeScript**，生产环境只跑原生 JS
- **WS 服务器的 node_modules 从 ~500MB 降到 ~30MB**（不装 Next.js/React）
- **启动更快**，没有 TypeScript 编译开销
