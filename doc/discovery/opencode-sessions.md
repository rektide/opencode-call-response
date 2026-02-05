# Session Architecture in OpenCode

## Overview

Sessions in OpenCode represent the core unit of conversation state between users and AI assistants. Each session encapsulates the entire interaction history, including messages, tool executions, file changes, permissions, and metadata. Sessions are persistently stored and can be restored, forked, shared, and managed through various interfaces.

## Session Storage

### Physical Storage Location

Sessions are stored in the OpenCode data directory using a structured JSON-based storage system:

```
~/.local/share/opencode/storage/
├── session/
│   └── {projectID}/
│       └── {sessionID}.json          # Session metadata
├── message/
│   └── {sessionID}/
│       └── {messageID}.json          # Message metadata
├── part/
│   └── {messageID}/
│       └── {partID}.json             # Message parts (text, tool calls, etc.)
├── session_diff/
│   └── {sessionID}.json              # File changes/diffs
└── share/
    └── {sessionID}.json              # Share information
```

The data directory location follows XDG Base Directory specifications:

- Linux/macOS: `~/.local/share/opencode/storage/`
- Can be overridden via `OPENCODE_TEST_HOME` environment variable for testing

### Project Association

Sessions are grouped by project ID, which is derived from the Git repository's root commit:

- Git projects: Project ID is the hash of the first commit (`git rev-list --max-parents=0 --all`)
- Non-Git projects: Project ID is `"global"`

This allows sessions to be scoped to specific codebases and worktrees.

### Session Identifier Format

Session IDs use a monotonic identifier format with the prefix `ses_`:

```
{prefix}_{timestamp_base62}{random}
```

- **Prefix**: `ses_` (identifies as session)
- **Timestamp**: 6 bytes of base62-encoded timestamp with counter
- **Random**: 14 bytes of random base62 characters

Example: `ses_01h8k7m5n2p3q4r5s6t7u8v9w0x1y2z3`

The timestamp allows sorting by creation time, while the random component ensures uniqueness. IDs can be generated in ascending (newest last) or descending (newest first) order.

### Session Data Structure

Each session file (`{sessionID}.json`) contains:

```typescript
{
  id: string                    // Unique session identifier
  slug: string                  // URL-friendly slug for sharing
  projectID: string             // Associated project ID
  directory: string             // Working directory path
  parentID: string?             // Parent session ID (for forks)
  title: string                 // Session title
  version: string               // OpenCode version that created the session
  time: {
    created: number              // Creation timestamp (ms)
    updated: number              // Last update timestamp (ms)
    compacting: number?         // Last compaction timestamp
    archived: number?            // Archive timestamp
  }
  summary?: {
    additions: number           // Total lines added
    deletions: number           // Total lines deleted
    files: number               // Number of files modified
    diffs?: FileDiff[]          // Detailed file changes
  }
  share?: {
    url: string                 // Shareable URL
  }
  permission?: PermissionRuleset[]  // Permission rules for this session
  revert?: {
    messageID: string            // Message being reverted
    partID: string?             // Specific part being reverted
    snapshot: string?           // Git snapshot hash
    diff: string?               // Diff content
  }
}
```

### Message and Part Storage

Messages are stored separately from session metadata:

**Message Structure** (`message/{sessionID}/{messageID}.json`):

```typescript
{
  id: string                    // Message ID (msg_ prefix)
  sessionID: string             // Parent session ID
  role: "user" | "assistant" | "system"
  parentID: string?             // Parent message ID
  agent?: string                // Agent that processed this
  model?: string                // Model used
  time: {
    created: number             // Creation timestamp
  }
  error?: Error                 // Error if processing failed
  cost?: number                 // Token cost
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
  }
}
```

**Part Structure** (`part/{messageID}/{partID}.json`):

```typescript
{
  id: string                    // Part ID (prt_ prefix)
  messageID: string             // Parent message ID
  sessionID: string             // Parent session ID
  type: "text" | "tool" | "file" | "agent" | "subtask" | "reasoning"
  // Type-specific fields...
  time: {
    start: number
    end?: number
  }
}
```

This separation allows efficient streaming of message parts during AI processing without reloading the entire session.

## Session List Implementation

### CLI Command: `opencode session list`

The `opencode session list` command is implemented in `packages/opencode/src/cli/cmd/session.ts`:

**Location**: [`packages/opencode/src/cli/cmd/session.ts:45-136`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/cli/cmd/session.ts#L45)

**Key Features**:

1. **Bootstrap Loading**: Uses `bootstrap()` to initialize project context from current working directory
2. **Session Enumeration**: Iterates through `Session.list()` to load all sessions
3. **Root Filtering**: Excludes child sessions (those with `parentID`) by default
4. **Sorting**: Sorts by `time.updated` in descending order (newest first)
5. **Limiting**: Supports `--max-count` flag to limit output
6. **Pagination**: Automatically uses `less` pager when outputting to TTY
7. **Format Options**: Supports table (default) and JSON formats

**Code Flow**:

```typescript
for await (const session of Session.list()) {
	if (!session.parentID) {
		sessions.push(session)
	}
}
sessions.sort((a, b) => b.time.updated - a.time.updated)
```

**Table Format Output**:

```
Session ID                    Title                         Updated
──────────────────────────────────────────────────────────────────────────
ses_01h8k7m...               New session - 2025-01-15...    Today at 2:30 PM
ses_01h8j9k...               Add authentication API         Yesterday
ses_01h8i8j...               Fix memory leak in worker      2 days ago
```

**JSON Format Output**:

```json
[
	{
		"id": "ses_01h8k7m...",
		"title": "New session - 2025-01-15T14:30:00.000Z",
		"updated": 1736963400000,
		"created": 1736963400000,
		"projectId": "a1b2c3d4...",
		"directory": "/home/user/project"
	}
]
```

### Server API Endpoint

The HTTP API provides equivalent functionality via `GET /api/session`:

**Location**: [`packages/opencode/src/server/routes/session.ts:24-67`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/server/routes/session.ts#L24)

**Query Parameters**:

- `directory`: Filter sessions by project directory
- `roots`: Only return root sessions (no parentID)
- `start`: Filter sessions updated on or after timestamp
- `search`: Filter sessions by title (case-insensitive)
- `limit`: Maximum number of sessions to return

**Example Request**:

```bash
curl "http://localhost:5173/api/session?roots=true&limit=10"
```

## Session Write Operations

OpenCode writes to sessions through multiple pathways depending on the operation type:

### 1. Session Creation

**Method**: `Session.create()`
**Location**: [`packages/opencode/src/session/index.ts:140-247`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/index.ts#L140)

**Process**:

1. Generate unique session ID using `Identifier.descending("session")`
2. Create session metadata with defaults:
   - Default title: "New session - {timestamp}" or "Child session - {timestamp}"
   - Project ID from current instance
   - Directory from instance context
3. Write to storage: `Storage.write(["session", projectID, sessionID], sessionInfo)`
4. Publish `session.created` event via Bus
5. Auto-share if configured
6. Publish `session.updated` event

**Code**:

```typescript
const result = {
	id: Identifier.descending("session"),
	slug: Slug.create(),
	version: Installation.VERSION,
	projectID: Instance.project.id,
	directory: input.directory,
	parentID: input.parentID,
	title: input.title ?? createDefaultTitle(!!input.parentID),
	time: {
		created: Date.now(),
		updated: Date.now(),
	},
}
await Storage.write(["session", Instance.project.id, result.id], result)
```

### 2. Message Addition

**Method**: `SessionPrompt.prompt()`
**Location**: [`packages/opencode/src/session/prompt.ts:152-181`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/prompt.ts#L152)

**Process**:

1. Create user message with provided parts (text, files, etc.)
2. Touch session to update timestamp
3. Start message processing loop
4. Stream AI response into assistant message parts
5. Each part is written immediately via `Session.updatePart()`
6. Publish events for each part update

**Flow**:

```typescript
const message = await createUserMessage(input)
await Session.touch(input.sessionID)
return loop(input.sessionID)
```

### 3. Part Streaming (During AI Processing)

**Method**: `Session.updatePart()`
**Location**: [`packages/opencode/src/session/index.ts:428-437`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/index.ts#L428)

**Process**:

1. Write part to storage: `Storage.write(["part", messageID, partID], part)`
2. Publish `part.updated` event via Bus
3. Support delta updates for text/reasoning parts (append instead of rewrite)

**Use Cases**:

- Text streaming: User prompts are built incrementally
- Reasoning: AI thinking process streams in real-time
- Tool execution: Tool inputs, outputs, and status updates
- File attachments: File metadata and content

### 4. Session Updates

**Method**: `Session.update()`
**Location**: [`packages/opencode/src/session/index.ts:297-309`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/index.ts#L297)

**Process**:

1. Read existing session from storage
2. Apply editor function to modify fields
3. Auto-update `time.updated` timestamp unless `{ touch: false }` option
4. Write back to storage
5. Publish `session.updated` event

**Common Updates**:

- Title changes
- Permission modifications
- Archive/unarchive
- Share URL updates
- Revert state changes

### 5. Session Compaction

**Method**: `SessionCompaction.create()`
**Location**: [`packages/opencode/src/session/compaction.ts`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/compaction.ts)

**Process**:

1. Create a summary message containing key information
2. Remove older messages that are summarized
3. Update session metadata with `time.compacting` timestamp
4. Generate diffs for summarized messages
5. Store diffs in `session_diff/{sessionID}.json`

**Purpose**: Reduce token usage by condensing long conversation histories while preserving important context.

### 6. Session Forking

**Method**: `Session.fork()`
**Location**: [`packages/opencode/src/session/index.ts:158-198`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/index.ts#L158)

**Process**:

1. Load original session
2. Create new session with derived title: "{original_title} (fork #N)"
3. Copy messages up to specified message ID (or all)
4. Remap message IDs using `Identifier.ascending("message")`
5. Copy all message parts with new IDs
6. Maintain parent-child relationship

**Use Case**: Experiment with different approaches without losing original work.

### 7. Session Revert

**Method**: `SessionRevert.revert()`
**Location**: [`packages/opencode/src/session/revert.ts`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/revert.ts)

**Process**:

1. Create git snapshot of current state
2. Mark message as reverted in session metadata
3. Restore files from git snapshot
4. Store revert info in session
5. Messages are not deleted, just marked as reverted

**Support**: `SessionRevert.unrevert()` restores previously reverted messages.

## Session Restoration and Switching

### HTTP API Session Selection

The web interface switches sessions by calling session endpoints:

**Get Session**: `GET /api/session/{sessionID}`
**Location**: [`packages/opencode/src/server/routes/session.ts:93-123`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/server/routes/session.ts#L93)

**Load Messages**: `GET /api/session/{sessionID}/message`
**Location**: [`packages/opencode/src/server/routes/session.ts:547-584`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/server/routes/session.ts#L547)

**Process**:

1. Frontend requests session metadata and messages
2. Backend loads from storage using `Session.get(sessionID)` and `Session.messages({ sessionID })`
3. Messages are returned with all parts
4. Frontend renders conversation history

### CLI Session Switching

The CLI doesn't have explicit session switching - instead, operations are performed on a per-project basis. The `opencode session list` command shows all sessions for the current project.

### ACP Session Management

The ACP (Agent Client Protocol) agent maintains its own session state:

**Manager**: `ACPSessionManager`
**Location**: [`packages/opencode/src/acp/session.ts:8-117`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/acp/session.ts#L8)

**In-Memory State**:

```typescript
{
  id: string
  cwd: string
  mcpServers: McpServer[]
  createdAt: Date
  model?: ModelInfo
  variant?: string
  modeId?: string
}
```

**Operations**:

- `create()`: Creates new session via SDK and stores in memory
- `load()`: Loads existing session from SDK and stores in memory
- `get()`: Retrieves in-memory session state
- `setModel()`, `setVariant()`, `setMode()`: Update session properties

**Persistence**: ACP sessions are persisted via the OpenCode SDK to the same storage backend.

### Instance Context Management

Sessions are tied to project instances:

**Location**: [`packages/opencode/src/project/instance.ts:22-44`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/project/instance.ts#L22)

**Context Scope**:

- Each directory/project has its own instance context
- Sessions are loaded within their project's instance
- Session operations automatically use the correct project context

**Cache**:

- Instances are cached by directory path
- Re-opening a session reuses the cached instance
- `Instance.dispose()` cleans up instance state

## Session Status Tracking

OpenCode tracks session processing status in-memory:

**Status Types**: [`packages/opencode/src/session/status.ts:7-25`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/status.ts#L7)

- **idle**: Session is not actively processing
- **busy**: Session is currently processing a prompt
- **retry**: Session encountered an error and is retrying

**Status Updates**:

- Set to "busy" when AI processing starts
- Set to "idle" when processing completes
- Set to "retry" with error info on failure

**Events**: Status changes are published via Bus events (`session.status`, `session.idle`).

## Session Events

OpenCode publishes events for session lifecycle changes:

**Event Types**:

- `session.created`: New session created
- `session.updated`: Session metadata updated
- `session.deleted`: Session deleted
- `session.diff`: File changes computed
- `session.error`: Processing error occurred
- `session.status`: Status changed (busy/idle/retry)

**Bus Integration**:

```typescript
Bus.subscribe(Session.Event.Created, (event) => {
	console.log("New session:", event.properties.info.id)
})
```

## Session Lifecycle

```
1. Creation
   ├─ Generate ID
   ├─ Create metadata
   ├─ Write to storage
   ├─ Publish events
   └─ Auto-share (if configured)

2. Active Use
   ├─ Add messages (user + assistant)
   ├─ Stream message parts
   ├─ Execute tools
   ├─ Track file changes (snapshots)
   └─ Update status (busy/idle)

3. Optional Operations
   ├─ Fork (create copy at message point)
   ├─ Revert (undo to previous state)
   ├─ Compaction (summarize long history)
   ├─ Share (create shareable link)
   └─ Archive (mark as archived)

4. Deletion
   ├─ Recursively delete children
   ├─ Delete all messages and parts
   ├─ Remove share
   ├─ Delete session metadata
   └─ Publish events
```

## Storage Implementation Details

### Locking

Storage operations use file-based locking to prevent concurrent writes:

```typescript
using _ = await Lock.write(target)
await Bun.write(target, JSON.stringify(content, null, 2))
```

Locks are acquired at file granularity to allow concurrent access to different sessions.

### Migrations

Storage includes migration support for schema changes:

**Location**: [`packages/opencode/src/storage/storage.ts:24-142`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/storage/storage.ts#L24)

Migration version is stored in `storage/migration` file and migrations run sequentially on startup.

### Error Handling

Storage operations throw `NotFoundError` for missing resources:

```typescript
try {
	const session = await Session.get(sessionID)
} catch (e) {
	if (e instanceof Storage.NotFoundError) {
		// Session doesn't exist
	}
}
```

## Performance Considerations

### Streaming

Message parts are written incrementally during AI processing to:

- Reduce memory usage
- Enable real-time UI updates
- Avoid blocking on large tool outputs

### Lazy Loading

Session messages are loaded on-demand via `Session.messages()` to avoid loading entire conversation history when only metadata is needed.

### Compaction

Long sessions can be compacted to:

- Reduce token usage
- Improve performance
- Maintain conversation context

Compaction is triggered automatically when sessions exceed certain thresholds (configurable).

## Integration with Other Systems

### Project System

Sessions are scoped to projects, which are identified by:

- Git root commit (for Git projects)
- "global" (for non-Git projects)

This allows sessions to be associated with specific codebases.

### Snapshot System

File changes are tracked using git-based snapshots:

- Each message can create a snapshot
- Diffs are computed between snapshots
- Reverts restore files to previous snapshots

### Bus System

All session changes are published as events:

- Enables real-time UI updates
- Supports plugins that react to session changes
- Provides audit trail

### MCP Integration

MCP servers are managed at the session level:

- Each session can have different MCP servers
- MCP state is scoped to session context

### Permission System

Sessions have their own permission rulesets:

- Control which tools can be used
- Apply to all operations within the session
- Can be updated dynamically

## Session API Endpoints

### Session Management

| Method | Endpoint                           | Description              | Location                                                                                                                    |
| ------ | ---------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/session`                     | List sessions            | [`session.ts:24-67`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/server/routes/session.ts#L24)    |
| POST   | `/api/session`                     | Create session           | [`session.ts:186-209`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/server/routes/session.ts#L186) |
| GET    | `/api/session/:sessionID`          | Get session              | [`session.ts:93-123`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/server/routes/session.ts#L93)   |
| PATCH  | `/api/session/:sessionID`          | Update session           | [`session.ts:240-292`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/server/routes/session.ts#L240) |
| DELETE | `/api/session/:sessionID`          | Delete session           | [`session.ts:210-239`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/server/routes/session.ts#L210) |
| GET    | `/api/session/:sessionID/children` | Get child sessions       | [`session.ts:125-154`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/server/routes/session.ts#L125) |
| GET    | `/api/session/status`              | Get all session statuses | [`session.ts:70-91`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/server/routes/session.ts#L70)    |

### Message Operations

| Method | Endpoint                                                  | Description           | Location                                                                                                                    |
| ------ | --------------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/session/:sessionID/message`                         | Get messages          | [`session.ts:547-584`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/server/routes/session.ts#L547) |
| GET    | `/api/session/:sessionID/message/:messageID`              | Get single message    | [`session.ts:586-623`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/server/routes/session.ts#L586) |
| POST   | `/api/session/:sessionID/message`                         | Send message (stream) | [`session.ts:698-737`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/server/routes/session.ts#L698) |
| POST   | `/api/session/:sessionID/prompt_async`                    | Send async message    | [`session.ts:739-768`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/server/routes/session.ts#L739) |
| DELETE | `/api/session/:sessionID/message/:messageID/part/:partID` | Delete part           | [`session.ts:624-658`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/server/routes/session.ts#L624) |
| PATCH  | `/api/session/:sessionID/message/:messageID/part/:partID` | Update part           | [`session.ts:660-696`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/server/routes/session.ts#L660) |

### Session Actions

| Method | Endpoint                            | Description          | Location                                                                                                                    |
| ------ | ----------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/session/:sessionID/fork`      | Fork session         | [`session.ts:327-356`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/server/routes/session.ts#L327) |
| POST   | `/api/session/:sessionID/init`      | Initialize session   | [`session.ts:294-325`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/server/routes/session.ts#L294) |
| POST   | `/api/session/:sessionID/abort`     | Abort active session | [`session.ts:358-385`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/server/routes/session.ts#L358) |
| POST   | `/api/session/:sessionID/share`     | Create share link    | [`session.ts:387-416`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/server/routes/session.ts#L387) |
| DELETE | `/api/session/:sessionID/share`     | Remove share link    | [`session.ts:457-486`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/server/routes/session.ts#L457) |
| POST   | `/api/session/:sessionID/summarize` | Compact session      | [`session.ts:488-545`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/server/routes/session.ts#L488) |
| POST   | `/api/session/:sessionID/revert`    | Revert message       | [`session.ts:839-872`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/server/routes/session.ts#L839) |
| POST   | `/api/session/:sessionID/unrevert`  | Restore reverted     | [`session.ts:874-902`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/server/routes/session.ts#L874) |

### Other Operations

| Method | Endpoint                          | Description       | Location                                                                                                                    |
| ------ | --------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/session/:sessionID/command` | Send command      | [`session.ts:770-805`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/server/routes/session.ts#L770) |
| POST   | `/api/session/:sessionID/shell`   | Run shell command | [`session.ts:807-837`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/server/routes/session.ts#L807) |
| GET    | `/api/session/:sessionID/todo`    | Get session todos | [`session.ts:156-184`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/server/routes/session.ts#L156) |
| GET    | `/api/session/:sessionID/diff`    | Get message diff  | [`session.ts:418-455`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/server/routes/session.ts#L418) |

## Key Files Reference

| File                                                                                                                                               | Purpose                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| [`packages/opencode/src/session/index.ts`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/index.ts)                 | Core session operations (CRUD, messages)  |
| [`packages/opencode/src/session/prompt.ts`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/prompt.ts)               | Message processing and AI interaction     |
| [`packages/opencode/src/session/processor.ts`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/processor.ts)         | Message part streaming and tool execution |
| [`packages/opencode/src/session/message-v2.ts`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/message-v2.ts)       | Message and part types                    |
| [`packages/opencode/src/session/status.ts`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/status.ts)               | Session status tracking                   |
| [`packages/opencode/src/session/compaction.ts`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/compaction.ts)       | Session compaction logic                  |
| [`packages/opencode/src/session/revert.ts`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/revert.ts)               | Revert functionality                      |
| [`packages/opencode/src/storage/storage.ts`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/storage/storage.ts)             | Storage abstraction layer                 |
| [`packages/opencode/src/project/instance.ts`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/project/instance.ts)           | Project instance context                  |
| [`packages/opencode/src/cli/cmd/session.ts`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/cli/cmd/session.ts)             | CLI session commands                      |
| [`packages/opencode/src/server/routes/session.ts`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/server/routes/session.ts) | HTTP API routes                           |
| [`packages/opencode/src/acp/session.ts`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/acp/session.ts)                     | ACP session management                    |
