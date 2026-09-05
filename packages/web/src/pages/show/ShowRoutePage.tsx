import type { SiteShowSettings } from "@imageshow/shared/browser";
import { ShowPixiPage } from "./pixi/ShowPixiPage.js";

export function ShowRoutePage({
  embedded = false,
  settings
}: {
  embedded?: boolean;
  settings: SiteShowSettings;
}) {
  return <ShowPixiPage embedded={embedded} settings={settings} />;
}
