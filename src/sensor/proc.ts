import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface Instance {
	pid: number;
	port?: number;
	cwd?: string;
	type: "proc";
}

interface ProcInfo {
	pid: number;
	cmdline: string[];
	cwd?: string;
}

async function readProcCmdline(pid: number): Promise<string[]> {
	try {
		const cmdlinePath = join("/proc", pid.toString(), "cmdline");
		const content = await readFile(cmdlinePath, "utf-8");
		return content.split("\0").filter((arg) => arg.length > 0);
	} catch {
		return [];
	}
}

async function readProcCwd(pid: number): Promise<string | undefined> {
	try {
		const cwdPath = join("/proc", pid.toString(), "cwd");
		const linkTarget = await readFile(cwdPath, "utf-8");
		return linkTarget.trim();
	} catch {
		return undefined;
	}
}

async function getOpenCodeProcesses(): Promise<ProcInfo[]> {
	const processes: ProcInfo[] = [];

	try {
		const procDir = "/proc";
		const entries = await readdir(procDir, { withFileTypes: true });

		for (const entry of entries) {
			if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) {
				continue;
			}

			const pid = parseInt(entry.name, 10);
			const cmdline = await readProcCmdline(pid);

			if (cmdline.length === 0) {
				continue;
			}

			const cmd = cmdline[0].toLowerCase();
			if (
				!cmd.includes("opencode") &&
				!cmd.includes("bun") &&
				!cmd.includes("node")
			) {
				continue;
			}

			const args = cmdline.slice(1).join(" ").toLowerCase();
			if (!args.includes("opencode")) {
				continue;
			}

			const cwd = await readProcCwd(pid);
			processes.push({ pid, cmdline, cwd });
		}
	} catch (error) {
		return [];
	}

	return processes;
}

function extractPortFromArgs(args: string[]): number | undefined {
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--port" && i + 1 < args.length) {
			const port = parseInt(args[i + 1], 10);
			if (!isNaN(port)) {
				return port;
			}
		}
	}
	return undefined;
}

export class ProcSensor {
	async discover(): Promise<Instance[]> {
		const processes = await getOpenCodeProcesses();
		const instances: Instance[] = [];

		for (const proc of processes) {
			const port = extractPortFromArgs(proc.cmdline);
			instances.push({
				pid: proc.pid,
				port,
				cwd: proc.cwd,
				type: "proc",
			});
		}

		return instances;
	}
}
