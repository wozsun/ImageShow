export const publicNavigationTopRevealThreshold = 26;
export const publicNavigationTopEdgeRevealHeight = 36;
export const publicNavigationAutoHideDelayMs = 3_000;
export const publicNavigationHeaderHideThreshold = 32;
export const publicNavigationHeaderRevealThreshold = 32;

export function isPublicNavigationInteracting(navigation: HTMLElement) {
  // 关闭弹窗归还的指针焦点不代表仍在操作导航；键盘可见焦点继续保护导航。
  // 触屏的粘滞 hover 不参与判断。
  return navigation.matches(":focus-visible")
    || navigation.querySelector(":focus-visible") !== null
    || (window.matchMedia("(hover: hover) and (pointer: fine)").matches
      && navigation.matches(":hover"));
}
