export type BackgroundJobOutcome =
  | { status: "succeeded"; result?: unknown }
  | { status: "ignored"; reason: string }
  | { status: "reschedule"; delayMs: number; result?: unknown };

export function jobSucceeded(result?: unknown): BackgroundJobOutcome {
  return { status: "succeeded", result };
}

export function jobIgnored(reason: string): BackgroundJobOutcome {
  return { status: "ignored", reason };
}

export function jobRescheduled(
  delayMs: number,
  result?: unknown
): BackgroundJobOutcome {
  return { status: "reschedule", delayMs, result };
}
