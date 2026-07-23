import type { BatchImageUpdateResponse } from "@imageshow/shared/browser";
import { shortImageId } from "../../lib/ui/formatters.js";

const failureSampleLimit = 5;
const failureCodeLimit = 20;
const failureSampleMessageLimit = 160;

export function summarizeBatchUpdateFailures(response: BatchImageUpdateResponse) {
  const failures = response.results.filter(
    (result): result is Extract<typeof result, { status: "failed" }> =>
      result.status === "failed"
  );
  const codeCounts = new Map<string, number>();
  for (const failure of failures) {
    const code = failure.code.trim().slice(0, 80) || "unknown";
    codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1);
  }

  return {
    requested: response.results.length,
    failed: failures.length,
    codes: Object.fromEntries(
      [...codeCounts.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, failureCodeLimit)
    ),
    samples: failures.slice(0, failureSampleLimit).map((failure) => ({
      image: shortImageId(failure.id),
      code: failure.code.trim().slice(0, 80),
      message: failure.message.trim().slice(0, failureSampleMessageLimit)
    }))
  };
}
