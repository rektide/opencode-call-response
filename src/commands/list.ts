import { define } from "gunshi";
import { listSessions, displaySessions } from "../session/index.ts";

export const list = define({
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
