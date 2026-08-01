import {
  defaultAdminPreferences,
  type AdminColorScheme
} from "@imageshow/shared/browser";

export type BrowserColorScheme = "dark" | "light";
export type UiColorContext = "bootstrap" | "public" | "admin";

export const systemColorSchemeMediaQuery = "(prefers-color-scheme: dark)";

export function readSystemPrefersDark() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return true;
  }
  return window.matchMedia(systemColorSchemeMediaQuery).matches;
}

function resolveAdminColorScheme(
  colorScheme: AdminColorScheme,
  systemPrefersDark: boolean
): BrowserColorScheme {
  if (colorScheme === "system") {
    return systemPrefersDark ? "dark" : "light";
  }
  return colorScheme;
}

export function resolveUiColorContext(
  uiContext: UiColorContext,
  adminColorScheme: AdminColorScheme = defaultAdminPreferences.color_scheme,
  systemPrefersDark = true
): BrowserColorScheme {
  return uiContext === "admin"
    ? resolveAdminColorScheme(adminColorScheme, systemPrefersDark)
    : "dark";
}

/**
 * 每组外观切换先到当前实际明暗的相反模式，下一次再回到自动模式。
 */
export function nextAdminColorScheme(
  resolvedColorScheme: BrowserColorScheme,
  systemIsNext: boolean
): AdminColorScheme {
  if (systemIsNext) return "system";
  return resolvedColorScheme === "dark" ? "light" : "dark";
}

/**
 * “下一步回到自动”只属于刚由当前标签页提交的显式模式。偏好一旦被其他
 * 标签页或设备改到别的值，旧标记即失效，之后即使回到同值也不能复活。
 */
export function reconcileSystemNextAfter(
  colorScheme: AdminColorScheme,
  systemNextAfter: BrowserColorScheme | null
) {
  return systemNextAfter === colorScheme ? systemNextAfter : null;
}
