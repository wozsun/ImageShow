import { projectionLua } from "./projection.ts";

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
  error('UPLOAD_INTENT invalid_clock')
end
assert_upload_intent_shape(template, false)
assert_json_array_field(ARGV[1], 'tags', 1, 'UPLOAD_INTENT')
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
    return redis.error_reply('INGESTION_CANONICAL invalid_upload_scope')
  end
  if canonical.session_id == template.session_id
    and canonical.request_hash == template.request_hash
    and redis.call('HGET', canonical_key, 'display_order_key')
      == template.display_order_key then
    return { 2, canonical_json }
  end
  return { -2 }
end

assert_snapshot_hash_container(intent_key, 'intent', 6, 'UPLOAD_INTENT')
local existing_json = redis.call('HGET', intent_key, 'snapshot')
assert_queue_structure(
  owner_key, display_key, metadata_key, template.owner, 'upload'
)
if redis.call('ZSCORE', owner_key, template.session_id) then
  error('INGESTION_QUEUE_STRUCTURE canonical_missing')
end
if redis.call('ZSCORE', display_key, template.display_order_key) then
  error('INGESTION_QUEUE_STRUCTURE canonical_missing')
end
if existing_json then
  local existing = decode_stored_json(
    existing_json, 'intent', 'UPLOAD_INTENT'
  )
  assert_upload_intent_shape(existing, true)
  assert_upload_intent_hash(intent_key, existing)
  assert_json_array_field(existing_json, 'tags', 1, 'UPLOAD_INTENT')
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
  error('UPLOAD_INTENT invalid_clock')
end
assert_snapshot_hash_container(intent_key, 'intent', 6, 'UPLOAD_INTENT')
local current_json = redis.call('HGET', intent_key, 'snapshot')
if not current_json then return { -1 } end
local current = decode_stored_json(current_json, 'intent', 'UPLOAD_INTENT')
assert_upload_intent_shape(current, true)
assert_upload_intent_hash(intent_key, current)
assert_json_array_field(current_json, 'tags', 1, 'UPLOAD_INTENT')
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
return redis.error_reply('UPLOAD_INTENT invalid_action')
`;

export const readUploadIntentScript = String.raw`
local intent_key = KEYS[1]
local key_type = redis.call('TYPE', intent_key)
key_type = type(key_type) == 'table' and key_type.ok or key_type
if key_type == 'none' then return { 0 } end
if key_type ~= 'hash'
  or redis.call('HLEN', intent_key) ~= 6
  or redis.call('HEXISTS', intent_key, 'snapshot') ~= 1 then
  return redis.error_reply('UPLOAD_INTENT intent_fields')
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
