import { projectionLua } from "./projection.ts";

export const createIngestionCanonicalScript = `${projectionLua}
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
export const mutateIngestionCanonicalScript = `${projectionLua}
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
