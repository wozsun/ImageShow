export type BackgroundJobOutcome =
  | { status: "succeeded" }
  | { status: "ignored"; reason: string }
  | { status: "reschedule"; delayMs: number };

export function jobSucceeded(): BackgroundJobOutcome {
  return { status: "succeeded" };
}

export function jobIgnored(reason: string): BackgroundJobOutcome {
  return { status: "ignored", reason };
}

export function jobRescheduled(delayMs: number): BackgroundJobOutcome {
  return { status: "reschedule", delayMs };
}
