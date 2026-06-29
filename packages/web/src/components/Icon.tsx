import React from "react";

// Served from a neutral path so the URL doesn't disclose the upstream icon set or its
// version; the SVGs are copied into public/assets/icons at build time (copy-assets.mjs).
const iconBaseUrl = "/assets/icons";

export function Icon({ name }: { name: string }) {
  const iconUrl = `${iconBaseUrl}/${name}.svg`;
  return (
    <span
      className="app-icon"
      style={{ "--icon-url": `url("${iconUrl}")` } as React.CSSProperties}
      aria-hidden="true"
    />
  );
}
