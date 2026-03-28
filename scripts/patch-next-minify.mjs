/**
 * 修复 Next.js 15.5.14 的 MinifyPlugin 中 WebpackError 引用 bug。
 * _webpack.WebpackError 为 undefined，正确路径是 _webpack.webpack.WebpackError。
 * 在 postinstall 阶段自动应用。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const target = resolve(
  __dirname,
  '../node_modules/next/dist/build/webpack/plugins/minify-webpack-plugin/src/index.js',
);

const original = readFileSync(target, 'utf8');

// 已经修复过则跳过
if (original.includes('_getWebpackError')) {
  console.log('[patch-next-minify] 已应用，跳过。');
  process.exit(0);
}

const patched = original.replace(
  'function buildError(error, file) {\n' +
    '    if (error.line) {\n' +
    '        return new _webpack.WebpackError(',
  'function _getWebpackError() {\n' +
    '    return _webpack.WebpackError || (_webpack.webpack && _webpack.webpack.WebpackError) || Error;\n' +
    '}\n' +
    'function buildError(error, file) {\n' +
    '    const WebpackError = _getWebpackError();\n' +
    '    if (error.line) {\n' +
    '        return new WebpackError(',
).replace(
  /return new _webpack\.WebpackError\(/g,
  'return new (_getWebpackError())(',
);

if (patched === original) {
  console.warn('[patch-next-minify] 未匹配到目标代码，可能版本已变更。');
  process.exit(0);
}

writeFileSync(target, patched, 'utf8');
console.log('[patch-next-minify] 已修复 WebpackError 引用。');
