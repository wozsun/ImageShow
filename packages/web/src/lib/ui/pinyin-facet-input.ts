import { match } from "pinyin-pro";
import { matchFacetText, type FacetTextMatch } from "./facet-input.js";

/** Extend literal matching without changing the displayed name or submitted slug. */
export function matchPinyinFacetText(value: string, query: string): FacetTextMatch | null {
  const literal = matchFacetText(value, query);
  if (literal) return literal;
  if (!/[a-zü]/i.test(query) || !/\p{Script=Han}/u.test(value)) return null;

  // The matcher returns UTF-16 offsets, as used by MatchedText, including both
  // code units of supplementary characters. Normalize before matching so that
  // characters whose lowercase form expands retain the same highlight offsets.
  const indices = match(value.toLowerCase(), query, {
    precision: "first",
    lastPrecision: "start",
    continuous: false,
    space: "ignore",
    v: true,
    insensitive: false
  });
  if (!indices?.length) return null;
  const ranges: [number, number][] = [];
  for (const index of indices) {
    const previous = ranges.at(-1);
    if (previous?.[1] === index) previous[1] = index + 1;
    else ranges.push([index, index + 1]);
  }
  return { rank: 3, ranges };
}
