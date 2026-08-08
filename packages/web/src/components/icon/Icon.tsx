import { ICONS, type IconName } from "./icons.generated.js";

export type { IconName };

export function IconGlyph({ path }: { path: string }) {
  return (
    <svg className="app-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={path} />
    </svg>
  );
}

export function Icon({ name }: { name: IconName }) {
  return <IconGlyph path={ICONS[name]} />;
}
