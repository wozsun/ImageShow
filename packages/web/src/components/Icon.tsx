import { ICONS, type IconName } from "./icons.generated.js";

// The whole icon set is inlined as a path-map (icons.generated.ts) and rendered as an inline
// <svg>, so it ships inside the hashed JS bundle: no per-icon request, fully CDN/immutable-
// cacheable, and the icon name is type-checked (IconName) instead of a free-form string — a
// typo'd or missing icon is now a compile error, not a silent runtime 404. Colour follows the
// surrounding text via fill: currentColor (.app-icon in base.css); every Remix icon shares the
// "0 0 24 24" viewBox.
export type { IconName };

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="app-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={ICONS[name]} />
    </svg>
  );
}
