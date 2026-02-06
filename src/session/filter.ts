import { Session } from "./session.js";

export interface SessionFilter {
  busy?: boolean;
  idle?: boolean;
  retrying?: boolean;
  port?: number;
  sessionIDPattern?: string;
  minRetryAttempt?: number;
}

export async function* filterSessions(
  sessions: AsyncGenerator<Session>,
  filter: SessionFilter,
): AsyncGenerator<Session> {
  for await (const session of sessions) {
    if (filter.busy && session.status !== "busy") {
      continue;
    }
    if (filter.idle && session.status !== "idle") {
      continue;
    }
    if (filter.retrying && session.status !== "retry") {
      continue;
    }
    if (filter.port && session.port !== filter.port) {
      continue;
    }
    if (filter.sessionIDPattern && !session.sessionID.includes(filter.sessionIDPattern)) {
      continue;
    }
    if (
      filter.minRetryAttempt &&
      session.retryAttempt !== undefined &&
      session.retryAttempt < filter.minRetryAttempt
    ) {
      continue;
    }
    yield session;
  }
}
