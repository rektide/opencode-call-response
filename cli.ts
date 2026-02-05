#!/usr/bin/env node

import { readdir, readFile, access } from "node:fs/promises";
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

      if (dir && !session.directory.includes(dir)) continue;

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
    const title = session.title || "Untitled";
    const updated = new Date(session.time.updated).toISOString();
    const directory = session.directory;

    console.log(`${session.id}\t${title}\t${updated}\t${directory}`);
  }
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
  } else {
    console.log("Usage: node cli.ts list [--dir <pattern>]");
    console.log("  list    List all sessions");
    console.log("  -d, --dir  Filter sessions by directory pattern");
    process.exit(1);
  }
}

main();
