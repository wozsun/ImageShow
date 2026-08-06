import { redis } from "../core/redis-client.ts";
import { logger } from "../core/logger.ts";
import { runRequiredRedisCommand } from "../core/runtime-availability.ts";
import { parseAdminCredentialVersions } from "./session-credential.ts";

const ADMIN_SESSION_PATTERN = "imageshow:session:*";
const SESSION_SCAN_COUNT = 100;

type SessionRedis = {
  scanSessions(cursor: string, pattern: string, count: number): Promise<[string, string[]]>;
  unlinkSessions(keys: string[]): Promise<number>;
};

type TargetSessionRedis = SessionRedis & {
  readSessions(keys: string[]): Promise<Array<string | null>>;
};

type RedisSessionCommands = {
  scan(
    cursor: string,
    matchToken: "MATCH",
    pattern: string,
    countToken: "COUNT",
    count: number
  ): Promise<[string, string[]]>;
  mget(...keys: string[]): Promise<Array<string | null>>;
  unlink(...keys: string[]): Promise<number>;
};

export function adminSessionRedisClient(client: RedisSessionCommands): TargetSessionRedis {
  const run = <T>(work: () => Promise<T>) => client === redis
    ? runRequiredRedisCommand(work)
    : work();
  return {
    scanSessions: (cursor, pattern, count) => run(() => client.scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      count
    )),
    readSessions: (keys) => run(() => client.mget(...keys)),
    unlinkSessions: (keys) => run(() => client.unlink(...keys))
  };
}

export async function invalidateAllAdminSessions(client: SessionRedis) {
  let cursor = "0";
  let removed = 0;
  do {
    const [nextCursor, keys] = await client.scanSessions(
      cursor,
      ADMIN_SESSION_PATTERN,
      SESSION_SCAN_COUNT
    );
    if (keys.length) removed += await client.unlinkSessions(keys);
    cursor = nextCursor;
  } while (cursor !== "0");
  return removed;
}

function sessionIdentity(raw: string | null) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as {
      username?: unknown;
      credential_versions?: unknown;
    };
    if (typeof value.username !== "string") return null;
    return {
      username: value.username,
      credentialVersions: parseAdminCredentialVersions(
        value.credential_versions
      )
    };
  } catch {
    return null;
  }
}

async function invalidateAdminSessionsByUsername(
  client: TargetSessionRedis,
  username: string,
  preservedSessionId?: string,
  validCredentialVersion?: string
) {
  const preservedKey = preservedSessionId
    ? `imageshow:session:${preservedSessionId}`
    : "";
  let cursor = "0";
  let removed = 0;
  do {
    const [nextCursor, keys] = await client.scanSessions(
      cursor,
      ADMIN_SESSION_PATTERN,
      SESSION_SCAN_COUNT
    );
    if (keys.length) {
      const values = await client.readSessions(keys);
      const targets = keys.filter((key, index) => {
        if (key === preservedKey) return false;
        const identity = sessionIdentity(values[index] ?? null);
        return identity?.username === username
          && !(
            validCredentialVersion
            && identity.credentialVersions.includes(validCredentialVersion)
          );
      });
      if (targets.length) removed += await client.unlinkSessions(targets);
    }
    cursor = nextCursor;
  } while (cursor !== "0");
  return removed;
}

export async function invalidateCommittedAdminSessionsByUsername(
  client: TargetSessionRedis,
  username: string,
  options: {
    operation: "account_delete" | "password_change" | "password_reset";
    preservedSessionId?: string;
    validCredentialVersion?: string;
  }
) {
  try {
    return await invalidateAdminSessionsByUsername(
      client,
      username,
      options.preservedSessionId,
      options.validCredentialVersion
    );
  } catch (error) {
    logger.warn("committed_admin_session_invalidation_failed", {
      operation: options.operation,
      username,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}
