export type ReorderDirection = "previous" | "next";

type ReorderResult<Item> = {
  items: Item[];
  moved: boolean;
};

type ReorderPosition = {
  position: number;
  total: number;
};

function unchanged<Item>(items: Item[]): ReorderResult<Item> {
  return { items, moved: false };
}

/**
 * Moves one item to another item's position while treating fixed items as
 * immovable barriers. Pointer and keyboard sorting both use this primitive.
 */
export function reorderItemByKey<Item, Key>(
  items: Item[],
  fromKey: Key,
  toKey: Key,
  getKey: (item: Item) => Key,
  isFixed: (item: Item) => boolean = () => false
): ReorderResult<Item> {
  const fromIndex = items.findIndex((item) => Object.is(getKey(item), fromKey));
  const toIndex = items.findIndex((item) => Object.is(getKey(item), toKey));
  if (
    fromIndex < 0
    || toIndex < 0
    || fromIndex === toIndex
    || isFixed(items[fromIndex])
    || isFixed(items[toIndex])
    || items
      .slice(Math.min(fromIndex, toIndex), Math.max(fromIndex, toIndex) + 1)
      .some(isFixed)
  ) {
    return unchanged(items);
  }

  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return {
    items: next,
    moved: true
  };
}

export function reorderItemByDirection<Item, Key>(
  items: Item[],
  key: Key,
  direction: ReorderDirection,
  getKey: (item: Item) => Key,
  isFixed: (item: Item) => boolean = () => false
): ReorderResult<Item> {
  const fromIndex = items.findIndex((item) => Object.is(getKey(item), key));
  if (fromIndex < 0 || isFixed(items[fromIndex])) {
    return unchanged(items);
  }

  const targetIndex = fromIndex + (direction === "previous" ? -1 : 1);
  if (
    targetIndex < 0
    || targetIndex >= items.length
    || isFixed(items[targetIndex])
  ) {
    return unchanged(items);
  }

  return reorderItemByKey(
    items,
    key,
    getKey(items[targetIndex]),
    getKey,
    isFixed
  );
}

export function reorderPositionByKey<Item, Key>(
  items: Item[],
  key: Key,
  getKey: (item: Item) => Key,
  isFixed: (item: Item) => boolean = () => false
): ReorderPosition | null {
  const movableItems = items.filter((item) => !isFixed(item));
  const index = movableItems.findIndex((item) => Object.is(getKey(item), key));
  return index < 0
    ? null
    : { position: index + 1, total: movableItems.length };
}

export function reorderPageForKey<Key>(
  keys: Key[],
  key: Key,
  pageSize?: number
) {
  const itemIndex = keys.findIndex((candidate) => Object.is(candidate, key));
  if (itemIndex < 0) return null;
  const effectivePageSize = Math.max(
    1,
    pageSize ?? (keys.length || 1)
  );
  return Math.floor(itemIndex / effectivePageSize) + 1;
}
