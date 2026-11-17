import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { zstdCompressSync } from 'node:zlib';
import { claudeSource } from '../src/transcripts/claude.js';
import { codexSource } from '../src/transcripts/codex.js';
import { createOpencodeSource } from '../src/transcripts/opencode.js';
import { geminiSource } from '../src/transcripts/gemini.js';
import { cursorSource } from '../src/transcripts/cursor.js';
import { antigravitySource } from '../src/transcripts/antigravity.js';
import { recordSessionCwd } from '../src/transcripts/session-cwd.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'adrive-transcripts-test-'));
  vi.stubEnv('CODEX_HOME', '');
  vi.stubEnv('XDG_DATA_HOME', '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

async function put(path: string, content: string | Buffer): Promise<string> {
  await fs.mkdir(join(path, '..'), { recursive: true });
  await fs.writeFile(path, content);
  return path;
}

const jsonl = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join('\n');

describe('claudeSource', () => {
  it('returns no entries when ~/.claude/projects does not exist', async () => {
    expect(await claudeSource.enumerate({ home })).toEqual([]);
  });

  it('enumerates jsonl files across project dirs, newest first, honoring since', async () => {
    await put(join(home, '.claude/projects/proj-a/session-1.jsonl'), '{}\n');
    await new Promise((r) => setTimeout(r, 10));
    await put(join(home, '.claude/projects/proj-b/session-2.jsonl'), '{}\n');
    const entries = await claudeSource.enumerate({ home });
    expect(entries.map((e) => e.sessionId)).toEqual(['session-2', 'session-1']);
    expect(await claudeSource.enumerate({ home, since: new Date(Date.now() + 60_000) })).toEqual([]);
  });

  it('parses turns, tools, files touched, cwd and title', async () => {
    const path = await put(
      join(home, '.claude/projects/proj/s1.jsonl'),
      jsonl([
        { type: 'summary', cwd: '/work/app' },
        { type: 'user', isMeta: true, message: { role: 'user', content: 'caveat boilerplate' } },
        { type: 'user', timestamp: '2026-10-01T00:00:00Z', message: { role: 'user', content: 'Add a health route' } },
        { type: 'assistant', timestamp: '2026-10-01T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] } },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', name: 'Write', input: { file_path: '/work/app/src/health.ts', content: 'SECRET FILE BODY' } },
              { type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } },
              { type: 'tool_use', name: 'NotebookEdit', input: { notebook_path: 'nb.ipynb' } },
            ],
          },
        },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
        'not-json',
      ]) + '\nnot-json\n',
    );
    const doc = await claudeSource.parseSession({ sessionId: 's1', path, mtime: new Date() });
    expect(doc).not.toBeNull();
    expect(doc!.cwd).toBe('/work/app');
    expect(doc!.title).toBe('Add a health route');
    expect(doc!.turns).toHaveLength(2);
    expect(doc!.turns[1]!.text).toBe('On it.');
    expect(doc!.turns[1]!.tools).toEqual([
      { name: 'Write', path: '/work/app/src/health.ts' },
      { name: 'Bash', summary: 'pnpm test' },
      { name: 'NotebookEdit', path: 'nb.ipynb' },
    ]);
    expect(doc!.filesTouched).toEqual(['/work/app/src/health.ts', 'nb.ipynb']);
    expect(JSON.stringify(doc)).not.toContain('SECRET FILE BODY');
  });

  it('titles a session after the first prompt, not a slash command or its output', async () => {
    const path = await put(
      join(home, '.claude/projects/proj/s2.jsonl'),
      jsonl([
        { type: 'user', message: { role: 'user', content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>' } },
        { type: 'user', message: { role: 'user', content: '<local-command-stdout>Set model to Opus</local-command-stdout>' } },
        { type: 'user', message: { role: 'user', content: 'which projects use Workers AI?' } },
      ]),
    );
    expect((await claudeSource.parseSession({ sessionId: 's2', path, mtime: new Date() }))!.title).toBe('which projects use Workers AI?');
  });

  it('returns null when no usable turns are found', async () => {
    const path = await put(join(home, '.claude/projects/proj/empty.jsonl'), '{"type":"system"}\n');
    expect(await claudeSource.parseSession({ sessionId: 'empty', path, mtime: new Date() })).toBeNull();
  });
});

describe('codexSource', () => {
  const id = '019e13ac-3554-7e62-87b1-478188dfcced';
  const rollout = jsonl([
    { timestamp: 't0', type: 'session_meta', payload: { id, cwd: '/work/api' } },
    { timestamp: 't0', type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>x</permissions instructions>' }] } },
    { timestamp: 't0', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/work/api</cwd>\n</environment_context>' }] } },
    { timestamp: 't0', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /work/api\n...' }] } },
    { timestamp: 't1', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'why is the test failing?' }] } },
    { timestamp: 't2', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'because of X' }] } },
    { timestamp: 't3', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'pnpm test'] }) } },
    { timestamp: 't4', type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** Add File: /work/api/b.ts\n+body\n*** End Patch' } },
    { timestamp: 't5', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', changes: { '/work/api/c.ts': { type: 'add', content: 'NEW FILE BODY' } } } } },
    { timestamp: 't6', type: 'session_meta', payload: { id: 'parent-id', cwd: '/elsewhere' } },
    { type: 'reasoning', payload: { thoughts: 'hmm' } },
  ]);

  function rolloutPath(ext: string): string {
    return join(home, '.codex/sessions/2026/05/11', `rollout-2026-05-11T00-00-00-${id}.${ext}`);
  }

  it('returns no entries when ~/.codex/sessions does not exist', async () => {
    expect(await codexSource.enumerate({ home })).toEqual([]);
  });

  it('parses messages, tools and file changes, skipping boilerplate', async () => {
    const path = await put(rolloutPath('jsonl'), rollout);
    const [entry] = await codexSource.enumerate({ home });
    expect(entry).toMatchObject({ sessionId: id, path });
    const doc = await codexSource.parseSession(entry!);
    expect(doc!.cwd).toBe('/work/api');
    expect(doc!.entry.sessionId).toBe(id);
    expect(doc!.turns.map((t) => [t.role, t.text])).toEqual([
      ['user', 'why is the test failing?'],
      ['assistant', 'because of X'],
    ]);
    expect(doc!.turns[1]!.tools).toEqual([
      { name: 'shell', summary: 'bash -lc pnpm test' },
      { name: 'apply_patch', path: 'src/a.ts' },
      { name: 'apply_patch', path: '/work/api/b.ts' },
      { name: 'file_add', path: '/work/api/c.ts' },
    ]);
    expect(doc!.filesTouched).toEqual(['src/a.ts', '/work/api/b.ts', '/work/api/c.ts']);
    expect(doc!.title).toBe('why is the test failing?');
    expect(JSON.stringify(doc)).not.toContain('NEW FILE BODY');
  });

  it('sweeps $CODEX_HOME/sessions when CODEX_HOME is set', async () => {
    const codexHome = join(home, 'cx');
    await put(join(codexHome, 'sessions/2026/05/11', `rollout-2026-05-11T00-00-00-${id}.jsonl`), rollout);
    await put(rolloutPath('jsonl'), rollout.replace(id, '019e13ac-3554-7e62-87b1-000000000000'));
    const entries = await codexSource.enumerate({ home, env: { CODEX_HOME: codexHome } });
    expect(entries.map((e) => e.sessionId)).toEqual([id]);
  });

  it('enumerates and parses zstd-compressed rollouts', async () => {
    await put(rolloutPath('jsonl.zst'), zstdCompressSync(Buffer.from(rollout)));
    const entries = await codexSource.enumerate({ home });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.sessionId).toBe(id);
    const doc = await codexSource.parseSession(entries[0]!);
    expect(doc!.turns).toHaveLength(2);
    expect(doc!.filesTouched).toContain('/work/api/c.ts');
  });
});

describe('opencodeSource', () => {
  const exported = {
    info: { id: 'ses_1', directory: '/work/oc', title: 'Fix login', time: { created: 1_700_000_000_000, updated: 1_700_000_100_000 } },
    messages: [
      { info: { role: 'user', time: { created: 1_700_000_000_000 } }, parts: [{ type: 'text', text: 'fix the login bug' }, { type: 'text', text: 'injected', synthetic: true }] },
      {
        info: { role: 'assistant', time: { created: 1_700_000_050_000 } },
        parts: [
          { type: 'step-start' },
          { type: 'reasoning', text: 'thinking' },
          { type: 'text', text: 'Patched it.' },
          { type: 'tool', tool: 'write', state: { status: 'completed', input: { filePath: '/work/oc/login.ts', content: 'BODY' } } },
          { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'npm test' }, output: 'ok' } },
        ],
      },
    ],
  };

  it('lists sessions and parses an export through the injected exec', async () => {
    await put(join(home, '.local/share/opencode/opencode.db'), '');
    const calls: string[][] = [];
    const source = createOpencodeSource(async (args) => {
      calls.push(args);
      if (args[0] === 'session') return JSON.stringify([{ id: 'ses_1', title: 'Fix login', directory: '/work/oc', updated: 1_700_000_100_000 }]);
      return JSON.stringify(exported);
    });
    const [entry] = await source.enumerate({ home, cwd: '/work/oc' });
    expect(entry).toMatchObject({ sessionId: 'ses_1', cwd: '/work/oc' });
    const doc = await source.parseSession(entry!);
    expect(calls[1]).toEqual(['export', 'ses_1']);
    expect(doc!.title).toBe('Fix login');
    expect(doc!.cwd).toBe('/work/oc');
    expect(doc!.turns[0]).toMatchObject({ role: 'user', text: 'fix the login bug', ts: new Date(1_700_000_000_000).toISOString() });
    expect(doc!.turns[1]!.tools).toEqual([
      { name: 'write', path: '/work/oc/login.ts' },
      { name: 'bash', summary: 'npm test' },
    ]);
    expect(doc!.filesTouched).toEqual(['/work/oc/login.ts']);
  });

  it('returns no entries when the opencode binary fails', async () => {
    await put(join(home, '.local/share/opencode/opencode.db'), '');
    const source = createOpencodeSource(async () => {
      throw new Error('ENOENT');
    });
    expect(await source.enumerate({ home })).toEqual([]);
  });

  it('never runs the opencode CLI when its data store does not exist', async () => {
    const calls: string[][] = [];
    const source = createOpencodeSource(async (args) => {
      calls.push(args);
      return '[]';
    });
    expect(await source.enumerate({ home })).toEqual([]);
    expect(calls).toEqual([]);
    const xdg = join(home, 'data');
    await put(join(xdg, 'opencode/opencode.db'), '');
    await source.enumerate({ home, env: { XDG_DATA_HOME: xdg } });
    expect(calls).toEqual([['session', 'list', '--format', 'json']]);
  });
});

describe('geminiSource', () => {
  it('parses jsonl chats, ignoring meta lines', async () => {
    const path = await put(
      join(home, '.gemini/tmp/abc123/chats/session-2026-10-01T00-00-1a2b3c4d.jsonl'),
      jsonl([
        { $set: { sessionId: 'gem-session-1', projectHash: 'abc123' } },
        { id: 'm1', timestamp: '2026-10-01T00:00:00Z', type: 'user', content: [{ text: 'write a README' }] },
        { id: 'm2', timestamp: '2026-10-01T00:00:05Z', type: 'gemini', content: 'Done.', toolCalls: [{ name: 'write_file', args: { file_path: '/work/g/README.md', content: 'BODY' } }, { name: 'run_shell_command', args: { command: 'ls' } }] },
        { id: 'm3', type: 'info', content: 'noise' },
        { $patch: { lastUpdated: 'x' } },
        { $rewindTo: 'm1' },
      ]),
    );
    const [entry] = await geminiSource.enumerate({ home });
    expect(entry!.path).toBe(path);
    expect(entry!.sessionId).toBe('gem-session-1');
    const doc = await geminiSource.parseSession(entry!);
    expect(doc!.entry.sessionId).toBe('gem-session-1');
    expect(doc!.turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(doc!.turns[1]!.tools).toEqual([
      { name: 'write_file', path: '/work/g/README.md' },
      { name: 'run_shell_command', summary: 'ls' },
    ]);
    expect(doc!.filesTouched).toEqual(['/work/g/README.md']);
  });

  it('parses legacy single-json chats', async () => {
    const path = await put(
      join(home, '.gemini/tmp/abc123/chats/session-legacy.json'),
      JSON.stringify({
        sessionId: 'gem-legacy',
        projectHash: 'abc123',
        messages: [
          { type: 'user', content: 'hello' },
          { type: 'gemini', content: 'hi', toolCalls: [{ name: 'replace', args: { file_path: 'src/x.ts' } }] },
        ],
      }),
    );
    const doc = await geminiSource.parseSession({ sessionId: 'legacy', path, mtime: new Date() });
    expect(doc!.entry.sessionId).toBe('gem-legacy');
    expect(doc!.turns).toHaveLength(2);
    expect(doc!.filesTouched).toEqual(['src/x.ts']);
  });
});

describe('geminiSource ids and cwd', () => {
  it('names chats by the in-file session id, falls back to the filename, and maps project hashes to recorded cwds', async () => {
    const cfg = join(home, 'cfg');
    const cwd = '/work/gem';
    const hash = createHash('sha256').update(cwd).digest('hex');
    await recordSessionCwd(cfg, 'gemini-cli:anything', cwd);
    await put(join(home, `.gemini/tmp/${hash}/chats/session-legacy.json`), JSON.stringify({ sessionId: 'in-file', messages: [{ type: 'user', content: 'a' }] }));
    const bare = await put(join(home, '.gemini/tmp/other/chats/session-bare-id.jsonl'), jsonl([{ type: 'user', content: 'b' }]));
    const entries = await geminiSource.enumerate({ home, configDir: cfg });
    const legacy = entries.find((e) => e.sessionId === 'in-file')!;
    expect(legacy.cwd).toBe(cwd);
    expect((await geminiSource.parseSession(legacy))!.cwd).toBe(cwd);
    const fallback = entries.find((e) => e.path === bare)!;
    expect(fallback.sessionId).toBe('bare-id');
    expect(fallback.cwd).toBeUndefined();
    expect((await geminiSource.parseSession({ ...fallback, sessionId: 'whatever' }))!.entry.sessionId).toBe('bare-id');
  });
});

describe('cursorSource', () => {
  const transcript = jsonl([
    { role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nrename the util\n</user_query>' }] } },
    {
      role: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Renaming.' },
          { type: 'tool_use', name: 'Write', input: { path: '/work/c/util.ts', contents: 'BODY' } },
          { type: 'tool_use', name: 'ApplyPatch', input: '*** Begin Patch\n*** Delete File: /work/c/old.ts\n*** End Patch' },
          { type: 'tool_use', name: 'Shell', input: { command: 'git status' } },
        ],
      },
    },
  ]);

  it('enumerates nested and flat transcripts', async () => {
    await put(join(home, '.cursor/projects/work-c/agent-transcripts/conv-1/conv-1.jsonl'), transcript);
    await put(join(home, '.cursor/projects/work-c/agent-transcripts/conv-2.jsonl'), transcript);
    const entries = await cursorSource.enumerate({ home });
    expect(entries.map((e) => e.sessionId).sort()).toEqual(['conv-1', 'conv-2']);
    const nested = entries.find((e) => e.sessionId === 'conv-1')!;

    const doc = await cursorSource.parseSession(nested);
    expect(doc!.cwd).toBeUndefined();
    expect(doc!.title).toBe('rename the util');
    expect(doc!.turns[0]!.text).toBe('rename the util');
    expect(doc!.turns[1]!.tools).toEqual([
      { name: 'Write', path: '/work/c/util.ts' },
      { name: 'ApplyPatch', path: '/work/c/old.ts' },
      { name: 'Shell', summary: 'git status' },
    ]);
    expect(doc!.filesTouched).toEqual(['/work/c/util.ts', '/work/c/old.ts']);
  });
});

describe('antigravitySource', () => {
  const transcript =
    jsonl([
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-01T10:00:00Z',
        content: '<USER_REQUEST>\nadd a health check\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-01T15:30:00+05:30.\n</ADDITIONAL_METADATA>',
      },
      { step_index: 1, source: 'SYSTEM_SDK', type: 'SYSTEM_MESSAGE', content: 'ignored' },
      { step_index: 2, source: 'MODEL', type: 'GENERIC', content: 'ignored tool output' },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-01T10:00:05Z',
        content: 'Adding it.',
        thinking: 'secret reasoning',
        tool_calls: [
          { name: 'write_to_file', args: { TargetFile: '"/work/a/health.ts"', CodeContent: '"BODY"' } },
          { name: 'replace_file_content', args: { TargetFile: '"/work/a/index.ts"', ReplacementContent: '"BODY"' } },
          { name: 'run_command', args: { CommandLine: '"pnpm test"', WaitMsBeforeAsync: '5000' } },
          { name: 'read_file', args: { Path: '"/work/a/README.md"', StartLine: '1' } },
          { name: 'call_mcp_tool', args: { Arguments: '{"session_id":"x"}', ServerName: '"agentdrive"', ToolName: '"drive_resume"' } },
          { name: 'run_command', args: { CommandLine: 'not json' } },
          'not-an-object',
        ],
      },
    ]) + '\n{"torn line';

  it('enumerates every Antigravity app dir by conversation id', async () => {
    await put(join(home, '.gemini/antigravity-cli/brain/c1/.system_generated/logs/transcript.jsonl'), transcript);
    await put(join(home, '.gemini/antigravity/brain/c2/.system_generated/logs/transcript.jsonl'), transcript);
    await put(join(home, '.gemini/antigravity-ide/brain/c3/.system_generated/logs/transcript.jsonl'), transcript);
    await put(join(home, '.gemini/antigravity-ide/brain/c4/.system_generated/logs/transcript_full.jsonl'), transcript);
    const entries = await antigravitySource.enumerate({ home });
    expect(entries.map((e) => e.sessionId).sort()).toEqual(['c1', 'c2', 'c3']);
  });

  it('keeps user and planner steps, records written files, and skips unknown steps and torn lines', async () => {
    const path = await put(join(home, '.gemini/antigravity-cli/brain/c1/.system_generated/logs/transcript.jsonl'), transcript);
    const doc = await antigravitySource.parseSession({ sessionId: 'c1', path, mtime: new Date() });
    expect(doc!.cwd).toBeUndefined();
    expect(doc!.title).toBe('add a health check');
    expect(doc!.turns.map((t) => [t.role, t.text, t.ts])).toEqual([
      ['user', 'add a health check', '2026-11-01T10:00:00Z'],
      ['assistant', 'Adding it.', '2026-11-01T10:00:05Z'],
    ]);
    expect(doc!.turns[1]!.tools).toEqual([
      { name: 'write_to_file', path: '/work/a/health.ts' },
      { name: 'replace_file_content', path: '/work/a/index.ts' },
      { name: 'run_command', summary: 'pnpm test' },
      { name: 'read_file', summary: '/work/a/README.md' },
      { name: 'call_mcp_tool', summary: 'drive_resume' },
      { name: 'run_command', summary: 'not json' },
      { name: 'tool' },
    ]);
    expect(doc!.filesTouched).toEqual(['/work/a/health.ts', '/work/a/index.ts']);
    expect(JSON.stringify(doc)).not.toMatch(/secret reasoning|BODY|ignored|ADDITIONAL_METADATA/);
  });
});
