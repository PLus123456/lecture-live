const path = require('path');

const isProduction = process.env.NODE_ENV === 'production';

function addOriginVariants(set, value) {
  if (!value) {
    return;
  }

  try {
    const url = new URL(value);
    const host = url.host;

    if (url.protocol === 'http:' || url.protocol === 'ws:') {
      set.add(`http://${host}`);
      set.add(`ws://${host}`);
      return;
    }

    if (url.protocol === 'https:' || url.protocol === 'wss:') {
      set.add(`https://${host}`);
      set.add(`wss://${host}`);
    }
  } catch {
    // Ignore invalid environment values and fall back to static origins below.
  }
}

function buildContentSecurityPolicy() {
  const connectSrc = new Set([
    "'self'",
    'http://localhost:3001',
    'ws://localhost:3001',
    'https://api.soniox.com',
    'https://api.eu.soniox.com',
    'https://api.jp.soniox.com',
    'wss://stt-rt.soniox.com',
    'wss://stt-rt.eu.soniox.com',
    'wss://stt-rt.jp.soniox.com',
  ]);

  addOriginVariants(connectSrc, process.env.NEXT_PUBLIC_APP_URL);
  addOriginVariants(connectSrc, process.env.NEXT_PUBLIC_WS_URL);

  // Y15/L9 未完成的一半：script-src 仍带 'unsafe-inline'，没有 nonce。
  // 上 nonce 必须由 middleware 逐请求签发（Next 只认 middleware 设的 CSP 里的 nonce），
  // 而当前 middleware 的 matcher 只覆盖 /api/* 与 /session/*/view —— 要给 HTML 文档发
  // nonce 就得把 middleware 扩到全站页面路由，那是另一档风险（每个页面请求都过一遍
  // middleware，且 hasTraversalAttempt 会对页面路径返回 JSON 400）。故此处保持现状，
  // 留作独立改动。
  const scriptSrc = ["'self'", "'unsafe-inline'"];
  if (!isProduction) {
    scriptSrc.push("'unsafe-eval'");
  }

  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    `script-src ${scriptSrc.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://flagcdn.com",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    `connect-src ${Array.from(connectSrc).join(' ')}`,
    "form-action 'self'",
    "frame-src 'none'",
    "manifest-src 'self'",
  ];

  if (isProduction) {
    directives.push('upgrade-insecure-requests');
  }

  return directives.join('; ');
}

const securityHeaders = [
  {
    // Y15/L9：显式声明本站真正用到的强权限，并把其余的关死。
    // - microphone / display-capture：录音与系统音频采集（audioCapture.ts 的
    //   getUserMedia / getDisplayMedia）确实需要，所以是 (self) 而不是 ()。
    //   ⚠️ 原始工单写的是 `display-capture=()`——那会直接打死「系统音频」录制源，不能照抄。
    // - 不写等于沿用浏览器默认（同样是 self），写出来的收益是：跨源 iframe 一律拿不到，
    //   而且以后谁想开新权限得先改这一行。
    key: 'Permissions-Policy',
    value: [
      'picture-in-picture=(self)',
      'microphone=(self)',
      'display-capture=(self)',
      'camera=()',
      'geolocation=()',
      'payment=()',
      'usb=()',
      'serial=()',
      'midi=()',
      'interest-cohort=()',
    ].join(', '),
  },
  {
    key: 'Content-Security-Policy',
    value: buildContentSecurityPolicy(),
  },
  ...(isProduction
    ? [
        {
          key: 'Strict-Transport-Security',
          value: 'max-age=31536000; includeSubDomains; preload',
        },
      ]
    : []),
];

/**
 * pdfjs 的运行时资源清单（worker / CMap / 内置字体 / wasm 解码器 / 色彩配置）。
 * 两份 pdfjs-dist 都要带：pdf-parse 内嵌一份，officeparser 依赖顶层一份，二者都走 legacy/build。
 */
const PDFJS_RUNTIME_ASSETS = [
  'pdf-parse/node_modules/pdfjs-dist',
  'pdfjs-dist',
].flatMap((pkg) =>
  ['legacy/build', 'cmaps', 'standard_fonts', 'wasm', 'iccs'].map(
    (dir) => `./node_modules/${pkg}/${dir}/**`
  )
).concat(
  // pdfjs 在 Node 下靠 @napi-rs/canvas 补 DOMMatrix / ImageData / Path2D。这不是「渲染才用」的
  // 可选件：pdf.mjs 顶层就有 `const SCALE_MATRIX = new DOMMatrix()`，补不上就在**模块求值阶段**
  // 抛 ReferenceError；而路由里 `await import('pdf-parse')` 在 getInfo 的 try 之外，于是整条上传
  // 变成不可读的 500（生产实测："Cannot load @napi-rs/canvas" → "Cannot polyfill DOMMatrix" →
  // "ReferenceError: DOMMatrix is not defined"）。
  // 追不到的原因与上面 worker/cmaps 同类：pdf.mjs 走 createRequire() 动态 require，且真正的二进制
  // 在平台专属包里（canvas-linux-x64-gnu / canvas-darwin-arm64 …），nft 静态分析不稳。
  // canvas-* 只用一层通配（不是前缀 **），命中的就是当前平台 npm 实际装下的那一个；
  // 两处都写：pdf-parse 内嵌一份，officeparser 依赖的顶层 pdfjs-dist 一份（缺哪份就 glob 空匹配）。
  [
    'pdf-parse/node_modules/@napi-rs',
    '@napi-rs',
  ].flatMap((scope) => [
    `./node_modules/${scope}/canvas/**`,
    `./node_modules/${scope}/canvas-*/**`,
  ])
);

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.resolve(__dirname),
  // 经过 middleware 的请求 body 会被 Next.js 克隆，默认上限 10MB，超出部分被静默截断。
  // 文件转录分片上传单片 20MB（asyncUploadClient.ts CHUNK_SIZE），截断后服务端
  // req.formData() 解析 multipart 失败并报 400 "Invalid multipart body"。
  experimental: {
    middlewareClientMaxBodySize: '32mb',
  },
  // 显式允许 picture-in-picture（Document PiP API 需要）
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: securityHeaders,
      },
    ];
  },
  // Prevent server-side bundling of browser-only ML packages
  // pdf-parse 内嵌 pdfjs-dist + @napi-rs/canvas（原生模块）：被 webpack 打进 server bundle
  // 会在 import 时抛 "Object.defineProperty called on non-object"，必须交给 node 原生 require。
  serverExternalPackages: ['@huggingface/transformers', 'onnxruntime-web', 'pdf-parse'],
  // pdfjs 的 worker / CMap / 字体是运行时按路径加载的，nft 静态追踪不到，standalone 产物里会缺
  // （install.sh 与 Dockerfile 都只拷 .next/standalone，缺了就在生产抛
  // "Setting up fake worker failed: Cannot find module …/pdf.worker.mjs"）。
  // 两份 pdfjs-dist 都要带：pdf-parse 内嵌一份，officeparser 依赖顶层一份，二者都走 legacy/build。
  // cmaps 是中文 PDF 的预定义编码表，缺了 CJK 文本会解析成乱码。
  // 路径写死到两份 pdfjs-dist（package-lock 锁定的安装结构）：前缀带 ** 的 glob 会让 nft
  // 对每条路由整树遍历 node_modules，直接把 build 打成 V8 OOM。
  outputFileTracingIncludes: {
    '/api/translate/documents': PDFJS_RUNTIME_ASSETS,
    '/api/chat-uploads': PDFJS_RUNTIME_ASSETS,
    '/api/llm/extract-keywords': PDFJS_RUNTIME_ASSETS,
  },
  webpack: (config, { dev, isServer }) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      // Prevent Node.js-only packages from being bundled on server
      'sharp$': false,
      'onnxruntime-node$': false,
    };

    // Skip parsing the already-bundled @huggingface/transformers dist
    // (it's a pre-compiled webpack bundle + has 21MB WASM files)
    config.module.noParse = [
      ...(Array.isArray(config.module.noParse)
        ? config.module.noParse
        : config.module.noParse
        ? [config.module.noParse]
        : []),
      /node_modules\/@huggingface\/transformers/,
      /node_modules\/onnxruntime-web/,
    ];

    if (!dev && !isServer) {
      // Transformers.js 的预编译 bundle 包含 ESM 语法被包裹在 CJS wrapper 中，
      // 导致 SWC 压缩器无法解析。通过自定义插件遍历 chunk 的模块列表，
      // 将包含这些模块的 asset 标记为 minimized，使 MinifyPlugin 跳过。
      const mlPattern = /[\\/]node_modules[\\/](@huggingface[\\/]transformers|onnxruntime-web)[\\/]/;
      config.plugins.push({
        apply(compiler) {
          compiler.hooks.compilation.tap('SkipMLMinify', (compilation) => {
            compilation.hooks.processAssets.tap(
              // PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE = 100，在其之前执行
              { name: 'SkipMLMinify', stage: 99 },
              () => {
                // 收集包含 ML 模块的 chunk 对应的所有文件名
                const filesToSkip = new Set();
                for (const chunk of compilation.chunks) {
                  const modules = compilation.chunkGraph.getChunkModules(chunk);
                  const hasML = modules.some((m) => {
                    const resource = m.resource || (m.rootModule && m.rootModule.resource);
                    return resource && mlPattern.test(resource);
                  });
                  if (hasML) {
                    for (const file of chunk.files) {
                      filesToSkip.add(file);
                    }
                  }
                }
                for (const file of filesToSkip) {
                  compilation.updateAsset(file, (x) => x, { minimized: true });
                }
              }
            );
          });
        },
      });
    }

    return config;
  },
};

module.exports = nextConfig;
