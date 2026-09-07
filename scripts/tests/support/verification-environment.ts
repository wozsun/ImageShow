export const scenarioSelectorEnvironmentVariables = [
  "IMAGESHOW_DATABASE_SCENARIO",
  "IMAGESHOW_STORAGE_INGESTION_SCENARIO",
  "IMAGESHOW_WEB_QUEUE_SCENARIO"
] as const;

export function completeVerificationEnvironment(
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const completeEnvironment = { ...environment };
  for (const variable of scenarioSelectorEnvironmentVariables) {
    delete completeEnvironment[variable];
  }
  return completeEnvironment;
}
