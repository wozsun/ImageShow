import {
  mkdirSync,
  mkdtempSync
} from "node:fs";
import {
  rm
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";

export const temporaryTestRoot = resolve(import.meta.dirname, "../../../tests/tmp");
const registeredTestDirectories = new Set<string>();
let interruptionCleanupStarted = false;

function assertTestDirectoryRegistrationOpen() {
  if (interruptionCleanupStarted) {
    throw new Error("测试临时目录中断清理已开始，不能再注册新目录");
  }
}

export function registerTestDirectory(directory: string) {
  assertTestDirectoryRegistrationOpen();
  const target = resolve(directory);
  const relativeTarget = relative(temporaryTestRoot, target);
  if (
    !relativeTarget
    || relativeTarget === ".."
    || relativeTarget.startsWith(`..${sep}`)
    || isAbsolute(relativeTarget)
  ) {
    throw new Error(`测试临时目录必须位于 ${temporaryTestRoot} 内：${target}`);
  }
  registeredTestDirectories.add(target);
  return target;
}

export async function createTestDirectory(prefix: string) {
  // Keep creation and registration in one synchronous turn. An interrupt can
  // therefore never snapshot the registry after the directory exists but
  // before its cleanup owner is recorded.
  assertTestDirectoryRegistrationOpen();
  mkdirSync(temporaryTestRoot, { recursive: true });
  return registerTestDirectory(mkdtempSync(join(temporaryTestRoot, prefix)));
}

export function sealTestDirectoryRegistrationForInterruption() {
  interruptionCleanupStarted = true;
}

export async function cleanupTestDirectories() {
  const directories = [...registeredTestDirectories];
  const results = await Promise.allSettled(
    directories.map((directory) => rm(directory, { recursive: true, force: true }))
  );
  const errors: unknown[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      registeredTestDirectories.delete(directories[index]!);
    } else {
      errors.push(result.reason);
    }
  });
  if (errors.length > 0) {
    throw new AggregateError(errors, "测试临时目录未能全部删除");
  }
}
