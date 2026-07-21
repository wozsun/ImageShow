import { bootstrapEnvironment } from "../config/bootstrap-env.ts";
import { pool } from "../core/db.ts";
import { ensureSuperAdmin } from "./admin-bootstrap.ts";

export async function initializeAdmin() {
  const client = await pool.connect();
  try {
    await ensureSuperAdmin(
      (sql, params) => client.query(sql, params),
      {
        username: bootstrapEnvironment.adminUsername,
        password: bootstrapEnvironment.adminPassword
      }
    );
  } finally {
    client.release();
  }
}
