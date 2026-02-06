#!/usr/bin/env node
import { cli, define } from "gunshi";
import { list, zeroconf } from "./src/commands/index.ts";

const main = define({
	name: "opencode-call-response",
	description: "Tool to send cross-session opencode messages",
	async run() {
		console.log("Usage: opencode-call-response <command>");
		console.log("");
		console.log("Commands:");
		console.log("  list      List all OpenCode sessions");
		console.log("  zeroconf  Enable mDNS zeroconf setting");
	},
});

await cli(process.argv.slice(2), main, {
	name: "opencode-call-response",
	version: "1.0.0",
	subCommands: {
		list,
		zeroconf,
	},
});
