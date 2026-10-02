import { sortOrderMin, sortOrderMax } from "@imageshow/shared/browser";

// Callers supply SQL fragments from source, never request input.
export function clampSortOrderSql(expression: string) {
  return `GREATEST(${sortOrderMin}, LEAST(${expression}, ${sortOrderMax}))`;
}

export function nextSortOrderSql(
  table: "theme" | "tag" | "author" | "storage_backend",
  placement: "append" | "prepend" = "append"
) {
  const expression = placement === "append"
    ? "COALESCE(MAX(sort_order), 0)::bigint + 1"
    : "COALESCE(MIN(sort_order), 0)::bigint - 1";
  return `(SELECT ${clampSortOrderSql(expression)} FROM ${table})`;
}
