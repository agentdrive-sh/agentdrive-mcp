import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { EnumerateOptions, TranscriptDoc, TranscriptEntry, TranscriptSource, TranscriptTool } from './types.js';
import { DocBuilder, asObj, asStr, jsonLines, mtimeOf, patchPaths, readText, toolSummary } from './util.js';

// Cursor agent: ~/.cursor/projects/<path-slug>/agent-transcripts/<conv>/<conv>.jsonl
// (or flat <conv>.jsonl). Lines are `{ role, message: { content: [...] } }`
// with no timestamps and no cwd; sync falls back to the cwd the hook recorded
// (see session-cwd.ts).

const PATH_TOOLS = new Set(['Write', 'StrReplace', 'Delete']);
const USER_QUERY_RE = /^\s*<user_query>\s*([\s\S]*?)\s*<\/user_query>\s*$/;

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

export const cursorSource: TranscriptSource = {
  platform: 'cursor',

  async enumerate({ home, since }: EnumerateOptions): Promise<TranscriptEntry[]> {
    const root = join(home, '.cursor', 'projects');
    const out: TranscriptEntry[] = [];
    for (const slug of await readdirSafe(root)) {
      const dir = join(root, slug, 'agent-transcripts');
      for (const name of await readdirSafe(dir)) {
        const sessionId = name.replace(/\.jsonl$/, '');
        const path = name.endsWith('.jsonl') ? join(dir, name) : join(dir, name, `${name}.jsonl`);
        const mtime = await mtimeOf(path);
        if (!mtime || (since && mtime <= since)) continue;
        out.push({ sessionId, path, mtime });
      }
    }
    return out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  },

  async parseSession(entry: TranscriptEntry): Promise<TranscriptDoc | null> {
    const raw = await readText(entry.path);
    if (raw === null) return null;
    const doc = new DocBuilder();
    for (const obj of jsonLines(raw)) {
      const role = asStr(obj.role);
      if (role !== 'user' && role !== 'assistant') continue;
      const content = asObj(obj.message)?.content;
      let text = typeof content === 'string' ? content : '';
      const tools: TranscriptTool[] = [];
      for (const part of Array.isArray(content) ? content : []) {
        const p = asObj(part);
        if (p?.type === 'text') {
          text += asStr(p.text) ?? '';
        } else if (p?.type === 'tool_use') {
          const name = asStr(p.name) ?? 'tool';
          if (name === 'ApplyPatch') {
            const input = typeof p.input === 'string' ? p.input : Object.values(asObj(p.input) ?? {}).filter((v) => typeof v === 'string').join('\n');
            const paths = patchPaths(input);
            for (const path of paths) doc.touch(path);
            tools.push(...(paths.length > 0 ? paths.map((path) => ({ name, path })) : [{ name }]));
          } else {
            const path = PATH_TOOLS.has(name) ? asStr(asObj(p.input)?.path) : undefined;
            doc.touch(path);
            tools.push(path ? { name, path } : { name, summary: toolSummary(p.input) });
          }
        }
      }
      doc.addTurn(role, text.replace(USER_QUERY_RE, '$1'), undefined, tools);
    }
    return doc.build(entry);
  },
};
