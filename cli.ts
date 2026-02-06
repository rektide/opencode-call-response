#!/usr/bin/env node

import { readdir, readFile, access, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

async function getOpenCodeStoragePath(): Promise<string> {
  const override = process.env.OPENCODE_TEST_HOME;
  if (override) {
    return join(override, "storage");
  }
  return join(homedir(), ".local", "share", "opencode", "storage");
}

interface Session {
  id: string;
  slug: string;
  projectID: string;
  directory: string;
  parentID?: string;
  title: string;
  version: string;
  time: {
    created: number;
    updated: number;
    compacting?: number;
    archived?: number;
  };
  summary?: {
    additions: number;
    deletions: number;
    files: number;
  };
  share?: {
    url: string;
  };
}

function matchesPattern(sessionDir: string, pattern: string): boolean {
  const hasWildcard = pattern.includes("*");

  if (!hasWildcard) {
    return sessionDir === pattern;
  }

  const regexPattern = pattern.replace(/\*/g, ".*").replace(/\?/g, ".");
  const regex = new RegExp(`^${regexPattern}$`);

  return regex.test(sessionDir);
}

async function listSessions(dir?: string): Promise<Session[]> {
  const storagePath = await getOpenCodeStoragePath();
  const sessionPath = join(storagePath, "session");

  try {
    await access(sessionPath);
  } catch {
    return [];
  }

  const projectDirs = await readdir(sessionPath, { withFileTypes: true });
  const sessions: Session[] = [];

  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) continue;

    const projectPath = join(sessionPath, projectDir.name);
    const sessionFiles = await readdir(projectPath);

    for (const sessionFile of sessionFiles) {
      if (!sessionFile.endsWith(".json")) continue;

      const sessionFilePath = join(projectPath, sessionFile);
      const content = await readFile(sessionFilePath, "utf-8");
      const session: Session = JSON.parse(content);

      if (dir && !matchesPattern(session.directory, dir)) continue;

      sessions.push(session);
    }
  }

  return sessions.sort((a, b) => b.time.updated - a.time.updated);
}

function displaySessions(sessions: Session[]) {
  if (sessions.length === 0) {
    return;
  }

  console.log("id\ttitle\tupdated\tdirectory");

  for (const session of sessions) {
    const title = (session.title || "Untitled").replace(/\n/g, "\\n");
    const updated = new Date(session.time.updated).toISOString();
    const directory = session.directory;

    console.log(`${session.id}\t${title}\t${updated}\t${directory}`);
  }
}

async function enableMdns(): Promise<void> {
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
}

const command = process.argv[2];
const options: { dir?: string } = {};

for (let i = 3; i < process.argv.length; i++) {
  if (process.argv[i] === "-d" || process.argv[i] === "--dir") {
    options.dir = process.argv[++i];
  }
}

async function main() {
  if (command === "list") {
    const dir = options.dir;
    const sessions = await listSessions(dir);
    displaySessions(sessions);
  } else if (command === "zeroconf") {
    await enableMdns();
  } else {
    console.log("Usage: node cli.ts <command>");
    console.log("");
    console.log("Commands:");
    console.log("  list      List all sessions");
    console.log("  zeroconf  Enable mDNS zeroconf setting in OpenCode config");
    console.log("");
    console.log("List options:");
    console.log("  -d, --dir  Filter sessions by directory pattern");
    process.exit(1);
  }
}

main();
