const legacyPreferencePattern = "imageshow:admin_preferences:*";
const cleanupCompleteKey = "imageshow:maintenance:admin_preferences_cleanup_v1";
const scanCount = 250;

export type LegacyPreferenceRedisClient = {
  get(key: string): Promise<string | null>;
  scan(
    cursor: string,
    matchToken: "MATCH",
    pattern: string,
    countToken: "COUNT",
    count: number
  ): Promise<[string, string[]]>;
  unlink(...keys: string[]): Promise<number>;
  set(key: string, value: string): Promise<unknown>;
};

export async function cleanupLegacyAdminPreferences(
  client: LegacyPreferenceRedisClient
) {
  if (await client.get(cleanupCompleteKey)) {
    return { completedNow: false, deleted: 0 };
  }

  let cursor = "0";
  let deleted = 0;
  do {
    const [nextCursor, keys] = await client.scan(
      cursor,
      "MATCH",
      legacyPreferencePattern,
      "COUNT",
      scanCount
    );
    cursor = nextCursor;
    if (keys.length) deleted += await client.unlink(...keys);
  } while (cursor !== "0");

  await client.set(cleanupCompleteKey, "1");
  return { completedNow: true, deleted };
}
