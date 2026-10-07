const httpsUrlInputMaxLength = 2_048;

/** Normalize form input without reserializing paths, queries or signatures. */
export function normalizeHttpsUrlInput(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length > httpsUrlInputMaxLength) return null;
  if (!trimmed) return "";
  const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  if (normalized.length > httpsUrlInputMaxLength) return null;
  try {
    const parsed = new URL(normalized);
    return parsed.protocol === "https:" && parsed.hostname
      && !parsed.username && !parsed.password
      ? normalized
      : null;
  } catch {
    return null;
  }
}
