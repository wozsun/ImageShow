export async function copyTextToClipboard(value: string) {
  const previouslyFocused = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    // 权限拒绝或非安全上下文继续使用浏览器兼容的同步复制路径。
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.readOnly = true;
  textarea.tabIndex = -1;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.cssText = "position:fixed;opacity:0;pointer-events:none;";
  document.body.append(textarea);
  try {
    textarea.focus();
    textarea.select();
    if (
      typeof document.execCommand !== "function"
      || !document.execCommand("copy")
    ) {
      throw new Error("Copy command was rejected");
    }
  } finally {
    textarea.remove();
    if (previouslyFocused?.isConnected) {
      previouslyFocused.focus({ preventScroll: true });
    }
  }
}
