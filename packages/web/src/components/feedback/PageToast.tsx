import { useEffect, useRef } from "react";
import { Icon } from "../icon/Icon.js";

export function PageToast({ message, kind = "error", onClose }: {
  message: string;
  kind?: "error" | "success";
  onClose: () => void;
}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => closeRef.current(), 6000);
    return () => clearTimeout(timer);
  }, [message]);

  if (!message) return null;
  return (
    <div className={`page-toast page-toast-${kind}`} role="alert">
      <span className="page-toast-text">{message}</span>
      <button type="button" className="page-toast-close" aria-label="关闭" onClick={() => closeRef.current()}>
        <Icon name="close-line" />
      </button>
    </div>
  );
}
