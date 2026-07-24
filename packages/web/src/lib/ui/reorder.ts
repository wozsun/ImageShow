export function moveItemByKey<Item, Key>(
  items: Item[],
  fromKey: Key,
  toKey: Key,
  getKey: (item: Item) => Key
) {
  const fromIndex = items.findIndex((item) => Object.is(getKey(item), fromKey));
  const toIndex = items.findIndex((item) => Object.is(getKey(item), toKey));
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return items;

  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}
