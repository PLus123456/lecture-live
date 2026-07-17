import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getRechargeSettings } from '@/lib/payment/settings';
import { formatCurrencyCents } from '@/lib/format';

/**
 * 沙箱支付确认页（仅当 sandbox 渠道启用时可用）。展示订单金额，
 * 提供「确认支付 / 取消」两个链接，指向沙箱回调路由完成到账/取消。开发/测试用。
 */
export async function GET(req: Request) {
  const settings = await getRechargeSettings();
  if (!settings.sandboxEnabled) {
    return new NextResponse('Sandbox channel disabled', { status: 404 });
  }

  const outTradeNo = new URL(req.url).searchParams.get('out_trade_no') ?? '';
  const order = outTradeNo
    ? await prisma.paymentOrder.findUnique({ where: { outTradeNo } })
    : null;
  if (!order) return new NextResponse('Order not found', { status: 404 });

  const esc = (s: string) => s.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const no = esc(order.outTradeNo);
  const amount = esc(formatCurrencyCents(order.amountCents, settings.currencySymbol));
  const paid = order.status === 'paid';
  const payHref = `/api/wallet/callback/sandbox?out_trade_no=${encodeURIComponent(order.outTradeNo)}&action=pay`;
  const cancelHref = `/api/wallet/callback/sandbox?out_trade_no=${encodeURIComponent(order.outTradeNo)}&action=cancel`;

  const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sandbox Pay</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;background:#f7f3ec;color:#2b2b2b;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
  .card{background:#fff;border:1px solid #e7ddcb;border-radius:16px;padding:32px;max-width:360px;width:90%;box-shadow:0 8px 24px rgba(0,0,0,.06);text-align:center}
  .tag{display:inline-block;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#b45f3c;background:#fbeee7;border-radius:999px;padding:4px 12px;margin-bottom:16px}
  .amt{font-size:34px;font-weight:700;margin:8px 0}
  .no{font-family:ui-monospace,monospace;font-size:12px;color:#9a9186;margin-bottom:24px;word-break:break-all}
  a.btn{display:block;padding:12px;border-radius:10px;text-decoration:none;font-weight:600;margin-top:10px}
  a.pay{background:#c56a44;color:#fff}
  a.cancel{background:#efe8dc;color:#6b6357}
  .done{color:#3a8a4f;font-weight:600}
</style></head>
<body><div class="card">
  <div class="tag">Sandbox 模拟支付</div>
  <div class="amt">${amount}</div>
  <div class="no">${no}</div>
  ${
    paid
      ? '<p class="done">该订单已支付</p><a class="btn cancel" href="/home">返回</a>'
      : `<a class="btn pay" href="${payHref}">确认支付</a><a class="btn cancel" href="${cancelHref}">取消</a>`
  }
</div></body></html>`;

  return new NextResponse(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
