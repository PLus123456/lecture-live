import 'server-only';

/**
 * 请求体「流式累计字节」硬上限 —— 全站上传/大 JSON 路由共用。
 *
 * 背景（M29 / L58 / L59）：路由此前一律写
 *   `const n = Number(req.headers.get('content-length') ?? '');`
 *   `if (Number.isFinite(n) && n > MAX) return 413;`
 * 三个路由都栽在同一处：**头部缺失时 `Number('')` 得 0（不是 NaN）**，
 * `Number.isFinite(0)` 为真、`0 > MAX` 为假 → 预检被完整跳过。
 * 随后 `req.formData()` / `req.json()` 把整个 body 缓冲进内存，之后才轮到
 * `file.size` / `segments.length` 校验 —— 对 chunked transfer-encoding 请求
 * （不带 content-length）等于没有上限。
 *
 * 正确做法：**不信任声明长度**。真正的保证来自逐块读 `req.body` 并累计字节数，
 * 越线立刻 cancel 上游流。声明长度只当作「能省则省」的早退优化，缺失/畸形时
 * 一律回落到流式上限，绝不放行。
 *
 * 注意：这里仍会把（受限的）body 收进内存 —— multipart/JSON 解析本就需要完整
 * body。区别在于内存占用被硬钉在 maxBytes，而不是任由对端决定。
 */

export type LimitedBodyFailure = { ok: false; reason: 'too-large' | 'invalid' };

export type LimitedBodyResult<T> = { ok: true; value: T } | LimitedBodyFailure;

/**
 * 声明长度早退：仅当 content-length 存在且能解析成非负有限数时才作判断。
 * 缺失 / 畸形 / 负数一律返回 false（= 不早退），交给流式上限兜底。
 *
 * 绝不能写成 `Number.isFinite(Number(header ?? ''))` —— 那正是被绕过的写法。
 */
export function declaredLengthExceeds(req: Request, maxBytes: number): boolean {
  const raw = req.headers.get('content-length');
  if (raw === null) return false;
  const trimmed = raw.trim();
  if (!trimmed) return false;
  const declared = Number(trimmed);
  if (!Number.isFinite(declared) || declared < 0) return false;
  return declared > maxBytes;
}

/**
 * 逐块读 `req.body` 并累计字节数，超过 maxBytes 立刻 cancel 并返回 too-large。
 * 无 body（GET 等）返回空 Buffer。
 */
export async function readBodyWithLimit(
  req: Request,
  maxBytes: number
): Promise<LimitedBodyResult<Buffer>> {
  if (declaredLengthExceeds(req, maxBytes)) {
    return { ok: false, reason: 'too-large' };
  }

  const body = req.body;
  if (!body) {
    return { ok: true, value: Buffer.alloc(0) };
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // 主动断流：不再继续把对端的字节读进内存。
        //
        // 先让出一个宏任务再 cancel：undici 用 FormData/Blob 构造出来的 body 流，其
        // `pull` 是个异步生成器，读到的这一块之后往往还有一次 enqueue 在飞。此刻直接
        // cancel 会关掉 controller，那次 enqueue 随即抛
        // `Invalid state: ReadableStream is already closed` —— 落在**我们够不到的**
        // 内部 promise 上，变成进程级 unhandledRejection（真实 HTTP 请求体流没有这个
        // 问题，实测只有 undici 的内存构造流会）。让出一拍等它落地再 cancel 即可。
        await new Promise((resolve) => setTimeout(resolve, 0));
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: 'too-large' };
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } catch {
    // 传输中断 / 上游报错：当作无效 body，由调用方回 400。
    return { ok: false, reason: 'invalid' };
  }

  return { ok: true, value: Buffer.concat(chunks, total) };
}

/**
 * 带上限地解析 multipart/form-data。
 *
 * 实现上先把（受限的）字节收齐，再用原始 content-type（含 boundary）重建一个
 * Response 交给平台的 multipart 解析器 —— 与 `req.formData()` 同一套解析实现，
 * 只是入口多了一道字节闸。
 */
export async function parseFormDataWithLimit(
  req: Request,
  maxBytes: number
): Promise<LimitedBodyResult<FormData>> {
  const read = await readBodyWithLimit(req, maxBytes);
  if (!read.ok) return read;

  const contentType = req.headers.get('content-type');
  if (!contentType) {
    return { ok: false, reason: 'invalid' };
  }

  try {
    const formData = await new Response(new Uint8Array(read.value), {
      headers: { 'content-type': contentType },
    }).formData();
    return { ok: true, value: formData };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

/** 带上限地解析 JSON body。 */
export async function parseJsonWithLimit<T>(
  req: Request,
  maxBytes: number
): Promise<LimitedBodyResult<T>> {
  const read = await readBodyWithLimit(req, maxBytes);
  if (!read.ok) return read;

  try {
    return { ok: true, value: JSON.parse(read.value.toString('utf8')) as T };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

/**
 * multipart 的 `formData.get('file')` 返回 `FormDataEntryValue`：**普通字符串字段
 * 也叫 `file` 时会原样返回字符串**。历史写法 `formData.get('file') as File` 只是
 * 类型断言、运行时零校验（L60）：字符串的 `.size` 是 `undefined`，
 * `size <= 0` 与 `size > max` 双双为 false → 两道大小检查全部绕过，一路走到
 * `file.arrayBuffer()` 抛 TypeError（且不在 try 内）→ 稳定 500。
 *
 * 用鸭子类型而非 `instanceof File`：跨 realm（Next 的 web/node runtime 边界、
 * 测试里重建的 Response）拿到的 File 未必是同一个构造函数。
 */
export function isUploadedFile(value: FormDataEntryValue | null): value is File {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<File>;
  return (
    typeof candidate.size === 'number' &&
    Number.isFinite(candidate.size) &&
    typeof candidate.name === 'string' &&
    typeof candidate.arrayBuffer === 'function'
  );
}
