import { describe, it, expect } from 'vitest';
import { ApiClient } from '../src/api-client.js';
import { TOOLS } from '../src/registry.js';

const URL_PRO = 'https://agentdrive.sh/billing/upgrade?plan=pro';
const PAUSED = `AgentDrive is paused: your Free plan's storage is full (1 of 1 GB). New files and sessions won't sync until you upgrade: ${URL_PRO}. Everything you've stored stays readable.`;

function clientReturning(...bodies: Array<{ status?: number; body: unknown }>): ApiClient {
  let i = 0;
  return new ApiClient({
    baseUrl: 'https://api.test',
    apiKey: 'k',
    fetchImpl: async () => {
      const r = bodies[Math.min(i++, bodies.length - 1)]!;
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    },
  });
}

function tool(name: string) {
  return TOOLS.find((t) => t.name === name)!;
}

const written = { success: true, data: { id: 'f_1', path: 'a.md', version: 1 } };
const warn = (level: string, pct: number) => ({
  level,
  message: `AgentDrive: your Free plan has used ${pct}% of its storage (0.${pct} of 1 GB). Upgrade to Pro: ${URL_PRO}`,
  upgrade_url: URL_PRO,
});
const text = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join('\n');
const writeArgs = { workspace_id: 'ws_1', path: 'a.md', content: 'x' };

describe('plan_limit relay', () => {
  it('hands the paused message and upgrade link to the agent verbatim', async () => {
    const client = clientReturning({
      status: 402,
      body: { success: false, error: PAUSED, code: 'plan_limit', metric: 'storage_bytes', upgrade_url: URL_PRO },
    });
    const result = await tool('drive_write').handler(client, writeArgs);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(PAUSED);
    expect(text(result)).toMatch(/tell the user/i);
  });

  it('adds the upgrade link when the message lacks it', async () => {
    const client = clientReturning({
      status: 402,
      body: { success: false, error: 'Workspace limit reached.', code: 'plan_limit', upgrade_url: URL_PRO },
    });
    const result = await tool('drive_log_run').handler(client, { task: 't' });
    expect(text(result)).toContain('Workspace limit reached.');
    expect(text(result)).toContain(URL_PRO);
  });

  it('leaves other errors alone', async () => {
    const client = clientReturning({ status: 404, body: { success: false, error: 'File not found' } });
    await expect(tool('drive_write').handler(client, writeArgs)).rejects.toThrow('File not found');
  });
});

describe('usage warnings on write tools', () => {
  it('shows each level once per process', async () => {
    const client = clientReturning(
      { body: { ...written, usage_warning: warn('warn80', 85) } },
      { body: { ...written, usage_warning: warn('warn80', 86) } },
      { body: { ...written, usage_warning: warn('warn90', 91) } },
      { body: { ...written, usage_warning: warn('warn90', 92) } },
    );
    const outputs = [];
    for (let i = 0; i < 4; i++) outputs.push(text(await tool('drive_write').handler(client, writeArgs)));
    expect(outputs[0]).toContain('used 85% of its storage');
    expect(outputs[1]).not.toContain('AgentDrive: your');
    expect(outputs[2]).toContain('used 91% of its storage');
    expect(outputs[3]).not.toContain('AgentDrive: your');
  });

  it('stays quiet without a warning', async () => {
    const client = clientReturning({ body: written });
    expect(text(await tool('drive_write').handler(client, writeArgs))).toBe('File written: a.md (v1, id: f_1)');
  });
});

describe('drive_context', () => {
  it('always carries the one-line warning, even when a write already showed it', async () => {
    const ctx = { success: true, data: { artifacts: [], retrieved_at: 0 }, usage_warning: warn('warn80', 85) };
    const client = clientReturning({ body: { ...written, usage_warning: warn('warn80', 85) } }, { body: ctx }, { body: ctx });
    await tool('drive_write').handler(client, writeArgs);
    const first = text(await tool('drive_context').handler(client, { task: 'x' }));
    expect(first).toContain('used 85% of its storage');
    expect(first.match(/AgentDrive: your/g)).toHaveLength(1);
    expect(text(await tool('drive_context').handler(client, { task: 'x' }))).toContain('used 85% of its storage');
  });
});
