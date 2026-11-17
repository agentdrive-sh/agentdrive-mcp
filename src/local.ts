import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { gitToplevel, projectKeyFor } from './project.js';
import { redact } from './redactor.js';
import { buildHandoff, renderSession, sessionRunId, type SessionHarness } from './session.js';
import { relativeTime } from './tools/drive-context.js';
import { antigravitySource } from './transcripts/antigravity.js';
import { claudeSource } from './transcripts/claude.js';
import { codexSource } from './transcripts/codex.js';
import { cursorSource } from './transcripts/cursor.js';
import { geminiSource } from './transcripts/gemini.js';
import { opencodeSource } from './transcripts/opencode.js';
import { readSessionCwds } from './transcripts/session-cwd.js';
import type { TranscriptDoc, TranscriptEntry, TranscriptSource } from './transcripts/types.js';
import { readHead } from './transcripts/util.js';

// Local mode: sessions read straight from each harness's transcript store on
// this machine, with no account and no network. Not imported by the registry,
// so the hosted worker never bundles filesystem code.

export const HARNESSES: SessionHarness[] = ['claude-code', 'codex', 'opencode', 'gemini-cli', 'cursor', 'antigravity'];

export const SOURCES: Record<SessionHarness, TranscriptSource> = {
  'claude-code': claudeSource,
  codex: codexSource,
  opencode: opencodeSource,
  'gemini-cli': geminiSource,
  cursor: cursorSource,
  antigravity: antigravitySource,
};

const DEFAULT_LIMIT = 10;
// shortcut: only the newest MAX_SCAN transcripts across harnesses are considered, so a project's sessions older than that many newer sessions elsewhere are not found; index transcript cwds if that bites.
const MAX_SCAN = 1000;
const HEAD_BYTES = 64 * 1024;
const CWD_RE = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/;

export const LOCAL_NOTE = 'From local transcripts on this machine: not synced across machines or recorded in provenance.';

export interface LocalOptions {
  cwd: string;
  // Project key to match instead of the one for `cwd`.
  project?: string;
  // The harness the caller runs in; its own sessions are left out.
  exclude?: string;
  harness?: string;
  limit?: number;
  home?: string;
  env?: NodeJS.ProcessEnv;
  // AgentDrive config dir, for the cwds hooks recorded for transcripts that carry none.
  configDir?: string;
  sources?: Partial<Record<SessionHarness, TranscriptSource>>;
}

export interface LocalSession {
  id: string;
  harness: SessionHarness;
  project: string;
  cwd?: string;
  title?: string;
  activityAt: number;
  doc: TranscriptDoc;
}

async function parse(
  source: TranscriptSource,
  harness: SessionHarness,
  entry: TranscriptEntry,
  sessionCwds: Record<string, string>,
  keyOf: (cwd: string) => string,
  hint: string | undefined,
): Promise<LocalSession | null> {
  let doc: TranscriptDoc | null;
  try {
    doc = await source.parseSession(entry);
  } catch {
    return null;
  }
  if (!doc) return null;
  const id = sessionRunId(harness, doc.entry.sessionId);
  const cwd = doc.cwd ?? sessionCwds[id] ?? hint;
  const lastTs = [...doc.turns].reverse().find((t) => t.ts)?.ts;
  const lastAt = lastTs ? Date.parse(lastTs) : NaN;
  return {
    id,
    harness,
    project: cwd ? keyOf(cwd) : 'local__unknown',
    cwd,
    title: doc.title ? redact(doc.title).redacted : undefined,
    activityAt: Number.isFinite(lastAt) ? lastAt : doc.entry.mtime.getTime(),
    doc,
  };
}

// Gemini CLI names a project's chat dir sha256(project root), so its sessions of
// the current project place without a hook-recorded cwd. Cursor's per-project dir
// name maps '/', '-', '_' and '.' alike, so it cannot tell /a/my-app from
// /a/my/app and Cursor sessions place only through the hook.
function storeDirCwd(harness: SessionHarness, path: string, candidates: string[]): string | undefined {
  if (harness !== 'gemini-cli') return undefined;
  const dir = /\/tmp\/([^/]+)\/chats\/[^/]+$/.exec(path)?.[1];
  return candidates.find((c) => createHash('sha256').update(c).digest('hex') === dir);
}

function cwdCandidates(cwd: string): string[] {
  return [...new Set([cwd, gitToplevel(cwd) ?? cwd])];
}

// Claude Code and Codex name the session cwd in their first records, so most
// transcripts of other projects are skipped without a full parse.
async function cwdHint(harness: SessionHarness, entry: TranscriptEntry, sessionCwds: Record<string, string>, candidates: string[]): Promise<string | undefined> {
  const known = entry.cwd ?? sessionCwds[sessionRunId(harness, entry.sessionId)] ?? storeDirCwd(harness, entry.path, candidates);
  if (known || !isAbsolute(entry.path) || entry.path.endsWith('.zst')) return known;
  const match = CWD_RE.exec(await readHead(entry.path, HEAD_BYTES).catch(() => ''));
  try {
    return match ? (JSON.parse(match[1]!) as string) : undefined;
  } catch {
    return undefined;
  }
}

function keyCache(): (cwd: string) => string {
  const keys = new Map<string, string>();
  return (cwd) => {
    let key = keys.get(cwd);
    if (key === undefined) keys.set(cwd, (key = projectKeyFor(cwd)));
    return key;
  };
}

export async function listLocalSessions(opts: LocalOptions): Promise<{ project: string; sessions: LocalSession[] }> {
  const sources = { ...SOURCES, ...opts.sources };
  const keyOf = keyCache();
  const project = opts.project ?? keyOf(opts.cwd);
  const found: Array<{ harness: SessionHarness; entry: TranscriptEntry }> = [];
  for (const harness of HARNESSES) {
    // An explicit harness wins over the exclusion, as an explicit id does.
    if (opts.harness ? harness !== opts.harness : harness === opts.exclude) continue;
    const entries = await sources[harness]
      .enumerate({ home: opts.home ?? homedir(), cwd: opts.cwd, env: opts.env, configDir: opts.configDir })
      .catch(() => []);
    for (const entry of entries) found.push({ harness, entry });
  }
  found.sort((a, b) => b.entry.mtime.getTime() - a.entry.mtime.getTime());

  const sessionCwds = opts.configDir ? await readSessionCwds(opts.configDir) : {};
  const candidates = cwdCandidates(opts.cwd);
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const sessions: LocalSession[] = [];
  for (const { harness, entry } of found.slice(0, MAX_SCAN)) {
    if (sessions.length >= limit) break;
    const hint = await cwdHint(harness, entry, sessionCwds, candidates);
    if (hint && keyOf(hint) !== project) continue;
    const session = await parse(sources[harness], harness, entry, sessionCwds, keyOf, hint);
    if (session?.project === project) sessions.push(session);
  }
  return { project, sessions: sessions.sort((a, b) => b.activityAt - a.activityAt) };
}

export async function findLocalSession(id: string, opts: LocalToolContext): Promise<LocalSession | null> {
  const harness = HARNESSES.find((h) => id.startsWith(`${h}:`));
  if (!harness) return null;
  const source = opts.sources?.[harness] ?? SOURCES[harness];
  const entries = await source.enumerate({ home: opts.home ?? homedir(), cwd: opts.cwd, env: opts.env, configDir: opts.configDir }).catch(() => []);
  const entry = entries.find((e) => sessionRunId(harness, e.sessionId) === id);
  if (!entry) return null;
  const sessionCwds = opts.configDir ? await readSessionCwds(opts.configDir) : {};
  return parse(source, harness, entry, sessionCwds, keyCache(), await cwdHint(harness, entry, sessionCwds, cwdCandidates(opts.cwd)));
}

function displayPath(path: string, cwd: string | undefined): string {
  if (!cwd) return path;
  const abs = isAbsolute(path) ? path : resolve(cwd, path);
  const rel = relative(cwd, abs);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : abs;
}

// The same render and redaction capture applies before upload, so a local
// handoff reads exactly like a cloud one.
export function localHandoff(session: LocalSession, maxChars?: number): string {
  const markdown = renderSession({
    harness: session.harness,
    sessionId: session.doc.entry.sessionId,
    project: session.project,
    cwd: session.cwd,
    title: session.doc.title,
    updatedAt: new Date(session.activityAt).toISOString(),
    turns: session.doc.turns,
    filesTouched: [...new Set(session.doc.filesTouched.map((p) => displayPath(p, session.cwd)))],
  });
  return buildHandoff(redact(markdown).redacted, maxChars);
}

export type LocalToolContext = Omit<LocalOptions, 'project' | 'harness' | 'limit'>;

function text(value: string) {
  return { content: [{ type: 'text' as const, text: value }] };
}

export async function driveSessionsLocal(ctx: LocalToolContext, args: { project?: string; platform?: string; limit?: number }) {
  const { project, sessions } = await listLocalSessions({ ...ctx, project: args.project, harness: args.platform, limit: args.limit });
  if (sessions.length === 0) return text(`No local sessions from other agents for project ${project} on this machine.`);
  const now = Date.now();
  const lines = sessions.map((s) => `${relativeTime(now - s.activityAt)} · ${s.harness} · ${s.title || 'Untitled session'} · id=${s.id}`);
  return text(`Local sessions for ${project} (newest first, read from this machine's agent transcripts):\n${lines.join('\n')}\n\nCall drive_resume with session_id to load one.`);
}

export async function driveResumeLocal(ctx: LocalToolContext, args: { session_id?: string; platform?: string; max_chars?: number }) {
  let session: LocalSession | null | undefined;
  if (args.session_id) {
    session = await findLocalSession(args.session_id, ctx);
    if (!session) return text(`No local session ${args.session_id} on this machine.`);
  } else {
    const listed = await listLocalSessions({ ...ctx, harness: args.platform, limit: 1 });
    session = listed.sessions[0];
    if (!session) return text(`No local sessions from other agents for project ${listed.project} on this machine.`);
  }
  return text(`${LOCAL_NOTE}\n\n${localHandoff(session, args.max_chars)}`);
}
