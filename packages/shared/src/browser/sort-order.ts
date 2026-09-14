/** Stored sorting values use PostgreSQL integer; larger values appear first. */
export const sortOrderMin = -2147483648;
export const sortOrderMax = 2147483647;

export type SortOrderUpdateInputDto = { sort_order: number };

export function isSortOrder(value: number) {
  return Number.isInteger(value) && value >= sortOrderMin && value <= sortOrderMax;
}
