import { useId, useMemo } from "react";
import { errorReport } from "../../lib/ui/error-report.js";
import { CopyButton } from "../actions/CopyButton.js";

/** A fixed-height record of an unexpected error, ready to copy into a report. */
export function ErrorDetails({ error }: { error: unknown }) {
  // Taken once per error, so the recorded time stays when the page re-renders.
  const report = useMemo(() => errorReport(error), [error]);
  const headingId = useId();
  return (
    <div className="error-details" role="region" aria-labelledby={headingId}>
      <div className="error-details-heading">
        <strong id={headingId}>错误详情</strong>
        <CopyButton value={report} ariaLabel="复制错误详情" variant="text" />
      </div>
      {/* Focusable so keyboard users can scroll a long report. */}
      <pre tabIndex={0}>{report}</pre>
    </div>
  );
}
