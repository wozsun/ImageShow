import { useLayoutEffect, useRef, useState } from "react";

function sameKeys<Key>(left: ReadonlySet<Key>, right: ReadonlySet<Key>) {
  return left.size === right.size && [...left].every((key) => right.has(key));
}

/** The cards for the second column so both columns end as close as possible. */
function balancedSecondColumn<Key>(keys: readonly Key[], heights: readonly number[]) {
  const total = heights.reduce((sum, height) => sum + height, 0);
  let best = 0;
  let bestDifference = Number.POSITIVE_INFINITY;
  // There are about ten cards, so every split is tried. The first card stays
  // in the first column: swapping the columns gives the same split.
  for (let split = 0; split < 1 << (keys.length - 1); split += 1) {
    let second = 0;
    for (let index = 1; index < keys.length; index += 1) {
      if (split & (1 << (index - 1))) second += heights[index]!;
    }
    const difference = Math.abs(total - 2 * second);
    if (difference < bestDifference) {
      bestDifference = difference;
      best = split;
    }
  }
  return new Set(keys.filter((_, index) => index > 0 && best & (1 << (index - 1))));
}

/**
 * Splits half-width cards between two columns by their measured heights, each
 * column keeping the declared order. It runs on mount and when the columns
 * change width, never when a card grows while being edited, so a card does not
 * jump to the other column under the cursor. A single-column layout keeps the
 * declared order. Cards carry `data-balanced-card` with their key.
 */
export function useBalancedColumns<Key extends string>(keys: readonly Key[]) {
  const columnsRef = useRef<HTMLDivElement>(null);
  const [secondColumn, setSecondColumn] = useState<ReadonlySet<Key>>(() => new Set());
  useLayoutEffect(() => {
    const columns = columnsRef.current;
    if (!columns) return;
    const balance = () => {
      let next = new Set<Key>();
      if (getComputedStyle(columns).gridTemplateColumns.split(" ").length > 1) {
        const firstColumn = columns.firstElementChild;
        const gap = firstColumn ? parseFloat(getComputedStyle(firstColumn).rowGap) || 0 : 0;
        next = balancedSecondColumn(keys, keys.map((key) =>
          (columns.querySelector(`[data-balanced-card="${key}"]`)?.getBoundingClientRect().height ?? 0) + gap
        ));
      }
      setSecondColumn((current) => (sameKeys(current, next) ? current : next));
    };
    balance();
    let width = columns.clientWidth;
    const observer = new ResizeObserver(() => {
      if (columns.clientWidth === width) return;
      width = columns.clientWidth;
      balance();
    });
    observer.observe(columns);
    return () => observer.disconnect();
  }, [keys]);
  return { columnsRef, secondColumn };
}
