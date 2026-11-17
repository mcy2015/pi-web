// Clipboard and composer actions for the image viewer (`components/FileViewer.tsx`).
// Every browser API is behind a `deps` slot so node tests can run the whole flow
// against fakes (see `lib/image-actions.test.mjs`); the defaults are the page's own.

export interface ImageActionDeps {
  fetchImpl?: typeof fetch;
  decodeImage?: (blob: Blob) => Promise<HTMLImageElement | ImageBitmap>;
  // A fake only needs `getContext("2d")` (fillStyle, fillRect, drawImage) and
  // `toBlob(callback, type)`.
  createCanvas?: () => HTMLCanvasElement;
  clipboard?: Pick<Clipboard, "write">;
  ClipboardItemCtor?: typeof ClipboardItem;
}

// `ClipboardItem.supports()` arrived in Safari 18.4; the constructor itself in
// 13.4. Ask only for what older browsers have.
export function canWriteImageToClipboard(): boolean {
  return typeof ClipboardItem !== "undefined" && typeof navigator !== "undefined" && !!navigator.clipboard?.write;
}

// `new Image()` + object URL, not `createImageBitmap()`: only the element
// decodes an SVG.
async function decodeWithImageElement(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Image failed to decode"));
      img.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Re-encodes any decodable image as PNG, a white backdrop under the alpha. */
export async function convertBlobToPng(blob: Blob, deps?: ImageActionDeps): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const decodeImage = deps?.decodeImage ?? decodeWithImageElement;
  const image = await decodeImage(blob);
  const width = "naturalWidth" in image ? image.naturalWidth : image.width;
  const height = "naturalHeight" in image ? image.naturalHeight : image.height;
  if (!width || !height) throw new Error("Image has no intrinsic size");
  const canvas = (deps?.createCanvas ?? (() => document.createElement("canvas")))();
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context unavailable");
  // PNG keeps the alpha channel; a JPEG conversion without the fill would
  // flatten transparency onto black.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!png) throw new Error("PNG encoding failed");
  return png;
}

/**
 * Writes the image at `url` to the clipboard as PNG. Safari only honours
 * `clipboard.write()` inside the click's user-activation window, so the fetch
 * and the `write()` call both run synchronously from the gesture and the
 * ClipboardItem carries the blob as a still-pending promise.
 */
export async function copyImageToClipboard(url: string, deps?: ImageActionDeps): Promise<void> {
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const clipboard = deps?.clipboard ?? (typeof navigator !== "undefined" ? navigator.clipboard : undefined);
  const ClipboardItemCtor = deps?.ClipboardItemCtor ?? globalThis.ClipboardItem;
  if (!canWriteImageToClipboard() || !clipboard || !ClipboardItemCtor) throw new Error("Clipboard image write unavailable");
  const pngPromise = (async () => {
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    return blob.type === "image/png" ? blob : convertBlobToPng(blob, deps);
  })();
  await clipboard.write([new ClipboardItemCtor({ "image/png": pngPromise })]);
}

/** Downloads the image at `url` as a named File for the composer to attach. */
export async function fetchImageAsFile(url: string, fileName: string, deps?: ImageActionDeps): Promise<File> {
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  // The download endpoint answers with the true Content-Type; the composer's
  // outgoing media_type must match the bytes, not a guessed constant.
  return new File([blob], fileName, { type: blob.type || "image/png" });
}
