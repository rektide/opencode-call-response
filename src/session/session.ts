import type { Session as PersistedSession } from "./types.ts";

export type Session = Omit<PersistedSession, "time" | "summary" | "share"> & {
  port?: number;
  hostname?: string;
  pid?: number;
  cwd?: string;
  source?: "mdns" | "proc" | "port" | "lockfile";
  status?: "busy" | "retry" | "idle";
  retryAttempt?: number;
  retryMessage?: string;
  retryNext?: number;
};
