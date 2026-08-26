import { projectionLua } from "./projection.ts";

export const discoverIngestionSessionsScript = `${projectionLua}
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

export const readIngestionSessionsScript = `${projectionLua}
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
