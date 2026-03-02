# openclaw-qq

Native QQ channel plugin for [OpenClaw](https://github.com/nicepkg/openclaw), connecting via [OneBot v11](https://github.com/botuniverse/onebot-11) WebSocket protocol. Designed for use with [NapCat](https://github.com/NapNeko/NapCatQQ).

## Features

- **Native Channel Integration** — Registers as a first-class OpenClaw channel, appearing in `openclaw status` and supporting all built-in commands (`/help`, `/reset`, etc.)
- **DM & Group Chat** — Private messages and group messages (triggered by @bot mention)
- **Security Policies** — DM allowlist, group allowlist, configurable via `openclaw.json`
- **Agent Binding** — Route different QQ groups to different OpenClaw agents
- **Emoji Reactions** — Add/remove QQ emoji reactions on messages (Unicode + QQ native face types)
- **Face Segments** — Bidirectional `[表情XXX]` ↔ QQ face segment conversion in message text
- **Poll System** — `poll_create` / `poll_result` tools using emoji-reaction voting
  - Auto-scheduled settlement via [openclaw-agent-cron](https://github.com/nicepkg/openclaw) cross-plugin API
  - Graceful fallback when agent-cron is unavailable
- **Robust WebSocket** — Exponential backoff reconnection (1s → 30s max), ping/pong dead-connection detection, message queuing during disconnection

## Requirements

- [OpenClaw](https://github.com/nicepkg/openclaw) (2026.3.x or later)
- A running [NapCat](https://github.com/NapNeko/NapCatQQ) instance with OneBot v11 WebSocket enabled
- Node.js 20+

## Installation

Clone or copy the plugin into your OpenClaw plugins directory:

```bash
git clone https://github.com/Ricky-Hao/openclaw-qq.git /path/to/openclaw-qq
cd /path/to/openclaw-qq
npm install
npm run build
```

Register the plugin in `openclaw.json`:

```json
{
  "plugins": {
    "allow": ["openclaw-qq"],
    "load": {
      "paths": ["/path/to/openclaw-qq"]
    },
    "entries": {
      "openclaw-qq": {
        "enabled": true
      }
    }
  }
}
```

## Configuration

Add QQ channel config under `channels.qq` in `openclaw.json`:

```json
{
  "channels": {
    "qq": {
      "default": {
        "enabled": true,
        "wsUrl": "ws://localhost:3001",
        "token": "your-onebot-token",
        "botQQ": "123456789",
        "dmPolicy": "allowlist",
        "allowFrom": ["111222333"],
        "groupPolicy": "allowlist",
        "groupAllowFrom": ["444555666"]
      }
    }
  }
}
```

| Field | Description | Default |
|-------|-------------|---------|
| `wsUrl` | OneBot v11 WebSocket URL | `ws://localhost:3001` |
| `token` | WebSocket authentication token | (empty) |
| `botQQ` | Bot's QQ number | (required) |
| `dmPolicy` | DM policy: `"open"` or `"allowlist"` | `"allowlist"` |
| `allowFrom` | Allowed DM sender QQ numbers | `[]` |
| `groupPolicy` | Group policy: `"open"` or `"allowlist"` | `"allowlist"` |
| `groupAllowFrom` | Allowed group IDs | `[]` |

### Multi-Account

Multiple QQ accounts can be configured by adding named entries under `channels.qq`:

```json
{
  "channels": {
    "qq": {
      "default": { "botQQ": "111111111", "...": "..." },
      "alt": { "botQQ": "222222222", "...": "..." }
    }
  }
}
```

### Agent Binding

Route specific groups to specific agents via `bindings`:

```json
{
  "bindings": [
    {
      "agentId": "my-agent",
      "match": {
        "channel": "qq",
        "peer": { "kind": "group", "id": "444555666" }
      }
    }
  ]
}
```

> **Multi-account note:** If multiple QQ bots are in the same group, add `"accountId": "<account-key>"` to `match` to disambiguate. Otherwise both bots will match the same binding and the message will be processed twice.
>
> ```json
> {
>   "agentId": "agent-a",
>   "match": {
>     "channel": "qq",
>     "accountId": "default",
>     "peer": { "kind": "group", "id": "444555666" }
>   }
> }
> ```

## Poll System

The plugin provides two tools for emoji-reaction-based polls:

### `poll_create`

Creates a poll message with emoji options. Users vote by clicking emoji reactions.

```
poll_create(
  question = "What to play tonight?",
  options = ["Game A", "Game B", "Game C"],
  duration = "10m",
  target = "qq:group:444555666"
)
```

- Emoji are randomly selected from a verified QQ-compatible pool
- If `duration` is set, settlement is auto-scheduled via `openclaw-agent-cron`
- If agent-cron is unavailable, returns a `settleAction` hint for manual scheduling

### `poll_result`

Queries the current vote counts for a poll.

```
poll_result(message_id = "123456")
```

Returns formatted results with vote counts and percentages.

## Project Structure

```
src/
├── index.ts              # Plugin entry point
├── channel.ts            # OpenClaw ChannelPlugin implementation
├── config.ts             # Configuration parsing & account resolution
├── emoji.ts              # QQ emoji mapping (Unicode + native face types)
├── gateway.ts            # WebSocket event handling & message dispatch
├── poll.ts               # Poll tools (poll_create / poll_result)
└── onebot/
    ├── client.ts         # OneBot v11 WebSocket client with reconnection
    ├── message.ts        # Message segment parsing & building
    └── types.ts          # OneBot v11 type definitions

tests/
├── channel.test.ts       # Channel adapter tests
├── config.test.ts        # Config parsing tests
├── emoji.test.ts         # Emoji lookup tests
├── message.test.ts       # Message segment tests
├── poll.test.ts          # Poll utility function tests
└── poll-create.test.ts   # Poll creation & settlement tests
```

## Development

```bash
npm install
npm run build       # TypeScript compilation
npm test            # Run all tests (vitest, 136 tests)
```

## License

MIT
