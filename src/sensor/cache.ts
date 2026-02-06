import type { Instance, Sensor } from "./types.ts";
import { mergeGenerators } from "../util/generator.ts";

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
      yield instance;
    }

    const sensorGenerators = this.sensors.map((sensor) => sensor.discover(timeout));

    for await (const instance of mergeGenerators(sensorGenerators)) {
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

  getInstances(): Instance[] {
    return [...this.instances];
  }

  stop(): void {
    for (const sensor of this.sensors) {
      sensor.stop?.();
    }
  }
}
