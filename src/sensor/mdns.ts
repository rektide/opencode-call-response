import { Browser } from "bonjour-service";
import { Instance, Sensor } from "./trait.js";

export class MdnsSensor implements Sensor {
  private browser?: Browser;

  async *discover(timeout = 5000): AsyncGenerator<Instance> {
    const bonjour = new Browser();
    this.browser = bonjour;

    const timer = setTimeout(() => {
      this.stop();
    }, timeout);

    try {
      const instances: Instance[] = [];

      bonjour.find({ type: "http", protocol: "tcp" }, (service) => {
        if (!service.name.includes("opencode")) {
          return;
        }

        if (service.port) {
          instances.push({
            port: service.port,
            hostname: service.host,
            source: "mdns",
          });
        }
      });

      await new Promise((resolve) => setTimeout(resolve, timeout));

      for (const instance of instances) {
        yield instance;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  stop(): void {
    if (this.browser) {
      this.browser.stop();
      this.browser = undefined;
    }
  }
}
