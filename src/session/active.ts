import { Instance } from "../sensor/trait.js";
import { Session } from "./session.js";

export type ActiveSession = Session & {
  port: number;
  status: "busy" | "retry" | "idle";
};

async function getSessionStatus(port: number): Promise<Record<string, any> | undefined> {
  try {
    const response = await fetch(`http://localhost:${port}/api/session/status`);
    if (!response.ok) {
      return undefined;
    }
    return await response.json();
  } catch {
    return undefined;
  }
}

export async function* getActiveSessions(
  instances: AsyncGenerator<Instance>,
): AsyncGenerator<ActiveSession> {
  for await (const instance of instances) {
    const statusMap = await getSessionStatus(instance.port);

    if (!statusMap) {
      continue;
    }

    for (const [sessionID, status] of Object.entries(statusMap)) {
      if (typeof status !== "object" || status === null) {
        continue;
      }

      const statusType = status.type;

      if (statusType === "busy" || statusType === "retry" || statusType === "idle") {
        yield {
          sessionID,
          port: instance.port,
          status: statusType,
          retryAttempt: status.attempt,
          retryMessage: status.message,
          retryNext: status.next,
        };
      }
    }
  }
}
