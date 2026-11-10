# @adrive/mcp-server

MCP server for **AgentDrive** — the cross-agent artifact workspace with provenance and portable storage across Claude Code, Codex, Cursor, and LangGraph. Files, semantic recall, run logging, and cross-platform attribution.

Drop this server into any MCP-compatible client and your agents get a shared filesystem with provenance, semantic search across artifacts written by other agents, and per-run audit. Memory is a feature of the workspace, not the headline.

## Install

```sh
pnpm dlx @adrive/mcp-server
# or
npx @adrive/mcp-server
```

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `AGENTDRIVE_API_KEY` | no | key saved by `adrive auth login` | Falls back to `~/.config/agentdrive/config.json`, so client configs never need the key inline. With no key at all the server still starts and offers one tool, `drive_connect`, which signs the user in through the browser and connects their other agent tools; the full toolset then appears in the same session. |
| `AGENTDRIVE_API_URL` | no | `https://app.agentdrive.sh` | Override for self-host or staging. |
| `AGENTDRIVE_AGENT_PLATFORM` | no | `unknown` | Identifies which host is calling. Valid: `claude-code | codex | opencode | gemini-cli | cursor | antigravity | langgraph | crewai | autogen | hermes | openclaw | unknown`. Unknown values downgrade to `unknown` server-side. |
| `AGENTDRIVE_AGENT_ROLE` | no | (empty) | Free-form role label (`planner`, `reviewer`, etc.). Stamped on every request for provenance. |

The server derives the current project from its working directory (git remote, else repo path), which scopes `drive_sessions` and `drive_resume`.

## Client configuration

`curl -fsSL https://app.agentdrive.sh/install | sh` runs `adrive init`, which wires every detected harness. For Claude Code, install the plugin instead: `/plugin marketplace add agentdrive-sh/agentdrive-mcp` then `/plugin install agentdrive@agentdrive`.

Manual entries, for reference:

### Codex CLI (`~/.codex/config.toml`)

```toml
[mcp_servers.agentdrive]
command = "npx"
args = ["-y", "@adrive/mcp-server"]

[mcp_servers.agentdrive.env]
AGENTDRIVE_AGENT_PLATFORM = "codex"
```

### Cursor (`~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "agentdrive": {
      "command": "npx",
      "args": ["-y", "@adrive/mcp-server"],
      "env": { "AGENTDRIVE_AGENT_PLATFORM": "cursor" }
    }
  }
}
```

## Tools (22)

**Files**
- `drive_write` — create or update a file with versioning
- `drive_read` — read a file's content
- `drive_list` — list files (paginated automatically)
- `drive_delete` — delete a file

**Collaboration**
- `drive_share` — create a share link (optionally email-gated)
- `drive_comment` — leave a comment on a file
- `drive_feedback` — read comments on a file

**Provenance**
- `drive_activity` — workspace event feed
- `drive_versions` — file version history

**Sessions**
- `drive_sessions` — recent sessions in this project from every harness
- `drive_resume` — load a prior session's handoff (defaults to the latest from another harness)

**Search and memory**
- `drive_search` — semantic search across artifacts
- `drive_recall` — recall facts and preferences (narrows to extracted facts in a future release)
- `drive_context` — auto-pull relevant artifacts for the task you are about to do
- `drive_log_run` — record an agent run for cross-platform audit

**Org**
- `drive_invite` — invite a human teammate
- `drive_roles` — assign / list / remove per-workspace roles
- `drive_org` — view org details, agents, members, usage

## License

Apache-2.0. See [LICENSE](https://github.com/agentdrive-sh/agentdrive-mcp/blob/main/LICENSE).
