import { redis } from "../core/redis-client.ts";
import { logger } from "../core/logger.ts";
import { runRequiredRedisCommand } from "../core/runtime-availability.ts";
import { parseAdminCredentialVersions } from "./session-credential.ts";
import {
  adminSessionKey,
  adminSessionKeyPattern
} from "./admin-session-key.ts";

const SESSION_SCAN_COUNT = 100;
const unlinkSessionsIfUnchangedScript = `
local removed = 0
for index = 1, #KEYS do
  if redis.call('GET', KEYS[index]) == ARGV[index] then
    removed = removed + redis.call('UNLINK', KEYS[index])
  end
end
return removed
`;

type SessionSnapshot = {
  key: string;
  value: string;
};

type TargetSessionInvalidation =
  | {
    operation: "password_change";
    preservedSessionId: string;
    staleCredentialVersion: string;
    validCredentialVersion: string;
  }
  | {
    operation: "password_reset";
    preservedSessionId?: never;
    staleCredentialVersion: string;
    validCredentialVersion: string;
  }
  | {
    operation: "account_delete";
    preservedSessionId?: never;
    staleCredentialVersion: string;
    validCredentialVersion?: never;
  };

type SessionRedis = {
  scanSessions(cursor: string, pattern: string, count: number): Promise<[string, string[]]>;
  unlinkSessions(keys: string[]): Promise<number>;
};

type TargetSessionRedis = SessionRedis & {
  readSessions(keys: string[]): Promise<Array<string | null>>;
  unlinkSessionsIfUnchanged(
    snapshots: SessionSnapshot[]
  ): Promise<number>;
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
  eval(
    script: string,
    numberOfKeys: number,
    ...arguments_: string[]
  ): Promise<unknown>;
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
    unlinkSessions: (keys) => run(() => client.unlink(...keys)),
    unlinkSessionsIfUnchanged: (snapshots) => run(async () => Number(
      await client.eval(
        unlinkSessionsIfUnchangedScript,
        snapshots.length,
        ...snapshots.map(({ key }) => key),
        ...snapshots.map(({ value }) => value)
      )
    ))
  };
}

export async function invalidateAllAdminSessions(client: SessionRedis) {
  let cursor = "0";
  let removed = 0;
  do {
    const [nextCursor, keys] = await client.scanSessions(
      cursor,
      adminSessionKeyPattern,
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
    const credentialVersions = parseAdminCredentialVersions(
      value.credential_versions
    );
    if (typeof value.username !== "string" || !credentialVersions) return null;
    return {
      username: value.username,
      credentialVersions
    };
  } catch {
    return null;
  }
}

async function invalidateAdminSessionsByUsername(
  client: TargetSessionRedis,
  username: string,
  staleCredentialVersion: string,
  preservedSessionId?: string,
  validCredentialVersion?: string
) {
  const preservedKey = preservedSessionId
    ? adminSessionKey(preservedSessionId)
    : "";
  let cursor = "0";
  let removed = 0;
  do {
    const [nextCursor, keys] = await client.scanSessions(
      cursor,
      adminSessionKeyPattern,
      SESSION_SCAN_COUNT
    );
    if (keys.length) {
      const values = await client.readSessions(keys);
      const targets = keys.flatMap((key, index): SessionSnapshot[] => {
        if (key === preservedKey) return [];
        const value = values[index] ?? null;
        const identity = sessionIdentity(value);
        return value
          && identity?.username === username
          && identity.credentialVersions.includes(staleCredentialVersion)
          && !(
            validCredentialVersion
            && identity.credentialVersions.includes(validCredentialVersion)
          )
          ? [{ key, value }]
          : [];
      });
      if (targets.length) {
        removed += await client.unlinkSessionsIfUnchanged(targets);
      }
    }
    cursor = nextCursor;
  } while (cursor !== "0");
  return removed;
}

export async function invalidateCommittedAdminSessionsByUsername(
  client: TargetSessionRedis,
  username: string,
  options: TargetSessionInvalidation
) {
  try {
    return await invalidateAdminSessionsByUsername(
      client,
      username,
      options.staleCredentialVersion,
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
