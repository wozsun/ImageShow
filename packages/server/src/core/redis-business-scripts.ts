export const reserveRedisWindowsScript = `
local output = {}
local blocked = false
for index = 1, #KEYS do
  local argument = (index - 1) * 2
  local capacity = ARGV[argument + 1]
  local duration = ARGV[argument + 2]
  if blocked then
    output[#output + 1] = -1
    output[#output + 1] = 0
    output[#output + 1] = 0
    output[#output + 1] = duration
  else
    local increment = redis.call(
      'INCREX', KEYS[index], 'BYINT', '1', 'UBOUND', capacity,
      'EX', duration, 'ENX'
    )
    local ttl = redis.call('TTL', KEYS[index])
    local allowed = increment[2] == 1
    output[#output + 1] = allowed and 1 or 0
    output[#output + 1] = increment[1]
    output[#output + 1] = increment[2]
    output[#output + 1] = ttl
    if not allowed then blocked = true end
  end
end
return output`;

function validateDerivedRegistryScript(
  maximumArgument: number,
  itemCountArgument: number,
  validationArgument: number
) {
  return `
local attribute_index_prefix = ARGV[${validationArgument}]
local attribute_axis_suffixes = {}
for suffix in string.gmatch(ARGV[${validationArgument + 1}], '[^,]+') do
  attribute_axis_suffixes[suffix] = true
end
local named_attribute_prefixes = {}
for kind in string.gmatch(ARGV[${validationArgument + 2}], '[^,]+') do
  table.insert(named_attribute_prefixes, kind .. ':')
end
local attribute_slug_max_length = tonumber(
  ARGV[${validationArgument + 3}]
)
local filter_key_prefix = ARGV[${validationArgument + 4}]
local stats_result_key_prefix = ARGV[${validationArgument + 5}]
local maximum_result_members = tonumber(ARGV[${validationArgument + 6}])
local minimum_total_members = tonumber(ARGV[${validationArgument + 7}])
local total_member_multiplier = tonumber(ARGV[${validationArgument + 8}])
local maximum_active_signatures = tonumber(ARGV[${validationArgument + 9}])
local maximum_stats_result_bytes = tonumber(
  ARGV[${validationArgument + 10}]
)
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
    and length <= attribute_slug_max_length
    and string.match(value, '^[a-z0-9][a-z0-9-]*$')
    and string.sub(value, -1) ~= '-'
end
local function valid_attribute_key(value)
  if not has_prefix(value, attribute_index_prefix) then return false end
  local suffix = string.sub(
    value, string.len(attribute_index_prefix) + 1
  )
  if attribute_axis_suffixes[suffix] then return true end
  for _, kind_prefix in ipairs(named_attribute_prefixes) do
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
      member, filter_key_prefix
    )
    local stats_signature = digest_suffix(
      member, stats_result_key_prefix
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
        or count > maximum_result_members then
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
    minimum_total_members,
    item_count * total_member_multiplier
  )
  if total_memberships > total_membership_limit
    or active_signature_count
      > maximum_active_signatures then
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

export const touchReadyImageIndexedResultScript = `${validateDerivedRegistryScript(11, 12, 13)}
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
  or count > maximum_result_members then
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

export const touchReadyImageStatsResultScript = `${validateDerivedRegistryScript(6, 7, 8)}
if registered_count ~= '0'
  or registered_kind ~= 'stats-result'
  or registered_signature ~= ARGV[4]
  or redis.call('TYPE', KEYS[1]).ok ~= 'string'
  or redis.call('TTL', KEYS[1]) <= 0
  or redis.call('STRLEN', KEYS[1])
    > maximum_stats_result_bytes
  or redis.call('GET', KEYS[1]) ~= ARGV[2] then
  return 0
end
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('ZADD', KEYS[3], ARGV[5], ARGV[1])
for index = 3, 6 do redis.call('EXPIRE', KEYS[index], ARGV[3]) end
return 1`;

export const storeReadyImageFilterSetScript = `
local source_count = #KEYS - 1
for index = 1, source_count do
  local actual = redis.call('ZCARD', KEYS[index])
  if actual ~= tonumber(ARGV[index]) then
    return {0, index, actual}
  end
end

local command = ARGV[source_count + 1]
local expected = tonumber(ARGV[source_count + 2])
local ttl = tonumber(ARGV[source_count + 3])
local destination = KEYS[source_count + 1]
local arguments = {destination, tostring(source_count)}
for index = 1, source_count do
  table.insert(arguments, KEYS[index])
end
if command ~= 'ZDIFFSTORE' then
  table.insert(arguments, 'AGGREGATE')
  table.insert(arguments, 'MAX')
end
local stored = redis.call(command, unpack(arguments))
if stored > expected then
  redis.call('UNLINK', destination)
  return {-1, stored, 0}
end
local expiry = 0
if stored > 0 then
  expiry = redis.call('EXPIRE', destination, ttl)
else
  redis.call('UNLINK', destination)
end
return {1, stored, expiry, redis.call('ZCARD', destination)}
`;

export const publishReadyImageAttributeIndexScript = `
local count = tonumber(ARGV[1])
if count > 0 then
  if redis.call('EXISTS', KEYS[3]) ~= 1 then return 0 end
  if redis.call('ZCARD', KEYS[3]) ~= count then return 0 end
  redis.call('RENAME', KEYS[3], KEYS[1])
  redis.call('EXPIRE', KEYS[1], ARGV[6])
else
  redis.call('UNLINK', KEYS[1], KEYS[3])
end
redis.call('DEL', KEYS[2])
redis.call(
  'HSET', KEYS[2],
  'applied_revision', ARGV[2],
  'count', ARGV[1],
  'built_at', ARGV[3],
  'last_accessed', ARGV[4],
  'instance_token', ARGV[5]
)
redis.call('EXPIRE', KEYS[2], ARGV[6])
return 1`;
