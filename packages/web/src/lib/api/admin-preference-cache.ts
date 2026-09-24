import {
  adminPreferenceKeys,
  type AdminPreferenceKey,
  type AdminPreferences,
  type AdminPreferenceValues
} from "@imageshow/shared/browser";

export type CachedAdminPreferences = {
  values: AdminPreferences;
  pending: AdminPreferences;
};

export function shouldReplaceAdminPreferenceQuerySnapshot(
  cachedUpdatedAt: number | undefined,
  serverUpdatedAt: number
) {
  return cachedUpdatedAt === undefined || cachedUpdatedAt < serverUpdatedAt;
}

export function sameAdminPreferences(
  left: AdminPreferences,
  right: AdminPreferences
) {
  return adminPreferenceKeys.every((key) => left[key] === right[key]);
}

export async function runAdminPreferenceWriteWithReadFence<Result>(
  cancelInFlightReads: () => Promise<void>,
  write: () => Promise<Result>
) {
  await cancelInFlightReads();
  const result = await write();
  await cancelInFlightReads();
  return result;
}

export function assignAdminPreference<Key extends AdminPreferenceKey>(
  preferences: AdminPreferences,
  key: Key,
  value: AdminPreferenceValues[Key]
) {
  Object.assign(preferences, { [key]: value });
}

export function reconcileAdminPreferenceCache(
  current: CachedAdminPreferences,
  serverPreferences: AdminPreferences
): CachedAdminPreferences {
  const values: AdminPreferences = {};
  const pending: AdminPreferences = {};

  for (const key of adminPreferenceKeys) {
    const pendingValue = current.pending[key];
    const serverValue = serverPreferences[key];
    const localValue = current.values[key];

    if (pendingValue !== undefined) {
      assignAdminPreference(values, key, pendingValue);
      if (pendingValue !== serverValue) {
        assignAdminPreference(pending, key, pendingValue);
      }
    } else if (serverValue !== undefined) {
      assignAdminPreference(values, key, serverValue);
    } else if (localValue !== undefined) {
      assignAdminPreference(values, key, localValue);
      assignAdminPreference(pending, key, localValue);
    }
  }

  return { values, pending };
}
