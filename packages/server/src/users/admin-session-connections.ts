import { logger } from "../core/logger.ts";

type AdminSessionConnection = Readonly<{
  sessionId: string;
  close: () => void;
}>;

const connectionsBySession = new Map<string, Set<AdminSessionConnection>>();

function closeConnection(connection: AdminSessionConnection) {
  try {
    connection.close();
  } catch (error) {
    logger.error("admin session connection close failed", error);
  }
}

/** Register an in-process long-lived connection owned by one login session. */
export function registerAdminSessionConnection(
  connection: AdminSessionConnection
) {
  const connections = connectionsBySession.get(connection.sessionId)
    ?? new Set<AdminSessionConnection>();
  connections.add(connection);
  connectionsBySession.set(connection.sessionId, connections);
  return () => {
    connections.delete(connection);
    if (!connections.size) connectionsBySession.delete(connection.sessionId);
  };
}

export function closeAdminSessionConnections(sessionIds: Iterable<string>) {
  const closed = new Set<AdminSessionConnection>();
  for (const sessionId of sessionIds) {
    const connections = connectionsBySession.get(sessionId);
    connectionsBySession.delete(sessionId);
    for (const connection of connections ?? []) {
      closed.add(connection);
    }
  }
  for (const connection of closed) closeConnection(connection);
  return closed.size;
}

export function closeAllAdminSessionConnections() {
  const connections = new Set(
    [...connectionsBySession.values()].flatMap((items) => [...items])
  );
  connectionsBySession.clear();
  for (const connection of connections) closeConnection(connection);
  return connections.size;
}
