const projectionLua = String.raw`
local max_safe_integer = 9007199254740991
local summary_fields = {
  'total', 'unfinished', 'waiting', 'running', 'ready', 'duplicate_pending',
  'committing_resolving', 'resolving', 'completed', 'failed'
}

local function projection(snapshot)
  local result = {
    total = 0,
    unfinished = 0,
    waiting = 0,
    running = 0,
    ready = 0,
    duplicate_pending = 0,
    committing_resolving = 0,
    resolving = 0,
    completed = 0,
    failed = 0
  }
  if snapshot.status == 'discarded' then return result end
  result.total = 1
  if snapshot.status == 'completed' then
    result.completed = 1
  else
    result.unfinished = 1
  end
  if snapshot.status == 'queued' or snapshot.status == 'received' then
    result.waiting = 1
  elseif snapshot.status == 'downloading'
    or snapshot.status == 'preparing' then
    result.running = 1
  end
  local duplicate_count = 0
  if snapshot.prepared and snapshot.prepared.duplicate_count then
    duplicate_count = tonumber(snapshot.prepared.duplicate_count) or 0
  end
  local duplicate_pending = snapshot.status == 'ready'
    and duplicate_count > 0
    and not snapshot.duplicate_decision
  if duplicate_pending then
    result.duplicate_pending = 1
  elseif snapshot.status == 'ready' then
    result.ready = 1
  end
  if snapshot.status == 'committing' or snapshot.status == 'resolving' then
    result.committing_resolving = 1
  end
  if snapshot.status == 'resolving' then result.resolving = 1 end
  if snapshot.status == 'failed' then result.failed = 1 end
  return result
end

local function metadata_summary(metadata_key)
  local summary = {}
  for _, field in ipairs(summary_fields) do
    summary[field] = tonumber(redis.call('HGET', metadata_key, field) or '0')
  end
  summary.owner = redis.call('HGET', metadata_key, 'owner') or ''
  summary.queue = redis.call('HGET', metadata_key, 'queue') or ''
  summary.revision = tonumber(redis.call('HGET', metadata_key, 'revision') or '0')
  summary.last_accepted_order = tonumber(
    redis.call('HGET', metadata_key, 'last_accepted_order') or '0'
  )
  return summary
end

local function redis_key_type(key)
  local result = redis.call('TYPE', key)
  return type(result) == 'table' and result.ok or result
end

local function assert_hash_type(key, name, marker)
  local key_type = redis_key_type(key)
  if key_type ~= 'none' and key_type ~= 'hash' then
    error((marker or 'IMPORT_QUEUE_STRUCTURE') .. ' ' .. name .. '_type')
  end
end

local function assert_snapshot_hash_container(
  key,
  name,
  expected_fields,
  marker
)
  assert_hash_type(key, name, marker)
  if redis.call('EXISTS', key) == 1
    and (redis.call('HLEN', key) ~= expected_fields
      or redis.call('HEXISTS', key, 'snapshot') ~= 1) then
    error((marker or 'IMPORT_QUEUE_STRUCTURE') .. ' ' .. name .. '_fields')
  end
end

local function assert_zset_type(key, name)
  local key_type = redis_key_type(key)
  if key_type ~= 'none' and key_type ~= 'zset' then
    error('IMPORT_QUEUE_STRUCTURE ' .. name .. '_type')
  end
end

local function decode_stored_json(value, name, marker)
  local ok, parsed = pcall(cjson.decode, value)
  if not ok or type(parsed) ~= 'table' then
    error((marker or 'IMPORT_QUEUE_STRUCTURE') .. ' ' .. name .. '_json')
  end
  return parsed
end

local function parse_stored_integer(value, name)
  if type(value) ~= 'string'
    or not (value == '0' or string.match(value, '^[1-9][0-9]*$')) then
    error('IMPORT_QUEUE_STRUCTURE ' .. name)
  end
  local parsed = tonumber(value)
  if not parsed or parsed > max_safe_integer then
    error('IMPORT_QUEUE_STRUCTURE ' .. name)
  end
  return parsed
end

local function assert_discovery_index_types(runnable_key, expires_key)
  assert_zset_type(runnable_key, 'runnable')
  assert_zset_type(expires_key, 'expires')
end

local function assert_queue_structure(
  owner_key,
  display_key,
  metadata_key,
  owner,
  queue
)
  assert_zset_type(owner_key, 'owner')
  assert_zset_type(display_key, 'display')
  assert_hash_type(metadata_key, 'metadata')
  local metadata_exists = redis.call('EXISTS', metadata_key) == 1
  local owner_count = redis.call('ZCARD', owner_key)
  local display_count = redis.call('ZCARD', display_key)
  if not metadata_exists then
    if owner_count ~= 0 or display_count ~= 0 then
      error('IMPORT_QUEUE_STRUCTURE metadata_missing')
    end
    return false
  end
  if redis.call('HLEN', metadata_key) ~= #summary_fields + 4 then
    error('IMPORT_QUEUE_STRUCTURE metadata_fields')
  end
  local stored_owner = redis.call('HGET', metadata_key, 'owner')
  local stored_queue = redis.call('HGET', metadata_key, 'queue')
  if type(stored_owner) ~= 'string'
    or stored_owner == ''
    or (owner ~= nil and stored_owner ~= owner)
    or stored_queue ~= queue then
    error('IMPORT_QUEUE_STRUCTURE metadata_scope')
  end
  local counts = {}
  for _, field in ipairs(summary_fields) do
    counts[field] = parse_stored_integer(
      redis.call('HGET', metadata_key, field),
      'invalid_count'
    )
  end
  local revision = parse_stored_integer(
    redis.call('HGET', metadata_key, 'revision'),
    'invalid_revision'
  )
  local last_accepted_order = parse_stored_integer(
    redis.call('HGET', metadata_key, 'last_accepted_order'),
    'invalid_revision'
  )
  if revision < last_accepted_order then
    error('IMPORT_QUEUE_STRUCTURE metadata_clock')
  end
  if owner_count > 0 then
    local highest = redis.call(
      'ZREVRANGE', owner_key, 0, 0, 'WITHSCORES'
    )
    local highest_score = tonumber(highest[2])
    if #highest ~= 2
      or not highest_score
      or highest_score < 1
      or highest_score > max_safe_integer
      or highest_score % 1 ~= 0
      or highest_score > last_accepted_order then
      error('IMPORT_QUEUE_STRUCTURE owner_clock')
    end
  end
  if counts.total ~= owner_count
    or counts.total ~= display_count
    or counts.unfinished + counts.completed ~= counts.total
    or counts.waiting > counts.unfinished
    or counts.running > counts.unfinished
    or counts.ready > counts.unfinished
    or counts.duplicate_pending > counts.unfinished
    or counts.committing_resolving > counts.unfinished
    or counts.resolving > counts.committing_resolving
    or counts.failed > counts.unfinished then
    error('IMPORT_QUEUE_STRUCTURE count_mismatch')
  end
  return true
end

local function assert_metadata_incrementable(metadata_key, include_order)
  local revision = parse_stored_integer(
    redis.call('HGET', metadata_key, 'revision'),
    'invalid_revision'
  )
  local last_accepted_order = parse_stored_integer(
    redis.call('HGET', metadata_key, 'last_accepted_order'),
    'invalid_revision'
  )
  if revision >= max_safe_integer
    or (include_order and last_accepted_order >= max_safe_integer) then
    error('IMPORT_QUEUE_STRUCTURE counter_exhausted')
  end
end

local function initialize_metadata(metadata_key, owner, queue)
  redis.call(
    'HSET', metadata_key,
    'owner', owner,
    'queue', queue,
    'revision', '0',
    'last_accepted_order', '0',
    'total', '0',
    'unfinished', '0',
    'waiting', '0',
    'running', '0',
    'ready', '0',
    'duplicate_pending', '0',
    'committing_resolving', '0',
    'resolving', '0',
    'completed', '0',
    'failed', '0'
  )
end

local function validate_projection_delta(metadata_key, before, after)
  for _, field in ipairs(summary_fields) do
    local current = parse_stored_integer(
      redis.call('HGET', metadata_key, field),
      'invalid_count'
    )
    local next_value = current + after[field] - before[field]
    if current < 0 or current > max_safe_integer
      or next_value < 0 or next_value > max_safe_integer then
      error('IMPORT_QUEUE_STRUCTURE negative_count')
    end
  end
end

local function apply_projection_delta(metadata_key, before, after)
  validate_projection_delta(metadata_key, before, after)
  for _, field in ipairs(summary_fields) do
    redis.call('HINCRBY', metadata_key, field, after[field] - before[field])
  end
end

local function runnable_status(status)
  return status == 'queued' or status == 'received' or status == 'committing'
end

local function valid_status(status)
  return status == 'queued'
    or status == 'downloading'
    or status == 'received'
    or status == 'preparing'
    or status == 'ready'
    or status == 'committing'
    or status == 'resolving'
    or status == 'completed'
    or status == 'failed'
    or status == 'discarded'
end

local function valid_remote_source(source_type)
  return source_type == 'url'
    or source_type == 'jsonl'
    or source_type == 'weibo'
end

local function valid_integer(value, minimum)
  return type(value) == 'number'
    and value >= minimum
    and value <= max_safe_integer
    and value % 1 == 0
end

local function append_runnable(runnable_key, canonical_key, score_floor)
  local tail = redis.call('ZREVRANGE', runnable_key, 0, 0, 'WITHSCORES')
  local tail_score = 0
  if #tail > 0 then
    tail_score = tonumber(tail[2])
    if not valid_integer(tail_score, 0) then
      error('IMPORT_QUEUE_STRUCTURE runnable_score')
    end
  end
  local next_score = math.max(tail_score + 1, score_floor, 1)
  if not valid_integer(next_score, 1) then
    error('IMPORT_QUEUE_STRUCTURE runnable_score_exhausted')
  end
  redis.call('ZADD', runnable_key, next_score, canonical_key)
  return next_score
end

local function valid_string_array(value)
  if type(value) ~= 'table' then return false end
  local count = 0
  for key, item in pairs(value) do
    count = count + 1
    if type(key) ~= 'number' or key < 1 or key % 1 ~= 0
      or type(item) ~= 'string' then return false end
  end
  return count == #value
end

local function assert_exact_fields(value, fields, name, marker)
  if type(value) ~= 'table' then
    error((marker or 'IMPORT_QUEUE_STRUCTURE') .. ' ' .. name .. '_shape')
  end
  local allowed = {}
  for _, field in ipairs(fields) do allowed[field] = true end
  local count = 0
  for field, _ in pairs(value) do
    count = count + 1
    if not allowed[field] then
      error((marker or 'IMPORT_QUEUE_STRUCTURE') .. ' ' .. name .. '_fields')
    end
  end
  if count ~= #fields then
    error((marker or 'IMPORT_QUEUE_STRUCTURE') .. ' ' .. name .. '_fields')
  end
end

local function assert_allowed_fields(
  value,
  required,
  optional,
  name,
  marker
)
  if type(value) ~= 'table' then
    error((marker or 'IMPORT_QUEUE_STRUCTURE') .. ' ' .. name .. '_shape')
  end
  local allowed = {}
  for _, field in ipairs(required) do
    allowed[field] = true
    if value[field] == nil then
      error((marker or 'IMPORT_QUEUE_STRUCTURE') .. ' ' .. name .. '_fields')
    end
  end
  for _, field in ipairs(optional) do allowed[field] = true end
  for field, _ in pairs(value) do
    if not allowed[field] then
      error((marker or 'IMPORT_QUEUE_STRUCTURE') .. ' ' .. name .. '_fields')
    end
  end
end

local function valid_hash(value, bytes)
  return type(value) == 'string'
    and #value == bytes * 2
    and string.match(value, '^[a-f0-9]+$') ~= nil
end

local function valid_display_order_key(value, session_id)
  return type(value) == 'string'
    and #value == 80
    and string.match(value, '^[0-9a-f]+:[0-9a-f]+:[A-Za-z0-9_%-]+$') ~= nil
    and string.sub(value, 33, 33) == ':'
    and string.sub(value, 37, 37) == ':'
    and string.sub(value, 38) == session_id
end

local function display_contains_session(display_key, session_id)
  -- The display member is prefixed by batch order. Only discovery needs this
  -- corruption-path reverse lookup; all normal reads and writes stay O(1).
  local cursor = '0'
  repeat
    local page = redis.call(
      'ZSCAN', display_key, cursor,
      'MATCH', '*:' .. session_id,
      'COUNT', 128
    )
    cursor = page[1]
    if #page[2] > 0 then return true end
  until cursor == '0'
  return false
end

local function count_plain_occurrences(value, needle)
  local count = 0
  local offset = 1
  while true do
    local first = string.find(value, needle, offset, true)
    if not first then return count end
    count = count + 1
    offset = first + #needle
  end
end

local function assert_json_array_field(
  serialized,
  field,
  expected_count,
  marker
)
  local property = '"' .. field .. '":'
  if count_plain_occurrences(serialized, property) ~= expected_count
    or count_plain_occurrences(serialized, property .. '[') ~= expected_count then
    error((marker or 'IMPORT_QUEUE_STRUCTURE') .. ' ' .. field .. '_array')
  end
end

local function assert_canonical_json_arrays(serialized, snapshot)
  local expected_tags = 0
  if snapshot.status ~= 'completed' and snapshot.status ~= 'discarded' then
    expected_tags = snapshot.commit and 2 or 1
  end
  assert_json_array_field(serialized, 'tags', expected_tags)
end

local function assert_draft(value, marker)
  assert_exact_fields(value, {
    'device', 'brightness', 'theme', 'author', 'title', 'description',
    'source', 'original', 'tags'
  }, 'metadata', marker)
  if (value.device ~= 'pc' and value.device ~= 'mb' and value.device ~= 'auto')
    or (value.brightness ~= 'dark'
      and value.brightness ~= 'light'
      and value.brightness ~= 'auto')
    or type(value.theme) ~= 'string'
    or type(value.author) ~= 'string'
    or type(value.title) ~= 'string'
    or type(value.description) ~= 'string'
    or type(value.source) ~= 'string'
    or type(value.original) ~= 'string'
    or not valid_string_array(value.tags) then
    error((marker or 'IMPORT_QUEUE_STRUCTURE') .. ' metadata_shape')
  end
end

local function assert_remote(value)
  assert_exact_fields(value, { 'url' }, 'remote')
  if type(value.url) ~= 'string' or value.url == '' then
    error('IMPORT_QUEUE_STRUCTURE remote_shape')
  end
end

local function assert_prepared(value)
  assert_exact_fields(value, {
    'prepared_image_key', 'prepared_thumbnail_key', 'original_size',
    'original_width', 'original_height', 'width', 'height', 'ext', 'md5',
    'prepared_image_sha256', 'prepared_thumbnail_sha256',
    'size', 'thumbnail_size', 'quality', 'transcoded', 'detected_device',
    'detected_brightness', 'duplicate_count', 'generation'
  }, 'prepared')
  local positive_fields = {
    'original_size', 'original_width', 'original_height', 'width', 'height',
    'size', 'thumbnail_size'
  }
  for _, field in ipairs(positive_fields) do
    if not valid_integer(value[field], 1) then
      error('IMPORT_QUEUE_STRUCTURE prepared_shape')
    end
  end
  if type(value.prepared_image_key) ~= 'string'
    or value.prepared_image_key == ''
    or type(value.prepared_thumbnail_key) ~= 'string'
    or value.prepared_thumbnail_key == ''
    or (value.ext ~= 'jpg' and value.ext ~= 'png'
      and value.ext ~= 'webp' and value.ext ~= 'gif' and value.ext ~= 'avif')
    or not valid_hash(value.md5, 16)
    or (value.quality ~= cjson.null and not valid_integer(value.quality, 0))
    or type(value.transcoded) ~= 'boolean'
    or (value.detected_device ~= 'pc' and value.detected_device ~= 'mb')
    or (value.detected_brightness ~= 'dark'
      and value.detected_brightness ~= 'light')
    or not valid_integer(value.duplicate_count, 0)
    or type(value.generation) ~= 'string'
    or value.generation == ''
    or not valid_hash(value.prepared_image_sha256, 32)
    or not valid_hash(value.prepared_thumbnail_sha256, 32) then
    error('IMPORT_QUEUE_STRUCTURE prepared_shape')
  end
end

local function assert_completed_display(value, queue)
  assert_allowed_fields(value, {
    'source_type', 'original_width', 'original_height', 'original_size',
    'quality', 'transcoded'
  }, {
    'manifest_position', 'manifest_line'
  }, 'completed_display')
  if (queue == 'upload' and value.source_type ~= 'upload')
    or (queue == 'import' and not valid_remote_source(value.source_type))
    or not valid_integer(value.original_width, 1)
    or not valid_integer(value.original_height, 1)
    or not valid_integer(value.original_size, 1)
    or (value.quality ~= cjson.null and not valid_integer(value.quality, 0))
    or type(value.transcoded) ~= 'boolean'
    or (value.manifest_position ~= nil
      and (not valid_integer(value.manifest_position, 0)
        or value.manifest_position > 4095))
    or (value.manifest_line ~= nil
      and (not valid_integer(value.manifest_line, 1)
        or value.manifest_line > 1000000)) then
    error('IMPORT_QUEUE_STRUCTURE completed_display_shape')
  end
end

local function assert_commit(value)
  assert_exact_fields(value, {
    'commit_request_id', 'commit_intent_hash', 'created_by', 'expected_md5',
    'duplicate_decision', 'metadata', 'final_object_key'
  }, 'commit')
  if type(value.commit_request_id) ~= 'string'
    or value.commit_request_id == ''
    or not valid_hash(value.commit_intent_hash, 32)
    or type(value.created_by) ~= 'string'
    or value.created_by == ''
    or not valid_hash(value.expected_md5, 16)
    or (value.duplicate_decision ~= 'upload'
      and value.duplicate_decision ~= 'confirmed')
    or type(value.final_object_key) ~= 'string'
    or value.final_object_key == '' then
    error('IMPORT_QUEUE_STRUCTURE commit_shape')
  end
  assert_draft(value.metadata)
end

local function assert_session_error(value)
  assert_exact_fields(value, { 'code', 'message' }, 'error')
  if type(value.code) ~= 'string' or value.code == ''
    or type(value.message) ~= 'string' then
    error('IMPORT_QUEUE_STRUCTURE error_shape')
  end
end

local function assert_upload_intent_shape(intent, stored)
  assert_exact_fields(intent, {
    'owner', 'session_id', 'candidate_image_id', 'resolved_image_time',
    'request_hash', 'display_order_key', 'manifest_position', 'metadata', 'storage_slug',
    'expected_size', 'max_long_edge', 'created_at', 'expires_at',
    'execution_token', 'claim_heartbeat_at'
  }, 'intent', 'IMPORT_INTENT')
  if type(intent.owner) ~= 'string' or intent.owner == ''
    or type(intent.session_id) ~= 'string' or intent.session_id == ''
    or type(intent.candidate_image_id) ~= 'string'
    or intent.candidate_image_id == ''
    or type(intent.resolved_image_time) ~= 'string'
    or intent.resolved_image_time == ''
    or not valid_hash(intent.request_hash, 32)
    or not valid_display_order_key(
      intent.display_order_key,
      intent.session_id
    )
    or type(intent.storage_slug) ~= 'string' or intent.storage_slug == ''
    or not valid_integer(intent.expected_size, 1)
    or not valid_integer(intent.max_long_edge, 1)
    or not valid_integer(intent.manifest_position, 0)
    or intent.manifest_position > 4095 then
    error('IMPORT_INTENT intent_shape')
  end
  if stored and (
    not valid_integer(intent.created_at, 0)
    or not valid_integer(intent.expires_at, 1)
    or type(intent.execution_token) ~= 'string'
    or not valid_integer(intent.claim_heartbeat_at, 0)
  ) then
    error('IMPORT_INTENT stored_intent_shape')
  end
  assert_draft(intent.metadata, 'IMPORT_INTENT')
end

local function assert_upload_intent_hash(intent_key, intent)
  local fields = {
    'session_id', 'candidate_image_id', 'request_hash', 'display_order_key',
    'execution_token'
  }
  for _, field in ipairs(fields) do
    if redis.call('HGET', intent_key, field) ~= intent[field] then
      error('IMPORT_INTENT intent_hash')
    end
  end
end

local function assert_canonical_shape(snapshot, pending_acceptance)
  if type(snapshot) ~= 'table' then
    error('IMPORT_QUEUE_STRUCTURE canonical_shape')
  end
  local minimum_version = pending_acceptance and 0 or 1
  local minimum_revision = pending_acceptance and 0 or 1
  local minimum_order = pending_acceptance and 0 or 1
  local minimum_discard_at = pending_acceptance and 0 or 1
  if type(snapshot.session_id) ~= 'string' or snapshot.session_id == ''
    or type(snapshot.image_id) ~= 'string' or snapshot.image_id == ''
    or type(snapshot.owner) ~= 'string' or snapshot.owner == ''
    or (snapshot.queue ~= 'upload' and snapshot.queue ~= 'import')
    or not valid_status(snapshot.status)
    or not valid_hash(snapshot.request_hash, 32)
    or not valid_integer(snapshot.version, minimum_version)
    or not valid_integer(snapshot.last_semantic_revision, minimum_revision)
    or not valid_integer(snapshot.accepted_at, 0)
    or not valid_integer(snapshot.accepted_order, minimum_order)
    or not valid_integer(snapshot.discard_at, minimum_discard_at) then
    error('IMPORT_QUEUE_STRUCTURE canonical_shape')
  end
  if snapshot.status == 'completed' then
    assert_allowed_fields(snapshot, {
      'owner', 'queue', 'session_id', 'image_id', 'request_hash',
      'commit_request_id', 'commit_intent_hash', 'status', 'version',
      'last_semantic_revision', 'accepted_at', 'accepted_order',
      'completed_at', 'discard_at'
    }, { 'display' }, 'completed')
    if type(snapshot.commit_request_id) ~= 'string'
      or snapshot.commit_request_id == ''
      or not valid_hash(snapshot.commit_intent_hash, 32)
      or not valid_integer(snapshot.completed_at, 0) then
      error('IMPORT_QUEUE_STRUCTURE completed_shape')
    end
    if snapshot.display ~= nil then
      assert_completed_display(snapshot.display, snapshot.queue)
    end
  elseif snapshot.status == 'discarded' then
    assert_exact_fields(snapshot, {
      'owner', 'queue', 'session_id', 'image_id', 'image_time',
      'request_hash', 'status', 'version', 'last_semantic_revision',
      'accepted_at', 'accepted_order', 'discarded_at', 'discard_at'
    }, 'discarded')
    if type(snapshot.image_time) ~= 'string' or snapshot.image_time == ''
      or not valid_integer(snapshot.discarded_at, 0) then
      error('IMPORT_QUEUE_STRUCTURE discarded_shape')
    end
  else
    assert_allowed_fields(snapshot, {
      'owner', 'queue', 'source_type', 'session_id', 'image_id', 'image_time',
      'request_hash', 'metadata', 'storage_slug', 'status', 'phase', 'message',
      'progress', 'version', 'progress_seq', 'last_semantic_revision',
      'accepted_at', 'accepted_order', 'execution_token', 'raw_generation',
      'raw_size', 'discard_at', 'semantic_hash'
    }, {
      'remote', 'manifest_position', 'manifest_line', 'prepared',
      'duplicate_decision', 'commit', 'error'
    }, 'active')
    if snapshot.queue == 'upload' and snapshot.source_type ~= 'upload' then
      error('IMPORT_QUEUE_STRUCTURE canonical_source')
    end
    if snapshot.queue == 'import'
      and not valid_remote_source(snapshot.source_type) then
      error('IMPORT_QUEUE_STRUCTURE canonical_source')
    end
    if type(snapshot.image_time) ~= 'string' or snapshot.image_time == ''
      or type(snapshot.storage_slug) ~= 'string'
      or snapshot.storage_slug == ''
      or type(snapshot.phase) ~= 'string'
      or type(snapshot.message) ~= 'string'
      or type(snapshot.execution_token) ~= 'string'
      or type(snapshot.raw_generation) ~= 'string'
      or not valid_hash(snapshot.semantic_hash, 32)
      or not valid_integer(snapshot.progress_seq, 0)
      or not valid_integer(snapshot.raw_size, 0)
      or (snapshot.manifest_position ~= nil
        and (not valid_integer(snapshot.manifest_position, 0)
          or snapshot.manifest_position > 4095))
      or (snapshot.manifest_line ~= nil
        and (not valid_integer(snapshot.manifest_line, 1)
          or snapshot.manifest_line > 1000000))
      or (snapshot.progress ~= cjson.null
        and (type(snapshot.progress) ~= 'number'
          or snapshot.progress < 0 or snapshot.progress > 100)) then
      error('IMPORT_QUEUE_STRUCTURE active_shape')
    end
    assert_draft(snapshot.metadata)
    if snapshot.queue == 'import' then
      assert_remote(snapshot.remote)
    elseif snapshot.remote ~= nil then
      error('IMPORT_QUEUE_STRUCTURE remote_scope')
    end
    if snapshot.prepared ~= nil then assert_prepared(snapshot.prepared) end
    if snapshot.duplicate_decision ~= nil
      and snapshot.duplicate_decision ~= 'upload'
      and snapshot.duplicate_decision ~= 'confirmed' then
      error('IMPORT_QUEUE_STRUCTURE duplicate_decision')
    end
    if snapshot.commit ~= nil then assert_commit(snapshot.commit) end
    if snapshot.error ~= nil then assert_session_error(snapshot.error) end
  end
end

local function assert_canonical_structure(
  snapshot,
  canonical_key,
  owner_key,
  display_key,
  metadata_key,
  runnable_key,
  expires_key
)
  assert_snapshot_hash_container(canonical_key, 'canonical', 12)
  assert_canonical_shape(snapshot, false)
  local metadata_revision = parse_stored_integer(
    redis.call('HGET', metadata_key, 'revision'),
    'invalid_revision'
  )
  local last_accepted_order = parse_stored_integer(
    redis.call('HGET', metadata_key, 'last_accepted_order'),
    'invalid_revision'
  )
  if snapshot.last_semantic_revision > metadata_revision
    or snapshot.accepted_order > last_accepted_order then
    error('IMPORT_QUEUE_STRUCTURE canonical_clock')
  end
  local hash_fields = {
    'session_id', 'image_id', 'owner', 'queue', 'status', 'request_hash'
  }
  for _, field in ipairs(hash_fields) do
    if redis.call('HGET', canonical_key, field) ~= snapshot[field] then
      error('IMPORT_QUEUE_STRUCTURE canonical_hash')
    end
  end
  local numeric_hash_fields = {
    'version', 'accepted_order', 'discard_at', 'last_semantic_revision'
  }
  for _, field in ipairs(numeric_hash_fields) do
    if parse_stored_integer(
      redis.call('HGET', canonical_key, field),
      'invalid_canonical_integer'
    ) ~= snapshot[field] then
      error('IMPORT_QUEUE_STRUCTURE canonical_hash')
    end
  end
  local owner_score = redis.call('ZSCORE', owner_key, snapshot.session_id)
  local display_order_key = redis.call(
    'HGET', canonical_key, 'display_order_key'
  )
  if not valid_display_order_key(display_order_key, snapshot.session_id) then
    error('IMPORT_QUEUE_STRUCTURE display_order_key')
  end
  local display_score = redis.call('ZSCORE', display_key, display_order_key)
  if snapshot.status == 'discarded' then
    if owner_score or display_score then
      error('IMPORT_QUEUE_STRUCTURE discarded_owner')
    end
  elseif not owner_score
    or tonumber(owner_score) ~= tonumber(snapshot.accepted_order) then
    error('IMPORT_QUEUE_STRUCTURE owner_score')
  elseif not display_score or tonumber(display_score) ~= 0 then
    error('IMPORT_QUEUE_STRUCTURE display_score')
  end
  local runnable_score = redis.call('ZSCORE', runnable_key, canonical_key)
  if runnable_status(snapshot.status) then
    if not runnable_score
      or not valid_integer(tonumber(runnable_score), 1) then
      error('IMPORT_QUEUE_STRUCTURE runnable_score')
    end
  elseif runnable_score then
    error('IMPORT_QUEUE_STRUCTURE unexpected_runnable')
  end
  local expires_score = redis.call('ZSCORE', expires_key, canonical_key)
  if not expires_score
    or tonumber(expires_score) ~= tonumber(snapshot.discard_at) then
    error('IMPORT_QUEUE_STRUCTURE expires_score')
  end
end

local function encode_snapshot(snapshot)
  local empty_tags = snapshot.metadata
    and snapshot.metadata.tags
    and next(snapshot.metadata.tags) == nil
  empty_tags = empty_tags or (
    snapshot.commit
    and snapshot.commit.metadata
    and snapshot.commit.metadata.tags
    and next(snapshot.commit.metadata.tags) == nil
  )
  local serialized = cjson.encode(snapshot)
  if empty_tags then
    serialized = string.gsub(serialized, '"tags":{}', '"tags":[]')
  end
  return serialized
end

local function store_snapshot(
  canonical_key,
  snapshot,
  serialized,
  display_order_key
)
  redis.call(
    'HSET', canonical_key,
    'snapshot', serialized,
    'session_id', snapshot.session_id,
    'image_id', snapshot.image_id,
    'owner', snapshot.owner,
    'queue', snapshot.queue,
    'status', snapshot.status,
    'version', tostring(snapshot.version),
    'request_hash', snapshot.request_hash,
    'accepted_order', tostring(snapshot.accepted_order),
    'display_order_key', display_order_key,
    'discard_at', tostring(snapshot.discard_at),
    'last_semantic_revision', tostring(snapshot.last_semantic_revision)
  )
end

local function same_string_array(left, right)
  if not left or not right or #left ~= #right then return false end
  for index = 1, #left do
    if left[index] ~= right[index] then return false end
  end
  return true
end

local function same_draft(left, right)
  if not left or not right then return false end
  local fields = {
    'device', 'brightness', 'theme', 'author', 'title', 'description',
    'source', 'original'
  }
  for _, field in ipairs(fields) do
    if left[field] ~= right[field] then return false end
  end
  return same_string_array(left.tags, right.tags)
end
`;

export const createImportCanonicalScript = `${projectionLua}
local source = ARGV[1]
local now = tonumber(ARGV[2])
local ttl_ms = tonumber(ARGV[3])
local template = cjson.decode(ARGV[4])
local expected_token = ARGV[5]
local requested_display_order_key = ARGV[6]
local intent_key = KEYS[1]
local canonical_key = KEYS[2]
local owner_key = KEYS[3]
local display_key = KEYS[4]
local metadata_key = KEYS[5]
local runnable_key = KEYS[6]
local expires_key = KEYS[7]
local display_order_key = ''

if not valid_integer(now, 0)
  or not valid_integer(ttl_ms, 1)
  or now > max_safe_integer - ttl_ms then
  error('IMPORT_CANONICAL invalid_clock')
end
assert_discovery_index_types(runnable_key, expires_key)
assert_snapshot_hash_container(canonical_key, 'canonical', 12)
assert_canonical_shape(template, true)
assert_canonical_json_arrays(ARGV[4], template)

local existing_json = redis.call('HGET', canonical_key, 'snapshot')
if existing_json then
  local existing = decode_stored_json(existing_json, 'canonical')
  assert_canonical_shape(existing, false)
  assert_canonical_json_arrays(existing_json, existing)
  assert_queue_structure(
    owner_key, display_key, metadata_key, existing.owner, existing.queue
  )
  assert_canonical_structure(
    existing,
    canonical_key,
    owner_key,
    display_key,
    metadata_key,
    runnable_key,
    expires_key
  )
  if existing.session_id == template.session_id
    and existing.request_hash == template.request_hash
    and (
      source ~= 'remote'
      or redis.call('HGET', canonical_key, 'display_order_key')
        == requested_display_order_key
    ) then
    return { 2, existing_json, cjson.encode(metadata_summary(metadata_key)) }
  end
  return { -2 }
end

if source == 'intent' then
  assert_snapshot_hash_container(intent_key, 'intent', 6, 'IMPORT_INTENT')
  if template.queue ~= 'upload' then
    return redis.error_reply('IMPORT_CANONICAL invalid_upload_takeover')
  end
  assert_queue_structure(
    owner_key, display_key, metadata_key, template.owner, 'upload'
  )
  if redis.call('ZSCORE', owner_key, template.session_id) then
    error('IMPORT_QUEUE_STRUCTURE canonical_missing')
  end
  local intent_json = redis.call('HGET', intent_key, 'snapshot')
  if not intent_json then return { -3 } end
  local intent = decode_stored_json(intent_json, 'intent', 'IMPORT_INTENT')
  assert_upload_intent_shape(intent, true)
  assert_upload_intent_hash(intent_key, intent)
  assert_json_array_field(intent_json, 'tags', 1, 'IMPORT_INTENT')
  if redis.call('ZSCORE', display_key, intent.display_order_key) then
    error('IMPORT_QUEUE_STRUCTURE canonical_missing')
  end
  if tonumber(intent.expires_at or 0) <= now then
    redis.call('DEL', intent_key)
    return { -3 }
  end
  if intent.session_id ~= template.session_id
    or intent.candidate_image_id ~= template.image_id
    or intent.request_hash ~= template.request_hash then
    return { -2 }
  end
  if intent.execution_token ~= expected_token or expected_token == '' then
    return { -4 }
  end
  if template.status ~= 'received'
    or template.raw_generation == ''
    or tonumber(template.raw_size) ~= tonumber(intent.expected_size)
    or template.owner ~= intent.owner
    or template.queue ~= 'upload'
    or template.source_type ~= 'upload'
    or template.image_time ~= intent.resolved_image_time
    or template.storage_slug ~= intent.storage_slug
    or not same_draft(template.metadata, intent.metadata) then
    return redis.error_reply('IMPORT_CANONICAL invalid_upload_takeover')
  end
  template.owner = intent.owner
  template.queue = 'upload'
  template.source_type = 'upload'
  template.session_id = intent.session_id
  template.image_id = intent.candidate_image_id
  template.image_time = intent.resolved_image_time
  template.request_hash = intent.request_hash
  template.metadata = intent.metadata
  template.storage_slug = intent.storage_slug
  display_order_key = intent.display_order_key
elseif source == 'remote' then
  if template.queue ~= 'import'
    or not valid_remote_source(template.source_type)
    or template.status ~= 'queued'
    or not template.remote
    or type(template.remote.url) ~= 'string'
    or template.remote.url == ''
    or template.execution_token ~= ''
    or template.raw_generation ~= ''
    or tonumber(template.raw_size) ~= 0 then
    return redis.error_reply('IMPORT_CANONICAL invalid_remote_accept')
  end
  display_order_key = requested_display_order_key
else
  return redis.error_reply('IMPORT_CANONICAL invalid_source')
end

if not valid_display_order_key(display_order_key, template.session_id) then
  return redis.error_reply('IMPORT_CANONICAL invalid_display_order')
end

local metadata_exists = assert_queue_structure(
  owner_key, display_key, metadata_key, template.owner, template.queue
)
if not metadata_exists then
  initialize_metadata(metadata_key, template.owner, template.queue)
end
if redis.call('ZSCORE', owner_key, template.session_id) then
  return redis.error_reply('IMPORT_QUEUE_STRUCTURE duplicate_member')
end
if redis.call('ZSCORE', display_key, display_order_key) then
  return redis.error_reply('IMPORT_QUEUE_STRUCTURE duplicate_display_member')
end

validate_projection_delta(
  metadata_key,
  projection({ status = 'discarded' }),
  projection(template)
)
assert_metadata_incrementable(metadata_key, true)
local accepted_order = redis.call(
  'HINCRBY', metadata_key, 'last_accepted_order', 1
)
local revision = redis.call('HINCRBY', metadata_key, 'revision', 1)
template.accepted_order = accepted_order
template.accepted_at = now
template.version = 1
template.progress_seq = 0
template.last_semantic_revision = revision
template.discard_at = now + ttl_ms
local serialized = encode_snapshot(template)

apply_projection_delta(metadata_key, projection({ status = 'discarded' }), projection(template))
store_snapshot(canonical_key, template, serialized, display_order_key)
redis.call('ZADD', owner_key, accepted_order, template.session_id)
redis.call('ZADD', display_key, 0, display_order_key)
if runnable_status(template.status) then
  append_runnable(runnable_key, canonical_key, now)
end
redis.call('ZADD', expires_key, template.discard_at, canonical_key)
if source == 'intent' then redis.call('DEL', intent_key) end

return { 1, serialized, cjson.encode(metadata_summary(metadata_key)) }
`;

export const mutateImportCanonicalScript = `${projectionLua}
local action = ARGV[1]
local expected_session_id = ARGV[2]
local expected_image_id = ARGV[3]
local expected_version = tonumber(ARGV[4])
local expected_token = ARGV[5]
local now = tonumber(ARGV[6])
local ttl_ms = tonumber(ARGV[7])
local payload_json = ARGV[8]
local allow_stale_semantic_noop = ARGV[9] == '1'
local canonical_key = KEYS[1]
local owner_key = KEYS[2]
local display_key = KEYS[3]
local metadata_key = KEYS[4]
local runnable_key = KEYS[5]
local expires_key = KEYS[6]
local expiry_semantic = false

if not valid_integer(now, 0)
  or not valid_integer(ttl_ms, 1)
  or now > max_safe_integer - ttl_ms then
  error('IMPORT_CANONICAL invalid_clock')
end
assert_discovery_index_types(runnable_key, expires_key)
assert_snapshot_hash_container(canonical_key, 'canonical', 12)

local current_json = redis.call('HGET', canonical_key, 'snapshot')
if not current_json then return { -1 } end
local current = decode_stored_json(current_json, 'canonical')
assert_canonical_shape(current, false)
assert_canonical_json_arrays(current_json, current)
if current.session_id ~= expected_session_id
  or current.image_id ~= expected_image_id then return { -2 } end
local version_matches = tonumber(current.version) == expected_version
if not version_matches and not (
  action == 'semantic'
  and allow_stale_semantic_noop
) then
  return { -3, current_json }
end

assert_queue_structure(
  owner_key, display_key, metadata_key, current.owner, current.queue
)
assert_canonical_structure(
  current,
  canonical_key,
  owner_key,
  display_key,
  metadata_key,
  runnable_key,
  expires_key
)
local display_order_key = redis.call(
  'HGET', canonical_key, 'display_order_key'
)

if action == 'expire' then
  if tonumber(current.discard_at) > now then return { -6, current_json } end
  if current.status == 'completed' or current.status == 'discarded' then
    action = 'delete'
  else
    if current.execution_token ~= expected_token then return { -4 } end
    expiry_semantic = true
    action = 'semantic'
  end
end

if action == 'progress' then
  if tonumber(current.discard_at) <= now then return { -5 } end
  if expected_token == '' or current.execution_token ~= expected_token then
    return { -4 }
  end
  if tonumber(current.progress_seq) >= max_safe_integer then
    return redis.error_reply('IMPORT_CANONICAL progress_sequence_exhausted')
  end
  local progress = cjson.decode(payload_json)
  assert_exact_fields(progress, {
    'phase', 'message', 'progress'
  }, 'progress')
  if type(progress.phase) ~= 'string'
    or type(progress.message) ~= 'string'
    or not (
      progress.progress == cjson.null
      or (type(progress.progress) == 'number'
        and progress.progress >= 0
        and progress.progress <= 100)
    ) then
    return redis.error_reply('IMPORT_CANONICAL invalid_progress')
  end
  current.phase = progress.phase
  current.message = progress.message
  current.progress = progress.progress
  current.progress_seq = tonumber(current.progress_seq or 0) + 1
  local serialized = encode_snapshot(current)
  store_snapshot(canonical_key, current, serialized, display_order_key)
  return { 3, serialized, cjson.encode(metadata_summary(metadata_key)) }
end

if action == 'heartbeat' then
  if tonumber(current.discard_at) <= now then return { -5 } end
  if expected_token == '' or current.execution_token ~= expected_token then
    return { -4 }
  end
  current.discard_at = math.max(
    tonumber(current.discard_at), now + ttl_ms
  )
  local serialized = encode_snapshot(current)
  store_snapshot(canonical_key, current, serialized, display_order_key)
  redis.call('ZADD', expires_key, current.discard_at, canonical_key)
  return { 4, serialized, cjson.encode(metadata_summary(metadata_key)) }
end

if action == 'delete' then
  if current.status ~= 'completed' and current.status ~= 'discarded' then
    return redis.error_reply('IMPORT_CANONICAL terminal_delete_required')
  end
  local before = projection(current)
  if before.total > 0 then
    assert_metadata_incrementable(metadata_key, false)
    apply_projection_delta(
      metadata_key,
      before,
      projection({ status = 'discarded' })
    )
    redis.call('ZREM', owner_key, current.session_id)
    redis.call('ZREM', display_key, display_order_key)
    redis.call('HINCRBY', metadata_key, 'revision', 1)
  end
  redis.call('ZREM', runnable_key, canonical_key)
  redis.call('ZREM', expires_key, canonical_key)
  redis.call('DEL', canonical_key)
  return { 5, '', cjson.encode(metadata_summary(metadata_key)) }
end

if action ~= 'semantic' then
  return redis.error_reply('IMPORT_CANONICAL invalid_action')
end

local next = cjson.decode(payload_json)
assert_canonical_shape(next, false)
assert_canonical_json_arrays(payload_json, next)
if not version_matches then
  -- A lost response may retry with an older expected version. It is a safe
  -- no-op only when the target semantic state is still the current canonical;
  -- a concurrent writer that changed the state must remain a CAS conflict.
  if allow_stale_semantic_noop
    and expected_version < tonumber(current.version)
    and type(next.semantic_hash) == 'string'
    and next.semantic_hash == current.semantic_hash then
    return { 0, current_json, cjson.encode(metadata_summary(metadata_key)) }
  end
  return { -3, current_json }
end
if expiry_semantic
  and next.status ~= 'completed'
  and next.status ~= 'discarded'
  and next.status ~= 'resolving' then
  return redis.error_reply('IMPORT_CANONICAL invalid_expiry_transition')
end
if not expiry_semantic
  and tonumber(current.discard_at) <= now
  and next.status ~= 'completed'
  and next.status ~= 'discarded' then
  return { -5 }
end
if current.status == 'completed' or current.status == 'discarded' then
  return redis.error_reply('IMPORT_CANONICAL terminal_transition')
end
if next.session_id ~= current.session_id
  or next.image_id ~= current.image_id
  or next.owner ~= current.owner
  or next.queue ~= current.queue
  or next.request_hash ~= current.request_hash
  or tonumber(next.accepted_at) ~= tonumber(current.accepted_at)
  or tonumber(next.accepted_order) ~= tonumber(current.accepted_order)
  or (next.status == 'discarded' and next.image_time ~= current.image_time) then
  return redis.error_reply('IMPORT_CANONICAL immutable_field_changed')
end
if next.status ~= 'completed' and next.status ~= 'discarded'
  and (next.source_type ~= current.source_type
    or next.image_time ~= current.image_time
    or next.storage_slug ~= current.storage_slug) then
  return redis.error_reply('IMPORT_CANONICAL immutable_active_field_changed')
end
if next.status ~= 'completed' and next.status ~= 'discarded'
  and current.queue == 'import'
  and (not next.remote
    or not current.remote
    or next.remote.url ~= current.remote.url) then
  return redis.error_reply('IMPORT_CANONICAL immutable_source_changed')
end
if next.status == 'completed'
  and (not current.commit
    or (current.status ~= 'committing' and current.status ~= 'resolving')
    or next.commit_request_id ~= current.commit.commit_request_id
    or next.commit_intent_hash ~= current.commit.commit_intent_hash) then
  return redis.error_reply('IMPORT_CANONICAL immutable_commit_changed')
end

if not expiry_semantic
  and next.status ~= 'completed' and next.status ~= 'discarded'
  and next.semantic_hash == current.semantic_hash then
  return { 0, current_json, cjson.encode(metadata_summary(metadata_key)) }
end

if tonumber(current.version) >= max_safe_integer then
  return redis.error_reply('IMPORT_CANONICAL version_exhausted')
end
assert_metadata_incrementable(metadata_key, false)

local before = projection(current)
local after = projection(next)
validate_projection_delta(metadata_key, before, after)
local revision = redis.call('HINCRBY', metadata_key, 'revision', 1)
next.version = tonumber(current.version) + 1
if next.status ~= 'completed' and next.status ~= 'discarded' then
  next.progress_seq = 0
end
next.last_semantic_revision = revision
next.discard_at = math.max(
  tonumber(current.discard_at), now + ttl_ms
)
local serialized = encode_snapshot(next)
apply_projection_delta(metadata_key, before, after)
store_snapshot(canonical_key, next, serialized, display_order_key)

if after.total == 0 then
  redis.call('ZREM', owner_key, current.session_id)
  redis.call('ZREM', display_key, display_order_key)
else
  redis.call('ZADD', owner_key, next.accepted_order, next.session_id)
  redis.call('ZADD', display_key, 0, display_order_key)
end
if runnable_status(next.status) then
  if not runnable_status(current.status) then
    append_runnable(runnable_key, canonical_key, now)
  end
else
  redis.call('ZREM', runnable_key, canonical_key)
end
redis.call('ZADD', expires_key, next.discard_at, canonical_key)
return { 1, serialized, cjson.encode(metadata_summary(metadata_key)) }
`;

export const createUploadIntentScript = `${projectionLua}
local intent_key = KEYS[1]
local canonical_key = KEYS[2]
local owner_key = KEYS[3]
local display_key = KEYS[4]
local metadata_key = KEYS[5]
local runnable_key = KEYS[6]
local expires_key = KEYS[7]
local template = cjson.decode(ARGV[1])
local ttl_seconds = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local function encode_intent(intent)
  local empty_tags = intent.metadata
    and intent.metadata.tags
    and next(intent.metadata.tags) == nil
  local serialized = cjson.encode(intent)
  if empty_tags then
    serialized = string.gsub(serialized, '"tags":{}', '"tags":[]')
  end
  return serialized
end

if not valid_integer(now, 0)
  or not valid_integer(ttl_seconds, 1)
  or ttl_seconds > math.floor((max_safe_integer - now) / 1000) then
  error('IMPORT_INTENT invalid_clock')
end
assert_upload_intent_shape(template, false)
assert_json_array_field(ARGV[1], 'tags', 1, 'IMPORT_INTENT')
assert_snapshot_hash_container(canonical_key, 'canonical', 12)
local canonical_json = redis.call('HGET', canonical_key, 'snapshot')
if canonical_json then
  assert_discovery_index_types(runnable_key, expires_key)
  local canonical = decode_stored_json(canonical_json, 'canonical')
  assert_canonical_shape(canonical, false)
  assert_canonical_json_arrays(canonical_json, canonical)
  assert_queue_structure(
    owner_key, display_key, metadata_key, canonical.owner, canonical.queue
  )
  assert_canonical_structure(
    canonical,
    canonical_key,
    owner_key,
    display_key,
    metadata_key,
    runnable_key,
    expires_key
  )
  if canonical.owner ~= template.owner or canonical.queue ~= 'upload' then
    return redis.error_reply('IMPORT_CANONICAL invalid_upload_scope')
  end
  if canonical.session_id == template.session_id
    and canonical.request_hash == template.request_hash
    and redis.call('HGET', canonical_key, 'display_order_key')
      == template.display_order_key then
    return { 2, canonical_json }
  end
  return { -2 }
end

assert_snapshot_hash_container(intent_key, 'intent', 6, 'IMPORT_INTENT')
local existing_json = redis.call('HGET', intent_key, 'snapshot')
assert_queue_structure(
  owner_key, display_key, metadata_key, template.owner, 'upload'
)
if redis.call('ZSCORE', owner_key, template.session_id) then
  error('IMPORT_QUEUE_STRUCTURE canonical_missing')
end
if redis.call('ZSCORE', display_key, template.display_order_key) then
  error('IMPORT_QUEUE_STRUCTURE canonical_missing')
end
if existing_json then
  local existing = decode_stored_json(
    existing_json, 'intent', 'IMPORT_INTENT'
  )
  assert_upload_intent_shape(existing, true)
  assert_upload_intent_hash(intent_key, existing)
  assert_json_array_field(existing_json, 'tags', 1, 'IMPORT_INTENT')
  if tonumber(existing.expires_at or 0) <= now then
    redis.call('DEL', intent_key)
  elseif existing.session_id == template.session_id
    and existing.request_hash == template.request_hash
    and existing.display_order_key == template.display_order_key then
    return { 1, existing_json }
  else
    return { -2 }
  end
end

template.created_at = now
template.expires_at = now + ttl_seconds * 1000
template.execution_token = ''
template.claim_heartbeat_at = 0
local serialized = encode_intent(template)
redis.call(
  'HSET', intent_key,
  'snapshot', serialized,
  'session_id', template.session_id,
  'candidate_image_id', template.candidate_image_id,
  'request_hash', template.request_hash,
  'display_order_key', template.display_order_key,
  'execution_token', ''
)
redis.call('EXPIRE', intent_key, ttl_seconds)
return { 0, serialized }
`;

export const mutateUploadIntentScript = `${projectionLua}
local action = ARGV[1]
local expected_session_id = ARGV[2]
local expected_image_id = ARGV[3]
local expected_hash = ARGV[4]
local token = ARGV[5]
local now = tonumber(ARGV[6])
local ttl_seconds = tonumber(ARGV[7])
local stale_ms = tonumber(ARGV[8])
local intent_key = KEYS[1]

local function encode_intent(intent)
  local empty_tags = intent.metadata
    and intent.metadata.tags
    and next(intent.metadata.tags) == nil
  local serialized = cjson.encode(intent)
  if empty_tags then
    serialized = string.gsub(serialized, '"tags":{}', '"tags":[]')
  end
  return serialized
end

if not valid_integer(now, 0)
  or not valid_integer(ttl_seconds, 1)
  or not valid_integer(stale_ms, 0)
  or ttl_seconds > math.floor((9007199254740991 - now) / 1000) then
  error('IMPORT_INTENT invalid_clock')
end
assert_snapshot_hash_container(intent_key, 'intent', 6, 'IMPORT_INTENT')
local current_json = redis.call('HGET', intent_key, 'snapshot')
if not current_json then return { -1 } end
local current = decode_stored_json(current_json, 'intent', 'IMPORT_INTENT')
assert_upload_intent_shape(current, true)
assert_upload_intent_hash(intent_key, current)
assert_json_array_field(current_json, 'tags', 1, 'IMPORT_INTENT')
if current.session_id ~= expected_session_id
  or current.candidate_image_id ~= expected_image_id
  or current.request_hash ~= expected_hash then return { -2 } end
if tonumber(current.expires_at or 0) <= now then
  redis.call('DEL', intent_key)
  return { -1 }
end
if token == '' then return { -4 } end

if action == 'claim' then
  if current.execution_token ~= ''
    and current.execution_token ~= token
    and tonumber(current.claim_heartbeat_at or 0) + stale_ms > now then
    return { -3, current_json }
  end
  current.execution_token = token
  current.claim_heartbeat_at = math.max(
    tonumber(current.claim_heartbeat_at or 0), now
  )
  current.expires_at = math.max(
    tonumber(current.expires_at), now + ttl_seconds * 1000
  )
  local serialized = encode_intent(current)
  redis.call('HSET', intent_key, 'snapshot', serialized, 'execution_token', token)
  redis.call('EXPIRE', intent_key, ttl_seconds)
  return { 1, serialized }
end

if current.execution_token ~= token or token == '' then return { -4 } end
if action == 'heartbeat' then
  current.claim_heartbeat_at = math.max(
    tonumber(current.claim_heartbeat_at or 0), now
  )
  current.expires_at = math.max(
    tonumber(current.expires_at), now + ttl_seconds * 1000
  )
  local serialized = encode_intent(current)
  redis.call('HSET', intent_key, 'snapshot', serialized)
  redis.call('EXPIRE', intent_key, ttl_seconds)
  return { 2, serialized }
end
if action == 'release' then
  current.execution_token = ''
  current.claim_heartbeat_at = 0
  local serialized = encode_intent(current)
  redis.call('HSET', intent_key, 'snapshot', serialized, 'execution_token', '')
  return { 3, serialized }
end
return redis.error_reply('IMPORT_INTENT invalid_action')
`;

export const readUploadIntentScript = String.raw`
local intent_key = KEYS[1]
local key_type = redis.call('TYPE', intent_key)
key_type = type(key_type) == 'table' and key_type.ok or key_type
if key_type == 'none' then return { 0 } end
if key_type ~= 'hash'
  or redis.call('HLEN', intent_key) ~= 6
  or redis.call('HEXISTS', intent_key, 'snapshot') ~= 1 then
  return redis.error_reply('IMPORT_INTENT intent_fields')
end
return {
  1,
  redis.call('HGET', intent_key, 'snapshot'),
  redis.call('HGET', intent_key, 'session_id'),
  redis.call('HGET', intent_key, 'candidate_image_id'),
  redis.call('HGET', intent_key, 'request_hash'),
  redis.call('HGET', intent_key, 'display_order_key'),
  redis.call('HGET', intent_key, 'execution_token')
}
`;

export const readImportQueueSnapshotScript = `${projectionLua}
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

if not valid_integer(offset, 0)
  or not valid_integer(limit, 0)
  or not valid_integer(max_limit, 1)
  or not valid_integer(max_excluded, 1)
  or limit > max_limit
  or string.sub(excluded_json, 1, 1) ~= '['
  or string.sub(included_json, 1, 1) ~= '[' then
  error('IMPORT_QUEUE_STRUCTURE snapshot_arguments')
end
local excluded_items = cjson.decode(excluded_json)
local included_items = cjson.decode(included_json)
if type(excluded_items) ~= 'table'
  or type(included_items) ~= 'table'
  or #excluded_items > max_excluded
  or #included_items + limit > max_limit then
  error('IMPORT_QUEUE_STRUCTURE snapshot_items')
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
    error('IMPORT_QUEUE_STRUCTURE snapshot_exclude')
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
    error('IMPORT_QUEUE_STRUCTURE snapshot_include')
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
      error('IMPORT_QUEUE_STRUCTURE canonical_without_metadata')
    end
  end
  return { 0 }
end
local metadata = redis.call('HGETALL', metadata_key)
local active_excluded = {}
local excluded_snapshots = {}
local excluded_ranks = {}
local stale_items = {}

-- Every client-owned pair is validated before it can affect pagination. A
-- missing, discarded, or replaced incarnation is reported explicitly so the
-- browser can atomically retire its old card; structural corruption remains a
-- hard failure even when the pair would otherwise be filtered off-page.
for _, item in ipairs(excluded_items) do
  local canonical_key = canonical_prefix .. item.session_id
  local canonical_type = redis_key_type(canonical_key)
  if canonical_type == 'none' then
    if redis.call('ZSCORE', owner_key, item.session_id)
      or display_contains_session(display_key, item.session_id) then
      error('IMPORT_QUEUE_STRUCTURE canonical_missing')
    end
    stale_items[#stale_items + 1] = item
  else
    assert_snapshot_hash_container(canonical_key, 'canonical', 12)
    local serialized = redis.call('HGET', canonical_key, 'snapshot')
    if not serialized then error('IMPORT_QUEUE_STRUCTURE canonical_missing') end
    local snapshot = decode_stored_json(serialized, 'canonical')
    assert_canonical_shape(snapshot, false)
    assert_canonical_json_arrays(serialized, snapshot)
    if snapshot.session_id ~= item.session_id
      or snapshot.owner ~= expected_owner
      or snapshot.queue ~= expected_queue then
      error('IMPORT_QUEUE_STRUCTURE canonical_scope')
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
        error('IMPORT_QUEUE_STRUCTURE display_score')
      end
      active_excluded[item.session_id] = item.image_id
      excluded_snapshots[item.session_id] = serialized
      excluded_ranks[#excluded_ranks + 1] = tonumber(display_rank)
    end
  end
end
table.sort(excluded_ranks)
if offset > max_safe_integer - limit - #excluded_ranks then
  error('IMPORT_QUEUE_STRUCTURE snapshot_range')
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
      return redis.error_reply('IMPORT_QUEUE_STRUCTURE display_order_key')
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
    error('IMPORT_QUEUE_STRUCTURE canonical_missing')
  end
  assert_snapshot_hash_container(canonical_key, 'canonical', 12)
  local snapshot = redis.call('HGET', canonical_key, 'snapshot')
  if not snapshot then error('IMPORT_QUEUE_STRUCTURE canonical_missing') end
  local parsed = decode_stored_json(snapshot, 'canonical')
  assert_canonical_shape(parsed, false)
  assert_canonical_json_arrays(snapshot, parsed)
  if parsed.session_id ~= session_id
    or parsed.owner ~= expected_owner
    or parsed.queue ~= expected_queue then
    error('IMPORT_QUEUE_STRUCTURE canonical_scope')
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
    error('IMPORT_QUEUE_STRUCTURE canonical_scope')
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

export const scanImportQueueActionScript = `${projectionLua}
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
  or not valid_integer(limit, 1)
  or not valid_integer(max_limit, 1)
  or limit > max_limit then
  error('IMPORT_QUEUE_STRUCTURE action_scan_arguments')
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
  error('IMPORT_QUEUE_STRUCTURE action_scan_watermark')
end
if cursor == 0 then return { 1, 0, 0, 0 } end

local values = redis.call(
  'ZREVRANGEBYSCORE', owner_key, cursor, 1,
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
    return redis.error_reply('IMPORT_QUEUE_STRUCTURE canonical_missing')
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
    return redis.error_reply('IMPORT_QUEUE_STRUCTURE canonical_scope')
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
  if index == count and has_more == 1 then next_cursor = score - 1 end
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
  error('IMPORT_QUEUE_STRUCTURE stale_receipt_arguments')
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
    error('IMPORT_QUEUE_STRUCTURE stale_receipt_identity')
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

export const discoverImportSessionsScript = `${projectionLua}
local index_key = KEYS[1]
local mode = ARGV[1]
local bound = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local canonical_root = ARGV[4]
local owner_root = ARGV[5]
local metadata_root = ARGV[6]
local display_root = ARGV[7]
local max_limit = tonumber(ARGV[8])
local runnable_tail = tonumber(ARGV[9])

if not valid_integer(bound, 0)
  or not valid_integer(limit, 1)
  or not valid_integer(max_limit, 1)
  or not valid_integer(runnable_tail, 0)
  or limit > max_limit then
  error('IMPORT_QUEUE_STRUCTURE discovery_arguments')
end

assert_zset_type(index_key, 'discovery')
local members
local frozen_tail = 0
local last_scanned_score = 0
if mode == 'expires' then
  members = redis.call(
    'ZRANGEBYSCORE', index_key, '-inf', bound, 'LIMIT', 0, limit
  )
elseif mode == 'all' then
  members = redis.call('ZRANGE', index_key, bound, bound + limit - 1)
elseif mode == 'runnable' then
  frozen_tail = runnable_tail
  last_scanned_score = bound
  if frozen_tail == 0 then
    local tail = redis.call('ZREVRANGE', index_key, 0, 0, 'WITHSCORES')
    if #tail > 0 then
      frozen_tail = tonumber(tail[2])
      if not valid_integer(frozen_tail, 0) then
        error('IMPORT_QUEUE_STRUCTURE runnable_score')
      end
    end
  end
  if bound > frozen_tail then
    error('IMPORT_QUEUE_STRUCTURE runnable_cursor')
  end
  local scored = {}
  if runnable_tail == 0 and bound == 0 then
    scored = redis.call(
      'ZRANGEBYSCORE', index_key, '-inf', frozen_tail,
      'WITHSCORES', 'LIMIT', 0, limit
    )
  elseif bound < frozen_tail then
    scored = redis.call(
      'ZRANGEBYSCORE', index_key, bound + 1, frozen_tail,
      'WITHSCORES', 'LIMIT', 0, limit
    )
  end
  members = {}
  for index = 1, #scored, 2 do
    local score = tonumber(scored[index + 1])
    if not valid_integer(score, 0) then
      error('IMPORT_QUEUE_STRUCTURE runnable_score')
    end
    members[#members + 1] = scored[index]
    last_scanned_score = score
  end
else
  error('IMPORT_QUEUE_STRUCTURE discovery_mode')
end
local output = {
  0,
  redis.call('ZCARD', index_key),
  #members,
  frozen_tail,
  last_scanned_score
}
local missing = {}
for _, canonical_key in ipairs(members) do
  assert_snapshot_hash_container(canonical_key, 'canonical', 12)
  if string.sub(canonical_key, 1, #canonical_root) ~= canonical_root then
    error('IMPORT_QUEUE_STRUCTURE canonical_key')
  end
  local suffix = string.sub(canonical_key, #canonical_root + 1)
  local separator = string.find(suffix, ':', 1, true)
  if not separator
    or string.find(suffix, ':', separator + 1, true) then
    error('IMPORT_QUEUE_STRUCTURE canonical_key')
  end
  local owner_scope = string.sub(suffix, 1, separator - 1)
  local session_id = string.sub(suffix, separator + 1)
  if #owner_scope ~= 32
    or not string.match(owner_scope, '^[A-Za-z0-9_%-]+$')
    or #session_id ~= 43
    or not string.match(session_id, '^[A-Za-z0-9_%-]+$') then
    error('IMPORT_QUEUE_STRUCTURE canonical_key')
  end
  local snapshot = redis.call('HGET', canonical_key, 'snapshot')
  if snapshot then
    local parsed = decode_stored_json(snapshot, 'canonical')
    assert_canonical_shape(parsed, false)
    assert_canonical_json_arrays(snapshot, parsed)
    if parsed.session_id ~= session_id
      or (parsed.queue ~= 'upload' and parsed.queue ~= 'import') then
      error('IMPORT_QUEUE_STRUCTURE canonical_scope')
    end
    local owner_key = owner_root .. owner_scope .. ':' .. parsed.queue
    local display_key = display_root .. owner_scope .. ':' .. parsed.queue
    local metadata_key = metadata_root .. owner_scope .. ':' .. parsed.queue
    assert_queue_structure(
      owner_key, display_key, metadata_key, parsed.owner, parsed.queue
    )
    assert_canonical_structure(
      parsed,
      canonical_key,
      owner_key,
      display_key,
      metadata_key,
      KEYS[2],
      KEYS[3]
    )
    output[1] = output[1] + 1
    output[#output + 1] = canonical_key
    output[#output + 1] = snapshot
  else
    local upload_owner_key = owner_root .. owner_scope .. ':upload'
    local import_owner_key = owner_root .. owner_scope .. ':import'
    local upload_display_key = display_root .. owner_scope .. ':upload'
    local import_display_key = display_root .. owner_scope .. ':import'
    local upload_metadata_key = metadata_root .. owner_scope .. ':upload'
    local import_metadata_key = metadata_root .. owner_scope .. ':import'
    assert_queue_structure(
      upload_owner_key,
      upload_display_key,
      upload_metadata_key,
      nil,
      'upload'
    )
    assert_queue_structure(
      import_owner_key,
      import_display_key,
      import_metadata_key,
      nil,
      'import'
    )
    if redis.call('ZSCORE', upload_owner_key, session_id)
      or redis.call('ZSCORE', import_owner_key, session_id)
      or display_contains_session(upload_display_key, session_id)
      or display_contains_session(import_display_key, session_id) then
      error('IMPORT_QUEUE_STRUCTURE canonical_missing')
    end
    missing[#missing + 1] = canonical_key
  end
end
for _, canonical_key in ipairs(missing) do
  redis.call('ZREM', index_key, canonical_key)
end
return output
`;

export const readImportSessionsScript = `${projectionLua}
local runnable_key = KEYS[1]
local expires_key = KEYS[2]
local upload_owner_key = KEYS[3]
local upload_display_key = KEYS[4]
local upload_metadata_key = KEYS[5]
local import_owner_key = KEYS[6]
local import_display_key = KEYS[7]
local import_metadata_key = KEYS[8]
local expected_owner = ARGV[1]
local canonical_prefix = ARGV[2]
local count = tonumber(ARGV[3])
local output = { count }

if not valid_integer(count, 0) then
  error('IMPORT_QUEUE_STRUCTURE session_read_arguments')
end
assert_discovery_index_types(runnable_key, expires_key)

for index = 1, count do
  local argument = 3 + (index - 1) * 2
  local session_id = ARGV[argument + 1]
  local expected_image_id = ARGV[argument + 2]
  local canonical_key = canonical_prefix .. session_id
  assert_snapshot_hash_container(canonical_key, 'canonical', 12)
  local snapshot = redis.call('HGET', canonical_key, 'snapshot')
  if not snapshot then
    assert_queue_structure(
      upload_owner_key,
      upload_display_key,
      upload_metadata_key,
      expected_owner,
      'upload'
    )
    assert_queue_structure(
      import_owner_key,
      import_display_key,
      import_metadata_key,
      expected_owner,
      'import'
    )
    if redis.call('ZSCORE', upload_owner_key, session_id)
      or redis.call('ZSCORE', import_owner_key, session_id)
      or display_contains_session(upload_display_key, session_id)
      or display_contains_session(import_display_key, session_id) then
      error('IMPORT_QUEUE_STRUCTURE canonical_missing')
    end
    output[#output + 1] = ''
  else
    local parsed = decode_stored_json(snapshot, 'canonical')
    assert_canonical_shape(parsed, false)
    assert_canonical_json_arrays(snapshot, parsed)
    if parsed.session_id ~= session_id or parsed.owner ~= expected_owner
      or (parsed.queue ~= 'upload' and parsed.queue ~= 'import') then
      error('IMPORT_QUEUE_STRUCTURE canonical_scope')
    end
    local owner_key = parsed.queue == 'upload'
      and upload_owner_key or import_owner_key
    local display_key = parsed.queue == 'upload'
      and upload_display_key or import_display_key
    local metadata_key = parsed.queue == 'upload'
      and upload_metadata_key or import_metadata_key
    assert_queue_structure(
      owner_key, display_key, metadata_key, expected_owner, parsed.queue
    )
    assert_canonical_structure(
      parsed,
      canonical_key,
      owner_key,
      display_key,
      metadata_key,
      runnable_key,
      expires_key
    )
    if expected_image_id ~= '' and parsed.image_id ~= expected_image_id then
      output[#output + 1] = '!incarnation'
    else
      output[#output + 1] = snapshot
    end
  end
end
return output
`;
