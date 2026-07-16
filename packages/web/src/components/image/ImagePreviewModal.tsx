import { useRef, type CSSProperties, type RefObject } from "react";
import { Icon } from "../icon/Icon.js";
import { ProgressiveImage } from "./ProgressiveImage.js";
import { useAnimatedClose } from "../../hooks/useAnimatedClose.js";
import { useBodyScrollLock } from "../../hooks/useBodyScrollLock.js";
import { useDialogFocus } from "../../hooks/useDialogFocus.js";

export function ImagePreviewModal({ src, thumbSrc, alt = "图片预览", width, height, onClose, returnFocusRef }: {
  src: string;
  thumbSrc?: string;
  alt?: string;
  width?: number;
  height?: number;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const exit = useAnimatedClose(onClose);
  useBodyScrollLock();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  useDialogFocus({
    containerRef: dialogRef,
    initialFocusRef: closeButtonRef,
    returnFocusRef,
    onEscape: () => exit.requestClose(),
  });
  const ratio = width && height ? width / height : 16 / 9;
  const previewStyle = {
    "--image-preview-ratio": ratio,
    width: width && height ? `min(96vw, ${ratio * 92}vh)` : undefined
  } as CSSProperties;
  return (
    <div
      ref={dialogRef}
      className={`modal image-preview-modal ${exit.closing ? "is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      tabIndex={-1}
      onAnimationEnd={exit.onAnimationEnd}
      onClick={() => exit.requestClose()}
    >
      <ProgressiveImage
        key={src}
        imageKey={src}
        thumbSrc={thumbSrc || src}
        fullSrc={src}
        alt={alt}
        className="image-preview-image"
        style={previewStyle}
        onClick={(event) => event.stopPropagation()}
      />
      <button
        ref={closeButtonRef}
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
