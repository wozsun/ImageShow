export const RANDOM_GENERATION_PUBLISH_SCRIPT = `
  local currentRevision = tonumber(redis.call("GET", KEYS[2]) or "0")
  if redis.call("GET", KEYS[5]) ~= ARGV[4] then return { -1, "" } end
  if currentRevision ~= tonumber(ARGV[1]) then return { 0, "" } end
  if redis.call("EXISTS", KEYS[7]) == 1 then return { 0, "" } end
  local previousGeneration = redis.call("GET", KEYS[1]) or ""
  if previousGeneration ~= "" and previousGeneration ~= ARGV[2] then
    redis.call("SADD", KEYS[6], previousGeneration)
  end
  redis.call("SET", KEYS[1], ARGV[2])
  redis.call("SET", KEYS[3], ARGV[1])
  redis.call("SET", KEYS[4], ARGV[3])
  return { 1, previousGeneration }
`;

export const RANDOM_COLD_BUILD_RATE_LIMIT_SCRIPT = `
  local now = tonumber(redis.call("TIME")[1])
  local window = tonumber(ARGV[1])
  local bucket = math.floor(now / window)
  local key = KEYS[1] .. ":" .. bucket
  local count = redis.call("INCR", key)
  if count == 1 then redis.call("EXPIRE", key, window + 1) end
  local retryAfter = window - (now % window)
  if count > tonumber(ARGV[2]) then return { 0, retryAfter } end
  return { 1, retryAfter }
`;

export const RANDOM_GENERATION_PERSIST_SCRIPT = `
  if redis.call("GET", KEYS[1]) ~= ARGV[1] then return -1 end
  if redis.call("EXISTS", KEYS[3]) == 1 then return -3 end
  if redis.call("EXISTS", KEYS[4]) == 0 then
    redis.call("DEL", KEYS[1])
    redis.call("SADD", KEYS[2], ARGV[1])
    return -2
  end
  local persisted = redis.call("PERSIST", KEYS[4])
  for index = 5, #KEYS do
    if redis.call("SISMEMBER", KEYS[4], KEYS[index]) == 1
      and redis.call("EXISTS", KEYS[index]) == 0 then
      redis.call("DEL", KEYS[1])
      redis.call("SADD", KEYS[2], ARGV[1])
      return -2
    end
  end
  for index = 5, #KEYS do
    if redis.call("SISMEMBER", KEYS[4], KEYS[index]) == 1 then
      persisted = persisted + redis.call("PERSIST", KEYS[index])
    end
  end
  return persisted
`;

export const RANDOM_INCREMENTAL_APPLY_SCRIPT = `
  local currentGeneration = redis.call("GET", KEYS[1]) or ""
  local currentRevision = tonumber(redis.call("GET", KEYS[2]) or "0")
  local currentToken = redis.call("GET", KEYS[4]) or ""
  if currentGeneration ~= ARGV[1]
    or currentRevision ~= tonumber(ARGV[2])
    or currentToken ~= ARGV[3]
    or redis.call("EXISTS", KEYS[5]) == 0 then
    return 0
  end

  local mutation = cjson.decode(ARGV[4])
  redis.call("PERSIST", KEYS[5])
  local function callBatched(command, key, values, batchSize)
    local offset = 1
    while offset <= #values do
      local arguments = { key }
      local final = math.min(offset + batchSize - 1, #values)
      for index = offset, final do
        arguments[#arguments + 1] = values[index]
      end
      redis.call(command, unpack(arguments))
      offset = final + 1
    end
  end
  local function updateMemberships(command, changes)
    for _, change in ipairs(changes) do
      local key = KEYS[8 + tonumber(change[1])]
      callBatched(command, key, change[2], 500)
    end
  end
  local function reconcileOwnedKey(key)
    if redis.call("EXISTS", key) == 1 then
      redis.call("SADD", KEYS[5], key)
      redis.call("PERSIST", key)
    else
      redis.call("SREM", KEYS[5], key)
    end
  end

  updateMemberships("SREM", mutation.removals)
  updateMemberships("SADD", mutation.additions)
  callBatched("HSET", KEYS[6], mutation.itemValues, 500)
  callBatched("HDEL", KEYS[6], mutation.removedIds, 500)
  redis.call("SET", KEYS[7], ARGV[5])
  redis.call("SET", KEYS[8], ARGV[6])

  reconcileOwnedKey(KEYS[6])
  reconcileOwnedKey(KEYS[7])
  for index = 9, #KEYS do
    reconcileOwnedKey(KEYS[index])
  end
  redis.call("SET", KEYS[3], ARGV[2])
  return 1
`;

export const RANDOM_OWNED_LOCK_RENEW_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("PEXPIRE", KEYS[1], ARGV[2])
  end
  return 0
`;

export const RANDOM_FILTER_CONSISTENCY_SCRIPT = `
  local requestedRevision = redis.call("GET", KEYS[1]) or "0"
  local completedRevision = redis.call("GET", KEYS[2]) or "0"
  local updateInProgress = redis.call("EXISTS", KEYS[3])
  return { requestedRevision, completedRevision, updateInProgress }
`;

export const RANDOM_FILTER_CACHE_READ_SCRIPT = `
  if redis.call("EXISTS", KEYS[5]) == 1 then return -2 end
  local currentRevision = redis.call("GET", KEYS[3]) or "0"
  local completedRevision = tonumber(redis.call("GET", KEYS[4]) or "0")
  if currentRevision ~= ARGV[1]
    or completedRevision < tonumber(currentRevision) then
    return -2
  end
  if redis.call("EXISTS", KEYS[1]) == 1 then
    local count = redis.call("SCARD", KEYS[1])
    redis.call("EXPIRE", KEYS[1], ARGV[2])
    return count
  end
  if redis.call("EXISTS", KEYS[2]) == 1 then
    redis.call("EXPIRE", KEYS[2], ARGV[2])
    return 0
  end
  return -1
`;

export const RANDOM_FILTER_PUBLISH_SCRIPT = `
  if redis.call("EXISTS", KEYS[6]) == 1 then
    redis.call("UNLINK", KEYS[3])
    return { 0, 0 }
  end
  local currentRevision = redis.call("GET", KEYS[4]) or "0"
  local completedRevision = tonumber(redis.call("GET", KEYS[5]) or "0")
  if currentRevision ~= ARGV[1]
    or completedRevision < tonumber(currentRevision) then
    redis.call("UNLINK", KEYS[3])
    return { 0, 0 }
  end
  local count = redis.call("SCARD", KEYS[3])
  if count == 0 then
    redis.call("UNLINK", KEYS[1])
    redis.call("SET", KEYS[2], "1", "EX", ARGV[2])
    redis.call("UNLINK", KEYS[3])
  else
    redis.call("RENAME", KEYS[3], KEYS[1])
    redis.call("EXPIRE", KEYS[1], ARGV[2])
    redis.call("UNLINK", KEYS[2])
  end
  return { 1, count }
`;
