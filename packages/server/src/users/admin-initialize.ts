import { bootstrapEnvironment } from "../config/bootstrap-env.ts";
import { ensureSuperAdmin } from "./admin-bootstrap.ts";

export async function initializeAdmin() {
  await ensureSuperAdmin({
    username: bootstrapEnvironment.adminUsername,
    password: bootstrapEnvironment.adminPassword
  });
}
