---
description: Log in to AgentDrive and connect your other agents
---

Log the user in to AgentDrive and connect their other agent tools.

1. Run `npx -y @adrive/cli init --yes` in the shell, in the background so you can read its output while it waits. It prints a sign-in URL and a code and opens the browser. Show the user both right away: they type the code on that page to finish signing in. Init then connects every installed agent tool: Codex, OpenCode, Cursor, Antigravity and MCP clients.
2. When it exits, relay init's summary to the user, including any manual step it lists.
