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
    key: 'Permissions-Policy',
    value: 'picture-in-picture=(self), camera=(), geolocation=(), payment=()',
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

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.resolve(__dirname),
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
  serverExternalPackages: ['@huggingface/transformers', 'onnxruntime-web'],
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
