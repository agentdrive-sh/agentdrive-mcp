import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { EnumerateOptions, TranscriptDoc, TranscriptEntry, TranscriptSource, TranscriptTool } from './types.js';
import { DocBuilder, asObj, asStr, jsonLines, mtimeOf, readText, toolSummary } from './util.js';

// Claude Code: ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl. Lines of
// type user|assistant carry `message.content` (string or parts: text,
// tool_use, tool_result) plus `cwd` and `timestamp`.

const FILE_TOOLS: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

export const claudeSource: TranscriptSource = {
  platform: 'claude-code',

  async enumerate({ home, since }: EnumerateOptions): Promise<TranscriptEntry[]> {
    const projectsDir = join(home, '.claude', 'projects');
    let projects: string[];
    try {
      projects = await fs.readdir(projectsDir);
    } catch {
      return [];
    }
    const out: TranscriptEntry[] = [];
    for (const p of projects) {
      let files: string[];
      try {
        files = await fs.readdir(join(projectsDir, p));
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const path = join(projectsDir, p, f);
        const mtime = await mtimeOf(path);
        if (!mtime || (since && mtime <= since)) continue;
        out.push({ sessionId: f.slice(0, -'.jsonl'.length), path, mtime });
      }
    }
    return out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  },

  async parseSession(entry: TranscriptEntry): Promise<TranscriptDoc | null> {
    const raw = await readText(entry.path);
    if (raw === null) return null;
    const doc = new DocBuilder();
    let cwd: string | undefined;
    for (const obj of jsonLines(raw)) {
      cwd ??= asStr(obj.cwd);
      if ((obj.type !== 'user' && obj.type !== 'assistant') || obj.isMeta) continue;
      const msg = asObj(obj.message);
      if (!msg) continue;
      const role = asStr(msg.role) ?? String(obj.type);
      let text = '';
      const tools: TranscriptTool[] = [];
      if (typeof msg.content === 'string') {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          const p = asObj(part);
          if (!p) continue;
          if (p.type === 'tool_use') {
            const name = asStr(p.name) ?? 'tool';
            const input = asObj(p.input);
            const pathKey = FILE_TOOLS[name];
            const path = pathKey ? asStr(input?.[pathKey]) : undefined;
            doc.touch(path);
            tools.push(path ? { name, path } : { name, summary: toolSummary(input) });
          } else if (typeof p.text === 'string' && p.type !== 'tool_result') {
            text += p.text;
          }
        }
      }
      doc.addTurn(role, text, asStr(obj.timestamp), tools);
    }
    return doc.build(entry, cwd);
  },
};
