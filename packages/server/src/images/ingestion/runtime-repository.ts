import { IngestionSessionRepository } from "./repository.ts";

// Own the shared repository here so cleanup can use it without importing runtime.ts and its Worker assembly.
export const ingestionSessionRepository = new IngestionSessionRepository();
