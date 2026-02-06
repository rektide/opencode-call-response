import { readdir, readFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { Session } from "./types.ts";

export async function getOpenCodeStoragePath(): Promise<string> {
  const override = process.env.OPENCODE_TEST_HOME;
  if (override) {
    return join(override, "storage");
  }
  return join(homedir(), ".local", "share", "opencode", "storage");
}

export async function listSessions(dir?: string): Promise<Session[]> {
  const storagePath = await getOpenCodeStoragePath();
  const sessionPath = join(storagePath, "session");

  try {
    await access(sessionPath);
  } catch {
    return [];
  }

  const projectDirs = await readdir(sessionPath, { withFileTypes: true });
  const sessions: Session[] = [];

  const targetDir = dir ? resolve(process.cwd(), dir) : undefined;

  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) continue;

    const projectPath = join(sessionPath, projectDir.name);
    const sessionFiles = await readdir(projectPath);

    for (const sessionFile of sessionFiles) {
      if (!sessionFile.endsWith(".json")) continue;

      const sessionFilePath = join(projectPath, sessionFile);
      const content = await readFile(sessionFilePath, "utf-8");
      const session: Session = JSON.parse(content);

      if (targetDir) {
        const isUnder = session.directory === targetDir || session.directory.startsWith(targetDir + "/");
        if (!isUnder) continue;
      }

      sessions.push(session);
    }
  }

  return sessions.sort((a, b) => b.time.updated - a.time.updated);
}
