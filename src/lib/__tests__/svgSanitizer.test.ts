import { describe, expect, it } from 'vitest';

import { sanitizeSvgContent } from '@/lib/svgSanitizer';

/**
 * M26：旧的正则黑名单实现有三条被实测坐实的绕过（原样通过消毒器）。
 * 这三条 PoC 是本次白名单重写的验收标准 —— 变异验证时把 svgSanitizer.ts 换回
 * 黑名单实现，下面 describe('M26 三条实测绕过') 里的用例必须全红。
 */

const SAFE_ICON = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <title>logo</title>
  <defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs>
  <path d="M4 4h16v16H4z" fill="url(#g)" stroke="#000" stroke-width="2"/>
  <g transform="translate(1,1)"><circle cx="12" cy="12" r="5" fill="none"/></g>
</svg>`;

describe('sanitizeSvgContent —— 正常图标不被破坏', () => {
  it('保留白名单元素、属性与同文档引用', () => {
    const out = sanitizeSvgContent(SAFE_ICON);

    expect(out.startsWith('<svg')).toBe(true);
    expect(out).toContain('viewBox="0 0 24 24"');
    expect(out).toContain('<linearGradient id="g">');
    expect(out).toContain('<stop offset="0" stop-color="#fff"/>');
    expect(out).toContain('fill="url(#g)"');
    expect(out).toContain('transform="translate(1,1)"');
    expect(out).toContain('<circle cx="12" cy="12" r="5" fill="none"/>');
    // camelCase 元素名不能被小写化（linearGradient / clipPath 等大小写敏感）
    expect(out).not.toContain('lineargradient');
    // 根节点必须自带 SVG 命名空间
    expect(out).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('非 SVG 内容仍然被拒', () => {
    expect(() => sanitizeSvgContent('<html><body>hi</body></html>')).toThrow(
      /missing <svg> root/
    );
  });

  it('DOCTYPE / ENTITY 仍然被拒（XXE / 实体炸弹）', () => {
    expect(() =>
      sanitizeSvgContent('<!DOCTYPE svg [<!ENTITY x "y">]><svg></svg>')
    ).toThrow(/DOCTYPE and ENTITY/);
  });
});

describe('sanitizeSvgContent —— 对照组（旧实现也挡得住的）', () => {
  it('裸 <script> 连同其文本一起消失', () => {
    const out = sanitizeSvgContent('<svg><script>alert(1)</script><rect/></svg>');
    expect(out).not.toMatch(/script/i);
    expect(out).not.toContain('alert(1)');
    expect(out).toContain('<rect/>');
  });

  it('on* 事件属性被剥掉', () => {
    const out = sanitizeSvgContent('<svg onload="alert(1)"><rect onclick="x()"/></svg>');
    expect(out).not.toMatch(/onload/i);
    expect(out).not.toMatch(/onclick/i);
    expect(out).not.toContain('alert(1)');
  });
});

describe('M26 三条实测绕过（旧黑名单实现全部原样放行）', () => {
  it('① 命名空间前缀：<svg:script> 不再被当成未知标签放行', () => {
    const payload =
      '<svg xmlns:svg="http://www.w3.org/2000/svg"><svg:script>alert(1)</svg:script></svg>';
    const out = sanitizeSvgContent(payload);

    expect(out).not.toMatch(/script/i);
    expect(out).not.toContain('alert(1)');
  });

  it('① 变体：带前缀的 foreignObject 同样被丢弃', () => {
    const out = sanitizeSvgContent(
      '<svg xmlns:s="http://www.w3.org/2000/svg"><s:foreignObject><b>x</b></s:foreignObject></svg>'
    );
    expect(out).not.toMatch(/foreignobject/i);
    expect(out).not.toContain('<b>');
  });

  it('② 实体编码 scheme：xlink:href="jav&#x09;ascript:…" 被剥掉', () => {
    const out = sanitizeSvgContent(
      '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="jav&#x09;ascript:alert(1)"/></svg>'
    );

    // 解码后是 javascript:，绝不能出现在输出里（原文或解码后都不行）
    expect(out).not.toMatch(/javascript/i);
    expect(out).not.toContain('alert(1)');
    expect(out).not.toContain('&#x09;');
  });

  it('② 变体：href="java&#x0A;script:…" 被剥掉', () => {
    const out = sanitizeSvgContent(
      '<svg><use href="java&#x0A;script:alert(1)"/></svg>'
    );
    expect(out).not.toMatch(/javascript/i);
    expect(out).not.toContain('alert(1)');
  });

  it('② 合法的同文档引用不受影响', () => {
    const out = sanitizeSvgContent('<svg><use href="#icon-a"/></svg>');
    expect(out).toContain('href="#icon-a"');
  });

  it('③ SMIL：<animate attributeName="href" values="javascript:…"> 被丢弃', () => {
    const out = sanitizeSvgContent(
      '<svg><use href="#a"><animate attributeName="href" values="javascript:alert(1)"/></use></svg>'
    );

    expect(out).not.toMatch(/animate/i);
    expect(out).not.toMatch(/javascript/i);
    expect(out).not.toContain('alert(1)');
  });

  it('③ 变体：<set attributeName="href" to="javascript:…"> 被丢弃', () => {
    const out = sanitizeSvgContent(
      '<svg><a><set attributeName="href" to="javascript:alert(1)"/></a></svg>'
    );
    expect(out).not.toMatch(/<set/i);
    expect(out).not.toMatch(/javascript/i);
  });
});

describe('sanitizeSvgContent —— 白名单顺带堵住的其它面', () => {
  it('外链资源（http/data）一律不保留', () => {
    const out = sanitizeSvgContent(
      '<svg><image href="https://evil.example/x.png"/><use href="data:image/svg+xml,x"/></svg>'
    );
    expect(out).not.toContain('evil.example');
    expect(out).not.toContain('data:');
  });

  it('style 属性里的 url()/@import 被丢弃，普通样式保留', () => {
    const evil = sanitizeSvgContent(
      '<svg><rect style="fill:url(https://evil.example/x)"/></svg>'
    );
    expect(evil).not.toContain('evil.example');

    const ok = sanitizeSvgContent('<svg><rect style="fill:#f00"/></svg>');
    expect(ok).toContain('style="fill:#f00"');
  });

  it('<style> 元素连同 CSS 文本一起消失', () => {
    const out = sanitizeSvgContent(
      '<svg><style>*{background:url(https://evil.example/x)}</style><rect/></svg>'
    );
    expect(out).not.toContain('evil.example');
    expect(out).not.toMatch(/<style/i);
  });

  it('输入里的 xmlns 不能改写解析上下文', () => {
    const out = sanitizeSvgContent(
      '<svg xmlns="http://www.w3.org/1999/xhtml"><rect/></svg>'
    );
    expect(out).not.toContain('1999/xhtml');
    expect(out).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('CDATA 里的脚本被当纯文本转义，不会逃逸', () => {
    const out = sanitizeSvgContent(
      '<svg><text><![CDATA[<script>alert(1)</script>]]></text></svg>'
    );
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('未闭合标签不会把输出变成畸形文档', () => {
    const out = sanitizeSvgContent('<svg><g><rect>');
    expect(out).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg"><g><rect></rect></g></svg>'
    );
  });
});
