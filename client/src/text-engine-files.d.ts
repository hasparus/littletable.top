/** Same-origin URLs for the OCR engines and language data emitted by Vite. */
declare module "virtual:text-engine-files" {
  const files: {
    detector: string;
    recogniser: string;
    tessdata: string;
    tesseractCore: string;
    tesseractCoreNoSimd: string;
    tesseractWorker: string;
  };
  export default files;
}
