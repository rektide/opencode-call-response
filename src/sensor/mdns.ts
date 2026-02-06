import { Browser } from "bonjour-service";
import { Instance, Sensor } from "./trait.js";

export class MdnsSensor implements Sensor {
  private browser?: Browser;

  async discover(timeout = 5000): Promise<Instance[]> {
    const instances: Instance[] = [];
    const bonjour = new Browser();

    this.browser = bonjour;

    return new Promise((resolve) => {
      setTimeout(() => {
        this.stop();
        resolve(instances);
      }, timeout);

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
    });
  }

  stop(): void {
    if (this.browser) {
      this.browser.stop();
      this.browser = undefined;
    }
  }
}
