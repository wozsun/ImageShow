import {
  defaultAdminPreferences,
  type AdminColorScheme
} from "@imageshow/shared/browser";
import {
  readSystemPrefersDark,
  resolveUiColorContext,
  type UiColorContext
} from "./color-scheme.js";

function ensureMeta(name: string) {
  let meta = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = name;
    document.head.appendChild(meta);
  }
  return meta;
}

function syncBrowserSurface(root: HTMLElement) {
  const styles = getComputedStyle(root);
  const browserCanvas = styles.getPropertyValue("--color-browser-canvas").trim();
  const resolvedBackground = styles.backgroundColor.trim();
  ensureMeta("theme-color").content = resolvedBackground || browserCanvas;
}

/**
 * 只有完整后台可以消费管理员外观偏好。启动、公开首页、画廊及由画廊打开的
 * 管理弹窗都由顶层公开颜色域锁定为暗色。
 */
export function applyUiColorContext(
  uiContext: UiColorContext,
  adminColorScheme: AdminColorScheme = defaultAdminPreferences.color_scheme,
  systemPrefersDark?: boolean
) {
  const resolvedSystemPreference = systemPrefersDark
    ?? (uiContext === "admin" && adminColorScheme === "system"
      ? readSystemPrefersDark()
      : true);
  const appearance = resolveUiColorContext(
    uiContext,
    adminColorScheme,
    resolvedSystemPreference
  );
  const root = document.documentElement;
  root.dataset.uiContext = uiContext;
  root.dataset.colorScheme = appearance;
  root.classList.toggle("public-page-document", uiContext === "public");
  ensureMeta("color-scheme").content = appearance;
  syncBrowserSurface(root);
  return appearance;
}
