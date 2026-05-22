declare module 'pdf-parse' {
  interface PdfParseResult {
    text: string;
    /** Total number of pages parsed; populated by pdf-parse at runtime. */
    numpages?: number;
  }

  export default function pdfParse(
    dataBuffer: Buffer
  ): Promise<PdfParseResult>;
}
