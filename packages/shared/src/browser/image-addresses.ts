import type { BoundImageAddress } from "./image-variants.ts";

// Only these response slots contain images. Metadata, tags and variant facts
// are never traversed. Binding happens at the HTTP boundary, before page merging.
const imageSlots = ["items", "item", "recent", "results", "duplicates", "completed_item", "session", "details"] as const;
type Node = Record<string, unknown>;
type ImageWireValue<T> = T extends { id: string; base_url: string }
  ? Omit<T, "base_url"> & { base_index?: number }
  : T extends readonly (infer Item)[] ? ImageWireValue<Item>[]
  : T extends object ? { [Key in keyof T]: ImageWireValue<T[Key]> } : T;
export type ImageWireResponse<T> = ImageWireValue<T> & { base_urls?: string[] };

function mapImages(value: unknown, image: (node: Node) => Node): unknown {
  if (Array.isArray(value)) return value.map((entry) => mapImages(entry, image));
  if (!value || typeof value !== "object") return value;
  const node = value as Node;
  if (typeof node.id === "string" && (
    "base_url" in node || "base_index" in node ||
    "variants" in node || "title" in node && "width" in node
  )) {
    return image(node);
  }
  let copy: Node | undefined;
  for (const slot of imageSlots) {
    if (!(slot in node)) continue;
    copy ??= { ...node };
    copy[slot] = mapImages(node[slot], image);
  }
  return copy ?? node;
}

/** Wire responses share one address table; image records carry only a 1-based index. */
export function packImageAddresses<T extends object>(value: T): ImageWireResponse<T> {
  const bases: string[] = [];
  const indexes = new Map<string, number>();
  const images: Node[] = [];
  const mapped = mapImages(value, (node) => {
    if (typeof node.base_url !== "string") return node;
    const { base_url: base, ...item } = node;
    let index = indexes.get(base);
    if (index === undefined) {
      bases.push(base);
      index = bases.length;
      indexes.set(base, index);
    }
    item.base_index = index;
    images.push(item);
    return item;
  }) as Node;
  if (!bases.length) return mapped as ImageWireResponse<T>;
  if (bases.length === 1) for (const item of images) delete item.base_index;
  return { ...mapped, base_urls: bases } as ImageWireResponse<T>;
}

/** Internal/UI DTOs bind the response's address table once, without expanding URLs. */
export function unpackImageAddresses<T>(value: T): T {
  if (!value || typeof value !== "object" || !("base_urls" in value)) return value;
  const { base_urls: bases, ...body } = value as Node;
  if (!Array.isArray(bases) || !bases.length || !bases.every((base) => typeof base === "string" && base.length > 0)) {
    throw new TypeError("Invalid image address table");
  }
  return mapImages(body, (node) => {
    const { base_index: rawIndex, ...item } = node;
    const index = bases.length === 1 ? rawIndex ?? 1 : rawIndex;
    if (!Number.isInteger(index) || Number(index) < 1 || Number(index) > bases.length) {
      throw new TypeError("Invalid image address index");
    }
    return { ...item, base_url: bases[Number(index) - 1] } as BoundImageAddress & Node;
  }) as T;
}
