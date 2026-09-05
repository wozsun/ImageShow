import type { ShowImage } from "./show-layout.js";

export type ShowDataPoolSnapshot = {
  active: number;
  available: number;
  retained: number;
};

export function shuffledShowImages(
  images: readonly ShowImage[],
  random: () => number = Math.random
) {
  const result = [...images];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

/**
 * Owns the bounded set of DTOs used by the moving window.
 *
 * Every retained DTO is used once before the shuffled set repeats. Released
 * DTOs return to the available tail; repetition begins only when a finite
 * filtered gallery cannot fill every simultaneous spatial slot.
 */
export class ShowDataPool {
  readonly #items = new Map<string, ShowImage>();
  readonly #available: string[] = [];
  readonly #availableSet = new Set<string>();
  readonly #activeBySlot = new Map<string, string>();
  readonly #activeCounts = new Map<string, number>();
  readonly #reuseOrder: string[] = [];
  #reuseCursor = 0;

  constructor(readonly maximumRetained = 800) {}

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
    // The bounded high-density view can request more simultaneous slots than a
    // finite filtered gallery owns. Preserve the no-repeat fast path above,
    // then cycle the already-shuffled retained set only when it is exhausted.
    const imageId = this.#nextReusableId();
    if (!imageId) return null;
    const image = this.#items.get(imageId);
    return image ? this.#activate(slotKey, imageId, image) : null;
  }

  release(slotKey: string) {
    const imageId = this.#activeBySlot.get(slotKey);
    if (!imageId) return;
    this.#activeBySlot.delete(slotKey);
    const activeCount = this.#activeCounts.get(imageId) ?? 0;
    if (activeCount > 1) {
      this.#activeCounts.set(imageId, activeCount - 1);
      return;
    }
    this.#activeCounts.delete(imageId);
    if (!this.#items.has(imageId) || this.#availableSet.has(imageId)) return;
    this.#available.push(imageId);
    this.#availableSet.add(imageId);
  }

  remove(imageId: string) {
    if (!this.#items.delete(imageId)) return false;
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
    while (remaining > 0 && this.#available.length) {
      const imageId = this.#available.shift();
      if (!imageId || !this.#availableSet.delete(imageId)) continue;
      this.#items.delete(imageId);
      this.#removeFromReuseOrder(imageId);
      remaining -= 1;
    }
  }

  #activate(slotKey: string, imageId: string, image: ShowImage) {
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
    const imageId = this.#reuseOrder[index];
    this.#reuseCursor = (index + 1) % this.#reuseOrder.length;
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
