import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomInt } from "node:crypto";

/** Use the dynamic/private range; an OS-customized port 0 range can include Fetch-blocked ports. */
export async function listenForFetch(server: Server): Promise<AddressInfo> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(randomInt(49152, 65536), "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      return server.address() as AddressInfo;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error("Cannot allocate a high loopback port for Fetch tests");
}
