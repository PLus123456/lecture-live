// src/lib/fileParser.ts
// PDF / DOCX / PPTX / TXT 文件内容提取

export async function extractTextFromFile(file: File): Promise<string> {
  const buffer = Buffer.from(await file.arrayBuffer());

  switch (file.type) {
    case 'application/pdf': {
      const pdf = (await import('pdf-parse')).default;
      const data = await pdf(buffer);
      return data.text;
    }

    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    }

    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation': {
      return await extractPptxText(buffer);
    }

    case 'text/plain': {
      return buffer.toString('utf-8');
    }

    default:
      throw new Error(`Unsupported type: ${file.type}`);
  }
}

async function extractPptxText(buffer: Buffer): Promise<string> {
  // PPTX 是 ZIP 文件，解包后读取 ppt/slides/slide*.xml 中的文本
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buffer);
  const texts: string[] = [];

  for (const [name, entry] of Object.entries(zip.files)) {
    if (name.match(/ppt\/slides\/slide\d+\.xml$/)) {
      const xml = await entry.async('text');
      // 提取 <a:t> 标签内文本
      const pattern = /<a:t>(.*?)<\/a:t>/g;
      let match: RegExpExecArray | null;
      do {
        match = pattern.exec(xml);
        if (match?.[1]) {
          texts.push(match[1]);
        }
      } while (match);
    }
  }

  return texts.join('\n');
}
