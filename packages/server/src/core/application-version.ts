import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let cachedApplicationVersion: string | undefined;

export function applicationVersion() {
  if (cachedApplicationVersion) return cachedApplicationVersion;
  try {
    const packagePath = fileURLToPath(
      new URL("../../../../package.json", import.meta.url)
    );
    const value = JSON.parse(readFileSync(packagePath, "utf8")) as {
      version?: unknown;
    };
    cachedApplicationVersion = typeof value.version === "string" && value.version
      ? value.version
      : "unknown";
  } catch {
    cachedApplicationVersion = "unknown";
  }
  return cachedApplicationVersion;
}
