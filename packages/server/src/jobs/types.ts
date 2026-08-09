export type BackgroundJobType =
  | "move.cleanup"
  | "import.cleanup"
  | "trash.purge"
  | "cache.rebuild";

export type BackgroundJob = {
  id: string;
  type: string;
  target_id: string;
  payload: Record<string, unknown>;
  execution_token: string;
  retry_count: number;
  created_at: Date | string;
};
