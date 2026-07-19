import { request } from "node:http";
import { appConfig } from "@imageshow/shared";
import { getRuntimeConfig } from "./config/runtime-config-store.ts";

const runtimeConfig = getRuntimeConfig();
const port = String(appConfig.applicationPort);
const host = runtimeConfig.site.domain;
const checks = ["/livez", "/readyz", "/", "/home", "/gallery", "/random?m=redirect", "/img-count"];

function requestStatus(path: string) {
  return new Promise<number>((resolve, reject) => {
    const outgoing = request({
      hostname: "127.0.0.1",
      port,
      path,
      method: "GET",
      headers: { Host: host }
    }, (incoming) => {
      incoming.resume();
      incoming.on("end", () => resolve(incoming.statusCode ?? 0));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

for (const path of checks) {
  const status = await requestStatus(path);
  const ok = path.startsWith("/random?m=")
    ? [200, 302, 404].includes(status)
    : status >= 200 && status < 300;
  if (!ok) {
    console.error(`${path} returned ${status}`);
    process.exit(1);
  }
}
