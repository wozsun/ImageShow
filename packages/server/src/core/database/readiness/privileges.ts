import { databaseReadiness, type DatabaseReader } from "./contract.ts";

export async function assertRuntimeDatabaseAccess(database: DatabaseReader) {
  const session = (await database.query<{
    transaction_read_only: string;
    public_schema_usage: boolean;
  }>(
    `SELECT current_setting('transaction_read_only') AS transaction_read_only,
            has_schema_privilege(current_user, 'public', 'USAGE')
              AS public_schema_usage`
  )).rows[0];
  if (
    session?.transaction_read_only !== "off"
    || !session.public_schema_usage
  ) {
    throw new Error(
      `database session cannot run ImageShow writes: `
        + `transaction_read_only=${session?.transaction_read_only ?? "unknown"}, `
        + `public_schema_usage=${session?.public_schema_usage ?? false}`
    );
  }

  const required = Object.entries(databaseReadiness).flatMap(
    ([table, readiness]) => readiness.privileges.map((privilege) => ({
      table,
      privilege
    }))
  );
  const rows = (await database.query<{
    table_name: string;
    privilege_name: string;
    allowed: boolean;
  }>(
    `SELECT required.table_name,
            required.privilege_name,
            has_table_privilege(
              current_user,
              format('public.%I', required.table_name),
              required.privilege_name
            ) AS allowed
       FROM unnest($1::text[], $2::text[])
         AS required(table_name, privilege_name)`,
    [
      required.map(({ table }) => table),
      required.map(({ privilege }) => privilege)
    ]
  )).rows;
  const missing = rows.filter((row) => !row.allowed);
  if (missing.length) {
    throw new Error(
      `database role lacks required table privileges: `
        + missing
          .map((row) => `${row.table_name}.${row.privilege_name}`)
          .join(", ")
    );
  }
}
