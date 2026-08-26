export const backgroundJobTypes = [
  "move.cleanup",
  "trash.purge",
  "cache.rebuild"
] as const;

export type BackgroundJobType = (typeof backgroundJobTypes)[number];

const backgroundJobTypeSet: ReadonlySet<string> = new Set(backgroundJobTypes);

export function parseBackgroundJobType(value: unknown): BackgroundJobType {
  if (typeof value !== "string" || !backgroundJobTypeSet.has(value)) {
    throw new Error(`Unsupported background job type: ${String(value)}`);
  }
  return value as BackgroundJobType;
}

export type BackgroundJob = {
  id: string;
  type: BackgroundJobType;
  target_id: string;
  payload: Record<string, unknown>;
  execution_token: string;
  retry_count: number;
  created_at: Date | string;
};
