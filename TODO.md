# LectureLive 完善计划

> 按优先级排序，逐项完成。每完成一项打勾。

---

## 第一梯队：缺失的基础设施（最高优先级）

### 1. 测试体系
- [x] 核心 lib 模块单元测试（加密、JWT、权限判断等纯函数）
- [x] API 路由集成测试（认证、Session CRUD、文件上传等）
- [x] WebSocket 服务端事件测试
- [x] E2E 测试（登录流程、录音流程、分享流程）
- [x] 配置 Jest / Vitest + Testing Library
- [x] 测试覆盖率目标：核心模块 > 80%

### 2. CI/CD 流水线
- [x] GitHub Actions 配置：lint + type-check + test + build
- [x] PR 自动检查（阻止测试不过的合并）
- [ ] 自动构建 Docker 镜像并推送到 registry
- [ ] 可选：自动部署到测试环境

### 3. 错误监控
- [ ] 集成 Sentry（或同类工具）
- [ ] 前端错误自动上报（React Error Boundary + Sentry SDK）
- [ ] 后端 API 异常自动上报
- [ ] WebSocket 进程异常上报
- [ ] 配置告警规则（错误率突增时通知）

### 4. 结构化应用日志
- [x] 引入日志库（pino / winston）
- [ ] 请求日志中间件（method, path, status, duration）
- [x] LLM 调用日志（模型、token 数、耗时、是否成功）
- [x] WebSocket 连接/断开日志
- [x] 日志按级别输出，生产环境 JSON 格式方便采集

---

## 第二梯队：生产环境健壮性

### 5. 数据库迁移管理
- [ ] 从 `prisma db push` / `ensure-database.mjs` 切换到 `prisma migrate`
- [ ] 为现有 schema 生成 baseline migration
- [ ] 部署脚本中用 `prisma migrate deploy` 替代 sync
- [ ] 文档化迁移流程和回滚方法

### 6. 健康检查端点
- [x] 创建 `/api/health` 端点
- [x] 检查项：数据库连通性、Redis 连通性、Cloudreve API 可达性
- [x] 返回各组件状态和总体健康状态
- [x] Docker / 负载均衡器配置 health check

### 7. 优雅关闭（Graceful Shutdown）
- [ ] Next.js 进程监听 SIGTERM/SIGINT，停止接受新请求，等待进行中请求完成
- [x] WebSocket Server 优雅关闭：通知已连接客户端、等待录音保存完成
- [x] Docker stop 超时配置合理（给足优雅关闭时间）

### 8. 备份策略
- [ ] 数据库自动备份脚本（定时 pg_dump / sqlite backup）
- [ ] Cloudreve 文件备份方案
- [ ] 备份恢复验证流程
- [ ] 备份保留策略（保留 N 天 / N 份）

---

## 第三梯队：可扩展性与性能

### 9. WebSocket 水平扩展
- [ ] 引入 Socket.IO Redis Adapter
- [ ] 支持多实例部署时房间状态同步
- [ ] 负载均衡器 sticky session 配置

### 10. API 响应缓存
- [ ] 静态/半静态接口加 Cache-Control / ETag
- [ ] 课程列表等高频读取接口加 Redis 缓存
- [ ] 缓存失效策略（写操作后主动清除）

### 11. 数据库索引优化
- [ ] 分析慢查询，为高频查询字段添加复合索引
- [ ] Session: `userId + status` 复合索引
- [ ] AuditLog: `userId + createdAt` 复合索引
- [ ] SharedLink: `token` 唯一索引（如未有）

### 12. 文件服务优化
- [ ] 大文件下载走 Cloudreve 直链或 CDN，不经 Next.js 代理
- [ ] 录音文件分片上传支持
- [ ] 文件访问加 CDN / 对象存储加速

---

## 第四梯队：用户体验完善

### 13. PWA 支持
- [ ] 添加 `manifest.json`（名称、图标、主题色、启动方式）
- [ ] 注册 Service Worker
- [ ] 离线缓存策略（App Shell + 关键资源）
- [ ] 移动端"添加到主屏幕"体验优化

### 14. 无障碍（Accessibility）
- [ ] 关键交互元素添加 ARIA 标签
- [ ] 键盘导航支持（Tab 顺序、Enter/Escape 操作）
- [ ] 颜色对比度检查
- [ ] 屏幕阅读器测试

### 15. 通知系统
- [ ] 邮件服务集成（密码重置、账号激活）
- [ ] 课程分享通知（邮件或站内通知）
- [ ] 可选：浏览器推送通知（Web Push）

### 16. 国际化（i18n）
- [x] 提取硬编码中文字符串到语言文件
- [x] 引入 i18n 框架（next-intl / react-i18next）
- [x] 支持中英文切换
