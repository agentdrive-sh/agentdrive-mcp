import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { codexHome } from './paths.js';
import type { EnumerateOptions, TranscriptDoc, TranscriptEntry, TranscriptSource, TranscriptTool } from './types.js';
import { DocBuilder, asObj, asStr, jsonLines, mtimeOf, patchPaths, readText, toolSummary } from './util.js';

// Codex CLI: $CODEX_HOME (default ~/.codex)/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl, with
// older rollouts zstd-compressed to .jsonl.zst. Lines are
// `{ timestamp, type, payload }`: session_meta (id, cwd), response_item
// (message | function_call | custom_tool_call), and event_msg
// item_completed whose FileChange item is the 0.160 file-edit signal. The
// format shifts between CLI versions, so unknown records are ignored.

const ROLLOUT_RE = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i;
// Codex injects environment/instruction dumps as user messages; a part that
// is one whole <tag>...</tag> block is harness boilerplate, not the user.
const BOILERPLATE_RE = /^\s*(?:<([a-z][\w-]*)[\s>][\s\S]*<\/\1>\s*$|# AGENTS\.md instructions)/i;

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function walkRollouts(root: string): Promise<string[]> {
  const acc: string[] = [];
  for (const y of await readdirSafe(root)) {
    for (const m of await readdirSafe(join(root, y))) {
      for (const d of await readdirSafe(join(root, y, m))) {
        const dir = join(root, y, m, d);
        for (const f of await readdirSafe(dir)) {
          if (ROLLOUT_RE.test(f)) acc.push(join(dir, f));
        }
      }
    }
  }
  return acc;
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export const codexSource: TranscriptSource = {
  platform: 'codex',

  async enumerate({ home, since, env }: EnumerateOptions): Promise<TranscriptEntry[]> {
    const byId = new Map<string, TranscriptEntry>();
    for (const path of await walkRollouts(join(codexHome(env, home), 'sessions'))) {
      const mtime = await mtimeOf(path);
      if (!mtime || (since && mtime <= since)) continue;
      const sessionId = ROLLOUT_RE.exec(path.split('/').pop()!)![1]!;
      const prev = byId.get(sessionId);
      if (!prev || prev.mtime < mtime) byId.set(sessionId, { sessionId, path, mtime });
    }
    return [...byId.values()].sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  },

  async parseSession(entry: TranscriptEntry): Promise<TranscriptDoc | null> {
    const raw = await readText(entry.path);
    if (raw === null) return null;
    const doc = new DocBuilder();
    let cwd: string | undefined;
    let metaId: string | undefined;

    for (const obj of jsonLines(raw)) {
      const ts = asStr(obj.timestamp);
      const payload = asObj(obj.payload) ?? {};

      // Forked rollouts repeat their parents' session_meta after their own.
      if (obj.type === 'session_meta') {
        cwd ??= asStr(payload.cwd);
        metaId ??= asStr(payload.id);
        continue;
      }

      if (obj.type === 'event_msg' && payload.type === 'item_completed') {
        const item = asObj(payload.item);
        const changes = item?.type === 'FileChange' ? asObj(item.changes) : undefined;
        if (changes) {
          const tools: TranscriptTool[] = Object.keys(changes).map((path) => {
            doc.touch(path);
            return { name: `file_${asStr(asObj(changes[path])?.type) ?? 'change'}`, path };
          });
          doc.addTurn('assistant', '', ts, tools);
        }
        continue;
      }

      if (obj.type !== 'response_item' && obj.type !== 'turn') continue;

      if (payload.type === 'function_call') {
        doc.addTurn('assistant', '', ts, [{ name: asStr(payload.name) ?? 'tool', summary: toolSummary(parseArgs(payload.arguments)) }]);
        continue;
      }

      if (payload.type === 'custom_tool_call') {
        const name = asStr(payload.name) ?? 'tool';
        const input = asStr(payload.input) ?? '';
        if (name === 'apply_patch') {
          const paths = patchPaths(input);
          for (const p of paths) doc.touch(p);
          doc.addTurn('assistant', '', ts, paths.map((path) => ({ name, path })));
        } else {
          doc.addTurn('assistant', '', ts, [{ name, summary: toolSummary(input) }]);
        }
        continue;
      }

      const role = asStr(payload.role);
      if (role !== 'user' && role !== 'assistant') continue;
      if (payload.type !== 'message' && obj.type !== 'turn') continue;
      let text = '';
      if (typeof payload.content === 'string') {
        text = BOILERPLATE_RE.test(payload.content) ? '' : payload.content;
      } else if (Array.isArray(payload.content)) {
        for (const part of payload.content) {
          const t = asStr(asObj(part)?.text);
          if (t && !BOILERPLATE_RE.test(t)) text += t;
        }
      }
      doc.addTurn(role, text, ts);
    }

    return doc.build(metaId ? { ...entry, sessionId: metaId } : entry, cwd);
  },
};
