import { request } from "node:http";
import { appConfig } from "@imageshow/shared";
import { getRuntimeConfig } from "./config/runtime-config-store.ts";

const runtimeConfig = getRuntimeConfig();
const port = String(appConfig.applicationPort);
const host = runtimeConfig.site.domain;

function requestReadiness() {
  return new Promise<number>((resolve, reject) => {
    const outgoing = request({
      hostname: "127.0.0.1",
      port,
      path: "/readyz",
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

const status = await requestReadiness();
if (status < 200 || status >= 300) {
  console.error(`/readyz returned ${status}`);
  process.exit(1);
}
