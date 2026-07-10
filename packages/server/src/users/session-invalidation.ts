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
  return {
    scanSessions: (cursor, pattern, count) => client.scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      count
    ),
    readSessions: (keys) => client.mget(...keys),
    unlinkSessions: (keys) => client.unlink(...keys)
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

function sessionUsername(raw: string | null) {
  if (!raw) return "";
  try {
    const value = JSON.parse(raw) as { username?: unknown };
    return typeof value.username === "string" ? value.username : "";
  } catch {
    return "";
  }
}

export async function invalidateAdminSessionsByUsername(
  client: TargetSessionRedis,
  username: string,
  preservedSessionId?: string
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
      const targets = keys.filter((key, index) => (
        key !== preservedKey && sessionUsername(values[index] ?? null) === username
      ));
      if (targets.length) removed += await client.unlinkSessions(targets);
    }
    cursor = nextCursor;
  } while (cursor !== "0");
  return removed;
}
