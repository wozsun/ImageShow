import type { FacetSuggestion, FacetTextMatch } from "../../lib/ui/facet-input.js";

export function MatchedText({ text, match }: { text: string; match: FacetTextMatch | null }) {
  if (!match) return text;

  const parts: { text: string; matched: boolean }[] = [];
  let offset = 0;
  let rangeIndex = 0;
  for (const character of text) {
    // Lowercasing can expand a character; ranges refer to the normalized text.
    const end = offset + character.toLowerCase().length;
    while (rangeIndex < match.ranges.length && match.ranges[rangeIndex]![1] <= offset) rangeIndex++;
    const range = match.ranges[rangeIndex];
    const matched = range !== undefined && range[0] < end;
    const previous = parts.at(-1);
    if (previous?.matched === matched) previous.text += character;
    else parts.push({ text: character, matched });
    offset = end;
  }
  return parts.map((part, index) => part.matched ? <b key={index}>{part.text}</b> : part.text);
}

export function FacetSuggestionLabel({ option }: { option: FacetSuggestion }) {
  return <>
    <span><MatchedText text={option.slug} match={option.slugMatch} /></span>
    {option.display_name && option.display_name !== option.slug && (
      <span className="option-display-name">
        <MatchedText text={option.display_name} match={option.displayNameMatch} />
      </span>
    )}
  </>;
}
