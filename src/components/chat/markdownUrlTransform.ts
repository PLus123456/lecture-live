import { defaultUrlTransform } from 'react-markdown';

/**
 * 聊天消息 Markdown 的 URL 变换（M4）。
 *
 * react-markdown 10 默认的 defaultUrlTransform 会把 data: URL 清成空串，导致刚发送的
 * base64 图片（乐观消息里的 `![image](data:image/...)`）渲染成 `<img src="">`、直接消失，
 * 刷成服务端相对 URL 后才恢复。这里放行 `data:image/` 让本地缩略图立即可见；其余 URL 仍走
 * react-markdown 默认净化（同时链接 href 另有 safeHref 二次过滤，链接安全不受影响）。
 */
export function chatUrlTransform(url: string): string {
  return url.startsWith('data:image/') ? url : defaultUrlTransform(url);
}
