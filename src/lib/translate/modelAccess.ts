import { getModelById } from '@/lib/llm/gateway';

/** 判定翻译模型可用性所需的用户字段（一律取自 DB 行：JWT 载荷的 role 最长陈旧 7 天） */
export interface TranslationModelAccessUser {
  role: string;
  allowedModels: string;
}

/**
 * 判定用户显式选择的翻译模型是否可用（句子翻译与文档翻译共用一套口径，别再各写一份）：
 *  ① 必须是挂了 TRANSLATION 用途的路由行（getModelById 命中同一 DB id）；
 *  ② allowedModels 门禁，与 /api/llm/models 同口径：ADMIN 或含 '*' 全放行，
 *     否则 token 需命中 DB id / 底层 modelId / 网关名三者之一；
 *  ③ 组绑定模型豁免 ②——它就是 /api/translate/models 下发的默认项（管理员决策可越过
 *     allowedModels），不豁免的话「按默认值提交」这条最常见路径恒 403（见 L21）。
 */
export async function isTranslationModelAllowed(
  user: TranslationModelAccessUser,
  requestedModelId: string,
  groupModelId: string | null
): Promise<boolean> {
  const cfg = await getModelById(requestedModelId).catch(() => null);
  if (!cfg || cfg.dbModelId !== requestedModelId || cfg.purpose !== 'TRANSLATION') {
    return false;
  }
  if (requestedModelId === groupModelId) {
    return true;
  }
  const allowedTokens = user.allowedModels
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return (
    user.role === 'ADMIN' ||
    allowedTokens.includes('*') ||
    allowedTokens.some(
      (tkn) => tkn === requestedModelId || tkn === cfg.model || tkn === cfg.name
    )
  );
}
