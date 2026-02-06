export interface Session {
  sessionID: string;
  port?: number;
  hostname?: string;
  pid?: number;
  cwd?: string;
  source?: "mdns" | "proc" | "port" | "lockfile";
  status?: "busy" | "retry" | "idle";
  retryAttempt?: number;
  retryMessage?: string;
  retryNext?: number;
}
