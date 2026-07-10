import type { CSSProperties } from "react";
import { Icon } from "../icon/Icon.js";
import { ProgressiveImage } from "./ProgressiveImage.js";
import { useAnimatedClose } from "../../hooks/useAnimatedClose.js";
import { useBodyScrollLock } from "../../hooks/useBodyScrollLock.js";

export function ImagePreviewModal({ src, thumbSrc, alt = "图片预览", width, height, onClose }: {
  src: string;
  thumbSrc?: string;
  alt?: string;
  width?: number;
  height?: number;
  onClose: () => void;
}) {
  const exit = useAnimatedClose(onClose);
  useBodyScrollLock();
  const ratio = width && height ? width / height : 16 / 9;
  const previewStyle = {
    "--image-preview-ratio": ratio,
    width: width && height ? `min(96vw, ${ratio * 92}vh)` : undefined
  } as CSSProperties;
  return (
    <div
      className={`modal image-preview-modal ${exit.closing ? "is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
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
