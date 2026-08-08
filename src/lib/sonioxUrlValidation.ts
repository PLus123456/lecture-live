// Soniox 地址校验（SSRF 防护）。
//
// 为什么单独成文件：P6-4 暴露出「同一防护只装在一条路径上」的坑 —— 管理员正规路由
// `admin/soniox/route.ts` 有校验，而公开的首次部署路由 `api/setup` 没有，攻击者据此把
// 转录流量指向自己的地址。两处各留一份副本迟早会再次分叉，所以口径收敛到这里，
// 两个调用方都 import 同一份实现。
import { validateCloudreveBaseUrl } from '@/lib/storage/cloudreve';

/**
 * 校验 Soniox REST 地址（https/http）：格式合法 + 私网过滤。
 * 复用 Cloudreve 的 validateCloudreveBaseUrl（http/https + 私网黑名单）。
 * 通过则返回去掉尾部斜杠的**原始**地址（不改写成 cloudreve 的规范化形式，
 * 管理员填什么就存什么）；非法抛 Error。
 */
export function validateSonioxRestUrl(value: string): string {
  validateCloudreveBaseUrl(value);
  return value.replace(/\/+$/, '');
}

/**
 * 校验 Soniox WebSocket 地址（wss/ws）：格式合法 + 私网过滤。
 * validateCloudreveBaseUrl 只收 http/https，故先把 ws(s) 映射成 http(s) 复用它的
 * 私网/格式校验（host/userinfo/port 原样保留），通过后仍返回原始 ws(s) 地址。
 */
export function validateSonioxWsUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('wsUrl must be a valid URL');
  }
  if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') {
    throw new Error('wsUrl must use ws or wss');
  }
  const httpEquivalent = new URL(value);
  httpEquivalent.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  validateCloudreveBaseUrl(httpEquivalent.toString());
  return value.replace(/\/+$/, '');
}
