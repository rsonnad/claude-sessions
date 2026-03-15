# Claude Sessions

Auto-saves every Claude Code session transcript to Cloudflare D1 (serverless SQLite) and serves a search/display UI directly from the Worker.

**One repo, one deployment, all projects.** No code duplication — every project that uses this shares the same Worker and UI.

## Quick Start

### 1. Create the D1 database

```bash
npx wrangler d1 create claude-sessions
```

Copy the `database_id` from the output into `wrangler.jsonc`.

### 2. Run the schema

```bash
npx wrangler d1 execute claude-sessions --file=schema.sql --remote
```

### 3. Set your auth token

Edit `src/index.js` and change `AUTH_TOKEN` to a secret of your choice.

### 4. Deploy the Worker

```bash
npx wrangler deploy
```

The Worker URL (e.g., `https://claude-sessions.YOUR-SUBDOMAIN.workers.dev`) serves:
- **`GET /`** — the session browser UI
- **API endpoints** — for storing and retrieving sessions

### 5. Install the hook

```bash
cp hooks/save-session.sh ~/.claude/hooks/save-session.sh
chmod +x ~/.claude/hooks/save-session.sh
```

Edit `~/.claude/hooks/save-session.sh` and set:
- `API_URL` to your Worker URL + `/sessions`
- `API_TOKEN` to the token you chose in step 3

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$HOME/.claude/hooks/save-session.sh",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

**IMPORTANT:** Use the `Stop` event, **not** `SessionEnd`. The `SessionEnd` event does not fire for worktree/subagent sessions. The hook includes a 5-minute rate limit per session to avoid duplicate saves.

### 6. Verify

Start a new Claude Code session, send a message, then visit your Worker URL in a browser.

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Session browser UI (no auth required) |
| `POST` | `/sessions` | Save a session (INSERT OR REPLACE — idempotent) |
| `GET` | `/sessions` | List sessions (`?limit=`, `?offset=`, `?search=`, `?from=`, `?to=`, `?project=`) |
| `GET` | `/sessions/:id` | Get full session with transcript |
| `GET` | `/stats` | Aggregate stats (total sessions, tokens, hours) |
| `POST` | `/fix-timestamps` | Repair `ended_at` for bulk-imported sessions |

All API endpoints (except `GET /`) require `Authorization: Bearer YOUR_TOKEN` header.

## Architecture

```
Claude Code Session (JSONL on disk)
    ↓ Stop hook fires
save-session.sh reads ~/.claude/projects/*/SESSION_ID.jsonl
    ↓ extracts messages, timestamps, model, tokens
POST to Cloudflare Worker
    ↓ Bearer token auth
INSERT OR REPLACE into D1 SQLite
    ↓
GET / serves the browser UI
```

## Cost

Cloudflare D1 free tier: 5M reads/day, 100K writes/day, 5GB storage.

## For Multiple Projects

This is designed to be shared across all your projects:
- The hook is installed globally at `~/.claude/hooks/` — it captures sessions from every project
- The Worker stores all sessions with a `project` field — filter by project in the UI
- Update the Worker once → changes apply everywhere
- Other users can fork this repo and deploy their own instance
