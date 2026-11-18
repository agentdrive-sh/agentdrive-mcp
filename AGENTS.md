# AGENTS.md

Instructions for AI coding agents (Codex, Claude Code, Cursor, OpenCode, Antigravity and others) working in this repository.

## What this is

The AgentDrive MCP server (`@adrive/mcp-server`, a stdio MCP server) and the AgentDrive plugin marketplace. AgentDrive is a shared workspace that lets coding agents resume each other's sessions; docs are at https://agentdrive.sh/docs and the full source, including the server in `packages/mcp-server`, is in https://github.com/agentdrive-sh/agentdrive.

## Layout

- `src/index.ts`: the server entry; `src/registry.ts` registers the tools in `src/tools/`.
- `src/transcripts/`, `src/session.ts`, `src/project.ts`: reading and resuming agent sessions. `src/redactor.ts` strips secrets before upload. `src/local.ts` is the account-free local mode.
- `test/`: Vitest tests, one file per module.
- `plugins/agentdrive/`: the plugin (skill, commands, hooks, MCP config). `.claude-plugin/plugin.json` is the Claude Code manifest and `plugin.json` plus `mcp.json` are the portable Agent Plugins manifest.
- `.claude-plugin/marketplace.json`: the marketplace that lists the plugin. `server.json`: the MCP registry entry.

## Commands

```sh
npm install
npm run typecheck
npm test
npm run build
```

## Rules

- TypeScript only. No emojis in code, comments or commit messages; comments explain why, not what.
- Keep the plugin's `@adrive/mcp-server@<version>` and `@adrive/cli@<version>` pins (in `.mcp.json`, `mcp.json` and `hooks/hooks.json`) on the versions this release ships, and keep `plugin.json` and `.claude-plugin/plugin.json` on the same plugin version.
- Never commit API keys or tokens.
- Add or update a test in `test/` for every behavior you change.
- Licensed Apache-2.0.
