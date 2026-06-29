import { ThumbImage } from "./ThumbImage.js";

// A fixed-box thumbnail. Pass `onClick` to make it click-to-preview (it becomes a
// keyboard-focusable button with a zoom cursor) — used by the upload/edit/batch cards;
// without it the thumbnail is a plain static image, as on the gallery and list pages.
export function ImageThumbnail({ src, alt = "", size = "normal", className = "", onClick }: {
  src: string;
  alt?: string;
  size?: "normal" | "small";
  className?: string;
  onClick?: () => void;
}) {
  const interactive = Boolean(onClick);
  return (
    <div
      className={`image-thumbnail ${size === "small" ? "is-small" : ""} ${className} ${interactive ? "is-clickable" : ""}`.trim()}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      title={interactive ? "点击预览" : undefined}
      onClick={onClick}
      onKeyDown={interactive ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onClick!(); } } : undefined}
    >
      <ThumbImage src={src} alt={alt} />
    </div>
  );
}
