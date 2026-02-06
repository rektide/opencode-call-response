import { readdir, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { define } from "gunshi";

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

interface ListOptions {
  dir?: string;
}

async function getOpenCodeStoragePath(): Promise<string> {
  const override = process.env.OPENCODE_TEST_HOME;
  if (override) {
    return join(override, "storage");
  }
  return join(homedir(), ".local", "share", "opencode", "storage");
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

export const list = define<ListOptions>({
  name: "list",
  description: "List all OpenCode sessions",
  options: {
    dir: {
      type: "string",
      alias: "d",
      description: "Filter sessions by directory pattern",
    },
  },
  async run({ dir }) {
    const sessions = await listSessions(dir);
    displaySessions(sessions);
  },
});
