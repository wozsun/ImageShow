import { useLayoutEffect, useState } from "react";
import type { AdminColorScheme } from "@imageshow/shared/browser";
import {
  readSystemPrefersDark,
  resolveUiColorContext,
  systemColorSchemeMediaQuery
} from "../lib/ui/color-scheme.js";
import { applyUiColorContext } from "../lib/ui/apply-ui-color-context.js";

/**
 * 在后台外观可以接管启动底色后应用管理员偏好；自动模式额外订阅设备外观变化。
 * 该 Hook 不会在公开路由挂载，因此画廊内的管理弹窗不会继承后台偏好。
 */
export function useAdminColorScheme(
  colorScheme: AdminColorScheme,
  enabled = true
) {
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    readSystemPrefersDark
  );
  const currentSystemPreference = colorScheme === "system"
    ? readSystemPrefersDark()
    : systemPrefersDark;

  useLayoutEffect(() => {
    if (!enabled) return;
    const mediaQuery = colorScheme === "system"
      && typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      ? window.matchMedia(systemColorSchemeMediaQuery)
      : null;
    const apply = (prefersDark?: boolean) => {
      if (prefersDark !== undefined) setSystemPrefersDark(prefersDark);
      applyUiColorContext("admin", colorScheme, prefersDark);
    };

    apply(mediaQuery?.matches);
    if (!mediaQuery) return;

    const handleChange = (event: MediaQueryListEvent) => apply(event.matches);
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [colorScheme, enabled]);

  return resolveUiColorContext("admin", colorScheme, currentSystemPreference);
}
