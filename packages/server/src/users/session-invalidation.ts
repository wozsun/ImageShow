import { redis } from "../core/redis-client.ts";
import {
  deleteRedisStringsIfEqual,
  type RedisStringSnapshot
} from "../core/redis-conditional-string.ts";
import { logger } from "../core/logger.ts";
import { runRequiredRedisCommand } from "../core/runtime-availability.ts";
import { parseAdminCredentialVersions } from "./session-credential.ts";
import {
  adminSessionKey,
  adminSessionKeyFamilyPrefix,
  adminSessionKeyPattern
} from "./admin-session-key.ts";
import { closeAdminSessionConnections } from "./admin-session-connections.ts";

const SESSION_SCAN_COUNT = 100;

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
    snapshots: RedisStringSnapshot[]
  ): Promise<RedisStringSnapshot[]>;
};

type RedisSessionPipeline = {
  call(command: string, ...arguments_: string[]): unknown;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
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
  pipeline(): RedisSessionPipeline;
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
    unlinkSessionsIfUnchanged: (snapshots) => run(
      () => deleteRedisStringsIfEqual(client, snapshots)
    )
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
    if (keys.length) {
      removed += await client.unlinkSessions(keys);
      closeAdminSessionConnections(keys.flatMap(adminSessionIdFromKey));
    }
    cursor = nextCursor;
  } while (cursor !== "0");
  return removed;
}

function adminSessionIdFromKey(key: string) {
  return key.startsWith(adminSessionKeyFamilyPrefix)
    ? [key.slice(adminSessionKeyFamilyPrefix.length)]
    : [];
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
      const targets = keys.flatMap((key, index): Array<{
        snapshot: RedisStringSnapshot;
        sessionId: string;
      }> => {
        if (key === preservedKey) return [];
        const value = values[index] ?? null;
        const identity = sessionIdentity(value);
        const sessionId = adminSessionIdFromKey(key)[0];
        return value
          && sessionId
          && identity?.username === username
          && identity.credentialVersions.includes(staleCredentialVersion)
          && !(
            validCredentialVersion
            && identity.credentialVersions.includes(validCredentialVersion)
          )
          ? [{ snapshot: { key, value }, sessionId }]
          : [];
      });
      if (targets.length) {
        const removedSnapshots = await client.unlinkSessionsIfUnchanged(
          targets.map((target) => target.snapshot)
        );
        removed += removedSnapshots.length;
        const sessionByKey = new Map(
          targets.map((target) => [target.snapshot.key, target.sessionId])
        );
        closeAdminSessionConnections(
          removedSnapshots.flatMap((snapshot) => {
            const sessionId = sessionByKey.get(snapshot.key);
            return sessionId ? [sessionId] : [];
          })
        );
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
