// Isomorphic token 计数 —— 浏览器与 Node 端共用。
//
// 用 gpt-tokenizer 的 cl100k_base 编码（GPT-3.5/4 系），对国内外主流 LLM
// （Claude / GPT / DeepSeek / Kimi / GLM / 豆包 / Minimax）都是 BPE 系列，
// token 边界相近，误差通常 ±15%。本项目用 estimateTokens() 做上下文预算的
// **预估**（reactive retry 兜底处理真实超限），所以这点误差可接受。
//
// 不为不同供应商加载不同 tokenizer 的原因：
//  - 多分词器 → 包体积 ~3x、首次加载慢、维护成本高
//  - 大部分商业 LLM 不公开自家分词器，cl100k 已是事实上的代理标准

import { encode } from 'gpt-tokenizer';

// P4-2：超过此长度就不再跑真 BPE encode，改用便宜估算。
// encode() 是**同步** CPU：60K 字符 ≈ 5ms，线性外推 32MB（Next 的实际 body 上限）≈ 2.6 秒，
// 一个请求就把事件循环钉死，而且这发生在任何 LLM 调用**之前**（extract-keywords 对整份输入
// encode 一次、chunkText 再对每个句子各 encode 一次）。
// 200K 字符 ≈ 17ms，超过这个量级的文本对任何上下文预算都已经是「远超上限」，精确值毫无意义。
const EXACT_ENCODE_MAX_CHARS = 200_000;
const TRUNCATE_COARSE_CHARS_PER_TOKEN = 8;

function truncateCoarseMaxChars(maxTokens: number): number {
  return Math.max(
    EXACT_ENCODE_MAX_CHARS,
    maxTokens * TRUNCATE_COARSE_CHARS_PER_TOKEN
  );
}

/**
 * truncateToTokensFromEnd 可能返回的 UTF-8 字节数确定上界，供付费调用预预算使用。
 * JS length 按 UTF-16 code unit；单个 code unit 经 TextEncoder 最多占 3 字节，
 * 这里按 4 预留，兼顾实现/编码器差异并保持安全方向。
 */
export function truncateToTokensFromEndUtf8ByteUpperBound(
  maxTokens: number
): number {
  return truncateCoarseMaxChars(maxTokens) * 4;
}

// CJK（含中日韩统一表意文字、假名、谚文）判定：cl100k 是 UTF-8 字节级 BPE，一个汉字通常
// 编成 1-2 个 token，而英文约 4 字符/token。两类字符必须分开算，否则中文会被严重低估。
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/gu;

/**
 * P4-2：便宜估算（O(n) 扫描，无 BPE）。刻意**高估**：预算判定里高估只会多走一次截断/切块，
 * 低估则会把超限内容送进模型（真超限），故按 CJK 1.6 token/字、其余 1/3.5 字符/token 取上界。
 */
function estimateTokensFast(text: string): number {
  CJK_RE.lastIndex = 0;
  const cjkCount = (text.match(CJK_RE) ?? []).length;
  const rest = text.length - cjkCount;
  return Math.ceil(cjkCount * 1.6 + rest / 3.5);
}

/**
 * 估算字符串的 token 数。空串返回 0。
 *
 * 性能参考（M1 Mac）：60K 字符 transcript ≈ 5ms。
 * 浏览器端配合 debounce 使用，不要每个 keystroke 都跑。
 *
 * P4-2：超长输入短路成便宜估算，杜绝「一个请求同步 encode 数十 MB 把进程钉死」。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  if (text.length > EXACT_ENCODE_MAX_CHARS) {
    return estimateTokensFast(text);
  }
  return encode(text).length;
}

/**
 * 估算多段拼接后的 token 数。比逐段相加更准 —— 因为段间空白会被合并编码。
 */
export function estimateTokensJoined(parts: readonly string[], separator = '\n'): number {
  if (parts.length === 0) return 0;
  return estimateTokens(parts.join(separator));
}

/**
 * 按 token 数从文本尾部截取，保留最后 N 个 token 对应的文本。
 * 用于 L4 "transcript 只保留尾部" 场景。
 *
 * 注：encode → slice → decode 会引入 BPE 边界问题（个别字符可能畸形），
 * 但截断本身就是降级行为，可接受。
 */
export function truncateToTokensFromEnd(text: string, maxTokens: number): string {
  if (maxTokens <= 0 || !text) return '';
  // P4-2：先按「最坏 8 字符/token」粗切尾部，把 encode 的工作量钉死在 maxTokens 量级，
  // 而不是随输入长度线性增长（几十 MB 的输入会同步 encode 数秒）。粗切只多留不少留，
  // 下面的精确按比例回切照常生效。
  const coarseMaxChars = truncateCoarseMaxChars(maxTokens);
  const source =
    text.length > coarseMaxChars ? text.slice(text.length - coarseMaxChars) : text;
  const tokens = encode(source);
  if (tokens.length <= maxTokens) return source;

  // 先按 token 比例反推字符位置，从尾部取
  const ratio = maxTokens / tokens.length;
  const charStart = Math.max(0, Math.floor(source.length * (1 - ratio)));
  let result = source.slice(charStart);

  // L38①：比例反推是**近似** —— 它假设 token 密度均匀，而尾部若比全文更密
  // （CJK/拉丁混排、代码块），保留下来的尾巴 token 数会**超过** maxTokens。
  // 这个函数是各处预算裁剪的最后一道闸，超一点就可能让整段上下文越过上游窗口 → 400。
  // 这里再用真编码校正几轮收紧，保证返回值确实 ≤ maxTokens。
  // result 本就只有 ~maxTokens 量级，重编码成本与上面那次同级。
  //
  // 每轮至少多切 5%：纯按比例切在「被切掉的头部比整体更稀疏」时收敛极慢
  // （比例算出来的量总是不够），5% 下限保证有限轮内一定收敛；代价是可能略微
  // 少于 maxTokens —— 对预算裁剪来说，少一点是安全方向，多一点会直接 400。
  let resultTokens = encode(result).length;
  for (
    let guard = 0;
    guard < 16 && resultTokens > maxTokens && result.length > 0;
    guard++
  ) {
    const overshootRatio = (resultTokens - maxTokens) / resultTokens;
    const cut = Math.max(
      1,
      Math.ceil(Math.max(overshootRatio, 0.05) * result.length)
    );
    result = result.slice(cut);
    resultTokens = encode(result).length;
  }
  return result;
}

/**
 * 估算文本是否在给定 token 上限内。比 estimateTokens() 快一些 ——
 * gpt-tokenizer 的 isWithinTokenLimit() 在超过上限时会提前终止编码。
 */
export function isWithinTokens(text: string, limit: number): boolean {
  if (!text) return true;
  // P4-2：超长输入不 encode——它必然超限（便宜估算是高估，判 false 是安全方向）。
  if (text.length > EXACT_ENCODE_MAX_CHARS) {
    return estimateTokensFast(text) <= limit;
  }
  return encode(text).length <= limit;
}
