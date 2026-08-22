import type { SessionReportData } from '@/types/report';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 客户端轮询的“报告已解决”语义：
 * - worth=false + report=null 是有效否定；
 * - worth=true 只有拿到报告对象才算完成，report=null 是可重试失败态。
 */
export function isSessionReportGenerationResolved(
  value: unknown
): value is SessionReportData {
  if (
    !isRecord(value) ||
    !isRecord(value.significance) ||
    typeof value.significance.isWorthSummarizing !== 'boolean' ||
    typeof value.generatedAt !== 'string'
  ) {
    return false;
  }
  return value.significance.isWorthSummarizing
    ? isRecord(value.report)
    : value.report === null;
}

/**
 * 后台单飞 winner 尚未落盘时，旧的 worth=true/report=null 失败对象也应显示为生成中。
 */
export function shouldShowSessionReportPending(
  value: unknown,
  pendingInBackground: boolean
): boolean {
  return pendingInBackground && !isSessionReportGenerationResolved(value);
}
