import { useInsertionEffect, useLayoutEffect, useState } from "react";
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

  useInsertionEffect(() => {
    if (!enabled) return;
    // 在后台子树的布局样式被浏览器计算前提交最终颜色域，避免通用控件从
    // bootstrap 安全色过渡到管理员偏好色时产生可见中间帧。
    applyUiColorContext("admin", colorScheme, currentSystemPreference);
  }, [colorScheme, currentSystemPreference, enabled]);

  useLayoutEffect(() => {
    if (!enabled) return;
    const mediaQuery = colorScheme === "system"
      && typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      ? window.matchMedia(systemColorSchemeMediaQuery)
      : null;
    if (!mediaQuery) return;

    const handleChange = (event: MediaQueryListEvent) => {
      setSystemPrefersDark(event.matches);
    };
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [colorScheme, enabled]);

  return resolveUiColorContext("admin", colorScheme, currentSystemPreference);
}
