import type { RequiredPrimaryKey } from "./contract.ts";

export function sameColumns(
  actual: readonly string[],
  expected: readonly string[]
) {
  return actual.length === expected.length
    && actual.every((column, index) => column === expected[index]);
}

export function primaryKeyLabel(required: RequiredPrimaryKey) {
  return `${required.table}(${required.columns.join(", ")})`;
}
