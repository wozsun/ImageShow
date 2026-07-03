import React from "react";

export function ProgressBar({ durationMs = 1_000, indeterminate = false }: { durationMs?: number; indeterminate?: boolean }) {
  const style = indeterminate ? undefined : ({ "--progress-duration": `${Math.max(0, durationMs)}ms` } as React.CSSProperties);
  return <div className={`preview-progress ${indeterminate ? "indeterminate" : ""}`} style={style} />;
}
