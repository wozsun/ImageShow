import type {
  ChildProcess,
  SpawnOptions
} from "node:child_process";

export function spawnManaged(
  command: string,
  arguments_: readonly string[],
  options?: SpawnOptions
): ChildProcess;

export function signalProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  forceAfterMs?: number,
  onForcedFallback?: () => void,
  onForcedFallbackFailure?: (error: unknown) => void
): () => void;

export function releaseFailedProcessTree(child: ChildProcess): void;
export function forceTerminateProcessTree(child: ChildProcess): Promise<void>;
