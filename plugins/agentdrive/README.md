# AgentDrive

AgentDrive saves your Claude Code sessions so you can pick one up in another coding agent (Codex, Cursor, OpenCode, Gemini CLI or Antigravity), or bring a session from one of those back into Claude Code. Hit a usage limit in one agent and keep going in another, with the transcript, decisions and files carried over.

## Commands

- `/agentdrive:login` signs you in. It runs the AgentDrive CLI (`npx -y @adrive/cli init --yes`), which opens your browser once.
- `/agentdrive:sessions` lists this project's recent sessions from every connected agent.
- `/agentdrive:resume` loads a session's handoff brief so Claude can continue it.

## What the plugin runs

- **Hooks** on `SessionStart`, `Stop`, `SessionEnd` and `PreCompact` run `adrive hook claude-code`: the AgentDrive CLI if it is on your `PATH`, otherwise the version pinned in `hooks/hooks.json` through `npx`.
- **An MCP server**, `@adrive/mcp-server` at the version pinned in `.mcp.json`, started with `npx`. It gives Claude the `drive_*` tools: list, resume, search, read, write and share sessions and files in your AgentDrive workspace.

Both packages are open source under Apache-2.0: [agentdrive-sh/agentdrive-mcp](https://github.com/agentdrive-sh/agentdrive-mcp) and [@adrive/cli](https://www.npmjs.com/package/@adrive/cli).

## What it sends, and where

Nothing leaves your machine until you sign in. Before that, the session-start hook only adds a short note offering to connect.

After you sign in, a notice shows what is on. On a new install capture is on, and then:

- **On each hook event**, a background `adrive sync` uploads the current session's transcript, and files your agents wrote that git does not track, to your AgentDrive workspace at `app.agentdrive.sh` (hosted on Cloudflare).
- **Secrets are redacted on your device** before anything is uploaded. Redaction is best-effort: list paths in a `.adriveignore` file to keep them out entirely, or turn on Private Workspace to encrypt everything end to end on your device, so the server stores only ciphertext.
- **At session start**, it fetches a short summary of this project's recent sessions and adds it to Claude's context, and connects installed agent tools it has not connected before by adding AgentDrive's hooks, MCP server, commands and skill to their config files.

Turn any of this off at any time with `adrive privacy` (capture of transcripts and files, session-start context, connecting new agent tools, and Private Workspace).

- Privacy policy: https://agentdrive.sh/legal/privacy
- Terms: https://agentdrive.sh/legal/terms
- Contact: privacy@agentdrive.sh
