import type { PoolClient } from "pg";

export type DatabaseReader = Pick<PoolClient, "query">;
type PostgreSqlType =
  | "_text"
  | "bool"
  | "int2"
  | "int4"
  | "int8"
  | "jsonb"
  | "text"
  | "timestamptz"
  | "uuid";
type TablePrivilege = "SELECT" | "INSERT" | "UPDATE" | "DELETE";
type TableReadiness = {
  columns: Record<string, PostgreSqlType>;
  privileges: readonly TablePrivilege[];
};

const readWritePrivileges = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;

// This is deliberately limited to columns referenced by current runtime SQL.
// schema.sql is the complete clean-install baseline. A release may add a
// separately reviewed, one-cycle schema-additions.sql delta before readiness.
export const databaseReadiness = {
  storage_backend: {
    columns: {
      slug: "text",
      display_name: "text",
      type: "text",
      config: "jsonb",
      namespace_identities: "_text",
      enabled: "bool",
      is_default: "bool",
      sort_order: "int4",
      updated_at: "timestamptz"
    },
    privileges: readWritePrivileges
  },
  theme: {
    columns: {
      slug: "text",
      display_name: "text",
      sort_order: "int4",
      updated_at: "timestamptz"
    },
    privileges: readWritePrivileges
  },
  tag: {
    columns: {
      slug: "text",
      display_name: "text",
      sort_order: "int4",
      updated_at: "timestamptz"
    },
    privileges: readWritePrivileges
  },
  author: {
    columns: {
      slug: "text",
      display_name: "text",
      link: "text",
      identity_provider: "text",
      identity_id: "text",
      sort_order: "int4",
      updated_at: "timestamptz"
    },
    privileges: readWritePrivileges
  },
  metadata: {
    columns: {
      id: "uuid",
      status: "text",
      storage_slug: "text",
      object_key: "text",
      device: "text",
      brightness: "text",
      theme: "text",
      author: "text",
      ext: "text",
      md5: "text",
      width: "int4",
      height: "int4",
      image_size: "int8",
      thumbnail_size: "int8",
      title: "text",
      description: "text",
      source: "text",
      original: "text",
      image_time: "timestamptz",
      deleted_at: "timestamptz",
      purge_state: "text",
      purge_started_at: "timestamptz",
      purge_attempts: "int4",
      purge_error: "text",
      created_by: "text",
      created_at: "timestamptz",
      updated_at: "timestamptz"
    },
    privileges: readWritePrivileges
  },
  image_tag: {
    columns: {
      image_id: "uuid",
      tag_slug: "text"
    },
    privileges: ["SELECT", "INSERT", "DELETE"]
  },
  ready_image_revision: {
    columns: {
      singleton: "int2",
      revision: "int8",
      updated_at: "timestamptz"
    },
    privileges: ["SELECT", "UPDATE"]
  },
  background_job: {
    columns: {
      id: "uuid",
      type: "text",
      status: "text",
      execution_token: "uuid",
      target_id: "text",
      idempotency_key: "text",
      payload: "jsonb",
      error: "text",
      retry_count: "int4",
      next_retry_at: "timestamptz",
      created_at: "timestamptz",
      updated_at: "timestamptz"
    },
    privileges: readWritePrivileges
  },
  admin_account: {
    columns: {
      username: "text",
      password_hash: "text",
      role: "text",
      preferences: "jsonb",
      updated_at: "timestamptz"
    },
    privileges: readWritePrivileges
  }
} as const satisfies Record<string, TableReadiness>;

export const requiredTableNames = Object.keys(databaseReadiness);

export type RequiredPrimaryKey = {
  table: string;
  columns: readonly string[];
};

export type RequiredUniqueIndex = RequiredPrimaryKey & {
  predicate:
    | "none"
    | "default_storage"
    | "non_null_idempotency"
    | "non_null_author_identity"
    | "active_cache_rebuild"
    | "super_admin";
};

export type RequiredForeignKey = {
  table: string;
  columns: readonly string[];
  referencedTable: string;
  referencedColumns: readonly string[];
  onDelete: "r" | "c" | "n";
};

export const requiredPrimaryKeys = [
  { table: "storage_backend", columns: ["slug"] },
  { table: "theme", columns: ["slug"] },
  { table: "tag", columns: ["slug"] },
  { table: "author", columns: ["slug"] },
  { table: "metadata", columns: ["id"] },
  { table: "image_tag", columns: ["image_id", "tag_slug"] },
  { table: "ready_image_revision", columns: ["singleton"] },
  { table: "background_job", columns: ["id"] },
  { table: "admin_account", columns: ["username"] }
] as const satisfies readonly RequiredPrimaryKey[];

export const requiredUniqueIndexes = [
  {
    table: "metadata",
    columns: ["object_key"],
    predicate: "none"
  },
  {
    table: "author",
    columns: ["identity_provider", "identity_id"],
    predicate: "non_null_author_identity"
  },
  {
    table: "background_job",
    columns: ["idempotency_key"],
    predicate: "non_null_idempotency"
  },
  {
    table: "background_job",
    columns: ["type"],
    predicate: "active_cache_rebuild"
  },
  {
    table: "storage_backend",
    columns: ["is_default"],
    predicate: "default_storage"
  },
  {
    table: "admin_account",
    columns: ["role"],
    predicate: "super_admin"
  }
] as const satisfies readonly RequiredUniqueIndex[];

export const requiredForeignKeys = [
  {
    table: "metadata",
    columns: ["storage_slug"],
    referencedTable: "storage_backend",
    referencedColumns: ["slug"],
    onDelete: "r"
  },
  {
    table: "metadata",
    columns: ["theme"],
    referencedTable: "theme",
    referencedColumns: ["slug"],
    onDelete: "r"
  },
  {
    table: "metadata",
    columns: ["author"],
    referencedTable: "author",
    referencedColumns: ["slug"],
    onDelete: "n"
  },
  {
    table: "image_tag",
    columns: ["image_id"],
    referencedTable: "metadata",
    referencedColumns: ["id"],
    onDelete: "c"
  },
  {
    table: "image_tag",
    columns: ["tag_slug"],
    referencedTable: "tag",
    referencedColumns: ["slug"],
    onDelete: "c"
  }
] as const satisfies readonly RequiredForeignKey[];
