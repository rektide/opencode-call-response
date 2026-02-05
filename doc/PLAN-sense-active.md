# Sensing Active OpenCode Instances and Sessions

## Goal

Detect all running OpenCode instances and identify which sessions are currently active/busy in order to manage agent lifecycle and avoid conflicts.

## Detection Strategy

### Priority Order

1. **mDNS Discovery** (Preferred - if enabled)
2. **Process Detection** (Fallback - parse running processes)
3. **Port Scanning** (Last resort - scan localhost)

---

## 1. mDNS Discovery

OpenCode can broadcast itself via mDNS/Bonjour when configured.

### Detection

- Query mDNS for `_opencode._tcp` service
- Each response provides:
  - Hostname/IP
  - Port number
  - Service name (can be used to identify instance)

### Prerequisites

- OpenCode must have `mdns: true` in config OR `--mdns` flag enabled
- This is off by default

### Advantages

- Clean, standard service discovery
- Multiple instances on different hosts can be discovered
- No special permissions needed

### Disadvantages

- Disabled by default, so won't work in most scenarios
- Requires mDNS library (e.g., `bonjour-service`, `mdns-js`, `node-dnssd`)

---

## 2. Process Detection

Parse `/proc` entries on Linux to find OpenCode processes.

### Detection Steps

1. List all processes in `/proc`
2. Find processes matching OpenCode (e.g., `bun opencode`, `node opencode`)
3. For each matching process:
   - Read `/proc/[PID]/cmdline` to get full command line
   - Parse `--port <N>` argument to extract port
   - Parse working directory from `/proc/[PID]/cwd`
   - Parse `--dir` or directory from `/proc/[PID]/environ`

### Information Extracted

| Process ID | Port | Working Directory | Args |
| ---------- | ---- | ---------------- | ---- |
| 12345 | 4096 | /home/user/project | --model claude-3-5 |

### Prerequisites

- Linux system with `/proc` filesystem
- Read access to `/proc` entries

### Advantages

- Works even if mDNS is disabled
- Extracts port and working directory directly
- No network overhead

### Disadvantages

- Linux-specific (won't work on macOS/Windows)
- Requires reading `/proc` (may fail with restricted permissions)
- Assumes port is in command line args (could be in config file)

---

## 3. Port Scanning

Scan localhost for HTTP servers that respond like OpenCode.

### Detection Steps

1. Scan ports `4096-65535` (or configurable range)
2. For each open port:
   - Send `GET /api/session/status` request
   - If response is JSON with status info, it's an OpenCode instance
3. Extract instance info:
   - Port number
   - Session statuses from `/api/session/status` endpoint

### Information Extracted

| Port | Session ID | Status |
| ---- | ---------- | ------ |
| 4096 | ses_abc123 | busy |
| 5173 | ses_def456 | idle |

### Prerequisites

- OpenCode server running and accessible via HTTP

### Advantages

- Works on any OS
- Directly retrieves session status (no parsing needed)
- Can detect sessions across multiple instances

### Disadvantages

- Slow to scan many ports
- Only finds instances with HTTP server running
- May miss instances bound to specific IPs (not 0.0.0.0 or 127.0.0.1)

---

## 4. Additional Fallbacks (Lower Priority)

### Lock Files

- Check for lock files in `~/.local/share/opencode/` or `$XDG_RUNTIME_DIR/opencode/`
- Format: `opencode-<port>.lock` containing PID
- Remove after checking if process still exists

### Unix Domain Sockets

- Check for sockets in `$XDG_RUNTIME_DIR/opencode/`
- Can query socket for status

### Systemd/User Service Status

- Check `systemctl --user status opencode*` for running services
- Extract port from unit file or ExecStart command

### PID Files

- Check for PID files in standard locations
- Use `systemd-run` or similar to manage instance lifecycle

---

## Session Status API

Once an instance is detected, query it for session activity.

### Endpoint

```
GET /api/session/status
```

### Response Format

```json
{
  "ses_abc123": {
    "type": "busy"
  },
  "ses_def456": {
    "type": "idle"
  },
  "ses_ghi789": {
    "type": "retry",
    "attempt": 3,
    "message": "Connection error",
    "next": 1737789123456
  }
}
```

### Status Types

| Type | Meaning |
| ---- | ------- |
| `idle` | Session not actively processing |
| `busy` | Session currently processing a prompt |
| `retry` | Session encountered error and retrying (includes attempt count and message) |

---

## Implementation Plan

### Phase 1: Basic Detection

1. Implement process detection (Linux `/proc` parsing)
2. Implement port scanning with `/api/session/status` check
3. Return list of instances: `{ pid, port, cwd, sessions[] }`

### Phase 2: mDNS Support

1. Add mDNS discovery library
2. Query for `_opencode._tcp` services
3. Merge with other discovery methods

### Phase 3: Cross-Platform

1. Add macOS process detection (using `ps` command)
2. Add Windows process detection (using `wmic` or PowerShell)
3. Use lock files as universal fallback

### Phase 4: API Client

1. Create simple HTTP client to query OpenCode API
2. Add helper: `getActiveSessions(port)` → returns `sessionID[]` with `type: "busy"`
3. Add helper: `getSessionStatus(port, sessionID)` → returns session details

---

## Configuration

Users can configure discovery:

```json
{
  "discovery": {
    "methods": ["mdns", "process", "port"],
    "portRange": [4096, 65535],
    "timeout": 5000,
    "scanInterval": 30000
  }
}
```

### Options

- `methods`: List of discovery methods to try, in priority order
- `portRange`: Port range to scan for port-based discovery
- `timeout`: Timeout for HTTP requests to instances (ms)
- `scanInterval`: How often to re-scan for instances (ms)

---

## Use Cases

### Finding an idle session to attach to

```typescript
const instances = await discoverOpenCodeInstances()
for (const instance of instances) {
  const sessions = await getInstanceSessions(instance.port)
  const idle = sessions.filter(s => s.status.type === 'idle')
  if (idle.length > 0) {
    return { instance, session: idle[0] }
  }
}
// Create new session if none available
```

### Checking if a session is busy before sending commands

```typescript
const instance = await discoverInstanceAtPort(4096)
const status = await getSessionStatus(instance.port, 'ses_abc123')
if (status.type === 'busy') {
  console.log('Session is busy, waiting...')
  await waitForIdle(instance.port, 'ses_abc123')
}
```

### Listing all active sessions across all instances

```typescript
const instances = await discoverOpenCodeInstances()
const allSessions: Array<{sessionID: string, port: number, status: string}> = []

for (const instance of instances) {
  const sessions = await getInstanceSessions(instance.port)
  for (const [id, status] of Object.entries(sessions)) {
    allSessions.push({ sessionID: id, port: instance.port, status: status.type })
  }
}

console.table(allSessions.filter(s => s.status === 'busy'))
```

---

## Notes

- Session status is **in-memory only** - lost when server restarts
- Multiple OpenCode instances can run simultaneously on different ports
- Default port is `4096` but can be auto-assigned if `0` is specified
- mDNS uses hostname `0.0.0.0` when enabled, making it discoverable on LAN
