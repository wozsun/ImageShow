export type ImportCleanupFailures = Map<string, unknown[]>;

export function appendImportCleanupFailure(
  failures: ImportCleanupFailures,
  id: string,
  error: unknown
) {
  const current = failures.get(id);
  if (current) current.push(error);
  else failures.set(id, [error]);
}

export function mergeImportCleanupFailures(
  target: ImportCleanupFailures,
  source: ReadonlyMap<string, readonly unknown[]>
) {
  for (const [id, errors] of source) {
    for (const error of errors) {
      appendImportCleanupFailure(target, id, error);
    }
  }
}
