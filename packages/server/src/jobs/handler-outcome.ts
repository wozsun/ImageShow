export type BackgroundJobOutcome =
  | { status: "succeeded" }
  | { status: "reschedule"; delayMs: number };

export function jobSucceeded(): BackgroundJobOutcome {
  return { status: "succeeded" };
}

export function jobRescheduled(delayMs: number): BackgroundJobOutcome {
  return { status: "reschedule", delayMs };
}
