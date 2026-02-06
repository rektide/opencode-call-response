import { define } from "gunshi";
import { listSessions } from "../session/store.ts";
import { displaySessions } from "../session/types.ts";

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
