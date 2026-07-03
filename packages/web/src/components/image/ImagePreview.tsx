import { Icon } from "../icon/Icon.js";
import { useAnimatedClose } from "../../hooks/useAnimatedClose.js";
import { useBodyScrollLock } from "../../hooks/useBodyScrollLock.js";

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
