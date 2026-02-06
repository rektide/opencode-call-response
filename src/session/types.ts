export interface Session {
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

export function matchesPattern(sessionDir: string, pattern: string): boolean {
  const hasWildcard = pattern.includes("*");

  if (!hasWildcard) {
    return sessionDir === pattern;
  }

  const regexPattern = pattern.replace(/\*/g, ".*").replace(/\?/g, ".");
  const regex = new RegExp(`^${regexPattern}$`);

  return regex.test(sessionDir);
}

export function displaySessions(sessions: Session[]): void {
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
