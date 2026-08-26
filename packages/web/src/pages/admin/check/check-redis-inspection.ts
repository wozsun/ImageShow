import {
  useCallback,
  useEffect,
  useMemo,
  useState
} from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../lib/api/client.js";
import { queryKeys } from "../../../lib/api/query-keys.js";
import { adminApiBasePath } from "../../../lib/constants.js";

const adminRedisInspectionPath = `${adminApiBasePath}/check/redis`;

type ReadyImageProjectionUsageAggregate = {
  key_count: number;
  memory_bytes: number;
};

type ReadyImageDerivedProjectionUsageAggregate =
  ReadyImageProjectionUsageAggregate & {
    member_count: number;
  };

export type ReadyImageProjectionUsageSnapshot = {
  measured_at: string;
  core: ReadyImageProjectionUsageAggregate;
  derived: ReadyImageDerivedProjectionUsageAggregate;
};

function recordValue(value: unknown) {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function projectionUsageAggregate(value: unknown) {
  const record = recordValue(value);
  if (!record) return null;
  const keyCount = record.key_count;
  const memoryBytes = record.memory_bytes;
  if (
    !Number.isSafeInteger(keyCount)
    || Number(keyCount) < 0
    || !Number.isSafeInteger(memoryBytes)
    || Number(memoryBytes) < 0
  ) {
    return null;
  }
  return {
    key_count: Number(keyCount),
    memory_bytes: Number(memoryBytes)
  };
}

function derivedProjectionUsageAggregate(value: unknown) {
  const record = recordValue(value);
  const aggregate = projectionUsageAggregate(record);
  const memberCount = record?.member_count;
  if (
    !aggregate
    || !Number.isSafeInteger(memberCount)
    || Number(memberCount) < 0
  ) {
    return null;
  }
  return {
    ...aggregate,
    member_count: Number(memberCount)
  };
}

export function readyImageProjectionUsage(
  result: unknown,
  resultKind: "redis" | "all"
): ReadyImageProjectionUsageSnapshot | null {
  const root = recordValue(result);
  let deepInspection: Record<string, unknown> | null = null;
  if (resultKind === "redis") {
    deepInspection = recordValue(root?.deep_inspection);
  } else {
    const redisResult = recordValue(root?.redis);
    if (redisResult?.status === "ok") {
      deepInspection = recordValue(
        recordValue(redisResult.data)?.deep_inspection
      );
    }
  }
  if (
    deepInspection?.complete !== true
    || deepInspection.source !== "deep"
    || typeof deepInspection.measured_at !== "string"
    || !Number.isFinite(Date.parse(deepInspection.measured_at))
  ) {
    return null;
  }
  const usage = recordValue(deepInspection.image_projection_usage);
  const core = projectionUsageAggregate(usage?.core);
  const derived = derivedProjectionUsageAggregate(usage?.derived);
  return core && derived
    ? { measured_at: deepInspection.measured_at, core, derived }
    : null;
}

function latestReadyImageProjectionUsage(
  first: ReadyImageProjectionUsageSnapshot | null,
  second: ReadyImageProjectionUsageSnapshot | null
) {
  if (!first) return second;
  if (!second) return first;
  return Date.parse(first.measured_at) >= Date.parse(second.measured_at)
    ? first
    : second;
}

export function useRetainedReadyImageProjectionUsage(result: unknown) {
  const currentProjectionUsage = useMemo(
    () => readyImageProjectionUsage(result, "redis"),
    [result]
  );
  const [retainedProjectionUsage, setRetainedProjectionUsage] = useState<
    ReadyImageProjectionUsageSnapshot | null
  >(null);

  useEffect(() => {
    if (!currentProjectionUsage) return;
    setRetainedProjectionUsage((current) => (
      latestReadyImageProjectionUsage(currentProjectionUsage, current)
    ));
  }, [currentProjectionUsage]);

  const retainProjectionUsage = useCallback((
    completeUsage: ReadyImageProjectionUsageSnapshot | null
  ) => {
    if (completeUsage) {
      setRetainedProjectionUsage((current) => (
        latestReadyImageProjectionUsage(completeUsage, current)
      ));
    }
    return completeUsage;
  }, []);

  return {
    currentProjectionUsage,
    projectionUsage: latestReadyImageProjectionUsage(
      currentProjectionUsage,
      retainedProjectionUsage
    ),
    retainProjectionUsage
  };
}

export function useAdminRedisInspection(
  options: { enabled?: boolean } = {}
) {
  return useQuery<unknown>({
    queryKey: queryKeys.adminRedisInspection,
    // The server enforces the ten-second inspection deadline. Keep this first
    // Promise alive across React Strict Mode's temporary unmount so the shared
    // query cannot start two expensive scans for one page visit.
    queryFn: () => api(adminRedisInspectionPath, { method: "POST" }),
    retry: false,
    staleTime: 0,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    enabled: options.enabled ?? true
  });
}
