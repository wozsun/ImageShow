import { ThumbImage } from "./ThumbImage.js";

export function ImageThumbnail({ src, alt = "", size = "normal", className = "", onClick }: {
  src: string;
  alt?: string;
  size?: "normal" | "small";
  className?: string;
  onClick?: (opener: HTMLElement) => void;
}) {
  const interactive = Boolean(onClick);
  return (
    <div
      className={`image-thumbnail ${size === "small" ? "is-small" : ""} ${className} ${interactive ? "is-clickable" : ""}`.trim()}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      title={interactive ? "点击预览" : undefined}
      onClick={onClick ? (event) => onClick(event.currentTarget) : undefined}
      onKeyDown={interactive ? (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick!(event.currentTarget);
        }
      } : undefined}
    >
      <ThumbImage src={src} alt={alt} />
    </div>
  );
}
