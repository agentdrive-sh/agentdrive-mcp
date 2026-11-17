import { describe, it, expect } from 'vitest';
import { ApiClient } from '../src/api-client.js';
import { driveOrg } from '../src/tools/drive-org.js';

function clientWithQuota(quota: Record<string, number | null>): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.test',
    apiKey: 'k',
    fetchImpl: async () => new Response(JSON.stringify({
      success: true,
      data: {
        id: 'org_1', name: 'Acme', plan: 'trial', agents: [], members: [],
        usage: { storage_bytes: 2048, agent_count: 1, workspace_count: 2, member_count: 0 },
        quota,
      },
    })),
  });
}

const text = async (quota: Record<string, number | null>) => (await driveOrg(clientWithQuota(quota), {})).content[0]!.text;

describe('drive_org', () => {
  it('shows plan limits', async () => {
    const out = await text({ storage_bytes: 1024 ** 3, max_agents: 3, max_workspaces: 1, max_human_seats: 1 });
    expect(out).toContain('Agents (0/3):');
    expect(out).toContain('Storage: 2.0 KB / 1.0 GB');
    expect(out).toContain('Workspaces: 2 / 1');
  });

  it('shows null quotas from a self-hosted instance as unlimited', async () => {
    const out = await text({ storage_bytes: null, max_agents: null, max_workspaces: null, max_human_seats: null });
    expect(out).toContain('Agents (0/unlimited):');
    expect(out).toContain('Members (0/unlimited):');
    expect(out).toContain('Storage: 2.0 KB / unlimited');
    expect(out).toContain('Workspaces: 2 / unlimited');
    expect(out).not.toMatch(/null|NaN/);
  });
});
