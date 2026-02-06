# opencode-call-response

> Tool to send cross-session opencode messages, including as request-response pattern

# Tools

| tool           | description                                     | params=[default]                                                                                                |
| -------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `list-session` | list all sessions                               | `dir=[pwd]` constraint, `active=[null]`                                                                         |
| `send-message` | create or update a message                      | `session=[new]`, `elaborate=[false]`, `fork=[false]`, `iterate=false`, `id=[uuid]`, `draft=[false]`, `reply=[]` |
| `buffer`       | list or accept buffered messages for this agent | `accept=[false]`, `replies=[null]`, session=[this]`                                                             |

## Messages

- `id` a unique id, auto generated as id if not provided
- `created_at` (nanoseconds), time of submission
- `updated_at` (nanoseconds), time last updated
- `from` source session id
- `to` destination session id
- `in-reply-to` a parent message id, used for responses and other threads.
- `draft`, boolean indicating message is not ready to be sent
- `buffered`, boolean indicating message is buffered and must be accepted first
- `accepted_at`, time when message is accepted
- `accepted_by`, the session that actually accepted the message, typically null (unless not the `to`)
- `initial`, the user's initial message
- `message`, message in it's ready form

### Session

- `new` create a new session
- `fork` forks the current session
- `[id]`, send message to a session identified by this id. can be a substring of the session but must match only one session id. will be expanded.

#### Fork

Call can accept a `fork` parameter (must not have a session set or a `session=fork` parameter). A fork of the session is created, and the message is sent to that agent. Fork can be: true (for most recent message id), a number (number of messages back to fork from).

### Buffering

Messages sent (without a reply field) to an existing session (not `new` or `fork` sessions) are not automatically received by the other agent, to allow the user to control the timing of messages. The `buffered` tool can list messages (if no accept parameter set), or be used to accept messages. `accept=true` or `oldest` will take the oldest message off the queue. `newest` will take the most recent. a number will select the message by id, and if that fails to match, by that accept as an ordinal number. Lists of messages are sent with an instruction to treat this as a list to be shown to the user, and to not process the messages now.

## Draft

A message can be built as a draft. This allows messages to be iterated on and improved over time, before being sent (by changing the state to buffered or ready).

## Storage

By default, a `~/.local/share/opencode/storage/call-response` directory will be used to store a [Turso AgentFS](https://github.com/tursodatabase/agentfs) sqlite-compatible database for each agent that is sent messages. These will be created on the fly as necessary.

Messages are stored as JSON files in agentfs, by their id.

# Tool Calling Tracing

`opencode-call-response` also includes a plugin that can be used to write agentfs tool call logs!

# Configuration

configuration is a toml file or json.

- storage directory. default `~/.local/share/opencode/storage/call-response`.
- tools enable, array of tools. default true (all tools).
- tracing enable. default true.
- parameter defaults ought be broadly configurable.
- turso cdc disable (enabled by default)

# Future Work

- configuration to constrain parameters shown/available, allowing additional lockdown. examples: restrict to only current directory sessions, restrict to only active sessions.
- `elaborate` to allow for an initial prompt from an agent to receive additional processing. probably via a fork? before being marked ready.
- explore other addressing modes for `fork`
- a raw file mode, without agentfs.
