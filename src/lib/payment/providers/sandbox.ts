import type {
  PaymentProvider,
  CreateChargeParams,
  CreateChargeResult,
  CallbackResult,
} from '@/lib/payment/types';

/**
 * 沙箱支付渠道（开发 / e2e）。无真实网关、无验签：
 *  - createCharge 返回一个指向本站沙箱确认页 `/api/wallet/sandbox/pay` 的 payUrl；
 *  - 用户在确认页点「确认支付」→ GET 回调路由 `/api/wallet/callback/sandbox?out_trade_no=...&action=pay`；
 *  - verifyCallback 直接据 query/body 的 out_trade_no + action 判定（action='cancel' 视为未支付）。
 *
 * 让「充值→下单→回调→到账→买时间→配额增加」整条链路在本地/测试环境可完整跑通，
 * 而无须任何真实商户密钥。生产环境应关闭沙箱渠道（recharge_sandbox_enabled=false）。
 */
export class SandboxProvider implements PaymentProvider {
  readonly name = 'sandbox' as const;

  async createCharge(params: CreateChargeParams): Promise<CreateChargeResult> {
    // 从 notifyUrl 推导本站 origin，拼出沙箱确认页地址。
    const origin = new URL(params.notifyUrl).origin;
    const payUrl = `${origin}/api/wallet/sandbox/pay?out_trade_no=${encodeURIComponent(
      params.outTradeNo
    )}`;
    return { payUrl, providerRef: `sandbox_${params.outTradeNo}` };
  }

  async verifyCallback(req: Request, rawBody: string): Promise<CallbackResult | null> {
    const url = new URL(req.url);
    const bodyParams = new URLSearchParams(rawBody || '');
    const outTradeNo =
      url.searchParams.get('out_trade_no') ?? bodyParams.get('out_trade_no') ?? '';
    if (!outTradeNo) return null;
    const action =
      url.searchParams.get('action') ?? bodyParams.get('action') ?? 'pay';
    return {
      outTradeNo,
      paid: action !== 'cancel',
      providerRef: `sandbox_${outTradeNo}`,
      rawStatus: action,
    };
  }
}
