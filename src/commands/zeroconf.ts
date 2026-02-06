import { readFile, access, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { define } from "gunshi";

export const zeroconf = define({
  name: "zeroconf",
  description: "Enable mDNS zeroconf setting in OpenCode config",
  async run() {
    const configPath1 = join(homedir(), ".config", "opencode", "opencode.json");
    const configPath2 = join(homedir(), ".opencode", "opencode.json");

    let config1Exists = false;
    let config2Exists = false;
    let config1HasMdns = false;
    let config2HasMdns = false;

    try {
      await access(configPath1);
      config1Exists = true;
      const content = await readFile(configPath1, "utf-8");
      const config = JSON.parse(content);
      config1HasMdns = config.server?.mdns !== undefined;
    } catch {}

    try {
      await access(configPath2);
      config2Exists = true;
      const content = await readFile(configPath2, "utf-8");
      const config = JSON.parse(content);
      config2HasMdns = config.server?.mdns !== undefined;
    } catch {}

    let targetFile: string;
    let existingConfig: any = {};

    if (config1HasMdns) {
      targetFile = configPath1;
      const content = await readFile(configPath1, "utf-8");
      existingConfig = JSON.parse(content);
    } else if (config2HasMdns) {
      targetFile = configPath2;
      const content = await readFile(configPath2, "utf-8");
      existingConfig = JSON.parse(content);
    } else if (config1Exists && !config2Exists) {
      targetFile = configPath1;
      const content = await readFile(configPath1, "utf-8");
      existingConfig = JSON.parse(content);
    } else if (config2Exists && !config1Exists) {
      targetFile = configPath2;
      const content = await readFile(configPath2, "utf-8");
      existingConfig = JSON.parse(content);
    } else {
      targetFile = configPath1;
      if (config1Exists) {
        const content = await readFile(configPath1, "utf-8");
        existingConfig = JSON.parse(content);
      }
    }

    existingConfig.server = existingConfig.server || {};
    existingConfig.server.mdns = true;

    if (!existingConfig.$schema) {
      existingConfig.$schema = "https://opencode.ai/config.json";
    }

    const targetDir = join(targetFile, "..");
    await mkdir(targetDir, { recursive: true });
    await writeFile(targetFile, JSON.stringify(existingConfig, null, 2));
    console.log(`Enabled mdns in ${targetFile}`);
  },
});
