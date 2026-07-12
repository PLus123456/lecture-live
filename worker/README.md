# LectureLive 音频增强 Worker

部署在独立机器上的录音后处理服务：把课堂录音做**响度标准化（EBU R128 loudnorm，默认 -14 LUFS / -1.0 dBTP）+ 深度降噪（DeepFilterNet，兜底 ffmpeg afftdn）**，解决"麦克风离老师远、回放几乎听不清"的问题。

主服务器全程主动（推音频 → 启动 → 轮询 → 取结果 → 清理），worker 完全被动，**不需要访问主服务器**，也不共享数据库。适合部署在甲骨文免费 ARM 机（2C12G 足够）。

```
LectureLive 主服务器  ── HTTPS ──▶  nginx (443, TLS)  ──▶  worker (127.0.0.1:8790)
   │ PUT  /jobs/{id}/input   （推原始音频）
   │ POST /jobs/{id}/start   （带参数入队）
   │ GET  /jobs/{id}         （轮询状态/进度）
   │ GET  /jobs/{id}/output  （取回增强后音频）
   └ DELETE /jobs/{id}       （清理）
```

## 依赖

- **Node.js ≥ 20**（worker 是零 npm 依赖单文件，无需 `npm install`）
- **ffmpeg / ffprobe**（`apt install ffmpeg`）
- **deep-filter**（可选但强烈推荐；没有它会自动兜底 ffmpeg `afftdn`，降噪效果弱不少）

### 安装 deep-filter（DeepFilterNet，aarch64）

二选一：

```bash
# 方式 A：官方预编译二进制（去 https://github.com/Rikorose/DeepFilterNet/releases
# 找 deep-filter-*-aarch64-unknown-linux-gnu；版本号以 release 页为准）
wget https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/deep-filter-0.5.6-aarch64-unknown-linux-gnu
chmod +x deep-filter-0.5.6-aarch64-unknown-linux-gnu
sudo mv deep-filter-0.5.6-aarch64-unknown-linux-gnu /usr/local/bin/deep-filter

# 方式 B：cargo 编译（机器上需要 rust 工具链，ARM 上编译约 10-20 分钟）
cargo install deep_filter --locked
sudo ln -s ~/.cargo/bin/deep-filter /usr/local/bin/deep-filter
```

验证：`deep-filter --help` 能输出即可（模型权重内嵌在二进制里，无需额外下载）。

## 部署步骤

```bash
# 1. 建目录与用户
sudo useradd --system --home /opt/lecturelive-worker --shell /usr/sbin/nologin llworker
sudo mkdir -p /opt/lecturelive-worker/data
sudo cp audio-enhance-worker.mjs /opt/lecturelive-worker/
sudo chown -R llworker:llworker /opt/lecturelive-worker

# 2. 生成通信 token（≥32 字符，主服务器管理后台里要填同一个值）
openssl rand -hex 32

# 3. 配置 systemd（编辑其中的 AUDIO_WORKER_TOKEN）
sudo cp lecturelive-enhance-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lecturelive-enhance-worker

# 4. 验证
curl -s http://127.0.0.1:8790/healthz          # → {"ok":true}
curl -s -H "Authorization: Bearer <token>" http://127.0.0.1:8790/healthz
# → {"ok":true,"version":...,"engines":{"ffmpeg":true,"deepFilter":true},...}
```

然后配 nginx TLS 反代（见下），在 LectureLive 管理后台 → 系统设置 → 录音音频增强里填 `https://你的域名` 和 token，点"测试连接"。

## nginx 反代示例

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name enhance.example.com;

    ssl_certificate     /etc/letsencrypt/live/enhance.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/enhance.example.com/privkey.pem;

    # 课堂录音可能上 GB，务必放大 body 上限、关掉缓冲、放宽超时
    client_max_body_size 2048m;

    location / {
        proxy_pass http://127.0.0.1:8790;
        proxy_http_version 1.1;
        proxy_request_buffering off;   # 上传流式直通，不在 nginx 落盘
        proxy_buffering off;           # 下载结果流式直通
        proxy_read_timeout  1800s;
        proxy_send_timeout  1800s;
        proxy_set_header Host $host;
    }
}
```

## 环境变量

| 变量 | 默认 | 说明 |
| :-- | :-- | :-- |
| `AUDIO_WORKER_TOKEN` | （必填） | Bearer 鉴权 token，≥32 字符，与主服务器一致 |
| `AUDIO_WORKER_PORT` | `8790` | 监听端口 |
| `AUDIO_WORKER_HOST` | `127.0.0.1` | 监听地址（走 nginx 反代就保持回环） |
| `AUDIO_WORKER_DATA_DIR` | `./data` | 任务暂存目录 |
| `AUDIO_WORKER_CONCURRENCY` | `1` | 并行处理任务数（2C 机器保持 1） |
| `AUDIO_WORKER_QUEUE_LIMIT` | `8` | 排队上限，满了对 start 回 429 |
| `AUDIO_WORKER_MAX_INPUT_BYTES` | `2147483648` | 单文件输入上限（2GB） |
| `AUDIO_WORKER_RETENTION_HOURS` | `24` | 任务产物保留时长，到期自动清 |
| `AUDIO_WORKER_JOB_TIMEOUT_MINUTES` | `150` | 单步处理超时 |
| `FFMPEG_BIN` / `FFPROBE_BIN` | `ffmpeg` / `ffprobe` | 可执行文件路径 |
| `DEEP_FILTER_BIN` | （PATH 查找） | deep-filter 路径；不配则找 `deep-filter`/`deepFilter` |

## 处理管线与耗时预期

`输入 → 48kHz 单声道 WAV → loudnorm 双遍（-14 LUFS）→ deep-filter（--atten-lim-db 30）→ AAC 96k (m4a, faststart)`

任何一步降噪失败都会逐级兜底（deep-filter → afftdn → 仅标准化），**绝不因降噪失败而丢任务**。

2C ARM（Neoverse-N1）参考耗时：2 小时课堂录音全管线约 15–40 分钟，其中 deep-filter 占大头。12G 内存远超需求（deep-filter 常驻 <1G）。

## 安全说明

- token 用常量时间比较；worker 监听回环地址，公网只暴露 nginx 443。
- jobId 只允许 `[A-Za-z0-9_-]{1,64}`，任务目录不可能穿越到数据目录之外。
- worker 重启后运行中/排队中的任务自动标记失败，主服务器会重新派发（jobId 不变、幂等续接），无需人工干预。
