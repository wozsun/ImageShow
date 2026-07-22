import { useLayoutEffect, useRef } from "react";
import { Link } from "react-router-dom";

const maximumNameFontSize = 20;
const minimumNameFontSize = 14;

function fitName(name: HTMLElement) {
  name.style.fontSize = `${maximumNameFontSize}px`;
  const availableWidth = name.clientWidth;
  const requiredWidth = name.scrollWidth;
  if (!availableWidth || !requiredWidth) return;

  const fittedSize = Math.max(
    minimumNameFontSize,
    Math.min(maximumNameFontSize, maximumNameFontSize * availableWidth / requiredWidth)
  );
  name.style.fontSize = `${Math.floor(fittedSize * 10) / 10}px`;
}

export function AdminBrand({
  siteName,
  applicationVersion,
  versionEnabled,
  versionLinkEnabled,
  to
}: {
  siteName: string;
  applicationVersion: string;
  versionEnabled: boolean;
  versionLinkEnabled: boolean;
  to: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLAnchorElement>(null);
  const visibleVersion = versionEnabled && applicationVersion && applicationVersion !== "unknown"
    ? applicationVersion
    : "";
  const releaseTag = `v${applicationVersion}`;
  const releaseUrl = `https://github.com/wozsun/ImageShow/releases/tag/${encodeURIComponent(releaseTag)}`;

  useLayoutEffect(() => {
    const root = rootRef.current;
    const name = nameRef.current;
    if (!root || !name) return;

    const fit = () => fitName(name);
    fit();

    const observer = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(fit);
    observer?.observe(root);

    let active = true;
    void document.fonts?.ready.then(() => {
      if (active) fit();
    });
    return () => {
      active = false;
      observer?.disconnect();
    };
  }, [siteName, visibleVersion]);

  return (
    <div
      ref={rootRef}
      className={`admin-brand${visibleVersion ? " has-version" : ""}`}
    >
      <Link ref={nameRef} className="admin-brand-name" to={to} title={siteName}>
        {siteName}
      </Link>
      {visibleVersion && versionLinkEnabled && (
        <a
          className="admin-version-slot is-link"
          href={releaseUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={`在 GitHub 打开 ImageShow ${visibleVersion} 版本发布页`}
          title={`GitHub Release ${releaseTag}`}
        >
          <span className="admin-version-badge">{visibleVersion}</span>
        </a>
      )}
      {visibleVersion && !versionLinkEnabled && (
        <span
          className="admin-version-slot"
          aria-label={`ImageShow 应用版本 ${visibleVersion}，发布页链接已关闭`}
          title={`ImageShow ${visibleVersion}`}
        >
          <span className="admin-version-badge">{visibleVersion}</span>
        </span>
      )}
    </div>
  );
}
