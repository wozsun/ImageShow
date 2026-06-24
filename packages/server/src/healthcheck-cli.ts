import { env } from "./config/env.js";

const port = String(env.PORT);
const checks = ["/livez", "/readyz", "/home", "/gallery", "/random?m=redirect", "/img-count"];

for (const path of checks) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: "manual" });
  const ok = path.startsWith("/random?m=")
    ? [200, 302, 404].includes(response.status)
    : response.ok;
  if (!ok) {
    console.error(`${path} returned ${response.status}`);
    process.exit(1);
  }
}
