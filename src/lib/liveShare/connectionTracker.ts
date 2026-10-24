// src/lib/liveShare/connectionTracker.ts
// WS 进程「每 IP 并发连接数」记账（server/websocket.ts 的握手中间件使用）。
//
// 旧实现在 io.use 中间件里 +1，却只在 io.on('connection') 里挂 'disconnect' 去 -1。
// 而 socket.io 的握手顺序是：收到 CONNECT → await _createSocket → 跑中间件 →
// process.nextTick 里才检查底层连接是否还开着、再触发 'connection'。底层连接若恰好在
// 这段窗口里关掉（轮询请求体里 CONNECT 后紧跟一个 engine.io close 包、或 websocket 同一批
// 帧里跟一个坏帧，都能稳定复现），socket.io 只会静默丢弃这个 socket（"next called after
// client was closed"），'connection' 永远不触发 —— 那次 +1 就再也减不回来。攒满上限后，
// 这个出口 IP（整栋楼的 NAT / 运营商 CGNAT）被永久拒连直到 WS 重启；轮换 IPv6 地址还能
// 让计数 Map 无界增长。
//
// 修法：名额与 engine.io 底层连接的生命周期绑定，并保证「恰好释放一次」：
//   ① 占名额前先确认底层连接仍是 open —— 已关闭的连接 'close' 早就发过了，此时再挂监听
//      永远等不到，必须直接不占；
//   ② 占名额后同时挂 conn 'close' 与 socket 'disconnect'，谁先到谁释放，另一个空转。
//      'disconnect' 覆盖「命名空间级断开但底层连接仍在」，'close' 覆盖「根本没走到
//      connection 就被丢弃」。

import type { Socket } from 'socket.io';

/** ok = 已占名额；limit = 该 IP 已达上限；closed = 底层连接已断（不占名额）。 */
export type ConnectionAcquireResult = 'ok' | 'limit' | 'closed';

export interface IpConnectionTracker {
  /** 为一个握手中的 socket 占一个名额（见文件头的生命周期说明）。 */
  acquire(socket: Socket, ip: string): ConnectionAcquireResult;
  /** 某 IP 当前占用的名额数。 */
  count(ip: string): number;
  /** 当前有名额占用的 IP 数。 */
  readonly size: number;
  /** 优雅关停时清空（之后迟到的释放不会把计数减成负数）。 */
  clear(): void;
}

export function createIpConnectionTracker(maxPerIp: number): IpConnectionTracker {
  const counts = new Map<string, number>();

  const release = (ip: string) => {
    const next = (counts.get(ip) ?? 1) - 1;
    if (next <= 0) {
      counts.delete(ip);
      return;
    }
    counts.set(ip, next);
  };

  return {
    acquire(socket, ip) {
      const conn = socket.conn;
      if (!conn || conn.readyState !== 'open') {
        return 'closed';
      }

      const current = counts.get(ip) ?? 0;
      if (current >= maxPerIp) {
        return 'limit';
      }
      counts.set(ip, current + 1);

      let released = false;
      const releaseOnce = () => {
        if (released) return;
        released = true;
        conn.off('close', releaseOnce);
        socket.off('disconnect', releaseOnce);
        release(ip);
      };
      conn.once('close', releaseOnce);
      socket.once('disconnect', releaseOnce);
      return 'ok';
    },
    count(ip) {
      return counts.get(ip) ?? 0;
    },
    get size() {
      return counts.size;
    },
    clear() {
      counts.clear();
    },
  };
}
