export type BackgroundJobType =
  | "thumb.generate"
  | "move.cleanup"
  | "import.cleanup"
  | "trash.purge"
  | "cache.rebuild";

export type BackgroundJob = {
  id: string;
  type: string;
  target_id: string;
  payload: Record<string, unknown>;
  retry_count: number;
  created_at: Date | string;
};
