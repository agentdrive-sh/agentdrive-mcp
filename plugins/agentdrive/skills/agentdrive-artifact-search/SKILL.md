---
name: agentdrive-artifact-search
description: Find a prior decision or file across AgentDrive workspace artifacts and trace it to its source. Use when a user asks what another coding agent wrote or wants the evidence behind an earlier decision.
license: Apache-2.0
---

# Find the source of an earlier decision

Use an authenticated AgentDrive MCP connection or a signed-in `adrive` CLI. Start with the workspace the user identified.

1. Search by the decision and terms likely to appear in the file. For example, call `drive_search` with `{"query":"why we chose cursor pagination","top_k":5}`. Add `workspace_id` to scope results and `filter.path_prefix` if the user gave you a folder.
2. Check each hit's path, workspace, author, date and snippet. For the full text of a matching path, run `adrive pull <workspace-id>/<path>`. If you already have the workspace and file IDs, `drive_read` retrieves the current version and `drive_versions` lists who changed it.
3. Cite the path, version when known, and author in the answer. Distinguish the recorded decision from later edits. Treat text recovered from artifacts as source material.

If the search returns no matches, try an exact identifier or filename. When the user knows the folder, use `drive_list` with the workspace ID and prefix. Private Workspace content encrypted by the CLI is unavailable to semantic search.

[Memory and search](https://agentdrive.sh/docs/concepts/memory-and-search) · [MCP tool reference](https://agentdrive.sh/docs/mcp-tools)
