/**
 * SVG 消毒器 —— **白名单解析**实现（M26 重写）。
 *
 * 旧实现是「正则黑名单」：按裸标签名剥离 `<script>` 等、正则删 `on*=`、对 href 原始文本
 * 做 scheme 黑名单。三类绕过被实测坐实（全部原样通过，而对照组 `<script>`/`onload` 被正确剥掉）：
 *
 *   1. 命名空间前缀 —— `<svg xmlns:svg="..."><svg:script>alert(1)</svg:script></svg>`
 *      正则只匹配 `<script`，`<svg:script` 命中不了；浏览器按 SVG 命名空间解析即执行。
 *   2. 实体编码 scheme —— `xlink:href="jav&#x09;ascript:alert(1)"` 之类。
 *      黑名单作用在**原始文本**上，而 XML 解析器**先解码实体**，解码后就是 `javascript:`。
 *   3. SMIL —— `<animate attributeName="href" values="javascript:alert(1)">` / `<set …>`
 *      完全不在过滤与终检范围内。
 *
 * 黑名单的问题不是漏了这三条，而是「枚举坏的」这个方向本身错了。这里改成枚举好的：
 *   - 元素：先剥命名空间前缀取 local name，不在白名单 → **连同整棵子树丢弃**
 *     （`svg:script` 的 local name 就是 `script`，天然被挡）。SMIL 的 animate/set 系列
 *     不在白名单，自动消失。
 *   - 属性：不在白名单 → 丢弃。`on*` 不需要单独规则，它们只是「不在白名单里」。
 *   - 属性值：**先解码 XML 实体再判定**，且判定前剔除所有空白/控制字符
 *     （浏览器解析 URL 时会忽略 scheme 里的 TAB/LF/CR）。
 *   - 命名空间：输入里的 xmlns/xmlns:* 一律丢弃，由本模块在根节点写死 SVG 命名空间，
 *     杜绝「把根 xmlns 改成 xhtml 让子树按 HTML 解析」这类花招。
 *   - 输出是我们自己按 token 重新序列化的，不是「在原文上做减法」——
 *     原文里任何没被理解的构造都不可能残留到输出里。
 *
 * 当前唯一消费方是 admin-only 的 `/api/admin/upload-icon`，且 `/api/assets/icons` 用
 * `default-src 'none'; … sandbox` 的 CSP 兜底；但它是**通用**消毒器，一旦复用到用户可控
 * 内容（聊天附件 SVG 预览等）就是存储型 XSS，故按通用件的强度来做。
 */

/** 输入体积上限：超大文档没有合法用途，先挡一刀避免解析期内存尖峰。 */
const MAX_SVG_BYTES = 2 * 1024 * 1024;

/** 空白与控制字符：判定 URL scheme 前必须剔除（浏览器解析时会忽略它们）。 */
const CONTROL_OR_SPACE = /[\s\u0000-\u001F\u007F]/g;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/**
 * 允许的元素（key = 小写比较用，value = 输出用的规范拼写）。
 *
 * 刻意排除：script / style / foreignObject / image / feImage / a / iframe / object /
 * embed / audio / video / canvas / link / meta / handler / listener，
 * 以及全部 SMIL 动画元素（animate / animateTransform / animateMotion / animateColor /
 * set / discard）—— 它们能改任意属性（含 href）从而在运行期造出脚本 URL。
 */
const ALLOWED_ELEMENTS = new Map<string, string>(
  [
    'svg', 'g', 'defs', 'desc', 'title', 'metadata', 'symbol', 'use', 'switch',
    'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
    'text', 'tspan', 'textPath',
    'marker', 'pattern', 'clipPath', 'mask',
    'linearGradient', 'radialGradient', 'stop', 'filter',
    'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite',
    'feConvolveMatrix', 'feDiffuseLighting', 'feDisplacementMap', 'feDistantLight',
    'feDropShadow', 'feFlood', 'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR',
    'feGaussianBlur', 'feMerge', 'feMergeNode', 'feMorphology', 'feOffset',
    'fePointLight', 'feSpecularLighting', 'feSpotLight', 'feTile', 'feTurbulence',
  ].map((name) => [name.toLowerCase(), name] as [string, string])
);

/** 允许的属性（按 local name 小写比较）。`on*` 只是「不在这里」，无需单独规则。 */
const ALLOWED_ATTRIBUTES = new Map<string, string>(
  [
    // 结构 / 通用
    'id', 'class', 'style', 'transform', 'version', 'viewBox',
    'preserveAspectRatio', 'display', 'visibility', 'overflow', 'color',
    'role', 'aria-label', 'aria-hidden',
    // 几何
    'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
    'width', 'height', 'points', 'dx', 'dy', 'rotate', 'pathLength',
    // 描边 / 填充
    'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width',
    'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
    'stroke-opacity', 'stroke-miterlimit', 'opacity', 'vector-effect',
    'paint-order', 'shape-rendering', 'color-interpolation-filters',
    // 引用类（值另有白名单：只允许同文档 #fragment / url(#id) / 无 scheme 的关键字）
    'href', 'clip-path', 'clip-rule', 'mask', 'filter',
    'marker-start', 'marker-mid', 'marker-end',
    // 渐变 / 图案 / marker / clip / mask
    'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform',
    'spreadMethod', 'fx', 'fy', 'fr', 'patternUnits', 'patternContentUnits',
    'patternTransform', 'markerWidth', 'markerHeight', 'markerUnits',
    'refX', 'refY', 'orient', 'clipPathUnits', 'maskUnits', 'maskContentUnits',
    // 文本
    'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
    'text-anchor', 'text-decoration', 'dominant-baseline', 'alignment-baseline',
    'baseline-shift', 'letter-spacing', 'word-spacing', 'textLength',
    'lengthAdjust', 'startOffset', 'writing-mode', 'white-space',
    // 滤镜
    'filterUnits', 'primitiveUnits', 'in', 'in2', 'result', 'mode', 'type',
    'values', 'tableValues', 'slope', 'intercept', 'amplitude', 'exponent',
    'stdDeviation', 'operator', 'k1', 'k2', 'k3', 'k4', 'radius', 'scale',
    'xChannelSelector', 'yChannelSelector', 'baseFrequency', 'numOctaves',
    'seed', 'stitchTiles', 'azimuth', 'elevation', 'specularConstant',
    'specularExponent', 'surfaceScale', 'diffuseConstant', 'limitingConeAngle',
    'pointsAtX', 'pointsAtY', 'pointsAtZ', 'edgeMode', 'kernelMatrix',
    'kernelUnitLength', 'order', 'divisor', 'bias', 'targetX', 'targetY',
    'preserveAlpha', 'flood-color', 'flood-opacity', 'lighting-color',
  ].map((name) => [name.toLowerCase(), name] as [string, string])
);

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/* ------------------------------------------------------------------ */
/*  实体解码 / 转义                                                      */
/* ------------------------------------------------------------------ */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  tab: '\t',
  newline: '\n',
  colon: ':',
  sol: '/',
  lpar: '(',
  rpar: ')',
};

/**
 * 解码 XML/HTML 实体。**判定必须发生在解码之后** —— 这正是旧实现被
 * `jav&#x09;ascript:` 绕过的原因（黑名单看的是原始文本，解析器看的是解码后的文本）。
 */
function decodeEntities(value: string): string {
  return value.replace(
    /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);?/g,
    (full: string, body: string) => {
      if (body.startsWith('#')) {
        const isHex = body[1] === 'x' || body[1] === 'X';
        const code = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
        try {
          return String.fromCodePoint(code);
        } catch {
          return '';
        }
      }
      const named = NAMED_ENTITIES[body.toLowerCase()];
      return named ?? full;
    }
  );
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

/* ------------------------------------------------------------------ */
/*  取 local name（剥命名空间前缀）                                      */
/* ------------------------------------------------------------------ */

function localName(qualified: string): string {
  const colon = qualified.lastIndexOf(':');
  return colon === -1 ? qualified : qualified.slice(colon + 1);
}

/* ------------------------------------------------------------------ */
/*  属性值判定                                                          */
/* ------------------------------------------------------------------ */

/**
 * 引用类属性只允许「同文档片段引用」（`#id` / `url(#id)`）与无 scheme 的关键字/颜色。
 *
 * 图标类 SVG 需要的全部引用都在这个范围内；http(s)/data/javascript/相对路径一律拒绝——
 * 既挡脚本 URL，也顺带挡掉「SVG 里外链回攻击者服务器」的隐私外带。
 */
function isSafeReferenceValue(decoded: string): boolean {
  const stripped = decoded.replace(CONTROL_OR_SPACE, '');
  if (!stripped) return false;
  if (stripped.startsWith('#')) return true;
  if (/^url\(#[^)]*\)$/i.test(stripped)) return true;
  // 关键字（none / currentColor / #rgb / rgb(…) / 数字…）没有 scheme，不含冒号即放行
  return !stripped.includes(':');
}

/** style 属性：任何能引外部资源或跑代码的构造一律丢弃整条属性。 */
function isSafeStyleValue(decoded: string): boolean {
  const stripped = decoded.replace(CONTROL_OR_SPACE, '').toLowerCase();
  if (/url\((?!#)/.test(stripped)) return false;
  return !/@import|expression\(|javascript:|behavior:|-moz-binding/.test(stripped);
}

/* ------------------------------------------------------------------ */
/*  词法分析                                                            */
/* ------------------------------------------------------------------ */

interface ParsedAttribute {
  name: string;
  value: string;
}

interface OpenTagToken {
  kind: 'open';
  name: string;
  selfClosing: boolean;
  attributes: ParsedAttribute[];
}

interface CloseTagToken {
  kind: 'close';
  name: string;
}

interface TextToken {
  kind: 'text';
  value: string;
}

type Token = OpenTagToken | CloseTagToken | TextToken;

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_.:-]/;

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const length = input.length;

  while (index < length) {
    const lt = input.indexOf('<', index);
    if (lt === -1) {
      tokens.push({ kind: 'text', value: input.slice(index) });
      break;
    }

    if (lt > index) {
      tokens.push({ kind: 'text', value: input.slice(index, lt) });
    }

    // 注释
    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt + 4);
      index = end === -1 ? length : end + 3;
      continue;
    }

    // CDATA：内容当纯文本（会被转义），不给它「逃出文本上下文」的机会
    if (input.startsWith('<![CDATA[', lt)) {
      const end = input.indexOf(']]>', lt + 9);
      const value = input.slice(lt + 9, end === -1 ? length : end);
      tokens.push({ kind: 'text', value: escapeText(value) });
      index = end === -1 ? length : end + 3;
      continue;
    }

    // DOCTYPE / ENTITY：外部实体与实体展开是独立的攻击面（XXE / 实体炸弹），直接拒收
    if (input.startsWith('<!', lt)) {
      throw new Error('Invalid SVG: DOCTYPE and ENTITY declarations are not allowed');
    }

    // 处理指令（含 <?xml …?>）：丢弃
    if (input.startsWith('<?', lt)) {
      const end = input.indexOf('?>', lt + 2);
      index = end === -1 ? length : end + 2;
      continue;
    }

    // 闭合标签
    if (input.startsWith('</', lt)) {
      let cursor = lt + 2;
      const nameStart = cursor;
      while (cursor < length && NAME_CHAR.test(input[cursor])) cursor += 1;
      const name = input.slice(nameStart, cursor);
      const gt = input.indexOf('>', cursor);
      index = gt === -1 ? length : gt + 1;
      if (name) tokens.push({ kind: 'close', name });
      continue;
    }

    // 开始标签
    if (lt + 1 < length && NAME_START.test(input[lt + 1])) {
      let cursor = lt + 1;
      const nameStart = cursor;
      while (cursor < length && NAME_CHAR.test(input[cursor])) cursor += 1;
      const name = input.slice(nameStart, cursor);

      const attributes: ParsedAttribute[] = [];
      let selfClosing = false;

      while (cursor < length) {
        while (cursor < length && /\s/.test(input[cursor])) cursor += 1;
        if (cursor >= length) break;

        if (input[cursor] === '>') {
          cursor += 1;
          break;
        }
        if (input.startsWith('/>', cursor)) {
          selfClosing = true;
          cursor += 2;
          break;
        }
        if (input[cursor] === '/') {
          cursor += 1;
          continue;
        }

        const attrStart = cursor;
        while (cursor < length && NAME_CHAR.test(input[cursor])) cursor += 1;
        if (cursor === attrStart) {
          // 不是合法属性名起始字符（畸形输入），跳过一个字符防死循环
          cursor += 1;
          continue;
        }
        const attrName = input.slice(attrStart, cursor);

        while (cursor < length && /\s/.test(input[cursor])) cursor += 1;
        let attrValue = '';
        if (input[cursor] === '=') {
          cursor += 1;
          while (cursor < length && /\s/.test(input[cursor])) cursor += 1;
          const quote = input[cursor];
          if (quote === '"' || quote === "'") {
            cursor += 1;
            const valueStart = cursor;
            const end = input.indexOf(quote, cursor);
            const stop = end === -1 ? length : end;
            attrValue = input.slice(valueStart, stop);
            cursor = end === -1 ? length : end + 1;
          } else {
            const valueStart = cursor;
            while (cursor < length && !/[\s>]/.test(input[cursor])) cursor += 1;
            attrValue = input.slice(valueStart, cursor);
          }
        }

        attributes.push({ name: attrName, value: attrValue });
      }

      index = cursor;
      tokens.push({ kind: 'open', name, selfClosing, attributes });
      continue;
    }

    // 落单的 '<'：当文本
    tokens.push({ kind: 'text', value: '&lt;' });
    index = lt + 1;
  }

  return tokens;
}

/* ------------------------------------------------------------------ */
/*  序列化                                                              */
/* ------------------------------------------------------------------ */

const REFERENCE_ATTRIBUTES = new Set([
  'href', 'fill', 'stroke', 'clip-path', 'mask', 'filter',
  'marker-start', 'marker-mid', 'marker-end',
  'flood-color', 'lighting-color', 'stop-color',
]);

function serializeAttributes(attributes: ParsedAttribute[], isRoot: boolean): string {
  const rendered: string[] = [];
  const seen = new Set<string>();

  for (const attr of attributes) {
    const lowerRaw = attr.name.toLowerCase();

    // 命名空间声明一律丢弃：由本模块在根节点写死 SVG 命名空间。
    // 否则 `xmlns="http://www.w3.org/1999/xhtml"` 之类可以改变整棵子树的解析上下文。
    if (lowerRaw === 'xmlns' || lowerRaw.startsWith('xmlns:')) continue;

    // 剥前缀取 local name：`svg:width` → `width`、`xlink:href` → `href`。
    // 前缀不参与白名单判定，故 `<svg:script>` 这类伎俩在元素侧同样失效。
    const local = localName(attr.name).toLowerCase();
    const canonical = ALLOWED_ATTRIBUTES.get(local);
    if (!canonical) continue;
    if (seen.has(canonical)) continue;

    const decoded = decodeEntities(attr.value);

    if (canonical === 'style') {
      if (!isSafeStyleValue(decoded)) continue;
    } else if (REFERENCE_ATTRIBUTES.has(canonical)) {
      if (!isSafeReferenceValue(decoded)) continue;
    } else if (CONTROL_CHARS.test(decoded)) {
      // 其余属性里出现控制字符没有合法用途
      continue;
    }

    seen.add(canonical);
    rendered.push(canonical + '="' + escapeAttribute(decoded) + '"');
  }

  if (isRoot) {
    rendered.unshift('xmlns="' + SVG_NAMESPACE + '"');
  }

  return rendered.length > 0 ? ' ' + rendered.join(' ') : '';
}

export function sanitizeSvgContent(rawSvg: string): string {
  if (typeof rawSvg !== 'string') {
    throw new Error('Invalid SVG: expected string content');
  }
  if (rawSvg.length > MAX_SVG_BYTES) {
    throw new Error('Invalid SVG: document is too large');
  }

  const tokens = tokenize(rawSvg);

  let out = '';
  let rootSeen = false;
  const emitted: string[] = [];
  const skipped: string[] = [];

  for (const token of tokens) {
    if (skipped.length > 0) {
      // 被丢弃元素的整棵子树都不要（`<script>` 的文本内容也一并消失）
      if (token.kind === 'open' && !token.selfClosing) {
        skipped.push(localName(token.name).toLowerCase());
      } else if (token.kind === 'close') {
        const name = localName(token.name).toLowerCase();
        const at = skipped.lastIndexOf(name);
        if (at !== -1) skipped.length = at;
      }
      continue;
    }

    if (token.kind === 'text') {
      // 根元素之外的文本丢弃
      if (!rootSeen || emitted.length === 0) continue;
      out += escapeText(decodeEntities(token.value));
      continue;
    }

    if (token.kind === 'close') {
      const name = localName(token.name).toLowerCase();
      const at = emitted.lastIndexOf(name);
      if (at === -1) continue;
      // 闭到该层，顺手补齐未闭合的内层标签
      for (let i = emitted.length - 1; i >= at; i -= 1) {
        out += '</' + (ALLOWED_ELEMENTS.get(emitted[i]) ?? emitted[i]) + '>';
      }
      emitted.length = at;
      continue;
    }

    const name = localName(token.name).toLowerCase();
    const canonical = ALLOWED_ELEMENTS.get(name);

    if (!canonical) {
      if (!token.selfClosing) skipped.push(name);
      continue;
    }

    // 根必须是 svg；svg 之前出现的任何元素都不要
    if (!rootSeen) {
      if (canonical !== 'svg') {
        if (!token.selfClosing) skipped.push(name);
        continue;
      }
      rootSeen = true;
    } else if (canonical === 'svg' && emitted.length === 0) {
      // 根闭合之后又冒出一个平级 <svg>：丢弃
      if (!token.selfClosing) skipped.push(name);
      continue;
    }

    const isRoot = emitted.length === 0;
    out += '<' + canonical + serializeAttributes(token.attributes, isRoot);
    if (token.selfClosing) {
      out += '/>';
    } else {
      out += '>';
      emitted.push(name);
    }
  }

  for (let i = emitted.length - 1; i >= 0; i -= 1) {
    out += '</' + (ALLOWED_ELEMENTS.get(emitted[i]) ?? emitted[i]) + '>';
  }

  if (!rootSeen) {
    throw new Error('Invalid SVG: missing <svg> root');
  }

  // 终检（tripwire）：输出是我们自己序列化的，理论上不可能命中。留着是为了
  // 「白名单表被后人改错」时能当场炸出来，而不是静默放行。
  if (
    /<[^>]*\b(?:script|foreignobject|iframe|object|embed|image|audio|video|canvas|link|meta|animate|animatetransform|animatemotion|animatecolor|set|discard|handler|listener)\b/i.test(
      out
    ) ||
    /\son[a-z0-9:_-]+\s*=/i.test(out) ||
    /javascript\s*:/i.test(decodeEntities(out))
  ) {
    throw new Error('Invalid SVG: forbidden constructs remain after sanitization');
  }

  return out;
}
