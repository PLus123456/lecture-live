declare module 'pdf-parse' {
  interface PdfParseResult {
    text: string;
  }

  export default function pdfParse(
    dataBuffer: Buffer
  ): Promise<PdfParseResult>;
}
