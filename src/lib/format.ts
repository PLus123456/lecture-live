/**
 * 把「分」金额格式化成货币字符串（充值系统；金额以分为单位整数存储，避免浮点误差）。
 * 例：formatCurrencyCents(1200) → "¥12.00"；负数（出账）保留符号 "-¥5.00"。
 */
export function formatCurrencyCents(cents: number, symbol = '¥'): string {
  if (!Number.isFinite(cents)) return `${symbol}0.00`;
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  const yuan = Math.floor(abs / 100);
  const fen = abs % 100;
  return `${sign}${symbol}${yuan}.${fen.toString().padStart(2, '0')}`;
}

/** 把字节数格式化成 human-readable（B / KB / MB / GB），最多一位小数 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}
