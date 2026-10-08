import { useRef, type CSSProperties, type RefObject } from "react";
import { Icon } from "../icon/Icon.js";
import { ProgressiveImage } from "./ProgressiveImage.js";
import { DialogFrame } from "../dialog/DialogFrame.js";

export function ImagePreviewModal({
  src,
  thumbSrc,
  alt = "图片预览",
  width,
  height,
  onClose,
  returnFocusRef
}: {
  src: string;
  thumbSrc?: string;
  alt?: string;
  width?: number;
  height?: number;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const ratio = width && height ? width / height : 16 / 9;
  const previewStyle = {
    "--image-preview-ratio": ratio,
    width: width && height ? `min(96vw, ${ratio * 92}vh)` : undefined
  } as CSSProperties;
  return (
    <DialogFrame
      className="modal image-preview-modal"
      ariaLabel="图片预览"
      closeOnBackdrop
      backdropCloseEvent="click"
      initialFocusRef={closeButtonRef}
      returnFocusRef={returnFocusRef}
      onClose={onClose}
    >
      {({ requestClose }) => (
        <>
          <ProgressiveImage
            key={src}
            imageKey={src}
            thumbSrc={thumbSrc || src}
            fullSrc={src}
            alt={alt}
            className="image-preview-image"
            style={previewStyle}
          />
          <button
            ref={closeButtonRef}
            className="icon close pressable image-preview-close"
            type="button"
            title="关闭"
            onClick={() => requestClose()}
          >
            <Icon name="close-line" />
          </button>
        </>
      )}
    </DialogFrame>
  );
}
