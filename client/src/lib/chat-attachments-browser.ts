import type {
  CanvasLike,
  ImageProcessingDeps,
  PdfProcessingDeps,
} from './chat-attachments';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function encodeJpegBase64(
  canvas: CanvasLike,
  quality: number,
): Promise<string> {
  const element = canvas as unknown as HTMLCanvasElement;
  return new Promise((resolve, reject) => {
    element.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('JPEG encoding failed'));
          return;
        }
        blob
          .arrayBuffer()
          .then((buffer) => resolve(bytesToBase64(new Uint8Array(buffer))))
          .catch(reject);
      },
      'image/jpeg',
      quality,
    );
  });
}

export const browserImageDeps: ImageProcessingDeps = {
  decode: (file) => createImageBitmap(file),
  createCanvas: (width, height) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas as unknown as CanvasLike;
  },
  encodeJpeg: encodeJpegBase64,
  readBytes: async (file) => new Uint8Array(await file.arrayBuffer()),
  base64Encode: bytesToBase64,
};

let pdfjsModule: Promise<typeof import('pdfjs-dist')> | undefined;

function loadPdfjs(): Promise<typeof import('pdfjs-dist')> {
  pdfjsModule ??= (async () => {
    const pdfjs = await import('pdfjs-dist');
    const workerUrl = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url,
    );
    try {
      pdfjs.GlobalWorkerOptions.workerPort = new Worker(workerUrl, {
        type: 'module',
      });
    } catch {
      // Bundlers that cannot emit the worker inline still resolve the URL,
      // letting pdfjs load it (or fall back to its main-thread worker).
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.toString();
    }
    return pdfjs;
  })();
  return pdfjsModule;
}

export async function browserPdfDeps(): Promise<PdfProcessingDeps> {
  const pdfjs = await loadPdfjs();
  return {
    loadPdf: async (data) => {
      const loaded = await pdfjs.getDocument({ data }).promise;
      return loaded as unknown as Awaited<
        ReturnType<PdfProcessingDeps['loadPdf']>
      >;
    },
  };
}
