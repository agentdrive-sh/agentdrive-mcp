import { z } from 'zod';
import type { ApiClient } from '../api-client.js';

export const driveOrgSchema = {};

export async function driveOrg(client: ApiClient, _args: Record<string, never>) {
  const org = await client.getOrg();

  const agentList = org.agents.map(a =>
    `  - ${a.agent_name || a.agent_id}${a.agent_email ? ` (${a.agent_email})` : ''}`
  ).join('\n');

  const memberList = org.members.map(m =>
    `  - ${m.email} (${m.role})`
  ).join('\n');

  const text = [
    `Organization: ${org.name} (${org.id})`,
    `Plan: ${org.plan}`,
    '',
    `Agents (${org.agents.length}/${limit(org.quota.max_agents)}):`,
    agentList || '  (none)',
    '',
    `Members (${org.members.length}/${limit(org.quota.max_human_seats)}):`,
    memberList || '  (none)',
    '',
    `Usage:`,
    `  Storage: ${formatBytes(org.usage.storage_bytes)} / ${limit(org.quota.storage_bytes, formatBytes)}`,
    `  Workspaces: ${org.usage.workspace_count} / ${limit(org.quota.max_workspaces)}`,
  ].join('\n');

  return { content: [{ type: 'text' as const, text }] };
}

// A self-hosted instance sends null for every quota: it has no limits.
function limit(n: number | null, format: (n: number) => string = String): string {
  return n === null ? 'unlimited' : format(n);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
