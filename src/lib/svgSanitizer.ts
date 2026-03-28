const XML_DECLARATION = /^\uFEFF?\s*<\?xml[\s\S]*?\?>\s*/i;
const SVG_ROOT_PATTERN = /<svg[\s>]/i;
const FORBIDDEN_SVG_TAGS = [
  'script',
  'foreignObject',
  'iframe',
  'object',
  'embed',
  'image',
  'audio',
  'video',
  'canvas',
  'link',
  'meta',
];

function stripForbiddenTagBlocks(svg: string): string {
  let sanitized = svg;

  for (const tag of FORBIDDEN_SVG_TAGS) {
    sanitized = sanitized.replace(
      new RegExp(`<\\s*${tag}\\b[^>]*>[\\s\\S]*?<\\s*\\/\\s*${tag}\\s*>`, 'gi'),
      ''
    );
    sanitized = sanitized.replace(
      new RegExp(`<\\s*${tag}\\b[^>]*\\/\\s*>`, 'gi'),
      ''
    );
  }

  return sanitized;
}

function stripDangerousAttributes(svg: string): string {
  let sanitized = svg;

  sanitized = sanitized.replace(
    /\s+on[a-zA-Z0-9:_-]+\s*=\s*(".*?"|'.*?'|[^\s>]+)/g,
    ''
  );

  sanitized = sanitized.replace(
    /\s+(?:href|xlink:href)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (full, _raw, doubleQuoted, singleQuoted, bareValue) => {
      const value = String(doubleQuoted ?? singleQuoted ?? bareValue ?? '').trim();
      if (!value || value.startsWith('#')) {
        return full;
      }

      if (/^(?:https?:|javascript:|data:|\/\/)/i.test(value)) {
        return '';
      }

      return full;
    }
  );

  sanitized = sanitized.replace(
    /\s+style\s*=\s*("([^"]*)"|'([^']*)')/gi,
    (full, _raw, doubleQuoted, singleQuoted) => {
      const value = String(doubleQuoted ?? singleQuoted ?? '');
      if (/(?:url\s*\(|@import|expression\s*\()/i.test(value)) {
        return '';
      }
      return full;
    }
  );

  return sanitized;
}

export function sanitizeSvgContent(rawSvg: string): string {
  let sanitized = rawSvg.replace(XML_DECLARATION, '').trim();

  if (!SVG_ROOT_PATTERN.test(sanitized)) {
    throw new Error('Invalid SVG: missing <svg> root');
  }

  if (/<!DOCTYPE/i.test(sanitized) || /<!ENTITY/i.test(sanitized)) {
    throw new Error('Invalid SVG: DOCTYPE and ENTITY declarations are not allowed');
  }

  sanitized = sanitized.replace(/<!--[\s\S]*?-->/g, '');
  sanitized = sanitized.replace(/<\s*style\b[^>]*>[\s\S]*?<\s*\/\s*style\s*>/gi, '');
  sanitized = stripForbiddenTagBlocks(sanitized);
  sanitized = stripDangerousAttributes(sanitized);

  if (
    /<(?:script|foreignObject|iframe|object|embed|image|audio|video|canvas|link|meta)\b/i.test(
      sanitized
    )
  ) {
    throw new Error('Invalid SVG: forbidden elements remain after sanitization');
  }

  if (
    /\s+on[a-zA-Z0-9:_-]+\s*=|\s+(?:href|xlink:href)\s*=\s*["']?(?:https?:|javascript:|data:|\/\/)/i.test(
      sanitized
    )
  ) {
    throw new Error('Invalid SVG: forbidden attributes remain after sanitization');
  }

  return sanitized;
}
