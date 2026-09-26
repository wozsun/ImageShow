import type {
  ImageVariant, PreparationMode, PreparationProfile, PreparationState, PreparedVariantFacts
} from "@imageshow/shared/browser";

export type SourceSnapshot = { original: string; storage_slug: string; storage_type: string };
export type ProcessIdentity = { pid: number; start: string; boot: string; namespace: string };
export type PreparationRun = {
  id: string;
  status: string;
  execution_token: string | null;
  payload: {
    profile: PreparationProfile;
    fingerprint: string;
    revision: number;
    desired_state: "running" | "stopped";
    execution_mode: PreparationMode;
    concurrency: number;
    block: string | null;
    cursor: string | null;
    enumerated: boolean;
    reconcile_requested: boolean;
    rerun_requested?: boolean;
    completed_attempts: number;
    next_short: number;
    next_long: number;
    rest: { kind: "short" | "long"; seconds: number; deadline: string | null } | null;
    verified_at: string | null;
    verification: number;
    owner: ProcessIdentity | null;
    max_output_bytes: number;
  };
};
export type PreparedReceipt = {
  fingerprint: string;
  candidate: string;
  expected?: PreparedVariantFacts;
  facts?: PreparedVariantFacts;
  owner_run: string;
  owner_attempt: string;
  input_sha256: string;
  replaced?: { run_id: string; sha256: string; facts: PreparedVariantFacts };
};
export type PreparationRecord = {
  run_id: string;
  image_id: string;
  state: PreparationState;
  updated_at: Date;
  data: {
    source: SourceSnapshot;
    input?: { path: string; sha256: string; bytes: number };
    phase: string;
    token: string | null;
    child: ProcessIdentity | null;
    cache_path?: string;
    attempt: string;
    counted: boolean;
    retries: number;
    error: string;
    next_retry_at: string | null;
    verified: number;
    exclusion_cleaned?: boolean;
    variants: Partial<Record<ImageVariant, PreparedReceipt>>;
  };
};

export function sameSource(a: SourceSnapshot, b: SourceSnapshot) {
  return a.original === b.original && a.storage_slug === b.storage_slug && a.storage_type === b.storage_type;
}
