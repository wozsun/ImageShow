import { useEffect, useRef, useState } from "react";
import { Icon } from "../icon/Icon.js";

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {

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

export function CopyButton({ value, ariaLabel = "复制内容" }: { value: string; ariaLabel?: string }) {
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
      aria-label={copied ? `${ariaLabel}成功，可再次复制` : failed ? `${ariaLabel}失败，可重试` : ariaLabel}
      onClick={() => void handleCopy()}
    >
      <Icon name={copied ? "check-line" : failed ? "close-line" : "file-copy-line"} />
    </button>
  );
}
