import { randomUuidV7At } from "../core/uuid.ts";

const localImageTimePattern = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const zonedImageTimePattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const earliestImageTime = 0;

type ParseImageTimeOptions = {
  now?: Date;
  timeZone?: string;
};

export class ImageTimeError extends Error {
  readonly code = "invalid_image_time";
}

function invalidImageTime(message = "image_time 必须是合法时间") {
  return new ImageTimeError(message);
}

function assertTimeZone(timeZone: string) {
  try {
    Temporal.Now.zonedDateTimeISO(timeZone);
  } catch {
    throw invalidImageTime(`无效的 TZ 时区配置: ${timeZone}`);
  }
}

function localImageTime(input: string, timeZone: string) {
  assertTimeZone(timeZone);
  let plain: Temporal.PlainDateTime;
  try {
    plain = Temporal.PlainDateTime.from(input.replace(" ", "T"));
  } catch {
    throw invalidImageTime();
  }
  try {
    return plain.toZonedDateTime(timeZone, { disambiguation: "reject" }).toInstant();
  } catch {
    throw invalidImageTime("image_time 在配置时区中不存在或存在歧义");
  }
}

function assertAllowedImageTime(date: Date) {
  if (!Number.isFinite(date.getTime())) throw invalidImageTime();
  if (date.getTime() < earliestImageTime) throw invalidImageTime("image_time 不能早于 1970-01-01");
  return date;
}

export function parseImageTime(value?: string | null, options: ParseImageTimeOptions = {}) {
  const input = value?.trim();
  let instant: Temporal.Instant;
  if (!input) {
    instant = Temporal.Instant.fromEpochMilliseconds(options.now?.getTime() ?? Date.now());
  } else {
    if (localImageTimePattern.test(input)) {
      instant = localImageTime(input, options.timeZone || process.env.TZ || "UTC");
    } else {
      if (!zonedImageTimePattern.test(input)) throw invalidImageTime();
      try {
        instant = Temporal.Instant.from(input);
      } catch {
        throw invalidImageTime();
      }
    }
  }
  const date = assertAllowedImageTime(new Date(instant.epochMilliseconds));
  return { date, iso: date.toISOString() };
}

export function createImageId(imageTime: Date, manifestPosition?: number) {
  assertAllowedImageTime(imageTime);
  if (manifestPosition === undefined) return randomUuidV7At(imageTime);
  if (!Number.isInteger(manifestPosition) || manifestPosition < 0 || manifestPosition > 0xfff) {
    throw new RangeError("manifest_position must fit in 12 bits");
  }
  return randomUuidV7At(imageTime, manifestPosition);
}
