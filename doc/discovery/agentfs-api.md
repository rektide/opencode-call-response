# AgentFS API Discovery

> An in-depth exploration of AgentFS database schema, library API, and usage patterns

## Overview

AgentFS is a filesystem explicitly designed for AI agents, built on top of SQLite (via libSQL/Turso). It provides three core storage abstractions:

1. **Virtual Filesystem** - POSIX-like filesystem with files, directories, symlinks, and special files
2. **Key-Value Store** - Simple JSON-serialized key-value storage for agent state
3. **Tool Call Audit Trail** - Insert-only log of tool/function invocations for debugging and compliance

**Key Design Philosophy**: Everything is stored in a single SQLite database file, enabling:
- **Auditability** - Complete history queryable via SQL
- **Reproducibility** - `cp agent.db snapshot.db` captures exact state
- **Portability** - Single file can be moved, versioned, or deployed anywhere

## Can AgentFS be used without FUSE?

**Yes!** AgentFS provides full-featured SDKs for Rust, Python, and TypeScript that operate directly on the SQLite database. The FUSE/NFS mount is optional and primarily useful for:
- Running existing tools that expect a POSIX filesystem
- Interactive shell sessions (`agentfs run`)
- Debugging and inspection

For programmatic access, **use the SDKs directly** - they're faster, more reliable, and give you finer control.

---

## Database Schema (Version 0.4)

### Schema Versioning

AgentFS uses schema versioning to handle migrations. Current version is stored in `fs_config`:

```sql
SELECT value FROM fs_config WHERE key = 'schema_version';
-- Returns: '0.4'
```

Version history:
- **0.0**: Base schema (fs_inode, fs_dentry, fs_data, fs_symlink, fs_config, kv_store, tool_calls)
- **0.2**: Added `nlink` column to `fs_inode` for hard link counts
- **0.4**: Added nanosecond precision timestamps (`atime_nsec`, `mtime_nsec`, `ctime_nsec`) and `rdev` for special files

---

### 1. Virtual Filesystem Tables

#### `fs_config` - Filesystem Configuration

Immutable configuration set at filesystem creation.

```sql
CREATE TABLE fs_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)
```

**Required Keys**:
| Key | Value | Description |
|-----|--------|-------------|
| `chunk_size` | '4096' | Size of data chunks in bytes (default: 4096) |
| `schema_version` | '0.4' | Current schema version |

**Note**: `chunk_size` is immutable after creation. All chunks except the last chunk of a file must be exactly `chunk_size` bytes.

---

#### `fs_inode` - File and Directory Metadata

Stores file/directory metadata using a Unix-like inode design.

```sql
CREATE TABLE fs_inode (
  ino INTEGER PRIMARY KEY AUTOINCREMENT,
  mode INTEGER NOT NULL,
  nlink INTEGER NOT NULL DEFAULT 0,
  uid INTEGER NOT NULL DEFAULT 0,
  gid INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  atime INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  ctime INTEGER NOT NULL,
  rdev INTEGER NOT NULL DEFAULT 0,
  atime_nsec INTEGER NOT NULL DEFAULT 0,
  mtime_nsec INTEGER NOT NULL DEFAULT 0,
  ctime_nsec INTEGER NOT NULL DEFAULT 0
)
```

**Fields**:
- `ino` - Unique inode number (root is always ino=1)
- `mode` - Unix mode bits combining file type and permissions (see Mode Encoding below)
- `nlink` - Hard link count (0 for unlinked files being deleted, 2+ for directories)
- `uid` / `gid` - Owner user/group IDs
- `size` - File size in bytes (0 for directories)
- `atime` / `mtime` / `ctime` - Access/modification/change time (Unix epoch, seconds)
- `atime_nsec` / `mtime_nsec` / `ctime_nsec` - Nanosecond components of timestamps
- `rdev` - Device number for character/block devices (major/minor encoded)

**Mode Encoding** (32-bit):

```
File type (upper 4 bits):
  0o170000 - File type mask (S_IFMT)
  0o100000 - Regular file (S_IFREG)
  0o040000 - Directory (S_IFDIR)
  0o120000 - Symbolic link (S_IFLNK)
  0o010000 - FIFO/named pipe (S_IFIFO)
  0o020000 - Character device (S_IFCHR)
  0o060000 - Block device (S_IFBLK)
  0o140000 - Socket (S_IFSOCK)

Permissions (lower 12 bits):
  0o000777 - Permission bits (rwxrwxrwx)

Example modes:
  0o100644 - Regular file, rw-r--r--
  0o040755 - Directory, rwxr-xr-x
  0o120777 - Symlink, rwxrwxrwx
```

**Special Inodes**:
- Inode 1 is always the root directory

**Consistency Rules**:
- Root inode (ino=1) MUST always exist
- Directories MUST have mode with S_IFDIR bit set
- Regular files MUST have mode with S_IFREG bit set
- File size MUST match total size of all `fs_data` chunks

---

#### `fs_dentry` - Directory Entries

Maps filenames to inodes (the filesystem namespace).

```sql
CREATE TABLE fs_dentry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_ino INTEGER NOT NULL,
  ino INTEGER NOT NULL,
  UNIQUE(parent_ino, name)
)

CREATE INDEX idx_fs_dentry_parent ON fs_dentry(parent_ino, name)
```

**Fields**:
- `name` - Basename (filename or directory name)
- `parent_ino` - Parent directory inode number
- `ino` - Inode this entry points to

**Notes**:
- Multiple dentries MAY point to the same inode (hard links)
- Root directory (ino=1) has no dentry (no parent)
- Link count in `fs_inode.nlink` tracks hard links

**Path Resolution Algorithm**:
```sql
-- To resolve "/a/b/c":
1. Start at ino=1 (root)
2. SELECT ino FROM fs_dentry WHERE parent_ino=1 AND name='a'
3. SELECT ino FROM fs_dentry WHERE parent_ino=<result> AND name='b'
4. SELECT ino FROM fs_dentry WHERE parent_ino=<result> AND name='c'
```

---

#### `fs_data` - File Content Chunks

Stores file content in fixed-size chunks.

```sql
CREATE TABLE fs_data (
  ino INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (ino, chunk_index)
)
```

**Fields**:
- `ino` - Inode number
- `chunk_index` - Zero-based chunk index (chunk 0 = bytes 0 to chunk_size-1)
- `data` - Binary content (BLOB), exactly `chunk_size` bytes except last chunk

**Chunk Access**:
```sql
-- Read entire file
SELECT data FROM fs_data WHERE ino=? ORDER BY chunk_index ASC;

-- Read bytes 1000-5000 (with chunk_size=4096)
SELECT chunk_index, data FROM fs_data
WHERE ino=? AND chunk_index >= 0 AND chunk_index <= 1
ORDER BY chunk_index ASC;
-- Returns chunk 0 (bytes 0-4095) and chunk 1 (bytes 4096-8191)
-- Extract bytes 1000-4095 from chunk 0
-- Extract bytes 0-904 from chunk 1
```

**Byte Offset Calculation**:
- `chunk_index = byte_offset / chunk_size`
- `offset_in_chunk = byte_offset % chunk_size`
- `byte_offset = chunk_index * chunk_size + offset_in_chunk`

**Consistency Rules**:
- Directories MUST NOT have data chunks
- All chunks except the last chunk MUST be exactly `chunk_size` bytes
- Last chunk MAY be smaller than `chunk_size`

---

#### `fs_symlink` - Symbolic Link Targets

```sql
CREATE TABLE fs_symlink (
  ino PRIMARY KEY,
  target TEXT NOT NULL
)
```

**Fields**:
- `ino` - Inode number of the symlink (must have S_IFLNK mode)
- `target` - Target path (may be absolute or relative)

**Note**: Symlink resolution (following symlinks) is implementation-defined. The SDKs implement depth-limited following (max 40 levels).

---

### 2. Overlay Filesystem Tables (Optional)

The overlay filesystem provides copy-on-write semantics, layering a writable delta on top of a read-only base.

#### `fs_whiteout` - Deletion Markers

Tracks deleted paths to prevent base layer visibility.

```sql
CREATE TABLE fs_whiteout (
  path TEXT PRIMARY KEY,
  parent_path TEXT NOT NULL,
  created_at INTEGER NOT NULL
)

CREATE INDEX idx_fs_whiteout_parent ON fs_whiteout(parent_path)
```

**Fields**:
- `path` - Normalized absolute path that has been deleted
- `parent_path` - Parent directory path (for efficient child lookups)
- `created_at` - Deletion timestamp (Unix epoch, seconds)

**Purpose**: When deleting `/a.txt` that exists in base layer, insert whiteout. On lookup, if whiteout exists, return "not found" instead of falling through to base.

**Whiteout Creation**:
```sql
INSERT INTO fs_whiteout (path, parent_path, created_at)
VALUES (?, ?, ?)
ON CONFLICT(path) DO UPDATE SET created_at = excluded.created_at
```

---

#### `fs_origin` - Copy-Up Origin Tracking

Maintains inode consistency across layers for FUSE cache compatibility.

```sql
CREATE TABLE fs_origin (
  delta_ino INTEGER PRIMARY KEY,
  base_ino INTEGER NOT NULL
)
```

**Fields**:
- `delta_ino` - Inode number in delta layer
- `base_ino` - Original inode number from base layer

**Purpose**: When copying a file from base to delta (copy-up), preserve the original base inode number. This prevents ENOENT errors when FUSE kernel caches inodes.

---

#### `fs_overlay_config` - Overlay Configuration

```sql
CREATE TABLE fs_overlay_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)
```

**Required Keys**:
| Key | Value | Description |
|-----|--------|-------------|
| `base_path` | '/absolute/path' | Canonical path to base directory |

---

### 3. Key-Value Store Table

#### `kv_store` - Agent State Storage

```sql
CREATE TABLE kv_store (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
)

CREATE INDEX idx_kv_store_created_at ON kv_store(created_at)
```

**Fields**:
- `key` - Unique key identifier (any naming convention supported, e.g., `user:123`, `session:state`)
- `value` - JSON-serialized value
- `created_at` / `updated_at` - Timestamps (Unix epoch, seconds)

**Upsert Pattern**:
```sql
INSERT INTO kv_store (key, value, updated_at)
VALUES (?, ?, unixepoch())
ON CONFLICT(key) DO UPDATE SET
  value = excluded.value,
  updated_at = unixepoch()
```

**Use Cases**:
- Agent preferences and configuration
- Session state and context
- Conversation history (optional extension)
- Structured data that doesn't fit filesystem model

---

### 4. Tool Call Audit Trail Table

#### `tool_calls` - Tool Invocation Log

Insert-only audit log for debugging and compliance.

```sql
CREATE TABLE tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parameters TEXT,
  result TEXT,
  error TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  duration_ms INTEGER
)

CREATE INDEX idx_tool_calls_name ON tool_calls(name)
CREATE INDEX idx_tool_calls_started_at ON tool_calls(started_at)
```

**Fields**:
- `id` - Unique tool call identifier
- `name` - Tool name (e.g., 'read_file', 'web_search', 'execute_code')
- `parameters` - JSON-serialized input parameters (NULL if no parameters)
- `result` - JSON-serialized result (NULL if error)
- `error` - Error message (NULL if success)
- `status` - 'pending', 'success', or 'error'
- `started_at` - Invocation timestamp (Unix epoch, seconds)
- `completed_at` - Completion timestamp (NULL if pending)
- `duration_ms` - Execution duration in milliseconds (NULL if pending)

**Consistency Rules**:
1. Exactly one of `result` or `error` should be non-NULL (mutual exclusion)
2. `completed_at` MUST always be set (no NULL values on completion)
3. `duration_ms` MUST equal `(completed_at - started_at) * 1000`
4. Parameters and results MUST be valid JSON strings when present
5. Records MUST NOT be updated or deleted (insert-only)

**Performance Analysis Query**:
```sql
SELECT
  name,
  COUNT(*) as total_calls,
  SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) as successful,
  SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) as failed,
  AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms ELSE 0 END) as avg_duration_ms
FROM tool_calls
GROUP BY name
ORDER BY total_calls DESC
```

---

## SDK API Reference

### Rust SDK (`agentfs_sdk` crate)

**Installation**:
```toml
[dependencies]
agentfs-sdk = "latest"
```

**Opening an AgentFS Database**:

```rust
use agentfs_sdk::{AgentFS, AgentFSOptions};

// Persistent storage with identifier
let agent = AgentFS::open(AgentFSOptions::with_id("my-agent")).await?;
// Creates: .agentfs/my-agent.db

// Ephemeral in-memory database
let agent = AgentFS::open(AgentFSOptions::ephemeral()).await?;

// Custom database path
let agent = AgentFS::open(AgentFSOptions::with_path("./data/mydb.db")).await?;

// With overlay filesystem (copy-on-write)
let agent = AgentFS::open(
    AgentFSOptions::with_id("my-overlay")
        .with_base("/path/to/project")
).await?;
```

**Filesystem Operations**:

```rust
use agentfs_sdk::{DEFAULT_DIR_MODE, DEFAULT_FILE_MODE};

// Create directory
agent.fs.mkdir("/documents", 0, 0).await?;

// Write file (creates parent directories automatically)
agent.fs.write_file("/documents/readme.txt", b"Hello, world!").await?;

// Read file
let content = agent.fs.read_file("/documents/readme.txt").await?;

// Get file stats
let stats = agent.fs.stat("/documents/readme.txt").await?;
if let Some(s) = stats {
    println!("Size: {} bytes", s.size);
    println!("Is file: {}", s.is_file());
}

// List directory
let entries = agent.fs.readdir("/documents").await?;
if let Some(files) = entries {
    for file in files {
        println!("  {}", file);
    }
}

// Create file with specific mode
let (stats, file) = agent.fs.create_file(
    "/data/test.txt",
    DEFAULT_FILE_MODE,
    0,
    0,
).await?;
file.pwrite(0, b"Hello").await?;

// Delete file
agent.fs.unlink("/documents/readme.txt").await?;

// Remove directory (recursive)
agent.fs.rm("/documents", true, false).await?;

// Rename/move
agent.fs.rename("/old.txt", "/new.txt").await?;

// Copy file
agent.fs.copy_file("/source.txt", "/dest.txt").await?;

// Check existence
let _ = agent.fs.access("/path/to/file").await?;
```

**Key-Value Operations**:

```rust
use serde_json::json;

// Set a value
agent.kv.set("user:preferences", &json!({"theme": "dark"})).await?;

// Get a value
let prefs: Option<serde_json::Value> = agent.kv.get("user:preferences").await?;

// Delete a value
agent.kv.delete("user:preferences").await?;

// List all keys
let keys = agent.kv.keys().await?;
for key in keys {
    println!("{}", key);
}
```

**Tool Call Tracking**:

```rust
use serde_json::json;

// Start a tool call
let call_id = agent.tools.start("search", Some(json!({"query": "Rust"}))).await?;

// Mark as successful
agent.tools.success(call_id, Some(json!({"results": ["doc1", "doc2"]})).await?;

// Or mark as failed
agent.tools.error(call_id, "Connection timeout").await?;

// Record a completed call (spec-compliant)
agent.tools.record(
    "search",
    1234567890,
    1234567892,
    Some(json!({"query": "Rust"})),
    Some(json!({"results": ["doc1", "doc2"]})),
    None,
).await?;

// Get tool call
let call = agent.tools.get(call_id).await?;
if let Some(c) = call {
    println!("Tool: {}, Status: {}", c.name, c.status);
}

// Get recent tool calls
let recent = agent.tools.recent(Some(10)).await?;

// Get statistics for a tool
let stats = agent.tools.stats_for("search").await?;
if let Some(s) = stats {
    println!("Total: {}, Success: {}, Avg: {:.2}ms",
        s.total_calls, s.successful, s.avg_duration_ms);
}
```

**Low-Level Database Access**:

```rust
// Get a connection for custom queries
let conn = agent.get_connection().await?;

// Execute custom SQL
let mut rows = conn.query("SELECT * FROM fs_inode WHERE ino > ?", (10,)).await?;
while let Some(row) = rows.next().await? {
    // Process row...
}
```

---

### Python SDK (`agentfs-sdk` pip package)

**Installation**:
```bash
pip install agentfs-sdk
```

**Opening an AgentFS Database**:

```python
import asyncio
from agentfs_sdk import AgentFS, AgentFSOptions

async def main():
    # Persistent storage with identifier
    agent = await AgentFS.open(AgentFSOptions(id='my-agent'))
    # Creates: .agentfs/my-agent.db

    # Ephemeral in-memory database
    agent = await AgentFS.open()

    # Custom database path
    agent = await AgentFS.open(AgentFSOptions(path='./data/mydb.db'))

    # Context manager support
    async with await AgentFS.open(AgentFSOptions(id='my-agent')) as agent:
        await agent.kv.set('key', 'value')
        # Automatically closed on exit
```

**Filesystem Operations**:

```python
# Write a file (creates parent directories automatically)
await agent.fs.write_file('/data/config.json', '{"key": "value"}')

# Read a file
content = await agent.fs.read_file('/data/config.json')

# Read as bytes
data = await agent.fs.read_file('/data/image.png', encoding=None)

# List directory
entries = await agent.fs.readdir('/data')

# Get file stats
stats = await agent.fs.stat('/data/config.json')
print(f"Size: {stats.size} bytes")
print(f"Modified: {stats.mtime}")
print(f"Is file: {stats.is_file()}")

# Create directory
await agent.fs.mkdir('/new-folder')

# Delete a file
await agent.fs.unlink('/data/config.json')

# Remove directory (recursive)
await agent.fs.rm('/folder', recursive=True, force=False)

# Rename/move
await agent.fs.rename('/old.txt', '/new.txt')

# Copy file
await agent.fs.copy_file('/source.txt', '/dest.txt')

# Check existence
try:
    await agent.fs.access('/documents/readme.txt')
    print("File exists")
except Exception:
    print("File not found")
```

**Key-Value Operations**:

```python
# Set a value
await agent.kv.set('user:123', {'name': 'Alice', 'age': 30})

# Get a value
user = await agent.kv.get('user:123')

# Delete a value
await agent.kv.delete('user:123')

# List by prefix (custom implementation)
# Note: Python SDK doesn't have built-in prefix listing
# Use direct SQL access for prefix queries:
conn = agent.fs._db
cursor = await conn.execute("SELECT key FROM kv_store WHERE key LIKE ?", ('user:%',))
```

**Tool Call Tracking**:

```python
# Start a tool call
call_id = await agent.tools.start('search', {'query': 'Python'})

# Mark as successful
await agent.tools.success(call_id, {'results': ['result1', 'result2']})

# Or mark as failed
await agent.tools.error(call_id, 'Connection timeout')

# Record a completed call
await agent.tools.record(
    'search',
    started_at=1234567890,
    completed_at=1234567892,
    parameters={'query': 'Python'},
    result={'results': ['result1', 'result2']}
)

# Query tool calls
calls = await agent.tools.get_by_name('search', limit=10)
recent = await agent.tools.get_recent(since=1234567890)

# Get statistics
stats = await agent.tools.get_stats()
for stat in stats:
    print(f"{stat.name}: {stat.successful}/{stat.total_calls} successful")
```

---

### TypeScript SDK (`agentfs-sdk` npm package)

**Installation**:
```bash
npm install agentfs-sdk
```

**Opening an AgentFS Database**:

```typescript
import { AgentFS } from 'agentfs-sdk';

// Persistent storage with identifier
const agent = await AgentFS.open({ id: 'my-agent' });
// Creates: .agentfs/my-agent.db

// Or use ephemeral in-memory database
const ephemeralAgent = await AgentFS.open();
```

**Filesystem Operations**:

```typescript
// Write files (parent dirs created automatically)
await agent.fs.writeFile('/documents/readme.txt', 'Hello, world!');
await agent.fs.writeFile('/data/config.json', JSON.stringify({ key: 'value' }));

// Write binary data
const imageBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
await agent.fs.writeFile('/images/icon.png', imageBuffer);

// Read files
const content = await agent.fs.readFile('/documents/readme.txt', 'utf-8');
console.log(content); // "Hello, world!"

const binary = await agent.fs.readFile('/images/icon.png');
console.log(binary); // <Buffer 89 50 4e 47>

// Get file statistics
const stats = await agent.fs.stat('/documents/readme.txt');
console.log({
  inode: stats.ino,
  size: stats.size,
  mode: stats.mode.toString(8),  // "100644" for regular file
  isFile: stats.isFile(),        // true
  isDirectory: stats.isDirectory(), // false
  modified: new Date(stats.mtime * 1000)
});

// List directory contents
const files = await agent.fs.readdir('/documents');
console.log(files); // ['readme.txt']

// Create directories
await agent.fs.mkdir('/new-folder');

// Remove files and directories
await agent.fs.unlink('/documents/readme.txt');
await agent.fs.rmdir('/empty-folder');
await agent.fs.rm('/folder', { recursive: true, force: true });

// Rename/move files
await agent.fs.rename('/old-name.txt', '/new-name.txt');

// Copy files
await agent.fs.copyFile('/source.txt', '/destination.txt');

// Check file access (existence)
try {
  await agent.fs.access('/documents/readme.txt');
  console.log('File exists');
} catch (e) {
  console.log('File does not exist');
}
```

**Key-Value Operations**:

```typescript
// Key-value operations
await agent.kv.set('user:preferences', { theme: 'dark' });
const prefs = await agent.kv.get('user:preferences');

// Tool call tracking
await agent.tools.record(
  'web_search',
  Date.now() / 1000,
  Date.now() / 1000 + 1.5,
  { query: 'AI' },
  { results: [...] }
);
```

---

## Direct SQL Access

Since AgentFS is just a SQLite database, you can query it directly with any SQLite client:

```bash
# Using sqlite3 CLI
sqlite3 .agentfs/my-agent.db

# List all files with paths (recursive CTE)
WITH RECURSIVE file_tree(ino, path) AS (
  SELECT 1, '/'
  UNION ALL
  SELECT d.ino, path || d.name || '/'
  FROM fs_dentry d
  JOIN file_tree ft ON d.parent_ino = ft.ino
)
SELECT path, i.size, i.mode
FROM file_tree ft
JOIN fs_inode i ON ft.ino = i.ino
WHERE (i.mode & 0o170000) = 0o100000;  -- Regular files only
```

---

## Overlay Filesystem (Copy-on-Write)

The overlay filesystem combines a read-only base layer (host filesystem) with a writable delta layer (AgentFS).

**Lookup Semantics**:
1. Check if path exists in delta layer → return delta entry
2. Check if path has a whiteout → return "not found"
3. Check if path exists in base layer → return base entry
4. Return "not found"

**Whiteouts**:
- Created when deleting a file that exists only in base layer
- Mark paths as deleted so base layer doesn't show through
- Example: Delete `/README.md` (exists in base), insert whiteout for `/README.md`

**Copy-Up**:
- When first writing to a base file, it's copied to delta layer
- Origin tracking ensures inode numbers stay consistent (FUSE cache compatibility)
- Example: Read `/src/main.rs` (from base), write to it → copy to delta

**Usage**:
```rust
// Create overlay on top of project directory
let agent = AgentFS::open(
    AgentFSOptions::with_id("my-overlay")
        .with_base("/path/to/project")
).await?;

// All modifications go to delta (my-overlay.db)
// Reads fall through to base filesystem (/path/to/project)

// Get modified paths
let delta_paths = agent.get_delta_paths().await?;

// Get deleted paths (whiteouts)
let whiteouts = agent.get_whiteouts().await?;
```

### Delta-to-Base Commit: **NOT SUPPORTED**

**Important Limitation**: AgentFS does **NOT** provide any built-in functionality to write/commit delta changes back to the base filesystem.

**Design Rationale**:
- The base layer is intentionally **read-only** - this enables:
  - Safe sandboxing of untrusted code
  - Reproducible execution (base never changes)
  - Easy rollback (just discard delta database)
  - Multiple independent sandboxes sharing the same base

**What Does Work**:
- `agentfs diff <id_or_path>` - CLI command to **view** changes (shows Added/Modified/Deleted)
- `get_delta_paths()` - SDK method to list all modified/new files in delta
- `get_whiteouts()` - SDK method to list all deleted paths

**What Does NOT Work**:
- No API to apply/merge delta changes into base
- No `commit` or `sync-to-base` command
- No built-in functionality to write delta back to base

**Workarounds** (if you need to apply delta changes to base):

1. **Manual Copy** - Iterate through delta paths and copy to base:
```bash
# Example shell script to apply changes
agentfs diff my-overlay | while read change_type type_char path; do
  case $change_type in
    A|M) cp ".agentfs/my-overlay.db:$path" "/base/path/$path" ;;
    D) rm "/base/path/$path" ;;
  esac
done
```

2. **Use `agentfs exec`** with overlay disabled:
```bash
# Temporarily disable overlay, copy changes directly
agentfs exec my-agent cp -r /delta/* /base/
```

3. **Database Query** - Extract delta changes and apply via direct filesystem operations:
```sql
-- Get all added/modified files
SELECT d.name, d.parent_ino, i.mode, i.size
FROM fs_dentry d
JOIN fs_inode i ON d.ino = i.ino
WHERE i.ino > 1 AND (i.mode & 0o170000) = 0o100000;

-- Then iterate results and copy to base using your preferred method
```

**Why No Built-in Commit**:
The overlay filesystem follows Linux's `overlayfs` design, which treats the lower (base) layer as immutable. This is intentional for security and reproducibility:
- AI agents can safely experiment without modifying source code
- Multiple agents can run concurrently against the same project
- Easy to "factory reset" by deleting the delta database
- Base layer serves as a canonical, immutable reference

---

## Performance Characteristics

### Chunk-Based Storage

**Advantages**:
- Efficient random access (read only needed chunks)
- Sparse file support (missing chunks return zeros)
- Memory-friendly for large files

**Trade-offs**:
- Small file overhead (minimum one chunk)
- Chunk boundary alignment for partial writes

**Chunk Size Selection**:
- Default: 4096 bytes (typical filesystem block size)
- Larger chunks: Better sequential read performance, more wasted space for small files
- Smaller chunks: Better random access, more overhead for large files

### Caching

The Rust SDK includes an LRU cache for directory entry lookups:
- Cache size: 10,000 entries
- Maps `(parent_ino, name) → child_ino`
- Reduces repeated path resolution queries
- Especially beneficial for repeated directory listings

### Connection Pooling

All SDKs use connection pooling:
- Rust: `ConnectionPool` with configurable size
- Python: Turso connection reuse
- TypeScript: Database connection reuse

---

## Common Patterns

### 1. Agent State Snapshot

```rust
// Snapshot agent state
use std::fs;
fs::copy(".agentfs/my-agent.db", "snapshots/agent-backup.db")?;

// Later restore
fs::copy("snapshots/agent-backup.db", ".agentfs/my-agent.db")?;
```

### 2. Tool Call Analysis

```sql
-- Find slowest tool calls
SELECT name, AVG(duration_ms) as avg_ms
FROM tool_calls
WHERE status = 'success'
GROUP BY name
ORDER BY avg_ms DESC;

-- Find failed tool calls in last hour
SELECT name, error, COUNT(*) as failures
FROM tool_calls
WHERE status = 'error' AND started_at > ?
GROUP BY name, error
ORDER BY failures DESC;
```

### 3. File System Diff

```sql
-- Compare two agent states (with attached databases)
ATTACH DATABASE 'snapshots/before.db' AS before;

SELECT 'added' as change, after_d.name || '/' || after_i.name as path
FROM after.fs_dentry after_d
JOIN after.fs_inode after_i ON after_d.ino = after_i.ino
LEFT JOIN before.fs_dentry before_d ON before_d.name = after_d.name
WHERE before_d.name IS NULL

UNION ALL

SELECT 'removed' as change, before_d.name || '/' || before_i.name as path
FROM before.fs_dentry before_d
JOIN before.fs_inode before_i ON before_d.ino = before_i.ino
LEFT JOIN after.fs_dentry after_d ON after_d.name = before_d.name
WHERE after_d.name IS NULL;
```

---

## Extension Points

The AgentFS specification includes extension points for additional functionality:

### Key-Value Store Extensions
- Namespaced keys with hierarchy support
- Value versioning/history
- TTL (time-to-live) for automatic expiration
- Value size limits and quotas

### Filesystem Extensions
- Extended attributes table
- File ACLs and advanced permissions
- Quota tracking per user/group
- Version history and snapshots
- Content deduplication
- Compression metadata
- File checksums/hashes

### Tool Call Extensions
- Session/conversation grouping (`session_id` field)
- User attribution (`user_id` field)
- Cost tracking (`cost` field for API calls)
- Parent/child relationships for nested tool calls
- Token usage tracking
- Input/output size metrics

**Implementation Guidance**: Extensions SHOULD use separate tables to maintain referential integrity with the core schema.

---

## Summary

**AgentFS provides**:
- A complete POSIX-like filesystem implementation in SQLite
- Key-value store for agent state
- Tool call audit trail for debugging and compliance
- Overlay filesystem for copy-on-write sandboxing
- Full-featured SDKs for Rust, Python, and TypeScript
- Direct SQL access for custom queries

**Key Advantages**:
- Queryable history via SQL
- Simple snapshot/restore via file copy
- Portable single-file database
- Works without FUSE (use SDKs directly)
- Designed for AI agents (auditability, reproducibility)

**When to Use FUSE**:
- Running existing POSIX tools
- Interactive shell sessions
- Debugging filesystem behavior

**When to Use SDK**:
- Programmatic access (most cases)
- Better performance and control
- Multi-language support (Rust, Python, TypeScript)
- No filesystem mount requirements

---

## References

- [AgentFS Repository](https://github.com/tursodatabase/agentfs)
- [AgentFS Specification](.test-agent/agentfs/SPEC.md)
- [AgentFS Manual](.test-agent/agentfs/MANUAL.md)
- [Turso Database](https://github.com/tursodatabase/turso)
- [Announcement Blog Post](https://turso.tech/blog/agentfs)
