/** Group deletion and member snapshots wait for all active membership writes. */
export function imageGroupLockRequest(slug: string, mode: "shared" | "exclusive" = "exclusive") {
  return { key: `imageshow:image-group:${slug}`, mode };
}
