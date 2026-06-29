import { Icon } from "./Icon.js";
import { useAnimatedClose } from "./useAnimatedClose.js";
import { useBodyScrollLock } from "./useBodyScrollLock.js";

// A minimal image lightbox: one image, centered over a dimmed backdrop, click anywhere
// (or the close button) to dismiss. Used by the editing windows (upload / edit / batch
// edit) so a card's left thumbnail is click-to-preview — these cards either have no saved
// ImageItem yet (uploads) or want a quick look without the metadata-heavy ImageDetailModal.
export function ImagePreview({ src, alt = "图片预览", onClose }: { src: string; alt?: string; onClose: () => void }) {
  const exit = useAnimatedClose(onClose);
  useBodyScrollLock();
  return (
    <div
      className={`modal image-preview-modal ${exit.closing ? "is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      onAnimationEnd={exit.onAnimationEnd}
      onClick={() => exit.requestClose()}
    >
      <img
        src={src}
        alt={alt}
        referrerPolicy="no-referrer"
        onClick={(event) => event.stopPropagation()}
      />
      <button
        className="icon close pressable image-preview-close"
        type="button"
        title="关闭"
        onClick={() => exit.requestClose()}
      >
        <Icon name="close-line" />
      </button>
    </div>
  );
}
