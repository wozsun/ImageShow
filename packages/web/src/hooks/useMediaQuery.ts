import { useEffect, useState } from "react";

/** 与全局响应式样式共用的移动端断点。 */
export const mobileViewportMediaQuery = "(max-width: 760px)";

function mediaQueryMatches(query: string) {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(query).matches;
}

/**
 * 将 CSS 媒体查询同步为 React 状态，用于确实需要改变组件挂载位置的场景。
 * 纯视觉差异仍应留给 CSS；这里保证首帧就采用当前视口，避免响应式宿主闪动。
 */
export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => mediaQueryMatches(query));

  useEffect(() => {
    const mediaQuery = window.matchMedia(query);
    const updateMatches = () => setMatches(mediaQuery.matches);

    updateMatches();
    mediaQuery.addEventListener("change", updateMatches);
    return () => mediaQuery.removeEventListener("change", updateMatches);
  }, [query]);

  return matches;
}
