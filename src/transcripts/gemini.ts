import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { readSessionCwds } from './session-cwd.js';
import type { EnumerateOptions, TranscriptDoc, TranscriptEntry, TranscriptSource, TranscriptTool } from './types.js';
import { DocBuilder, asObj, asStr, jsonLines, mtimeOf, readHead, readText, toolSummary, type Json } from './util.js';

// Gemini CLI: ~/.gemini/tmp/<project_hash>/chats/session-*.jsonl, one message
// record per line plus `$set`/`$patch`/`$rewindTo` meta lines; legacy chats
// are a single .json `{ sessionId, messages }`. The project hash is sha256 of
// the project root, so cwd is recovered by hashing cwds the hook recorded.

const CHAT_RE = /^session-.+\.jsonl?$/;
// Both formats put the session id first, so the head is enough to name a chat
// without parsing it; enumerate, parse and the hook must agree on this id.
const HEAD_BYTES = 16 * 1024;
const SESSION_ID_RE = /"sessionId"\s*:\s*"([^"\\]+)"/;

function sessionIdOf(head: string, path: string): string {
  return SESSION_ID_RE.exec(head)?.[1] ?? (path.split(/[\\/]/).pop() ?? path).replace(/^session-/, '').replace(/\.jsonl?$/, '');
}

const FILE_TOOLS = new Set(['write_file', 'replace']);

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p) => (typeof p === 'string' ? p : asStr(asObj(p)?.text) ?? '')).join('');
}

function addMessage(doc: DocBuilder, msg: Json): void {
  if (msg.type !== 'user' && msg.type !== 'gemini') return;
  const tools: TranscriptTool[] = [];
  for (const raw of Array.isArray(msg.toolCalls) ? msg.toolCalls : []) {
    const call = asObj(raw);
    const name = asStr(call?.name) ?? 'tool';
    const args = asObj(call?.args);
    const path = FILE_TOOLS.has(name) ? asStr(args?.file_path) : undefined;
    doc.touch(path);
    tools.push(path ? { name, path } : { name, summary: toolSummary(args) });
  }
  doc.addTurn(msg.type === 'user' ? 'user' : 'assistant', messageText(msg.content), asStr(msg.timestamp), tools);
}

export const geminiSource: TranscriptSource = {
  platform: 'gemini-cli',

  async enumerate({ home, since, configDir }: EnumerateOptions): Promise<TranscriptEntry[]> {
    const tmp = join(home, '.gemini', 'tmp');
    let hashes: string[];
    try {
      hashes = await fs.readdir(tmp);
    } catch {
      return [];
    }
    const cwdByHash = new Map<string, string>();
    for (const cwd of Object.values(configDir ? await readSessionCwds(configDir) : {})) {
      cwdByHash.set(createHash('sha256').update(cwd).digest('hex'), cwd);
    }
    const out: TranscriptEntry[] = [];
    for (const h of hashes) {
      let files: string[];
      try {
        files = await fs.readdir(join(tmp, h, 'chats'));
      } catch {
        continue;
      }
      for (const f of files) {
        if (!CHAT_RE.test(f)) continue;
        const path = join(tmp, h, 'chats', f);
        const mtime = await mtimeOf(path);
        if (!mtime || (since && mtime <= since)) continue;
        const head = await readHead(path, HEAD_BYTES).catch(() => '');
        out.push({ sessionId: sessionIdOf(head, path), path, mtime, cwd: cwdByHash.get(h) });
      }
    }
    return out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  },

  async parseSession(entry: TranscriptEntry): Promise<TranscriptDoc | null> {
    const raw = await readText(entry.path);
    if (raw === null) return null;
    const doc = new DocBuilder();

    if (entry.path.endsWith('.json')) {
      let legacy: Json | undefined;
      try {
        legacy = asObj(JSON.parse(raw));
      } catch {
        return null;
      }
      for (const m of Array.isArray(legacy?.messages) ? legacy.messages : []) {
        const msg = asObj(m);
        if (msg) addMessage(doc, msg);
      }
    } else {
      for (const line of jsonLines(raw)) {
        if ('$set' in line || '$patch' in line || '$rewindTo' in line) continue;
        addMessage(doc, line);
      }
    }
    return doc.build({ ...entry, sessionId: sessionIdOf(Buffer.from(raw).subarray(0, HEAD_BYTES).toString('utf8'), entry.path) });
  },
};
