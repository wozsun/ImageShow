import type { ShowImage } from "./show-layout.js";
import { shuffledImageBatch } from "../../lib/gallery/image-browse.js";

export const showContinuationLimit = 100;

export type ShowCandidateUsage = {
  dataKey: string;
  activeIds: readonly string[];
  consumedIds: readonly string[];
  available: number;
  capacity: number;
};

export type ShowDataPoolSnapshot = {
  active: number;
  available: number;
  retained: number;
};

/**
 * Owns the bounded set of DTOs used by the moving window.
 *
 * New candidates are consumed before reuse. While the stream continues,
 * consumed items stop receiving new slots and retire after their final lease.
 */
export class ShowDataPool {
  readonly #items = new Map<string, ShowImage>();
  readonly #available: string[] = [];
  readonly #availableSet = new Set<string>();
  readonly #activeBySlot = new Map<string, string>();
  readonly #activeCounts = new Map<string, number>();
  readonly #reuseOrder: string[] = [];
  readonly #consumed = new Set<string>();
  #reuseCursor = 0;
  #streaming = false;
  #randomOrder = false;
  revision = 0;

  constructor(readonly maximumRetained = 800) {}

  setStreaming(value: boolean, randomOrder: boolean) {
    this.#streaming = value;
    this.#randomOrder = randomOrder;
  }

  usage(dataKey: string): ShowCandidateUsage {
    return {
      dataKey, activeIds: [...this.#activeCounts.keys()], consumedIds: [...this.#consumed],
      available: this.#availableSet.size, capacity: this.maximumRetained
    };
  }

  reset(images: readonly ShowImage[]) {
    this.clear();
    this.add(images);
  }

  add(images: readonly ShowImage[]) {
    for (const image of images) {
      if (!image.id) continue;
      if (this.#items.has(image.id)) {
        this.#items.set(image.id, image);
        continue;
      }
      this.#evictAvailableFor(1);
      if (this.#items.size >= this.maximumRetained) break;
      this.#items.set(image.id, image);
      this.#reuseOrder.push(image.id);
      this.#available.push(image.id);
      this.#availableSet.add(image.id);
      this.revision += 1;
    }
  }

  claim(slotKey: string) {
    const currentId = this.#activeBySlot.get(slotKey);
    if (currentId) return this.#items.get(currentId) ?? null;
    while (this.#available.length) {
      const imageId = this.#available.shift();
      if (!imageId || !this.#availableSet.delete(imageId)) continue;
      const image = this.#items.get(imageId);
      if (!image) continue;
      return this.#activate(slotKey, imageId, image);
    }
    // Dense views can require more slots than the DTO budget. While awaiting
    // another batch, reuse existing references to preserve visible coverage;
    // leave released candidates free for the owner to retire.
    const imageId = this.#nextReusableId();
    if (!imageId) return null;
    const image = this.#items.get(imageId);
    return image ? this.#activate(slotKey, imageId, image) : null;
  }

  release(slotKey: string) {
    const imageId = this.#activeBySlot.get(slotKey);
    if (!imageId) return;
    this.#activeBySlot.delete(slotKey);
    this.revision += 1;
    const activeCount = this.#activeCounts.get(imageId) ?? 0;
    if (activeCount > 1) {
      this.#activeCounts.set(imageId, activeCount - 1);
      return;
    }
    this.#activeCounts.delete(imageId);
  }

  remove(imageId: string) {
    if (!this.#items.delete(imageId)) return false;
    this.revision += 1;
    this.#consumed.delete(imageId);
    this.#availableSet.delete(imageId);
    this.#activeCounts.delete(imageId);
    this.#removeFromReuseOrder(imageId);
    for (const [slotKey, activeImageId] of this.#activeBySlot) {
      if (activeImageId === imageId) this.#activeBySlot.delete(slotKey);
    }
    return true;
  }

  clear() {
    this.#items.clear();
    this.#available.length = 0;
    this.#availableSet.clear();
    this.#activeBySlot.clear();
    this.#activeCounts.clear();
    this.#reuseOrder.length = 0;
    this.#reuseCursor = 0;
    this.#consumed.clear();
    this.revision += 1;
  }

  snapshot(): ShowDataPoolSnapshot {
    return {
      active: this.#activeBySlot.size,
      available: this.#availableSet.size,
      retained: this.#items.size
    };
  }

  #evictAvailableFor(count: number) {
    let remaining = Math.max(0, this.#items.size + count - this.maximumRetained);
    for (const imageId of this.#consumed) {
      if (remaining <= 0) break;
      if (this.#activeCounts.has(imageId)) continue;
      this.remove(imageId);
      remaining -= 1;
    }
  }

  #activate(slotKey: string, imageId: string, image: ShowImage) {
    this.#consumed.add(imageId);
    this.revision += 1;
    this.#activeBySlot.set(slotKey, imageId);
    this.#activeCounts.set(
      imageId,
      (this.#activeCounts.get(imageId) ?? 0) + 1
    );
    return image;
  }

  #nextReusableId() {
    if (!this.#reuseOrder.length) return null;
    const index = this.#reuseCursor % this.#reuseOrder.length;
    if (index === 0 && this.#randomOrder && !this.#streaming) {
      this.#reuseOrder.splice(0, this.#reuseOrder.length, ...shuffledImageBatch(this.#reuseOrder));
    }
    let selected = index;
    // Let an oldest cohort drain completely. Reissuing all active IDs would
    // keep every DTO referenced forever when the scene has >800 slots.
    const draining = this.#streaming
      ? Math.min(showContinuationLimit, Math.floor(this.#reuseOrder.length / 2)) : 0;
    for (let offset = 0; offset < this.#reuseOrder.length; offset += 1) {
      const candidate = (index + offset) % this.#reuseOrder.length;
      if (candidate < draining) continue;
      const active = this.#activeCounts.has(this.#reuseOrder[candidate]!);
      if (active === this.#streaming) { selected = candidate; break; }
    }
    const imageId = this.#reuseOrder[selected];
    if (this.#streaming && (selected < draining || (imageId && !this.#activeCounts.has(imageId)))) return null;
    this.#reuseCursor = (selected + 1) % this.#reuseOrder.length;
    return imageId;
  }

  #removeFromReuseOrder(imageId: string) {
    const index = this.#reuseOrder.indexOf(imageId);
    if (index < 0) return;
    this.#reuseOrder.splice(index, 1);
    if (!this.#reuseOrder.length) {
      this.#reuseCursor = 0;
      return;
    }
    if (index < this.#reuseCursor) this.#reuseCursor -= 1;
    this.#reuseCursor %= this.#reuseOrder.length;
  }
}
