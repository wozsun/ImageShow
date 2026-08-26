export const projectionLua = String.raw`
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
    error((marker or 'INGESTION_QUEUE_STRUCTURE') .. ' ' .. name .. '_type')
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
    error((marker or 'INGESTION_QUEUE_STRUCTURE') .. ' ' .. name .. '_fields')
  end
end

local function assert_zset_type(key, name)
  local key_type = redis_key_type(key)
  if key_type ~= 'none' and key_type ~= 'zset' then
    error('INGESTION_QUEUE_STRUCTURE ' .. name .. '_type')
  end
end

local function decode_stored_json(value, name, marker)
  local ok, parsed = pcall(cjson.decode, value)
  if not ok or type(parsed) ~= 'table' then
    error((marker or 'INGESTION_QUEUE_STRUCTURE') .. ' ' .. name .. '_json')
  end
  return parsed
end

local function parse_stored_integer(value, name)
  if type(value) ~= 'string'
    or not (value == '0' or string.match(value, '^[1-9][0-9]*$')) then
    error('INGESTION_QUEUE_STRUCTURE ' .. name)
  end
  local parsed = tonumber(value)
  if not parsed or parsed > max_safe_integer then
    error('INGESTION_QUEUE_STRUCTURE ' .. name)
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
      error('INGESTION_QUEUE_STRUCTURE metadata_missing')
    end
    return false
  end
  if redis.call('HLEN', metadata_key) ~= #summary_fields + 4 then
    error('INGESTION_QUEUE_STRUCTURE metadata_fields')
  end
  local stored_owner = redis.call('HGET', metadata_key, 'owner')
  local stored_queue = redis.call('HGET', metadata_key, 'queue')
  if type(stored_owner) ~= 'string'
    or stored_owner == ''
    or (owner ~= nil and stored_owner ~= owner)
    or stored_queue ~= queue then
    error('INGESTION_QUEUE_STRUCTURE metadata_scope')
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
    error('INGESTION_QUEUE_STRUCTURE metadata_clock')
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
      error('INGESTION_QUEUE_STRUCTURE owner_clock')
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
    error('INGESTION_QUEUE_STRUCTURE count_mismatch')
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
    error('INGESTION_QUEUE_STRUCTURE counter_exhausted')
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
      error('INGESTION_QUEUE_STRUCTURE negative_count')
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

local function valid_import_source(source_type)
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
      error('INGESTION_QUEUE_STRUCTURE runnable_score')
    end
  end
  local next_score = math.max(tail_score + 1, score_floor, 1)
  if not valid_integer(next_score, 1) then
    error('INGESTION_QUEUE_STRUCTURE runnable_score_exhausted')
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
    error((marker or 'INGESTION_QUEUE_STRUCTURE') .. ' ' .. name .. '_shape')
  end
  local allowed = {}
  for _, field in ipairs(fields) do allowed[field] = true end
  local count = 0
  for field, _ in pairs(value) do
    count = count + 1
    if not allowed[field] then
      error((marker or 'INGESTION_QUEUE_STRUCTURE') .. ' ' .. name .. '_fields')
    end
  end
  if count ~= #fields then
    error((marker or 'INGESTION_QUEUE_STRUCTURE') .. ' ' .. name .. '_fields')
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
    error((marker or 'INGESTION_QUEUE_STRUCTURE') .. ' ' .. name .. '_shape')
  end
  local allowed = {}
  for _, field in ipairs(required) do
    allowed[field] = true
    if value[field] == nil then
      error((marker or 'INGESTION_QUEUE_STRUCTURE') .. ' ' .. name .. '_fields')
    end
  end
  for _, field in ipairs(optional) do allowed[field] = true end
  for field, _ in pairs(value) do
    if not allowed[field] then
      error((marker or 'INGESTION_QUEUE_STRUCTURE') .. ' ' .. name .. '_fields')
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
    error((marker or 'INGESTION_QUEUE_STRUCTURE') .. ' ' .. field .. '_array')
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
    error((marker or 'INGESTION_QUEUE_STRUCTURE') .. ' metadata_shape')
  end
end

local function assert_import_source(value)
  assert_exact_fields(value, { 'url' }, 'import_source')
  if type(value.url) ~= 'string' or value.url == '' then
    error('INGESTION_QUEUE_STRUCTURE import_source_shape')
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
      error('INGESTION_QUEUE_STRUCTURE prepared_shape')
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
    error('INGESTION_QUEUE_STRUCTURE prepared_shape')
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
    or (queue == 'import' and not valid_import_source(value.source_type))
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
    error('INGESTION_QUEUE_STRUCTURE completed_display_shape')
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
    error('INGESTION_QUEUE_STRUCTURE commit_shape')
  end
  assert_draft(value.metadata)
end

local function assert_session_error(value)
  assert_exact_fields(value, { 'code', 'message' }, 'error')
  if type(value.code) ~= 'string' or value.code == ''
    or type(value.message) ~= 'string' then
    error('INGESTION_QUEUE_STRUCTURE error_shape')
  end
end

local function assert_upload_intent_shape(intent, stored)
  assert_exact_fields(intent, {
    'owner', 'session_id', 'candidate_image_id', 'resolved_image_time',
    'request_hash', 'display_order_key', 'manifest_position', 'metadata', 'storage_slug',
    'expected_size', 'max_long_edge', 'created_at', 'expires_at',
    'execution_token', 'claim_heartbeat_at'
  }, 'intent', 'UPLOAD_INTENT')
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
    error('UPLOAD_INTENT intent_shape')
  end
  if stored and (
    not valid_integer(intent.created_at, 0)
    or not valid_integer(intent.expires_at, 1)
    or type(intent.execution_token) ~= 'string'
    or not valid_integer(intent.claim_heartbeat_at, 0)
  ) then
    error('UPLOAD_INTENT stored_intent_shape')
  end
  assert_draft(intent.metadata, 'UPLOAD_INTENT')
end

local function assert_upload_intent_hash(intent_key, intent)
  local fields = {
    'session_id', 'candidate_image_id', 'request_hash', 'display_order_key',
    'execution_token'
  }
  for _, field in ipairs(fields) do
    if redis.call('HGET', intent_key, field) ~= intent[field] then
      error('UPLOAD_INTENT intent_hash')
    end
  end
end

local function assert_canonical_shape(snapshot, pending_acceptance)
  if type(snapshot) ~= 'table' then
    error('INGESTION_QUEUE_STRUCTURE canonical_shape')
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
    error('INGESTION_QUEUE_STRUCTURE canonical_shape')
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
      error('INGESTION_QUEUE_STRUCTURE completed_shape')
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
      error('INGESTION_QUEUE_STRUCTURE discarded_shape')
    end
  else
    assert_allowed_fields(snapshot, {
      'owner', 'queue', 'source_type', 'session_id', 'image_id', 'image_time',
      'request_hash', 'metadata', 'storage_slug', 'status', 'phase', 'message',
      'progress', 'version', 'progress_seq', 'last_semantic_revision',
      'accepted_at', 'accepted_order', 'execution_token', 'raw_generation',
      'raw_size', 'discard_at', 'semantic_hash'
    }, {
      'import_source', 'manifest_position', 'manifest_line', 'prepared',
      'duplicate_decision', 'commit', 'error'
    }, 'active')
    if snapshot.queue == 'upload' and snapshot.source_type ~= 'upload' then
      error('INGESTION_QUEUE_STRUCTURE canonical_source')
    end
    if snapshot.queue == 'import'
      and not valid_import_source(snapshot.source_type) then
      error('INGESTION_QUEUE_STRUCTURE canonical_source')
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
      error('INGESTION_QUEUE_STRUCTURE active_shape')
    end
    assert_draft(snapshot.metadata)
    if snapshot.queue == 'import' then
      assert_import_source(snapshot.import_source)
    elseif snapshot.import_source ~= nil then
      error('INGESTION_QUEUE_STRUCTURE import_source_scope')
    end
    if snapshot.prepared ~= nil then assert_prepared(snapshot.prepared) end
    if snapshot.duplicate_decision ~= nil
      and snapshot.duplicate_decision ~= 'upload'
      and snapshot.duplicate_decision ~= 'confirmed' then
      error('INGESTION_QUEUE_STRUCTURE duplicate_decision')
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
    error('INGESTION_QUEUE_STRUCTURE canonical_clock')
  end
  local hash_fields = {
    'session_id', 'image_id', 'owner', 'queue', 'status', 'request_hash'
  }
  for _, field in ipairs(hash_fields) do
    if redis.call('HGET', canonical_key, field) ~= snapshot[field] then
      error('INGESTION_QUEUE_STRUCTURE canonical_hash')
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
      error('INGESTION_QUEUE_STRUCTURE canonical_hash')
    end
  end
  local owner_score = redis.call('ZSCORE', owner_key, snapshot.session_id)
  local display_order_key = redis.call(
    'HGET', canonical_key, 'display_order_key'
  )
  if not valid_display_order_key(display_order_key, snapshot.session_id) then
    error('INGESTION_QUEUE_STRUCTURE display_order_key')
  end
  local display_score = redis.call('ZSCORE', display_key, display_order_key)
  if snapshot.status == 'discarded' then
    if owner_score or display_score then
      error('INGESTION_QUEUE_STRUCTURE discarded_owner')
    end
  elseif not owner_score
    or tonumber(owner_score) ~= tonumber(snapshot.accepted_order) then
    error('INGESTION_QUEUE_STRUCTURE owner_score')
  elseif not display_score or tonumber(display_score) ~= 0 then
    error('INGESTION_QUEUE_STRUCTURE display_score')
  end
  local runnable_score = redis.call('ZSCORE', runnable_key, canonical_key)
  if runnable_status(snapshot.status) then
    if not runnable_score
      or not valid_integer(tonumber(runnable_score), 1) then
      error('INGESTION_QUEUE_STRUCTURE runnable_score')
    end
  elseif runnable_score then
    error('INGESTION_QUEUE_STRUCTURE unexpected_runnable')
  end
  local expires_score = redis.call('ZSCORE', expires_key, canonical_key)
  if not expires_score
    or tonumber(expires_score) ~= tonumber(snapshot.discard_at) then
    error('INGESTION_QUEUE_STRUCTURE expires_score')
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
