import {
  tryWithStorageLocationReadAndAdvisoryLocks,
  withStorageLocationReadAndAdvisoryLock
} from "../../storage/maintenance-lock.ts";

export function importSessionLockKey(id: string) {
  return `imageshow:import-session:${id}`;
}

export function withImportSessionLock<T>(
  id: string,
  work: (signal: AbortSignal) => Promise<T>
) {
  return withStorageLocationReadAndAdvisoryLock(importSessionLockKey(id), work);
}

export function tryWithImportSessionLock<T>(
  id: string,
  work: (signal: AbortSignal) => Promise<T>
) {
  return tryWithStorageLocationReadAndAdvisoryLocks(
    [{ key: importSessionLockKey(id), acquisition: "try" }],
    work
  );
}
