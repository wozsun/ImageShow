import { redis } from "../../core/redis-client.ts";
import {
  assertReadyImageDerivedResult,
  nextDerivedAccessScore,
  nonNegativeInteger
} from "./derived-cache-common.ts";
import { READY_IMAGE_DERIVED_CACHE_POLICY } from "./derived-cache-policy.ts";
import {
  READY_IMAGE_ATTRIBUTE_AXIS_SUFFIXES,
  READY_IMAGE_ATTRIBUTE_SLUG_MAX_LENGTH,
  READY_IMAGE_DERIVED_INDEX_PREFIX,
  READY_IMAGE_DERIVED_REGISTRY_COUNTS_KEY,
  READY_IMAGE_DERIVED_REGISTRY_KINDS_KEY,
  READY_IMAGE_DERIVED_REGISTRY_LRU_KEY,
  READY_IMAGE_DERIVED_REGISTRY_SIGNATURES_KEY,
  READY_IMAGE_FILTER_KEY_PREFIX,
  READY_IMAGE_NAMED_ATTRIBUTE_KINDS,
  READY_IMAGE_STATS_RESULT_KEY_PREFIX
} from "./keys.ts";

const luaAttributeAxes = READY_IMAGE_ATTRIBUTE_AXIS_SUFFIXES
  .map((suffix) => `suffix == '${suffix}'`)
  .join("\n    or ");
const luaNamedAttributeKinds = READY_IMAGE_NAMED_ATTRIBUTE_KINDS
  .map((kind) => `'${kind}'`)
  .join(", ");

function validateDerivedRegistryScript(
  maximumArgument: number,
  itemCountArgument: number
) {
  return `
local function has_prefix(value, prefix)
  return string.sub(value, 1, string.len(prefix)) == prefix
end
local function digest_suffix(value, prefix)
  if not has_prefix(value, prefix) then return nil end
  local suffix = string.sub(value, string.len(prefix) + 1)
  if string.len(suffix) ~= 64
    or not string.match(suffix, '^[0-9a-f]+$') then
    return nil
  end
  return suffix
end
local function valid_slug(value)
  local length = string.len(value)
  return length >= 1
    and length <= ${READY_IMAGE_ATTRIBUTE_SLUG_MAX_LENGTH}
    and string.match(value, '^[a-z0-9][a-z0-9-]*$')
    and string.sub(value, -1) ~= '-'
end
local function valid_attribute_key(value)
  local prefix = '${READY_IMAGE_DERIVED_INDEX_PREFIX}'
  if not has_prefix(value, prefix) then return false end
  local suffix = string.sub(value, string.len(prefix) + 1)
  if ${luaAttributeAxes} then return true end
  for _, kind in ipairs({${luaNamedAttributeKinds}}) do
    local kind_prefix = kind .. ':'
    if has_prefix(suffix, kind_prefix) then
      return valid_slug(string.sub(suffix, string.len(kind_prefix) + 1))
    end
  end
  return false
end
local lru_type = redis.call('TYPE', KEYS[3]).ok
local counts_type = redis.call('TYPE', KEYS[4]).ok
local kinds_type = redis.call('TYPE', KEYS[5]).ok
local signatures_type = redis.call('TYPE', KEYS[6]).ok
if lru_type ~= 'zset'
  or counts_type ~= 'hash'
  or kinds_type ~= 'hash'
  or signatures_type ~= 'hash' then
  return -1
end
local registry_size = redis.call('ZCARD', KEYS[3])
local item_count_raw = ARGV[${itemCountArgument}]
if not string.match(item_count_raw, '^%d+$') then return -1 end
local item_count = tonumber(item_count_raw)
if not item_count
  or registry_size > tonumber(ARGV[${maximumArgument}])
  or registry_size ~= redis.call('HLEN', KEYS[4])
  or registry_size ~= redis.call('HLEN', KEYS[5])
  or registry_size ~= redis.call('HLEN', KEYS[6]) then
  return -1
end
local registry_members = redis.call('ZRANGE', KEYS[3], 0, -1)
if #registry_members > 0 then
  local registry_counts = redis.call(
    'HMGET', KEYS[4], unpack(registry_members)
  )
  local registry_kinds = redis.call(
    'HMGET', KEYS[5], unpack(registry_members)
  )
  local registry_signatures = redis.call(
    'HMGET', KEYS[6], unpack(registry_members)
  )
  local total_memberships = 0
  local active_signatures = {}
  local active_signature_count = 0
  for index = 1, #registry_members do
    if not registry_counts[index]
      or not registry_kinds[index]
      or not registry_signatures[index] then
      return -1
    end
    local count_raw = registry_counts[index]
    if not string.match(count_raw, '^%d+$') then
      return -1
    end
    local count = tonumber(count_raw)
    if not count then return -1 end
    local member = registry_members[index]
    local kind = registry_kinds[index]
    local signature = registry_signatures[index]
    local filter_signature = digest_suffix(
      member, '${READY_IMAGE_FILTER_KEY_PREFIX}'
    )
    local stats_signature = digest_suffix(
      member, '${READY_IMAGE_STATS_RESULT_KEY_PREFIX}'
    )
    if valid_attribute_key(member) then
      if kind ~= 'attribute' or signature ~= '' then return -1 end
    elseif filter_signature then
      if kind ~= 'filter' or signature ~= filter_signature then return -1 end
    elseif stats_signature then
      if kind ~= 'stats-result'
        or signature ~= stats_signature
        or count ~= 0 then
        return -1
      end
    else
      return -1
    end
    if kind ~= 'stats-result' then
      if count > item_count
        or count > ${READY_IMAGE_DERIVED_CACHE_POLICY.maxResultMembers} then
        return -1
      end
      total_memberships = total_memberships + count
    end
    if signature ~= '' and not active_signatures[signature] then
      active_signatures[signature] = true
      active_signature_count = active_signature_count + 1
    end
  end
  local total_membership_limit = math.max(
    ${READY_IMAGE_DERIVED_CACHE_POLICY.minimumTotalMembers},
    item_count * ${READY_IMAGE_DERIVED_CACHE_POLICY.totalMemberMultiplier}
  )
  if total_memberships > total_membership_limit
    or active_signature_count
      > ${READY_IMAGE_DERIVED_CACHE_POLICY.maxActiveSignatures} then
    return -1
  end
end
local registered_score = redis.call('ZSCORE', KEYS[3], ARGV[1])
local registered_count = redis.call('HGET', KEYS[4], ARGV[1])
local registered_kind = redis.call('HGET', KEYS[5], ARGV[1])
local registered_signature = redis.call('HGET', KEYS[6], ARGV[1])
local registered_fields = 0
if registered_score then registered_fields = registered_fields + 1 end
if registered_count then registered_fields = registered_fields + 1 end
if registered_kind then registered_fields = registered_fields + 1 end
if registered_signature then registered_fields = registered_fields + 1 end
if registered_fields == 0 then return 0 end
if registered_fields ~= 4 then return -1 end`;
}

const touchIndexedDerivedResultScript = `${validateDerivedRegistryScript(11, 12)}
if registered_count ~= ARGV[2]
  or registered_kind ~= ARGV[8]
  or registered_signature ~= ARGV[9] then
  return 0
end
if redis.call('TYPE', KEYS[2]).ok ~= 'hash'
  or redis.call('HLEN', KEYS[2]) ~= tonumber(ARGV[7])
  or redis.call('TTL', KEYS[2]) <= 0
  or redis.call('HGET', KEYS[2], 'applied_revision') ~= ARGV[3]
  or redis.call('HGET', KEYS[2], 'count') ~= ARGV[2]
  or redis.call('HGET', KEYS[2], 'instance_token') ~= ARGV[6]
  or not redis.call('HGET', KEYS[2], 'built_at') then
  return 0
end
local count = tonumber(ARGV[2])
if count > tonumber(ARGV[12])
  or count > ${READY_IMAGE_DERIVED_CACHE_POLICY.maxResultMembers} then
  return 0
end
local result_type = redis.call('TYPE', KEYS[1]).ok
if count == 0 then
  if result_type ~= 'none' then return 0 end
elseif result_type ~= 'zset'
  or redis.call('ZCARD', KEYS[1]) ~= count
  or redis.call('TTL', KEYS[1]) <= 0 then
  return 0
end
if ARGV[8] == 'attribute' then
  if not redis.call('HGET', KEYS[2], 'last_accessed') then return 0 end
  redis.call('HSET', KEYS[2], 'last_accessed', ARGV[4])
end
redis.call('EXPIRE', KEYS[2], ARGV[5])
if count > 0 then redis.call('EXPIRE', KEYS[1], ARGV[5]) end
redis.call('ZADD', KEYS[3], ARGV[10], ARGV[1])
for index = 3, 6 do redis.call('EXPIRE', KEYS[index], ARGV[5]) end
return 1`;

export async function touchReadyImageIndexedResultUnchecked(options: {
  key: string;
  kind: "attribute" | "filter";
  revision: string;
  count: number;
  itemCount: number;
  instanceToken: string;
  accessedAt: string;
}) {
  const descriptor = assertReadyImageDerivedResult(options.key, options.kind);
  if (!descriptor.metaKey) {
    throw new Error(
      `Ready-image derived ${options.kind} result has no metadata key`
    );
  }
  if (
    nonNegativeInteger(options.count) === null
    || nonNegativeInteger(options.itemCount) === null
    || !/^[0-9a-f]{32}$/u.test(options.instanceToken)
  ) {
    return 0;
  }
  return redis.call(
    "EVAL",
    touchIndexedDerivedResultScript,
    "6",
    options.key,
    descriptor.metaKey,
    READY_IMAGE_DERIVED_REGISTRY_LRU_KEY,
    READY_IMAGE_DERIVED_REGISTRY_COUNTS_KEY,
    READY_IMAGE_DERIVED_REGISTRY_KINDS_KEY,
    READY_IMAGE_DERIVED_REGISTRY_SIGNATURES_KEY,
    options.key,
    String(options.count),
    options.revision,
    options.accessedAt,
    String(READY_IMAGE_DERIVED_CACHE_POLICY.ttlSeconds),
    options.instanceToken,
    options.kind === "attribute" ? "5" : "4",
    options.kind,
    descriptor.signature ?? "",
    String(nextDerivedAccessScore()),
    String(READY_IMAGE_DERIVED_CACHE_POLICY.maxResults),
    String(options.itemCount)
  );
}

const touchStatsResultScript = `${validateDerivedRegistryScript(6, 7)}
if registered_count ~= '0'
  or registered_kind ~= 'stats-result'
  or registered_signature ~= ARGV[4]
  or redis.call('TYPE', KEYS[1]).ok ~= 'string'
  or redis.call('TTL', KEYS[1]) <= 0
  or redis.call('STRLEN', KEYS[1])
    > ${READY_IMAGE_DERIVED_CACHE_POLICY.maxStatsResultBytes}
  or redis.call('GET', KEYS[1]) ~= ARGV[2] then
  return 0
end
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('ZADD', KEYS[3], ARGV[5], ARGV[1])
for index = 3, 6 do redis.call('EXPIRE', KEYS[index], ARGV[3]) end
return 1`;

export async function touchReadyImageStatsResultUnchecked(
  key: string,
  serialized: string,
  itemCount: number
) {
  const descriptor = assertReadyImageDerivedResult(key, "stats-result");
  if (nonNegativeInteger(itemCount) === null) return 0;
  return redis.call(
    "EVAL",
    touchStatsResultScript,
    "6",
    key,
    key,
    READY_IMAGE_DERIVED_REGISTRY_LRU_KEY,
    READY_IMAGE_DERIVED_REGISTRY_COUNTS_KEY,
    READY_IMAGE_DERIVED_REGISTRY_KINDS_KEY,
    READY_IMAGE_DERIVED_REGISTRY_SIGNATURES_KEY,
    key,
    serialized,
    String(READY_IMAGE_DERIVED_CACHE_POLICY.ttlSeconds),
    descriptor.signature ?? "",
    String(nextDerivedAccessScore()),
    String(READY_IMAGE_DERIVED_CACHE_POLICY.maxResults),
    String(itemCount)
  );
}
