import type { Client, QueryResult } from "pg";
import { createDedicatedDatabaseClient } from "./db.ts";

const APPLICATION_LIFECYCLE_LOCK_KEY =
  "imageshow:application-lifecycle";

type LifecycleLockClient = Pick<
  Client,
  "connect" | "query" | "end" | "on" | "off"
>;

type LifecycleLockDependencies = {
  createClient(): LifecycleLockClient;
};

const defaultDependencies: LifecycleLockDependencies = {
  createClient: () => createDedicatedDatabaseClient(
    "imageshow-application-lifecycle"
  )
};

class ApplicationInstanceAlreadyRunningError extends Error {
  readonly code = "application_instance_already_running";

  constructor() {
    super(
      "Another ImageShow application instance already owns this database"
    );
    this.name = "ApplicationInstanceAlreadyRunningError";
  }
}

class ApplicationLifecycleLockLostError extends Error {
  readonly code = "application_lifecycle_lock_lost";

  constructor(cause?: unknown) {
    super("ImageShow application lifecycle lock ownership was lost", {
      cause
    });
    this.name = "ApplicationLifecycleLockLostError";
  }
}

export type ApplicationLifecycleLock = Readonly<{
  ownershipLost: Promise<ApplicationLifecycleLockLostError>;
  assertOwned(): void;
  release(): Promise<void>;
}>;

export async function acquireApplicationLifecycleLock(
  dependencies: LifecycleLockDependencies = defaultDependencies
): Promise<ApplicationLifecycleLock> {
  const client = dependencies.createClient();
  let state: "acquiring" | "owned" | "lost" | "releasing" | "released" =
    "acquiring";
  let loss: ApplicationLifecycleLockLostError | null = null;
  let resolveOwnershipLost:
    ((error: ApplicationLifecycleLockLostError) => void) | null = null;
  const ownershipLost = new Promise<ApplicationLifecycleLockLostError>(
    (resolve) => {
      resolveOwnershipLost = resolve;
    }
  );
  let releasePromise: Promise<void> | null = null;

  const connectionLost = (cause?: unknown) => {
    if (state === "releasing" || state === "released" || state === "lost") {
      return;
    }
    loss = new ApplicationLifecycleLockLostError(cause);
    state = "lost";
    resolveOwnershipLost?.(loss);
    resolveOwnershipLost = null;
  };
  const onError = (error: Error) => connectionLost(error);
  const onEnd = () => connectionLost();
  client.on("error", onError);
  client.on("end", onEnd);

  const closeUnownedClient = async () => {
    try {
      await client.end().catch(() => undefined);
    } finally {
      client.off("error", onError);
      client.off("end", onEnd);
    }
  };

  try {
    await client.connect();
    const result = await client.query(
      `SELECT pg_try_advisory_lock(
         hashtextextended($1, 0)
       ) AS acquired`,
      [APPLICATION_LIFECYCLE_LOCK_KEY]
    ) as QueryResult<{ acquired: boolean }>;
    if (loss) throw loss;
    if (result.rows[0]?.acquired !== true) {
      state = "releasing";
      await closeUnownedClient();
      state = "released";
      throw new ApplicationInstanceAlreadyRunningError();
    }
    state = "owned";
  } catch (error) {
    if (state !== "released") {
      state = "releasing";
      await closeUnownedClient();
      state = "released";
    }
    throw error;
  }

  const assertOwned = () => {
    if (state !== "owned") {
      throw loss ?? new ApplicationLifecycleLockLostError();
    }
  };

  return {
    ownershipLost,
    assertOwned,
    release() {
      if (releasePromise) return releasePromise;
      state = state === "lost" ? "lost" : "releasing";
      releasePromise = client.end().finally(() => {
        client.off("error", onError);
        client.off("end", onEnd);
        state = "released";
      });
      return releasePromise;
    }
  };
}
