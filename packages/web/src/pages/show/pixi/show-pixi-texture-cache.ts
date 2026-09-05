import { ImageSource, Texture } from "pixi.js";
import type { ShowPixiTextureStats } from "./show-pixi-types.js";

type TextureListener = (
  texture: Texture | null,
  retryable: boolean
) => void;

type TextureEntry = {
  key: string;
  url: string;
  state: "queued" | "loading" | "ready" | "failed";
  texture: Texture | null;
  bitmap: ImageBitmap | null;
  controller: AbortController | null;
  listeners: Set<TextureListener>;
  references: number;
  pixelWidth: number;
  pixelHeight: number;
  sourceRatio: number;
  reservedPixels: number;
  touchedAt: number;
};

type TextureLod = {
  pixelWidth: number;
  pixelHeight: number;
  sourceRatio?: number;
};

class TextureTransportError extends Error {}

export type ShowPixiTextureLease = {
  release: () => void;
};

export type ShowPixiTextureCacheOptions = {
  maximumEntries: number;
  maximumPixels: number;
  maximumInFlight: number;
  maximumUnreferenced: number;
  generateMipmaps: boolean;
};

const safePixels = (value: number) => (
  Number.isFinite(value) ? Math.max(1, Math.round(value)) : 1
);

// The full mip chain costs at most 1 + 1/4 + 1/16 + ... = 4/3 texels.
const mipmappedPixels = (basePixels: number, generateMipmaps: boolean) => (
  generateMipmaps
    ? Math.ceil(safePixels(basePixels) * 4 / 3)
    : safePixels(basePixels)
);

const normalizedLod = (lod: TextureLod) => {
  const sourceRatio = lod.sourceRatio;
  return {
    pixelWidth: Math.min(512, Math.max(1, Math.round(lod.pixelWidth))),
    pixelHeight: Math.min(1_024, Math.max(1, Math.round(lod.pixelHeight))),
    sourceRatio: sourceRatio !== undefined
      && Number.isFinite(sourceRatio)
      && sourceRatio > 0
      ? sourceRatio
      : lod.pixelHeight / Math.max(1, lod.pixelWidth)
  };
};

function coverSourceRectangle(
  width: number,
  height: number,
  targetRatio: number
) {
  const sourceRatio = height / Math.max(1, width);
  let x = 0;
  let y = 0;
  let cropWidth = width;
  let cropHeight = height;
  if (sourceRatio > targetRatio) {
    cropHeight = Math.max(1, Math.round(width * targetRatio));
    y = Math.max(0, Math.floor((height - cropHeight) / 2));
  } else if (sourceRatio < targetRatio) {
    cropWidth = Math.max(1, Math.round(height / targetRatio));
    x = Math.max(0, Math.floor((width - cropWidth) / 2));
  }
  return { x, y, width: cropWidth, height: cropHeight };
}

async function resizedBitmap(blob: Blob, lod: ReturnType<typeof normalizedLod>) {
  const targetRatio = lod.pixelHeight / lod.pixelWidth;
  if (Math.abs(lod.sourceRatio - targetRatio) < 0.002) {
    return createImageBitmap(blob, {
      resizeWidth: lod.pixelWidth,
      resizeHeight: lod.pixelHeight,
      resizeQuality: "high"
    });
  }
  // Match the former card's cover crop. Decode only uncommon extreme aspect
  // ratios through a centered crop so the rounded WebGL fill keeps the same
  // geometry without stretching the picture into the capped card ratio.
  const source = await createImageBitmap(blob);
  try {
    const crop = coverSourceRectangle(source.width, source.height, targetRatio);
    return await createImageBitmap(
      source,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      {
        resizeWidth: lod.pixelWidth,
        resizeHeight: lod.pixelHeight,
        resizeQuality: "high"
      }
    );
  } finally {
    source.close();
  }
}

async function bitmapTexture(
  url: string,
  lod: TextureLod,
  generateMipmaps: boolean,
  signal: AbortSignal
) {
  const transportFailure = (error: unknown): never => {
    if (signal.aborted) throw error;
    throw new TextureTransportError(
      error instanceof Error ? error.message : "缩略图网络请求失败"
    );
  };
  const response = await fetch(url, {
    credentials: "omit",
    mode: "cors",
    signal
  }).catch(transportFailure);
  if (!response.ok) {
    throw new Error(`缩略图加载失败：${response.status} ${response.statusText}`);
  }
  const blob = await response.blob().catch(transportFailure);
  if (signal.aborted) throw signal.reason;
  if (typeof createImageBitmap === "function") {
    let bitmap: ImageBitmap;
    try {
      bitmap = await resizedBitmap(blob, normalizedLod(lod));
    } catch {
      const source = await createImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width = lod.pixelWidth;
      canvas.height = lod.pixelHeight;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) {
        source.close();
        throw new Error("无法创建缩略图 LOD 解码画布");
      }
      const crop = coverSourceRectangle(
        source.width,
        source.height,
        lod.pixelHeight / lod.pixelWidth
      );
      context.drawImage(
        source,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        0,
        0,
        lod.pixelWidth,
        lod.pixelHeight
      );
      source.close();
      bitmap = await createImageBitmap(canvas);
    }
    if (signal.aborted) {
      bitmap.close();
      throw signal.reason;
    }
    const source = new ImageSource({
      resource: bitmap,
      autoGenerateMipmaps: generateMipmaps,
      scaleMode: "linear"
    });
    return {
      bitmap,
      texture: new Texture({ source })
    };
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = objectUrl;
    await image.decode();
    if (signal.aborted) throw signal.reason;
    const canvas = document.createElement("canvas");
    canvas.width = lod.pixelWidth;
    canvas.height = lod.pixelHeight;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("无法创建缩略图 LOD 解码画布");
    const crop = coverSourceRectangle(
      image.naturalWidth,
      image.naturalHeight,
      lod.pixelHeight / lod.pixelWidth
    );
    context.drawImage(
      image,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      0,
      0,
      lod.pixelWidth,
      lod.pixelHeight
    );
    const source = new ImageSource({
      resource: canvas,
      autoGenerateMipmaps: generateMipmaps,
      scaleMode: "linear"
    });
    return {
      bitmap: null,
      texture: new Texture({ source })
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export class ShowPixiTextureCache {
  readonly #blockedOrigins = new Map<string, number>();
  readonly #entries = new Map<string, TextureEntry>();
  readonly #failedUrls = new Map<string, boolean>();
  readonly #availabilityListeners = new Map<() => void, string>();
  readonly #originTransportFailures = new Map<string, number>();
  readonly #queue: TextureEntry[] = [];
  readonly #options: ShowPixiTextureCacheOptions;
  readonly #maximumFailedUrls: number;
  #destroyed = false;
  #inFlight = 0;
  #reservedPixels = 0;
  #rejected = 0;
  #failures = 0;
  #evictions = 0;
  #availabilityScheduled = false;

  constructor(options: ShowPixiTextureCacheOptions) {
    this.#options = {
      maximumEntries: Math.max(1, Math.floor(options.maximumEntries)),
      maximumPixels: Math.max(1, Math.floor(options.maximumPixels)),
      maximumInFlight: Math.max(1, Math.floor(options.maximumInFlight)),
      maximumUnreferenced: Math.max(0, Math.floor(options.maximumUnreferenced)),
      generateMipmaps: options.generateMipmaps
    };
    // Show retains at most 800 DTOs. Keeping at least 1,024 failed URL
    // tombstones prevents a broken CDN/CORS policy from turning sprite
    // recycling into an unbounded request loop while keeping memory bounded.
    this.#maximumFailedUrls = Math.max(1_024, this.#options.maximumEntries);
  }

  acquire(
    url: string,
    requestedLod: TextureLod,
    listener: TextureListener
  ): ShowPixiTextureLease {
    if (this.#destroyed || !url) {
      queueMicrotask(() => listener(null, false));
      return { release: () => undefined };
    }
    const lod = normalizedLod(requestedLod);
    const key = `${url}\n${lod.pixelWidth}x${lod.pixelHeight}`;
    if (this.#isBlocked(url)) {
      if (this.#failedUrls.has(url)) this.#touchFailedUrl(url);
      const retryable = this.#isTransportBlocked(url);
      queueMicrotask(() => listener(null, retryable));
      return { release: () => undefined };
    }
    let entry = this.#entries.get(key);
    if (!entry) {
      const reservation = Math.min(
        this.#options.maximumPixels,
        mipmappedPixels(
          lod.pixelWidth * lod.pixelHeight,
          this.#options.generateMipmaps
        )
      );
      this.#evictFor(reservation);
      if (
        this.#entries.size >= this.#options.maximumEntries
        || this.#reservedPixels + reservation > this.#options.maximumPixels
      ) {
        this.#rejected += 1;
        // Capacity pressure can clear as off-screen cards release leases, so
        // this case remains retryable without issuing a network request.
        queueMicrotask(() => listener(null, true));
        return { release: () => undefined };
      }
      entry = {
        key,
        url,
        state: "queued",
        texture: null,
        bitmap: null,
        controller: null,
        listeners: new Set(),
        references: 0,
        pixelWidth: lod.pixelWidth,
        pixelHeight: lod.pixelHeight,
        sourceRatio: lod.sourceRatio,
        reservedPixels: reservation,
        touchedAt: performance.now()
      };
      this.#entries.set(key, entry);
      this.#queue.push(entry);
      this.#reservedPixels += reservation;
    }
    entry.references += 1;
    entry.touchedAt = performance.now();
    if (entry.state === "ready") {
      const texture = entry.texture;
      queueMicrotask(() => listener(texture, false));
    } else if (entry.state === "failed") {
      queueMicrotask(() => listener(null, false));
    } else {
      entry.listeners.add(listener);
    }
    this.#pump();
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        entry?.listeners.delete(listener);
        if (entry) {
          entry.references = Math.max(0, entry.references - 1);
          entry.touchedAt = performance.now();
        }
        this.#trimUnreferenced();
        if (entry?.references === 0) this.#notifyAvailable();
      }
    };
  }

  whenAvailable(url: string, listener: () => void) {
    if (this.#destroyed) return () => undefined;
    this.#availabilityListeners.set(listener, url);
    return () => { this.#availabilityListeners.delete(listener); };
  }

  resumeTransportRequests() {
    if (this.#destroyed) return;
    this.#blockedOrigins.clear();
    this.#originTransportFailures.clear();
    for (const [url, transportFailure] of this.#failedUrls) {
      if (transportFailure) this.#failedUrls.delete(url);
    }
    this.#notifyAvailable();
  }

  stats(): ShowPixiTextureStats {
    let ready = 0;
    let queued = 0;
    let referenced = 0;
    let mipmapped = 0;
    let lod128 = 0;
    let lod256 = 0;
    let lod512 = 0;
    for (const entry of this.#entries.values()) {
      if (entry.state === "ready") ready += 1;
      if (entry.texture?.source.autoGenerateMipmaps) mipmapped += 1;
      if (entry.state === "queued") queued += 1;
      if (entry.references > 0) referenced += 1;
      if (entry.pixelWidth <= 128) lod128 += 1;
      else if (entry.pixelWidth <= 256) lod256 += 1;
      else lod512 += 1;
    }
    return {
      entries: this.#entries.size,
      ready,
      queued,
      inFlight: this.#inFlight,
      referenced,
      reservedPixels: this.#reservedPixels,
      mipmapped,
      lod128,
      lod256,
      lod512,
      rejected: this.#rejected,
      failures: this.#failures,
      evictions: this.#evictions
    };
  }

  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#queue.length = 0;
    for (const entry of this.#entries.values()) {
      entry.controller?.abort(new DOMException("Pixi 纹理缓存已卸载", "AbortError"));
      entry.listeners.clear();
      if (entry.state === "ready") this.#unload(entry);
    }
    this.#entries.clear();
    this.#blockedOrigins.clear();
    this.#failedUrls.clear();
    this.#originTransportFailures.clear();
    this.#availabilityListeners.clear();
    this.#reservedPixels = 0;
  }

  #evictFor(requiredPixels: number) {
    const requiresEntry = requiredPixels > 0 ? 1 : 0;
    while (
      this.#entries.size + requiresEntry > this.#options.maximumEntries
      || this.#reservedPixels + requiredPixels > this.#options.maximumPixels
    ) {
      const candidate = [...this.#entries.values()]
        .filter((entry) => (
          entry.references === 0
          && entry.state !== "loading"
        ))
        .sort((left, right) => left.touchedAt - right.touchedAt)[0];
      if (!candidate) return;
      this.#evict(candidate);
    }
  }

  #pump() {
    while (
      !this.#destroyed
      && this.#inFlight < this.#options.maximumInFlight
      && this.#queue.length
    ) {
      const entry = this.#queue.shift();
      if (!entry || this.#entries.get(entry.key) !== entry) continue;
      if (this.#isBlocked(entry.url)) {
        this.#discardFailedEntry(entry, this.#isTransportBlocked(entry.url), false, false);
        continue;
      }
      if (entry.references === 0) {
        this.#entries.delete(entry.key);
        this.#reservedPixels -= entry.reservedPixels;
        continue;
      }
      entry.state = "loading";
      entry.controller = new AbortController();
      this.#inFlight += 1;
      void bitmapTexture(
        entry.url,
        entry,
        this.#options.generateMipmaps,
        entry.controller.signal
      ).then(({ bitmap, texture }) => {
        if (this.#destroyed || this.#entries.get(entry.key) !== entry) {
          bitmap?.close();
          texture.destroy(true);
          return;
        }
        const actualPixels = mipmappedPixels(
          texture.width * texture.height,
          this.#options.generateMipmaps
        );
        const projected = this.#reservedPixels
          - entry.reservedPixels
          + actualPixels;
        if (projected > this.#options.maximumPixels) {
          bitmap?.close();
          texture.destroy(true);
          this.#discardFailedEntry(entry, true, false);
          return;
        }
        this.#reservedPixels = projected;
        entry.reservedPixels = actualPixels;
        entry.bitmap = bitmap;
        entry.texture = texture;
        entry.state = "ready";
        entry.touchedAt = performance.now();
        this.#originTransportFailures.delete(this.#origin(entry.url));
        for (const listener of entry.listeners) listener(texture, false);
        entry.listeners.clear();
        // A loading entry could lose its last reference before decoding ends.
        // It only becomes evictable now, even when the idle LRU keeps it warm.
        if (entry.references === 0) this.#notifyAvailable();
      }).catch((error: unknown) => {
        if (this.#destroyed || this.#entries.get(entry.key) !== entry) return;
        if (error instanceof TextureTransportError) {
          this.#recordTransportFailure(entry.url);
        }
        const transportFailure = error instanceof TextureTransportError;
        this.#discardFailedEntry(entry, transportFailure, true, true, transportFailure);
      }).finally(() => {
        entry.controller = null;
        this.#inFlight = Math.max(0, this.#inFlight - 1);
        this.#evictFor(0);
        this.#trimUnreferenced();
        this.#pump();
      });
    }
  }

  #trimUnreferenced() {
    while (true) {
      const candidates = [...this.#entries.values()]
        .filter((entry) => entry.references === 0 && entry.state !== "loading")
        .sort((left, right) => left.touchedAt - right.touchedAt);
      if (
        candidates.length <= this.#options.maximumUnreferenced
        && this.#reservedPixels <= this.#options.maximumPixels * 0.8
      ) return;
      const candidate = candidates[0];
      if (!candidate) return;
      this.#evict(candidate);
    }
  }

  #evict(entry: TextureEntry) {
    this.#entries.delete(entry.key);
    this.#reservedPixels -= entry.reservedPixels;
    entry.listeners.clear();
    this.#evictions += 1;
    if (entry.state === "ready") this.#unload(entry);
    this.#notifyAvailable();
  }

  #unload(entry: TextureEntry) {
    entry.bitmap?.close();
    entry.bitmap = null;
    entry.texture?.destroy(true);
    entry.texture = null;
  }

  #discardFailedEntry(
    entry: TextureEntry,
    retryable: boolean,
    blockUrl: boolean,
    countFailure = true,
    transportFailure = false
  ) {
    entry.state = "failed";
    if (countFailure) this.#failures += 1;
    if (blockUrl) this.#rememberFailedUrl(entry.url, transportFailure);
    if (this.#entries.get(entry.key) === entry) {
      this.#entries.delete(entry.key);
      this.#reservedPixels = Math.max(
        0,
        this.#reservedPixels - entry.reservedPixels
      );
      entry.reservedPixels = 0;
    }
    for (const listener of entry.listeners) listener(null, retryable);
    entry.listeners.clear();
    this.#notifyAvailable();
  }

  #rememberFailedUrl(url: string, transportFailure: boolean) {
    this.#failedUrls.delete(url);
    this.#failedUrls.set(url, transportFailure);
    while (this.#failedUrls.size > this.#maximumFailedUrls) {
      const oldest = this.#failedUrls.keys().next().value;
      if (oldest === undefined) break;
      this.#failedUrls.delete(oldest);
    }
  }

  #touchFailedUrl(url: string) {
    const transportFailure = this.#failedUrls.get(url) ?? false;
    this.#failedUrls.delete(url);
    this.#failedUrls.set(url, transportFailure);
  }

  #isTransportBlocked(url: string) {
    return this.#failedUrls.get(url) === true || this.#blockedOrigins.has(this.#origin(url));
  }

  #notifyAvailable() {
    if (this.#destroyed || this.#availabilityScheduled) return;
    this.#availabilityScheduled = true;
    queueMicrotask(() => {
      this.#availabilityScheduled = false;
      if (this.#destroyed) return;
      // A card owns at most one cancellable wait. Release/online events wake
      // waiters once; unavailable requests never poll the network or ticker.
      for (const [listener, url] of [...this.#availabilityListeners]) {
        if (this.#isBlocked(url)) continue;
        this.#availabilityListeners.delete(listener);
        listener();
      }
    });
  }

  #isBlocked(url: string) {
    return this.#failedUrls.has(url)
      || this.#blockedOrigins.has(this.#origin(url));
  }

  #recordTransportFailure(url: string) {
    const origin = this.#origin(url);
    const failures = (this.#originTransportFailures.get(origin) ?? 0) + 1;
    if (failures < 3) {
      this.#originTransportFailures.set(origin, failures);
      return;
    }
    this.#originTransportFailures.delete(origin);
    this.#blockedOrigins.delete(origin);
    this.#blockedOrigins.set(origin, performance.now());
    while (this.#blockedOrigins.size > 32) {
      const oldest = this.#blockedOrigins.keys().next().value;
      if (oldest === undefined) break;
      this.#blockedOrigins.delete(oldest);
    }
  }

  #origin(url: string) {
    try {
      return new URL(url, window.location.href).origin;
    } catch {
      return url;
    }
  }
}
