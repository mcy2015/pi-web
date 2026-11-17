import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { canWriteImageToClipboard, convertBlobToPng, copyImageToClipboard, fetchImageAsFile } = await jiti.import("./image-actions.ts");

// Node ships its own `navigator` on new versions and none on old ones, so each
// test swaps the globals in and restores whatever was there.
function setGlobal(name, value) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, name);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  if (value === undefined) delete globalThis[name];
  else Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  return () => {
    if (had && descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  };
}

test("canWriteImageToClipboard needs both ClipboardItem and clipboard.write", () => {
  const restoreItem = setGlobal("ClipboardItem", class {});
  const restoreNavigator = setGlobal("navigator", { clipboard: { write() {} } });
  try {
    assert.equal(canWriteImageToClipboard(), true);
    const restoreWriteless = setGlobal("navigator", { clipboard: {} });
    try {
      assert.equal(canWriteImageToClipboard(), false);
    } finally {
      restoreWriteless();
    }
    const restoreBareNavigator = setGlobal("navigator", {});
    try {
      assert.equal(canWriteImageToClipboard(), false);
    } finally {
      restoreBareNavigator();
    }
  } finally {
    restoreNavigator();
    restoreItem();
  }
  const restoreMissingItem = setGlobal("ClipboardItem", undefined);
  const restoreNavigator2 = setGlobal("navigator", { clipboard: { write() {} } });
  try {
    assert.equal(canWriteImageToClipboard(), false);
  } finally {
    restoreNavigator2();
    restoreMissingItem();
  }
});

test("convertBlobToPng passes a PNG blob through without touching a canvas", async () => {
  const png = { type: "image/png" };
  const pngOut = await convertBlobToPng(png, {
    createCanvas: () => {
      throw new Error("no canvas expected");
    },
  });
  assert.equal(pngOut, png);
});

test("convertBlobToPng paints the white backdrop before the image and asks the canvas for PNG bytes", async () => {
  const order = [];
  const fillRect = [];
  const drawImage = [];
  let fillStyle;
  let toBlobType;
  const canvas = {
    width: 0,
    height: 0,
    getContext(kind) {
      assert.equal(kind, "2d");
      return {
        set fillStyle(value) { fillStyle = value; },
        get fillStyle() { return fillStyle; },
        fillRect(...args) { order.push("fillRect"); fillRect.push(args); },
        drawImage(...args) { order.push("drawImage"); drawImage.push(args); },
      };
    },
    toBlob(callback, type) { toBlobType = type; callback({ type: "image/png" }); },
  };
  const image = { naturalWidth: 640, naturalHeight: 480 };
  const out = await convertBlobToPng({ type: "image/jpeg" }, {
    decodeImage: async () => image,
    createCanvas: () => canvas,
  });
  assert.equal(out.type, "image/png");
  assert.equal(canvas.width, 640);
  assert.equal(canvas.height, 480);
  assert.equal(fillStyle, "#ffffff");
  assert.deepEqual(order, ["fillRect", "drawImage"]);
  assert.deepEqual(fillRect[0], [0, 0, 640, 480]);
  assert.deepEqual(drawImage[0], [image, 0, 0, 640, 480]);
  assert.equal(toBlobType, "image/png");
});

test("convertBlobToPng throws when decoding fails, the image is empty or the encoder refuses", async () => {
  const canvas = {
    getContext: () => ({
      fillStyle: "",
      fillRect() {},
      drawImage() {},
    }),
    toBlob(callback) { callback(null); },
  };
  await assert.rejects(convertBlobToPng({ type: "image/webp" }, { decodeImage: async () => { throw new Error("broken file"); } }), /broken file/);
  await assert.rejects(
    convertBlobToPng({ type: "image/webp" }, { decodeImage: async () => ({ naturalWidth: 0, naturalHeight: 0 }), createCanvas: () => canvas }),
    /intrinsic size/,
  );
  await assert.rejects(
    convertBlobToPng({ type: "image/webp" }, { decodeImage: async () => ({ naturalWidth: 1, naturalHeight: 1 }), createCanvas: () => canvas }),
    /PNG encoding/,
  );
});

// The gesture requirement: clipboard.write() must be called synchronously from
// the click handler while the image is still loading, so the ClipboardItem
// carries a pending blob promise rather than the bytes.
test("copyImageToClipboard calls write within the call and hands it a pending PNG promise", async () => {
  let resolveFetch;
  const fetchImpl = () => new Promise((resolve) => { resolveFetch = resolve; });
  const written = [];
  const clipboard = { write(items) { written.push(items); return Promise.resolve(); } };
  class FakeClipboardItem {
    constructor(items) { this.items = items; }
  }
  const restoreItem = setGlobal("ClipboardItem", FakeClipboardItem);
  const restoreNavigator = setGlobal("navigator", { clipboard });
  try {
    const copied = copyImageToClipboard("/api/files/pic.png?type=read", {
      fetchImpl,
      clipboard,
      ClipboardItemCtor: FakeClipboardItem,
    });
    // No await yet: write() has already left, and the fetch has not answered.
    assert.equal(written.length, 1);
    const [item] = written[0];
    assert.ok(item instanceof FakeClipboardItem);
    assert.ok(item.items["image/png"] instanceof Promise);
    assert.equal(typeof resolveFetch, "function");

    const blob = { type: "image/png" };
    resolveFetch({ ok: true, status: 200, blob: async () => blob });
    await copied;
    assert.equal(await item.items["image/png"], blob);
  } finally {
    restoreNavigator();
    restoreItem();
  }
});

test("copyImageToClipboard rejects on an HTTP error, a decode failure and a refused write", async () => {
  class ItemsClipboardItem {
    constructor(items) { this.items = items; }
  }
  const awaitingClipboard = (written) => ({
    async write(items) {
      for (const item of items) {
        for (const type of Object.keys(item.items)) item.items[type] = await item.items[type];
      }
      written.push(items);
    },
  });
  // The globals only satisfy canWriteImageToClipboard's feature detect; the
  // constructor and clipboard themselves flow through the injected deps.
  const install = () => {
    const restoreItem = setGlobal("ClipboardItem", ItemsClipboardItem);
    const restoreNavigator = setGlobal("navigator", { clipboard: awaitingClipboard([]) });
    return () => { restoreNavigator(); restoreItem(); };
  };

  let restore = install();
  try {
    await assert.rejects(
      copyImageToClipboard("/gone.png", {
        fetchImpl: async () => ({ ok: false, status: 404 }),
        clipboard: awaitingClipboard([]),
        ClipboardItemCtor: ItemsClipboardItem,
      }),
      /HTTP 404/,
    );
  } finally {
    restore();
  }

  restore = install();
  try {
    await assert.rejects(
      copyImageToClipboard("/pic.jpg", {
        fetchImpl: async () => ({ ok: true, status: 200, blob: async () => ({ type: "image/jpeg" }) }),
        clipboard: awaitingClipboard([]),
        ClipboardItemCtor: ItemsClipboardItem,
        decodeImage: async () => { throw new Error("broken file"); },
      }),
      /broken file/,
    );
  } finally {
    restore();
  }

  const restoreRejectingItem = setGlobal("ClipboardItem", class {});
  const restoreRejectingNavigator = setGlobal("navigator", { clipboard: { write: () => Promise.reject(new Error("clipboard full")) } });
  try {
    await assert.rejects(
      copyImageToClipboard("/pic.png", {
        fetchImpl: () => new Promise(() => {}),
        clipboard: { write: () => Promise.reject(new Error("clipboard full")) },
        ClipboardItemCtor: class {},
      }),
      /clipboard full/,
    );
  } finally {
    restoreRejectingNavigator();
    restoreRejectingItem();
  }
});

test("fetchImageAsFile wraps the downloaded bytes in a named File", async () => {
  const file = await fetchImageAsFile("/api/files/a.jpg?type=download", "a.jpg", {
    fetchImpl: async () => ({ ok: true, status: 200, blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }) }),
  });
  assert.ok(file instanceof File);
  assert.equal(file.name, "a.jpg");
  assert.equal(file.type, "image/jpeg");
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [1, 2, 3]);
  const fallback = await fetchImageAsFile("/api/files/b.bin?type=download", "b.bin", {
    fetchImpl: async () => ({ ok: true, status: 200, blob: async () => new Blob([new Uint8Array([4])]) }),
  });
  assert.equal(fallback.type, "image/png");
});

test("fetchImageAsFile refuses an HTTP error", async () => {
  await assert.rejects(
    fetchImageAsFile("/denied.jpg", "denied.jpg", { fetchImpl: async () => ({ ok: false, status: 403 }) }),
    /HTTP 403/,
  );
});
