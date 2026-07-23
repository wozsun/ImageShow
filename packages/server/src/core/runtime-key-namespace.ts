export function volatileKey(...parts: string[]) {
  return ["imageshow", ...parts].join(":");
}
