export const logLevels = ["DEBUG", "INFO", "WARN", "ERROR", "OFF"] as const;

export type LogLevel = (typeof logLevels)[number];
