import { Session } from "./session.ts";

export type SessionPredicate = (session: Session) => boolean;

export interface SessionFilter extends Partial<Session> {
  busy?: boolean;
  idle?: boolean;
  retrying?: boolean;
  sessionIDPattern?: string;
  minRetryAttempt?: number;
}

function matches(session: Session, filter: SessionFilter): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (key === "busy" && value === true && session.status !== "busy") {
      return false;
    }
    if (key === "idle" && value === true && session.status !== "idle") {
      return false;
    }
    if (key === "retrying" && value === true && session.status !== "retry") {
      return false;
    }
    if (key === "sessionIDPattern" && !session.sessionID.includes(value as string)) {
      return false;
    }
    if (
      key === "minRetryAttempt" &&
      session.retryAttempt !== undefined &&
      session.retryAttempt < (value as number)
    ) {
      return false;
    }
    if (
      key !== "busy" &&
      key !== "idle" &&
      key !== "retrying" &&
      key !== "sessionIDPattern" &&
      key !== "minRetryAttempt"
    ) {
      const sessionValue = (session as any)[key];
      if (sessionValue !== value) {
        return false;
      }
    }
  }
  return true;
}

export async function* filterSessions(
  sessions: AsyncGenerator<Session>,
  filter: SessionFilter | SessionPredicate,
): AsyncGenerator<Session> {
  for await (const session of sessions) {
    if (typeof filter === "function") {
      if (filter(session)) {
        yield session;
      }
    } else {
      if (matches(session, filter)) {
        yield session;
      }
    }
  }
}
