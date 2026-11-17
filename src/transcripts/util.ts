import { promises as fs } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import type { TranscriptDoc, TranscriptEntry, TranscriptTool, TranscriptTurn } from './types.js';

const SUMMARY_CHARS = 160;
const TITLE_CHARS = 120;
// Claude Code records a slash command, and its local output, as user turns wrapped in these tags.
const HARNESS_WRAPPER = /<(command-[a-z]+|local-command-[a-z]+|system-reminder)>[\s\S]*?<\/\1>/g;
// Only these input keys feed tool summaries, so file bodies (`content`,
// `new_string`, ...) never reach a tool line.
const SUMMARY_KEYS = ['command', 'cmd', 'CommandLine', 'Path', 'ToolName', 'file_path', 'filePath', 'notebook_path', 'path', 'pattern', 'query', 'url', 'description'];

export type Json = Record<string, unknown>;

export function asObj(value: unknown): Json | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
}

export function asStr(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export async function readText(path: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(path);
    return (path.endsWith('.zst') ? zstdDecompressSync(buf) : buf).toString('utf8');
  } catch {
    return null;
  }
}

export async function readHead(path: string, bytes: number): Promise<string> {
  const handle = await fs.open(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

export function jsonLines(raw: string): Json[] {
  const out: Json[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = asObj(JSON.parse(line));
      if (parsed) out.push(parsed);
    } catch {
      // Permissive: a torn last line or unknown record never fails a parse.
    }
  }
  return out;
}

export function truncate(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 3)}...`;
}

export function toolSummary(input: unknown): string | undefined {
  const obj = asObj(input);
  if (!obj) return typeof input === 'string' && input.trim() ? truncate(input.split('\n')[0]!, SUMMARY_CHARS) : undefined;
  for (const key of SUMMARY_KEYS) {
    const v = obj[key];
    const s = Array.isArray(v) ? v.filter((x) => typeof x === 'string').join(' ') : asStr(v);
    if (s && s.trim()) return truncate(s, SUMMARY_CHARS);
  }
  return undefined;
}

export function patchPaths(patch: string): string[] {
  const out: string[] = [];
  for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.push(m[1]!.trim());
  return out;
}

export async function mtimeOf(path: string): Promise<Date | null> {
  try {
    return (await fs.stat(path)).mtime;
  } catch {
    return null;
  }
}

export class DocBuilder {
  readonly turns: TranscriptTurn[] = [];
  private readonly files = new Set<string>();

  addTurn(role: string, text: string, ts?: string, tools: TranscriptTool[] = []): void {
    const last = this.turns[this.turns.length - 1];
    if (!text.trim()) {
      if (tools.length === 0) return;
      // Harnesses log tool calls as separate records; fold them into the
      // turn they belong to instead of emitting empty turns.
      if (last && last.role === role) {
        last.tools = [...(last.tools ?? []), ...tools];
        return;
      }
    }
    this.turns.push(tools.length > 0 ? { role, text, ts, tools } : { role, text, ts });
  }

  touch(path: string | undefined): void {
    if (path && path.trim()) this.files.add(path.trim());
  }

  build(entry: TranscriptEntry, cwd?: string, title?: string): TranscriptDoc | null {
    if (this.turns.length === 0) return null;
    const firstPrompt = this.turns.map((t) => (t.role === 'user' ? t.text.replace(HARNESS_WRAPPER, '').trim() : '')).find(Boolean);
    return {
      entry,
      turns: this.turns,
      cwd: cwd ?? entry.cwd,
      title: title?.trim() ? truncate(title, TITLE_CHARS) : firstPrompt ? truncate(firstPrompt, TITLE_CHARS) : undefined,
      filesTouched: [...this.files],
    };
  }
}
