declare module 'svg-to-pdfkit' {
  import type PDFDocument from 'pdfkit';

  export default function SVGtoPDF(
    document: PDFDocument,
    svg: string,
    x: number,
    y: number,
    options?: Record<string, unknown>,
  ): void;
}
