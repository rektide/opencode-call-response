export interface Instance {
  port: number;
  hostname?: string;
  pid?: number;
  cwd?: string;
  source: "mdns" | "proc" | "port" | "lockfile";
}

export interface Sensor {
  discover(timeout?: number): AsyncGenerator<Instance>;
  stop?(): void;
}
