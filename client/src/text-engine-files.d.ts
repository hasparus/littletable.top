// The text engines' files as vite.config.ts publishes them: an address on
// this origin each, and the folder of Tesseract's language data.
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
