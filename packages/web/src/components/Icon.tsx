import React from "react";

const defaultRemixIconBaseUrl = "/assets/remixicon/v4.9.1";

export function Icon({ name }: { name: string }) {
  const iconUrl = `${defaultRemixIconBaseUrl}/${name}.svg`;
  return <span className="app-icon" style={{ "--icon-url": `url("${iconUrl}")` } as React.CSSProperties} aria-hidden="true" />;
}
