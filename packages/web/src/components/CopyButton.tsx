import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon.js";

export async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall back for browsers that expose Clipboard API but deny access.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.readOnly = true;
  textarea.style.cssText = "position:fixed;opacity:0;pointer-events:none;";
  document.body.append(textarea);
  textarea.focus();
  textarea.select();
  try {
    if (!document.execCommand("copy")) throw new Error("Copy command was rejected");
  } finally {
    textarea.remove();
  }
}

export function CopyButton({ value }: { value: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const resetTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  const handleCopy = async () => {
    try {
      await copyText(value);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
    window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setStatus("idle"), 3000);
  };

  const copied = status === "copied";
  const failed = status === "failed";

  return (
    <button
      className={`copy-button ${copied ? "is-copied" : failed ? "is-failed" : ""}`}
      type="button"
      title={copied ? "已复制" : failed ? "复制失败" : "复制"}
      aria-label={copied ? "已复制，可再次复制" : failed ? "复制失败，可重试" : "复制随机图片链接"}
      onClick={() => void handleCopy()}
    >
      <Icon name={copied ? "check-line" : failed ? "close-line" : "file-copy-line"} />
    </button>
  );
}
