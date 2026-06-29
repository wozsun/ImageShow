import { useEffect, useRef } from "react";
import { Icon } from "./Icon.js";

// A floating notice pinned to the viewport's top-right corner — used for server errors and
// other one-off feedback that shouldn't push the page layout around. Renders nothing when the
// message is empty, auto-dismisses after a few seconds, and can also be closed by hand. The
// caller owns the message state (set it to show, clear it to hide); re-setting the same text
// after a clear re-shows it, since the empty string in between counts as a change.
export function PageToast({ message, kind = "error", onClose }: {
  message: string;
  kind?: "error" | "success";
  onClose: () => void;
}) {
  // Keep the latest onClose without making it an effect dependency, so the auto-dismiss timer is
  // keyed purely on the message (it resets when a new message arrives, not on every render).
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
