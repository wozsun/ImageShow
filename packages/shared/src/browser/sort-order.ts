/** Business limits for sorting writes; storage remains PostgreSQL integer. */
export const sortOrderMin = -5_000_000;
export const sortOrderMax = 5_000_000;

export type SortOrderUpdateInputDto = { sort_order: number };

export function isSortOrder(value: number) {
  return Number.isInteger(value) && value >= sortOrderMin && value <= sortOrderMax;
}
