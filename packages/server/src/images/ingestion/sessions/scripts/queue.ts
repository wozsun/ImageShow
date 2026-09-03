import { projectionLua } from "./projection.ts";

export const readIngestionQueueSnapshotScript = `${projectionLua}
local owner_key = KEYS[1]
local display_key = KEYS[2]
local metadata_key = KEYS[3]
local runnable_key = KEYS[4]
local expires_key = KEYS[5]
local offset = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local canonical_prefix = ARGV[3]
local expected_owner = ARGV[4]
local expected_queue = ARGV[5]
local max_limit = tonumber(ARGV[6])
local excluded_json = ARGV[7]
local included_json = ARGV[8]
local max_excluded = tonumber(ARGV[9])

local function display_contains_any_session(display_key, session_ids)
  if next(session_ids) == nil then return false end
  local cursor = '0'
  repeat
    local page = redis.call('ZSCAN', display_key, cursor, 'COUNT', 128)
    cursor = page[1]
    local members = page[2]
    for index = 1, #members, 2 do
      local member = members[index]
      if #member >= 44
        and string.sub(member, -44, -44) == ':'
        and session_ids[string.sub(member, -43)] then
        return true
      end
    end
  until cursor == '0'
  return false
end

if not valid_integer(offset, 0)
  or not valid_integer(limit, 0)
  or not valid_integer(max_limit, 1)
  or not valid_integer(max_excluded, 1)
  or limit > max_limit
  or string.sub(excluded_json, 1, 1) ~= '['
  or string.sub(included_json, 1, 1) ~= '[' then
  error('INGESTION_QUEUE_STRUCTURE snapshot_arguments')
end
local excluded_items = cjson.decode(excluded_json)
local included_items = cjson.decode(included_json)
if type(excluded_items) ~= 'table'
  or type(included_items) ~= 'table'
  or #excluded_items > max_excluded
  or #included_items + limit > max_limit then
  error('INGESTION_QUEUE_STRUCTURE snapshot_items')
end
local excluded = {}
for _, item in ipairs(excluded_items) do
  assert_exact_fields(item, { 'session_id', 'image_id' }, 'snapshot_exclude')
  if type(item.session_id) ~= 'string'
    or #item.session_id ~= 43
    or not string.match(item.session_id, '^[A-Za-z0-9_%-]+$')
    or type(item.image_id) ~= 'string'
    or item.image_id == ''
    or excluded[item.session_id] then
    error('INGESTION_QUEUE_STRUCTURE snapshot_exclude')
  end
  excluded[item.session_id] = item.image_id
end
local included = {}
for _, item in ipairs(included_items) do
  assert_exact_fields(item, { 'session_id', 'image_id' }, 'snapshot_include')
  if type(item.session_id) ~= 'string'
    or #item.session_id ~= 43
    or not string.match(item.session_id, '^[A-Za-z0-9_%-]+$')
    or type(item.image_id) ~= 'string'
    or item.image_id == ''
    or excluded[item.session_id] ~= item.image_id
    or included[item.session_id] then
    error('INGESTION_QUEUE_STRUCTURE snapshot_include')
  end
  included[item.session_id] = true
end
assert_discovery_index_types(runnable_key, expires_key)
local metadata_exists = assert_queue_structure(
  owner_key, display_key, metadata_key, expected_owner, expected_queue
)
if not metadata_exists then
  for _, item in ipairs(excluded_items) do
    if redis_key_type(canonical_prefix .. item.session_id) ~= 'none' then
      error('INGESTION_QUEUE_STRUCTURE canonical_without_metadata')
    end
  end
  return { 0 }
end
local metadata = redis.call('HGETALL', metadata_key)
local active_excluded = {}
local excluded_snapshots = {}
local excluded_ranks = {}
local stale_items = {}
local missing_canonical_sessions = {}

-- Every client-owned pair is validated before it can affect pagination. A
-- missing, discarded, or replaced incarnation is reported explicitly so the
-- browser can atomically retire its old card; structural corruption remains a
-- hard failure even when the pair would otherwise be filtered off-page.
for _, item in ipairs(excluded_items) do
  local canonical_key = canonical_prefix .. item.session_id
  local canonical_type = redis_key_type(canonical_key)
  if canonical_type == 'none' then
    if redis.call('ZSCORE', owner_key, item.session_id) then
      error('INGESTION_QUEUE_STRUCTURE canonical_missing')
    end
    missing_canonical_sessions[item.session_id] = true
    stale_items[#stale_items + 1] = item
  else
    assert_snapshot_hash_container(canonical_key, 'canonical', 12)
    local serialized = redis.call('HGET', canonical_key, 'snapshot')
    if not serialized then error('INGESTION_QUEUE_STRUCTURE canonical_missing') end
    local snapshot = decode_stored_json(serialized, 'canonical')
    assert_canonical_shape(snapshot, false)
    assert_canonical_json_arrays(serialized, snapshot)
    if snapshot.session_id ~= item.session_id
      or snapshot.owner ~= expected_owner
      or snapshot.queue ~= expected_queue then
      error('INGESTION_QUEUE_STRUCTURE canonical_scope')
    end
    assert_canonical_structure(
      snapshot,
      canonical_key,
      owner_key,
      display_key,
      metadata_key,
      runnable_key,
      expires_key
    )
    if snapshot.image_id ~= item.image_id
      or snapshot.status == 'discarded' then
      stale_items[#stale_items + 1] = item
    else
      local display_order_key = redis.call(
        'HGET', canonical_key, 'display_order_key'
      )
      local display_rank = redis.call(
        'ZREVRANK', display_key, display_order_key
      )
      if display_rank == false then
        error('INGESTION_QUEUE_STRUCTURE display_score')
      end
      active_excluded[item.session_id] = item.image_id
      excluded_snapshots[item.session_id] = serialized
      excluded_ranks[#excluded_ranks + 1] = tonumber(display_rank)
    end
  end
end
-- A canonical removed by another client is a normal stale exclusion. The
-- display projection still has to be checked for an orphan, but scan the ZSET
-- once for the complete bounded session set instead of once per stale pair.
if display_contains_any_session(display_key, missing_canonical_sessions) then
  error('INGESTION_QUEUE_STRUCTURE canonical_missing')
end
table.sort(excluded_ranks)
if offset > max_safe_integer - limit - #excluded_ranks then
  error('INGESTION_QUEUE_STRUCTURE snapshot_range')
end
local members = {}
if limit > 0 then
  -- Translate the filtered offset into a raw display rank using only the
  -- bounded exact exclusion ranks. Reads stay O(limit + exclusions) even for
  -- a very large page offset; they never scan the prefix from rank zero.
  local raw_start = offset
  for _, display_rank in ipairs(excluded_ranks) do
    if display_rank <= raw_start then
      raw_start = raw_start + 1
    else
      break
    end
  end
  local raw_end = raw_start + limit + #excluded_ranks - 1
  local candidates = redis.call(
    'ZREVRANGE', display_key, raw_start, raw_end
  )
  for _, display_order_key in ipairs(candidates) do
    local session_id = string.sub(display_order_key, 38)
    if not valid_display_order_key(display_order_key, session_id) then
      return redis.error_reply('INGESTION_QUEUE_STRUCTURE display_order_key')
    end
    if not active_excluded[session_id] then
      members[#members + 1] = display_order_key
      if #members >= limit then break end
    end
  end
end
local snapshots = {}
local output_sessions = {}
local function append_serialized(session_id, serialized)
  if not output_sessions[session_id] then
    output_sessions[session_id] = true
    snapshots[#snapshots + 1] = serialized
  end
end
local function append_snapshot(session_id)
  local canonical_key = canonical_prefix .. session_id
  local canonical_type = redis_key_type(canonical_key)
  if canonical_type == 'none' then
    error('INGESTION_QUEUE_STRUCTURE canonical_missing')
  end
  assert_snapshot_hash_container(canonical_key, 'canonical', 12)
  local snapshot = redis.call('HGET', canonical_key, 'snapshot')
  if not snapshot then error('INGESTION_QUEUE_STRUCTURE canonical_missing') end
  local parsed = decode_stored_json(snapshot, 'canonical')
  assert_canonical_shape(parsed, false)
  assert_canonical_json_arrays(snapshot, parsed)
  if parsed.session_id ~= session_id
    or parsed.owner ~= expected_owner
    or parsed.queue ~= expected_queue then
    error('INGESTION_QUEUE_STRUCTURE canonical_scope')
  end
  assert_canonical_structure(
    parsed,
    canonical_key,
    owner_key,
    display_key,
    metadata_key,
    runnable_key,
    expires_key
  )
  if parsed.status == 'discarded' then
    error('INGESTION_QUEUE_STRUCTURE canonical_scope')
  end
  append_serialized(session_id, snapshot)
end
for _, display_order_key in ipairs(members) do
  append_snapshot(string.sub(display_order_key, 38))
end
for _, item in ipairs(included_items) do
  local serialized = excluded_snapshots[item.session_id]
  if serialized then append_serialized(item.session_id, serialized) end
end
local output = { 1, #metadata }
for _, value in ipairs(metadata) do output[#output + 1] = value end
output[#output + 1] = #snapshots
for _, snapshot in ipairs(snapshots) do output[#output + 1] = snapshot end
output[#output + 1] = #stale_items
for _, item in ipairs(stale_items) do
  output[#output + 1] = item.session_id
  output[#output + 1] = item.image_id
end
return output
`;

export const scanIngestionQueueActionScript = `${projectionLua}
local owner_key = KEYS[1]
local display_key = KEYS[2]
local metadata_key = KEYS[3]
local runnable_key = KEYS[4]
local expires_key = KEYS[5]
local maximum_order = tonumber(ARGV[1])
local cursor = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local canonical_prefix = ARGV[4]
local expected_owner = ARGV[5]
local expected_queue = ARGV[6]
local max_limit = tonumber(ARGV[7])

if not valid_integer(maximum_order, 0)
  or not valid_integer(cursor, 0)
  or cursor > maximum_order
  or (maximum_order == 0 and cursor ~= 0)
  or (maximum_order > 0 and cursor < 1)
  or not valid_integer(limit, 1)
  or not valid_integer(max_limit, 1)
  or limit > max_limit then
  error('INGESTION_QUEUE_STRUCTURE action_scan_arguments')
end
assert_discovery_index_types(runnable_key, expires_key)
if not assert_queue_structure(
  owner_key, display_key, metadata_key, expected_owner, expected_queue
) then
  return { 0 }
end
local current_maximum = parse_stored_integer(
  redis.call('HGET', metadata_key, 'last_accepted_order'),
  'metadata_last_accepted_order'
)
if maximum_order > current_maximum then
  error('INGESTION_QUEUE_STRUCTURE action_scan_watermark')
end
if maximum_order == 0 then return { 1, 0, 0, 0 } end

local values = redis.call(
  'ZRANGEBYSCORE', owner_key, cursor, maximum_order,
  'WITHSCORES', 'LIMIT', 0, limit + 1
)
local available = #values / 2
local count = math.min(available, limit)
local has_more = available > limit and 1 or 0
local next_cursor = 0
local output = { 1, count, has_more, next_cursor }
for index = 1, count do
  local session_id = values[(index - 1) * 2 + 1]
  local score = tonumber(values[(index - 1) * 2 + 2])
  local canonical_key = canonical_prefix .. session_id
  assert_snapshot_hash_container(canonical_key, 'canonical', 12)
  local serialized = redis.call('HGET', canonical_key, 'snapshot')
  if not serialized then
    return redis.error_reply('INGESTION_QUEUE_STRUCTURE canonical_missing')
  end
  local snapshot = decode_stored_json(serialized, 'canonical')
  assert_canonical_shape(snapshot, false)
  assert_canonical_json_arrays(serialized, snapshot)
  if snapshot.session_id ~= session_id
    or snapshot.owner ~= expected_owner
    or snapshot.queue ~= expected_queue
    or snapshot.status == 'discarded'
    or tonumber(snapshot.accepted_order) ~= score
    or score > maximum_order then
    return redis.error_reply('INGESTION_QUEUE_STRUCTURE canonical_scope')
  end
  assert_canonical_structure(
    snapshot,
    canonical_key,
    owner_key,
    display_key,
    metadata_key,
    runnable_key,
    expires_key
  )
  output[#output + 1] = serialized
  if index == count and has_more == 1 then next_cursor = score + 1 end
end
output[4] = next_cursor
return output
`;

export const deleteStaleCompletedReceiptsScript = `${projectionLua}
local owner_key = KEYS[1]
local display_key = KEYS[2]
local metadata_key = KEYS[3]
local runnable_key = KEYS[4]
local expires_key = KEYS[5]
local canonical_prefix = ARGV[1]
local expected_owner = ARGV[2]
local expected_queue = ARGV[3]
local expected = cjson.decode(ARGV[4])
local max_items = tonumber(ARGV[5])

if type(expected) ~= 'table'
  or not valid_integer(max_items, 1)
  or #expected < 1
  or #expected > max_items then
  error('INGESTION_QUEUE_STRUCTURE stale_receipt_arguments')
end
assert_discovery_index_types(runnable_key, expires_key)
if not assert_queue_structure(
  owner_key, display_key, metadata_key, expected_owner, expected_queue
) then
  return { 0 }
end

local snapshots = {}
local canonical_keys = {}
local display_order_keys = {}
local seen = {}
for index, item in ipairs(expected) do
  assert_exact_fields(
    item,
    { 'session_id', 'image_id', 'version' },
    'stale_receipt'
  )
  if type(item.session_id) ~= 'string'
    or type(item.image_id) ~= 'string'
    or not valid_integer(tonumber(item.version), 1)
    or seen[item.session_id] then
    error('INGESTION_QUEUE_STRUCTURE stale_receipt_identity')
  end
  seen[item.session_id] = true
  local canonical_key = canonical_prefix .. item.session_id
  assert_snapshot_hash_container(canonical_key, 'canonical', 12)
  local serialized = redis.call('HGET', canonical_key, 'snapshot')
  if not serialized then return { 0 } end
  local snapshot = decode_stored_json(serialized, 'canonical')
  assert_canonical_shape(snapshot, false)
  assert_canonical_json_arrays(serialized, snapshot)
  if snapshot.owner ~= expected_owner
    or snapshot.queue ~= expected_queue
    or snapshot.session_id ~= item.session_id
    or snapshot.image_id ~= item.image_id
    or snapshot.status ~= 'completed'
    or tonumber(snapshot.version) ~= tonumber(item.version) then
    return { 0 }
  end
  assert_canonical_structure(
    snapshot,
    canonical_key,
    owner_key,
    display_key,
    metadata_key,
    runnable_key,
    expires_key
  )
  snapshots[index] = snapshot
  canonical_keys[index] = canonical_key
  display_order_keys[index] = redis.call(
    'HGET', canonical_key, 'display_order_key'
  )
end

assert_metadata_incrementable(metadata_key, false)
for index, snapshot in ipairs(snapshots) do
  validate_projection_delta(
    metadata_key,
    projection(snapshot),
    projection({ status = 'discarded' })
  )
  apply_projection_delta(
    metadata_key,
    projection(snapshot),
    projection({ status = 'discarded' })
  )
  redis.call('ZREM', owner_key, snapshot.session_id)
  redis.call('ZREM', display_key, display_order_keys[index])
  redis.call('ZREM', runnable_key, canonical_keys[index])
  redis.call('ZREM', expires_key, canonical_keys[index])
  redis.call('DEL', canonical_keys[index])
end
redis.call('HINCRBY', metadata_key, 'revision', 1)
assert_queue_structure(
  owner_key, display_key, metadata_key, expected_owner, expected_queue
)
return { 1, cjson.encode(metadata_summary(metadata_key)) }
`;
