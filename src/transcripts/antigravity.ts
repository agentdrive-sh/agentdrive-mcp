import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { EnumerateOptions, TranscriptDoc, TranscriptEntry, TranscriptSource, TranscriptTool } from './types.js';
import { DocBuilder, asObj, asStr, jsonLines, mtimeOf, readText, toolSummary, type Json } from './util.js';

// Antigravity CLI, app and IDE: ~/.gemini/<app dir>/brain/<conversationId>/.system_generated/logs/transcript.jsonl,
// one step per line. Steps carry no cwd; sync falls back to the cwd the hook
// recorded (see session-cwd.ts).

const APP_DIRS = ['antigravity-cli', 'antigravity', 'antigravity-ide'];
const FILE_TOOLS = new Set(['write_to_file', 'replace_file_content', 'multi_replace_file_content']);

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

// agy JSON-encodes each arg value: {"CommandLine":"\"git status\"","WaitMsBeforeAsync":"5000"}.
function argsOf(raw: unknown): Json | undefined {
  const obj = asObj(raw);
  if (!obj) return undefined;
  const out: Json = {};
  for (const [key, value] of Object.entries(obj)) {
    try {
      out[key] = typeof value === 'string' ? JSON.parse(value) : value;
    } catch {
      out[key] = value;
    }
  }
  return out;
}

// agy wraps the prompt in <USER_REQUEST> next to metadata blocks (local time, settings changes).
function userRequest(content: string): string {
  return /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(content)?.[1] ?? content;
}

export const antigravitySource: TranscriptSource = {
  platform: 'antigravity',

  async enumerate({ home, since }: EnumerateOptions): Promise<TranscriptEntry[]> {
    const out: TranscriptEntry[] = [];
    for (const app of APP_DIRS) {
      const brain = join(home, '.gemini', app, 'brain');
      for (const sessionId of await readdirSafe(brain)) {
        const path = join(brain, sessionId, '.system_generated', 'logs', 'transcript.jsonl');
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
    for (const step of jsonLines(raw)) {
      const text = asStr(step.content) ?? '';
      const ts = asStr(step.created_at);
      if (step.type === 'USER_INPUT') {
        doc.addTurn('user', userRequest(text), ts);
      } else if (step.type === 'PLANNER_RESPONSE') {
        const tools: TranscriptTool[] = [];
        for (const rawCall of Array.isArray(step.tool_calls) ? step.tool_calls : []) {
          const call = asObj(rawCall);
          const name = asStr(call?.name) ?? 'tool';
          const args = argsOf(call?.args);
          // shortcut: write-tool names and TargetFile come from agy's docs, not a real transcript (only run_command/read_file/call_mcp_tool were seen); recheck after an agy session that edits files.
          const path = FILE_TOOLS.has(name) ? asStr(args?.TargetFile) ?? asStr(args?.Path) : undefined;
          doc.touch(path);
          tools.push(path ? { name, path } : { name, summary: toolSummary(args) });
        }
        doc.addTurn('assistant', text, ts, tools);
      }
    }
    return doc.build(entry);
  },
};
