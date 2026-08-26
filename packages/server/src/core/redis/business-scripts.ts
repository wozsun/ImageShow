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

const sampleReadyImageIndexPrelude = `
local STATUS_OK = 1
local STATUS_EMPTY = 2
local STATUS_CORE_INVALID = -1
local STATUS_DERIVED_INVALID = -2
local STATUS_REVISION_CHANGED = -3
local STATUS_TOKEN_CHANGED = -4
local STATUS_EXPIRED = -5
local STATUS_CORE_MISSING_ITEM = -6
local STATUS_DERIVED_MISSING_ITEM = -7

local function command_failed(value)
  return type(value) == 'table' and value.err ~= nil
end

local function non_negative_integer(raw)
  local value = tonumber(raw)
  if not value or value < 0 or value ~= math.floor(value) then return nil end
  return value
end

local function positive_integer(raw)
  local value = non_negative_integer(raw)
  if not value or value == 0 then return nil end
  return value
end

local function valid_revision(value)
  return type(value) == 'string' and string.match(value, '^%d+$') ~= nil
end

local function valid_instance_token(value)
  return type(value) == 'string'
    and string.len(value) == 32
    and string.match(value, '^[0-9a-f]+$') ~= nil
end

local function valid_timestamp(value)
  if type(value) ~= 'string' then return false end
  local year_raw, month_raw, day_raw, hour_raw, minute_raw, second_raw =
    string.match(
      value,
      '^(%d%d%d%d)%-(%d%d)%-(%d%d)T(%d%d):(%d%d):(%d%d)%.%d%d%dZ$'
    )
  if not year_raw then return false end
  local year = tonumber(year_raw)
  local month = tonumber(month_raw)
  local day = tonumber(day_raw)
  local hour = tonumber(hour_raw)
  local minute = tonumber(minute_raw)
  local second = tonumber(second_raw)
  if month < 1
    or month > 12
    or hour > 23
    or minute > 59
    or second > 59 then
    return false
  end
  local days_in_month = {
    31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31
  }
  if year % 4 == 0 and (year % 100 ~= 0 or year % 400 == 0) then
    days_in_month[2] = 29
  end
  return day >= 1 and day <= days_in_month[month]
end

local function validate_core(
  meta_key,
  integrity_key,
  index_key,
  items_key,
  expected_revision,
  expected_count
)
  local meta = redis.pcall(
    'HMGET', meta_key, 'state', 'applied_revision', 'item_count'
  )
  if command_failed(meta) or #meta ~= 3 then return STATUS_CORE_INVALID end
  if meta[2] ~= expected_revision then
    return valid_revision(meta[2])
      and STATUS_REVISION_CHANGED
      or STATUS_CORE_INVALID
  end
  if meta[1] ~= 'ready' or meta[3] ~= tostring(expected_count) then
    return STATUS_CORE_INVALID
  end

  local integrity = redis.pcall(
    'HMGET', integrity_key, index_key, items_key
  )
  if command_failed(integrity)
    or #integrity ~= 2
    or integrity[1] ~= tostring(expected_count)
    or integrity[2] ~= tostring(expected_count) then
    return STATUS_CORE_INVALID
  end

  local index_count = redis.pcall('ZCARD', index_key)
  local item_count = redis.pcall('HLEN', items_key)
  if command_failed(index_count)
    or command_failed(item_count)
    or index_count ~= expected_count
    or item_count ~= expected_count then
    return STATUS_CORE_INVALID
  end

  local meta_ttl = redis.pcall('TTL', meta_key)
  local integrity_ttl = redis.pcall('TTL', integrity_key)
  local index_ttl = redis.pcall('TTL', index_key)
  local items_ttl = redis.pcall('TTL', items_key)
  if command_failed(meta_ttl)
    or command_failed(integrity_ttl)
    or command_failed(index_ttl)
    or command_failed(items_ttl)
    or meta_ttl ~= -1
    or integrity_ttl ~= -1 then
    return STATUS_CORE_INVALID
  end
  if expected_count == 0 then
    if index_ttl ~= -2 or items_ttl ~= -2 then
      return STATUS_CORE_INVALID
    end
  elseif index_ttl ~= -1 or items_ttl ~= -1 then
    return STATUS_CORE_INVALID
  end
  return STATUS_OK
end

local function sample_count(
  index_count,
  limit,
  recent_size,
  history_size
)
  local requested
  if limit <= 1 then
    requested = math.max(8, math.min(64, history_size + 1))
  else
    requested = math.min(index_count, limit + recent_size)
  end
  return math.min(index_count, requested)
end

local function sample_members(
  index_key,
  items_key,
  requested,
  invalid_status
)
  local members = redis.pcall('ZRANDMEMBER', index_key, requested)
  if command_failed(members)
    or type(members) ~= 'table'
    or #members ~= requested then
    return {invalid_status, 0}, {}, {}
  end
  local values = redis.pcall('HMGET', items_key, unpack(members))
  if command_failed(values)
    or type(values) ~= 'table'
    or #values ~= #members then
    return {STATUS_CORE_INVALID, 0}, {}, {}
  end

  local output = {STATUS_OK, #members}
  local missing_members = {}
  for index, member in ipairs(members) do
    local value = values[index]
    table.insert(output, member)
    table.insert(output, value or false)
    if not value then table.insert(missing_members, member) end
  end
  return output, members, missing_members
end

local function valid_sampling_arguments(
  limit,
  recent_size,
  history_size,
  maximum_limit
)
  return limit
    and recent_size
    and history_size
    and maximum_limit
    and limit <= maximum_limit
    and recent_size <= history_size
end`;

export const sampleReadyImageCoreIndexScript = `${sampleReadyImageIndexPrelude}
local expected_count = non_negative_integer(ARGV[2])
local limit = positive_integer(ARGV[3])
local recent_size = non_negative_integer(ARGV[4])
local history_size = non_negative_integer(ARGV[5])
local maximum_limit = positive_integer(ARGV[6])
if not expected_count
  or not valid_revision(ARGV[1])
  or not valid_sampling_arguments(
    limit, recent_size, history_size, maximum_limit
  ) then
  return {STATUS_CORE_INVALID, 0}
end

local core_status = validate_core(
  KEYS[1], KEYS[2], KEYS[3], KEYS[4], ARGV[1], expected_count
)
if core_status ~= STATUS_OK then return {core_status, 0} end
if expected_count == 0 then return {STATUS_EMPTY, 0} end

local requested = sample_count(
  expected_count, limit, recent_size, history_size
)
local output, _, missing_members = sample_members(
  KEYS[3], KEYS[4], requested, STATUS_CORE_INVALID
)
if #missing_members > 0 then output[1] = STATUS_CORE_MISSING_ITEM end
return output`;

export const sampleReadyImageDerivedIndexScript = `${sampleReadyImageIndexPrelude}
local expected_core_count = non_negative_integer(ARGV[2])
local expected_index_count = non_negative_integer(ARGV[3])
local limit = positive_integer(ARGV[6])
local recent_size = non_negative_integer(ARGV[7])
local history_size = non_negative_integer(ARGV[8])
local maximum_limit = positive_integer(ARGV[9])
local maximum_index_members = non_negative_integer(ARGV[10])
if not expected_core_count
  or not expected_index_count
  or not maximum_index_members
  or expected_index_count > expected_core_count
  or expected_index_count > maximum_index_members
  or not valid_revision(ARGV[1])
  or not valid_instance_token(ARGV[4])
  or (ARGV[5] ~= 'attribute' and ARGV[5] ~= 'filter')
  or not valid_sampling_arguments(
    limit, recent_size, history_size, maximum_limit
  ) then
  return {STATUS_DERIVED_INVALID, 0}
end

local core_status = validate_core(
  KEYS[1], KEYS[2], KEYS[3], KEYS[4], ARGV[1], expected_core_count
)
if core_status ~= STATUS_OK then return {core_status, 0} end

local meta_ttl = redis.pcall('TTL', KEYS[6])
if command_failed(meta_ttl) then return {STATUS_DERIVED_INVALID, 0} end
if meta_ttl <= 0 then return {STATUS_EXPIRED, 0} end

local meta = redis.pcall(
  'HMGET', KEYS[6],
  'applied_revision', 'count', 'built_at', 'instance_token', 'last_accessed'
)
if command_failed(meta) or #meta ~= 5 then
  return {STATUS_DERIVED_INVALID, 0}
end
if meta[1] ~= ARGV[1] then
  return valid_revision(meta[1])
    and {STATUS_REVISION_CHANGED, 0}
    or {STATUS_DERIVED_INVALID, 0}
end
if meta[4] ~= ARGV[4] then
  return valid_instance_token(meta[4])
    and {STATUS_TOKEN_CHANGED, 0}
    or {STATUS_DERIVED_INVALID, 0}
end
if meta[2] ~= tostring(expected_index_count)
  or not valid_timestamp(meta[3]) then
  return {STATUS_DERIVED_INVALID, 0}
end

local meta_field_count = redis.pcall('HLEN', KEYS[6])
if command_failed(meta_field_count) then
  return {STATUS_DERIVED_INVALID, 0}
end
if ARGV[5] == 'attribute' then
  if meta_field_count ~= 5
    or not valid_timestamp(meta[5]) then
    return {STATUS_DERIVED_INVALID, 0}
  end
elseif meta_field_count ~= 4 or meta[5] then
  return {STATUS_DERIVED_INVALID, 0}
end

local index_count = redis.pcall('ZCARD', KEYS[5])
local index_ttl = redis.pcall('TTL', KEYS[5])
if command_failed(index_count) or command_failed(index_ttl) then
  return {STATUS_DERIVED_INVALID, 0}
end
if expected_index_count > 0 then
  if index_ttl <= 0 then return {STATUS_EXPIRED, 0} end
elseif index_ttl ~= -2 then
  return {STATUS_DERIVED_INVALID, 0}
end
if index_count ~= expected_index_count then
  return {STATUS_DERIVED_INVALID, 0}
end
if expected_index_count == 0 then return {STATUS_EMPTY, 0} end

local requested = sample_count(
  expected_index_count, limit, recent_size, history_size
)
local output, _, missing_members = sample_members(
  KEYS[5], KEYS[4], requested, STATUS_DERIVED_INVALID
)
if #missing_members == 0 then return output end

local core_scores = redis.pcall(
  'ZMSCORE', KEYS[3], unpack(missing_members)
)
if command_failed(core_scores)
  or type(core_scores) ~= 'table'
  or #core_scores ~= #missing_members then
  output[1] = STATUS_CORE_INVALID
  return output
end
for _, score in ipairs(core_scores) do
  if score then
    output[1] = STATUS_CORE_MISSING_ITEM
    return output
  end
end
output[1] = STATUS_DERIVED_MISSING_ITEM
return output`;
