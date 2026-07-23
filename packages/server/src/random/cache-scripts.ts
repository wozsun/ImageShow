export const RANDOM_GENERATION_PUBLISH_SCRIPT = `
  local currentRevision = tonumber(redis.call("GET", KEYS[2]) or "0")
  if currentRevision ~= tonumber(ARGV[1]) then return { 0, "" } end
  local previousGeneration = redis.call("GET", KEYS[1]) or ""
  redis.call("SET", KEYS[1], ARGV[2])
  redis.call("SET", KEYS[3], ARGV[1])
  redis.call("SET", KEYS[4], ARGV[3])
  return { 1, previousGeneration }
`;

export const RANDOM_INCREMENTAL_COMPLETE_SCRIPT = `
  local currentGeneration = redis.call("GET", KEYS[1]) or ""
  local currentRevision = tonumber(redis.call("GET", KEYS[2]) or "0")
  local currentToken = redis.call("GET", KEYS[4]) or ""
  if currentGeneration ~= ARGV[1]
    or currentRevision ~= tonumber(ARGV[2])
    or currentToken ~= ARGV[3] then
    return 0
  end
  redis.call("SET", KEYS[3], ARGV[2])
  return 1
`;

export const RANDOM_UPDATE_LOCK_RENEW_SCRIPT = `
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
