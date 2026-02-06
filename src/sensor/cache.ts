import { Instance, Sensor } from "./trait.js";

export interface CacheOptions {
  sensors: Iterable<Sensor>;
}

export class CacheSensor implements Sensor {
  public sensors: Sensor[];
  private instances: Instance[] = [];

  constructor(options: CacheOptions) {
    this.sensors = Array.from(options.sensors);
  }

  async *discover(timeout?: number): AsyncGenerator<Instance> {
    const seen = new Set<number>();

    for (const instance of this.instances) {
      if (instance.pid !== undefined) {
        seen.add(instance.pid);
      }
    }

    for (const instance of this.instances) {
      yield instance;
    }

    for (const sensor of this.sensors) {
      for await (const instance of sensor.discover(timeout)) {
        if (instance.pid !== undefined && seen.has(instance.pid)) {
          continue;
        }

        if (instance.pid !== undefined) {
          seen.add(instance.pid);
        }

        this.instances.push(instance);
        yield instance;
      }
    }
  }

  getInstances(): Instance[] {
    return [...this.instances];
  }

  stop(): void {
    for (const sensor of this.sensors) {
      sensor.stop?.();
    }
  }
}
