import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { runtimePaths } from "../config/bootstrap-env.ts";

const defaultActiveServerPortFile = join(
  runtimePaths.configDirectory,
  ".active-server-port"
);

function validatedPort(value: unknown) {
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Invalid active listening port marker");
  }
  return port;
}

export function writeActiveServerPort(
  port: number,
  path = defaultActiveServerPortFile
) {
  const validated = validatedPort(port);
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, `${validated}\n`, { mode: 0o600 });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export function readActiveServerPort(path = defaultActiveServerPortFile) {
  return validatedPort(readFileSync(path, "utf8").trim());
}
