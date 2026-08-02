import {
  defaultAdminPreferences,
  type AdminColorScheme
} from "@imageshow/shared/browser";

export type BrowserColorScheme = "dark" | "light";
export type UiColorContext = "bootstrap" | "public" | "admin";
export type AdminColorSchemeCycle = Readonly<{
  expectedColorScheme: BrowserColorScheme;
  returnToSystemAfter: BrowserColorScheme;
}>;

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

function oppositeColorScheme(colorScheme: BrowserColorScheme) {
  return colorScheme === "dark" ? "light" : "dark";
}

/**
 * 自动模式先进入实际明暗的反相，再遍历另一显式模式，最后回到自动。
 */
export function nextAdminColorScheme(
  colorScheme: AdminColorScheme,
  resolvedColorScheme: BrowserColorScheme,
  cycle: AdminColorSchemeCycle | null
): AdminColorScheme {
  if (colorScheme === "system") {
    return oppositeColorScheme(resolvedColorScheme);
  }
  if (
    cycle?.expectedColorScheme === colorScheme
    && cycle.returnToSystemAfter === colorScheme
  ) {
    return "system";
  }
  return oppositeColorScheme(colorScheme);
}

/**
 * 记录当前标签页发起的显式模式序列；第二个显式模式之后才回到自动。
 */
export function advanceAdminColorSchemeCycle(
  colorScheme: AdminColorScheme,
  resolvedColorScheme: BrowserColorScheme,
  nextColorScheme: AdminColorScheme
): AdminColorSchemeCycle | null {
  if (nextColorScheme === "system") return null;
  return {
    expectedColorScheme: nextColorScheme,
    returnToSystemAfter: colorScheme === "system"
      ? resolvedColorScheme
      : nextColorScheme
  };
}

/**
 * 偏好被其他标签页或设备改到非预期值时丢弃本地序列，避免旧状态复活。
 */
export function reconcileAdminColorSchemeCycle(
  colorScheme: AdminColorScheme,
  cycle: AdminColorSchemeCycle | null
) {
  return cycle?.expectedColorScheme === colorScheme ? cycle : null;
}
