import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { driveResumeLocal, driveSessionsLocal, findLocalSession, listLocalSessions, localHandoff, type LocalToolContext } from '../src/local.js';
import { projectKeyFor } from '../src/project.js';
import { createOpencodeSource } from '../src/transcripts/opencode.js';

const CWD = '/work/app';
const OTHER = '/work/other';
const CODEX_ID = '019e13ac-3554-7e62-87b1-478188dfcced';
const SECRET = `sk-ant-${'a'.repeat(40)}`;

let root: string;
let home: string;
let configDir: string;

const jsonl = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join('\n');
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

// One fixture transcript per harness, written oldest first so each harness gets a distinct mtime.
async function put(path: string, content: string, ageMinutes: number): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true });
  await fs.writeFile(path, content);
  const at = new Date(Date.now() - ageMinutes * 60_000);
  await fs.utimes(path, at, at);
}

const opencode = createOpencodeSource(async (args) => {
  if (args[0] === 'session') return JSON.stringify([{ id: 'ses_1', title: 'OpenCode work', directory: CWD, updated: Date.now() - 60 * 60_000 }]);
  return JSON.stringify({
    info: { id: 'ses_1', directory: CWD, title: 'OpenCode work' },
    messages: [{ info: { role: 'user', time: { created: Date.now() - 60 * 60_000 } }, parts: [{ type: 'text', text: 'tidy the config' }] }],
  });
});

function ctx(extra: Partial<LocalToolContext> = {}): LocalToolContext {
  return { cwd: CWD, home, env: {}, configDir, sources: { opencode }, ...extra };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'adrive-local-test-'));
  home = join(root, 'home');
  configDir = join(root, 'config');
  await fs.mkdir(join(home, '.local/share/opencode'), { recursive: true });

  await put(
    join(home, '.claude/projects/-work-app/c1.jsonl'),
    jsonl([
      { type: 'user', cwd: CWD, timestamp: ago(11), message: { role: 'user', content: `Fix the login bug, key ${SECRET}` } },
      { type: 'assistant', cwd: CWD, timestamp: ago(10), message: { role: 'assistant', content: [{ type: 'text', text: 'Patched it.' }, { type: 'tool_use', name: 'Write', input: { file_path: '/work/app/src/auth.ts', content: 'BODY' } }] } },
    ]),
    10,
  );
  await put(
    join(home, '.claude/projects/-work-other/c2.jsonl'),
    jsonl([{ type: 'user', cwd: OTHER, timestamp: ago(1), message: { role: 'user', content: 'unrelated project' } }]),
    1,
  );
  await put(
    join(home, `.codex/sessions/2026/11/01/rollout-2026-11-01T00-00-00-${CODEX_ID}.jsonl`),
    jsonl([
      { timestamp: ago(21), type: 'session_meta', payload: { id: CODEX_ID, cwd: CWD } },
      { timestamp: ago(21), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'add retries to the client' }] } },
      { timestamp: ago(20), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Added retries.' }] } },
    ]),
    20,
  );
  const hash = createHash('sha256').update(CWD).digest('hex');
  await put(
    join(home, `.gemini/tmp/${hash}/chats/session-g1.jsonl`),
    jsonl([{ $set: { sessionId: 'g1' } }, { id: 'm1', timestamp: ago(30), type: 'user', content: [{ text: 'write a README' }] }]),
    30,
  );
  await put(
    join(home, '.cursor/projects/work-app/agent-transcripts/cur1.jsonl'),
    jsonl([{ role: 'user', message: { content: [{ type: 'text', text: '<user_query>rename the util</user_query>' }] } }]),
    40,
  );
  await put(
    join(home, '.cursor/projects/work-other/agent-transcripts/cur2.jsonl'),
    jsonl([{ role: 'user', message: { content: [{ type: 'text', text: '<user_query>other project</user_query>' }] } }]),
    2,
  );
  // Antigravity transcripts carry no cwd and its store has no per-project dir, so only a hook can place it.
  await put(
    join(home, '.gemini/antigravity-cli/brain/ag1/.system_generated/logs/transcript.jsonl'),
    jsonl([{ type: 'USER_INPUT', created_at: ago(50), content: '<USER_REQUEST>add a health check</USER_REQUEST>' }]),
    50,
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('listLocalSessions', () => {
  it('finds this project\'s sessions in every store that records or encodes the cwd, newest first, with no hook-recorded cwds', async () => {
    const { project, sessions } = await listLocalSessions(ctx());
    expect(project).toBe(projectKeyFor(CWD));
    expect(sessions.map((s) => s.id)).toEqual(['claude-code:c1', `codex:${CODEX_ID}`, 'gemini-cli:g1', 'opencode:ses_1']);
    expect(sessions.find((s) => s.id === 'gemini-cli:g1')!.cwd).toBe(CWD);
    expect(sessions[0]!.title).not.toContain(SECRET);
  });

  it('places a Cursor session only through a hook-recorded cwd, never by its lossy project dir name', async () => {
    expect((await listLocalSessions({ ...ctx(), harness: 'cursor' })).sessions).toEqual([]);
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(join(configDir, 'session-cwd.json'), JSON.stringify({ 'cursor:cur1': CWD, 'cursor:cur2': OTHER }));
    expect((await listLocalSessions({ ...ctx(), harness: 'cursor' })).sessions.map((s) => s.id)).toEqual(['cursor:cur1']);
    expect((await listLocalSessions({ ...ctx({ cwd: OTHER }), harness: 'cursor' })).sessions.map((s) => s.id)).toEqual(['cursor:cur2']);
    expect((await listLocalSessions({ ...ctx({ cwd: '/work_app' }), harness: 'cursor' })).sessions).toEqual([]);
  });

  it('places an Antigravity session once a hook has recorded its cwd', async () => {
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(join(configDir, 'session-cwd.json'), JSON.stringify({ 'antigravity:ag1': CWD }));
    const { sessions } = await listLocalSessions({ ...ctx(), harness: 'antigravity' });
    expect(sessions.map((s) => s.id)).toEqual(['antigravity:ag1']);
  });

  it('lets an explicit harness override the exclusion', async () => {
    const { sessions } = await listLocalSessions({ ...ctx({ exclude: 'claude-code' }), harness: 'claude-code' });
    expect(sessions.map((s) => s.id)).toEqual(['claude-code:c1']);
  });

  it('leaves out the harness the caller runs in', async () => {
    const { sessions } = await listLocalSessions(ctx({ exclude: 'claude-code' }));
    expect(sessions.map((s) => s.harness)).not.toContain('claude-code');
    expect(sessions[0]!.id).toBe(`codex:${CODEX_ID}`);
  });

  it('filters by harness and respects the limit', async () => {
    expect((await listLocalSessions({ ...ctx(), harness: 'gemini-cli' })).sessions.map((s) => s.id)).toEqual(['gemini-cli:g1']);
    expect((await listLocalSessions({ ...ctx(), limit: 2 })).sessions).toHaveLength(2);
  });

  it('matches another project key when one is given', async () => {
    const { sessions } = await listLocalSessions({ ...ctx(), project: projectKeyFor(OTHER) });
    expect(sessions.map((s) => s.id)).toEqual(['claude-code:c2']);
  });
});

describe('findLocalSession and localHandoff', () => {
  it('finds a session by run id and renders a redacted handoff', async () => {
    const session = await findLocalSession('claude-code:c1', ctx());
    const handoff = localHandoff(session!);
    expect(handoff).toContain('Handoff from a claude-code session (c1).');
    expect(handoff).toContain('Fix the login bug');
    expect(handoff).toContain('[redacted:anthropic-key]');
    expect(handoff).not.toContain(SECRET);
    expect(handoff).toMatch(/## Files touched\n\n- src\/auth\.ts/);
  });

  it('returns null for an unknown id or harness', async () => {
    expect(await findLocalSession('claude-code:nope', ctx())).toBeNull();
    expect(await findLocalSession('langgraph:x', ctx())).toBeNull();
  });
});

describe('local drive_sessions and drive_resume', () => {
  it('lists local sessions without an account', async () => {
    const res = await driveSessionsLocal(ctx({ exclude: 'claude-code' }), {});
    const text = res.content[0]!.text;
    expect(text).toContain(`Local sessions for ${projectKeyFor(CWD)}`);
    expect(text).toContain(`codex · add retries to the client · id=codex:${CODEX_ID}`);
    expect(text).not.toContain('claude-code:c1');
  });

  it('resumes the newest session from another harness', async () => {
    const res = await driveResumeLocal(ctx({ exclude: 'claude-code' }), {});
    const text = res.content[0]!.text;
    expect(text).toMatch(/^From local transcripts on this machine/);
    expect(text).toContain(`Handoff from a codex session (${CODEX_ID}).`);
    expect(text).toContain('Added retries.');
  });

  it('resumes a named session and reports a missing one', async () => {
    expect((await driveResumeLocal(ctx(), { session_id: 'cursor:cur1' })).content[0]!.text).toContain('rename the util');
    expect((await driveResumeLocal(ctx(), { session_id: 'codex:missing' })).content[0]!.text).toBe('No local session codex:missing on this machine.');
  });

  it('reports a project with no local sessions', async () => {
    const res = await driveSessionsLocal(ctx({ cwd: '/work/empty' }), {});
    expect(res.content[0]!.text).toBe(`No local sessions from other agents for project ${projectKeyFor('/work/empty')} on this machine.`);
  });
});
