import { useEffect, useRef, useState } from "react";
import { Icon } from "../../../../components/icon/Icon.js";

export function LinkImportSplitButton({ onOpenUrls, onOpenJsonl }: {
  onOpenUrls: () => void;
  onOpenJsonl: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="link-import-split" ref={rootRef}>
      <button className="button secondary upload-trigger link-import-main" type="button" onClick={onOpenUrls}>
        <Icon name="download-cloud-2-line" />链接导入
      </button>
      <button className="button secondary link-import-menu-trigger" type="button" title="更多导入方式" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Icon name="arrow-down-s-line" />
      </button>
      {open && (
        <div className="link-import-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onOpenJsonl(); }}>
            <Icon name="file-copy-line" />批量导入
          </button>
        </div>
      )}
    </div>
  );
}
