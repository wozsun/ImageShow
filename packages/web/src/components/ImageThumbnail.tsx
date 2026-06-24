import { ThumbImage } from "./ThumbImage.js";

export function ImageThumbnail({ src, alt = "", size = "normal", className = "" }: {
  src: string;
  alt?: string;
  size?: "normal" | "small";
  className?: string;
}) {
  return (
    <div className={`image-thumbnail ${size === "small" ? "is-small" : ""} ${className}`.trim()}>
      <ThumbImage src={src} alt={alt} />
    </div>
  );
}
