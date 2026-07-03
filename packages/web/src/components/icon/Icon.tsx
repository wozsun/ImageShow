import { ICONS, type IconName } from "./icons.generated.js";

export type { IconName };

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="app-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={ICONS[name]} />
    </svg>
  );
}
