declare module 'html2canvas' {
  export interface Html2CanvasOptions {
    [key: string]: unknown;
  }

  export default function html2canvas(
    element: HTMLElement,
    options?: Html2CanvasOptions
  ): Promise<HTMLCanvasElement>;
}
