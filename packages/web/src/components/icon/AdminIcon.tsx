import {
  ADMIN_ICONS,
  type AdminOnlyIconName
} from "./admin-icons.generated.js";
import { ICONS, type IconName } from "./icons.generated.js";
import { IconGlyph } from "./Icon.js";

export type AdminIconName = IconName | AdminOnlyIconName;

function isAdminOnlyIconName(name: AdminIconName): name is AdminOnlyIconName {
  return Object.hasOwn(ADMIN_ICONS, name);
}

export function AdminIcon({ name }: { name: AdminIconName }) {
  const path = isAdminOnlyIconName(name) ? ADMIN_ICONS[name] : ICONS[name];
  return <IconGlyph path={path} />;
}
