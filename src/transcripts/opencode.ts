import { execFile } from 'node:child_process';
import { opencodeDataDir } from './paths.js';
import type { EnumerateOptions, TranscriptDoc, TranscriptEntry, TranscriptSource, TranscriptTool } from './types.js';
import { DocBuilder, asObj, asStr, mtimeOf, patchPaths, toolSummary, type Json } from './util.js';

// OpenCode keeps sessions in its own store, so we read them through its CLI:
// `opencode session list --format json` and `opencode export <id>`. `--pure`
// skips plugins, including our own hook plugin.

export type OpencodeExec = (args: string[], cwd?: string) => Promise<string>;

const EXEC_TIMEOUT_MS = 15_000;

const defaultExec: OpencodeExec = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      'opencode',
      [...args, '--pure'],
      { cwd, timeout: EXEC_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });

function parseJson(out: string): unknown {
  const start = out.search(/[[{]/);
  return start < 0 ? null : JSON.parse(out.slice(start));
}

function isoFromMs(ms: unknown): string | undefined {
  return typeof ms === 'number' ? new Date(ms).toISOString() : undefined;
}

function toolEntry(doc: DocBuilder, name: string, input: Json | undefined): TranscriptTool[] {
  if (name === 'write' || name === 'edit') {
    const path = asStr(input?.filePath);
    doc.touch(path);
    return [path ? { name, path } : { name }];
  }
  if (name === 'patch' || name === 'apply_patch') {
    const patch = Object.values(input ?? {}).filter((v): v is string => typeof v === 'string').join('\n');
    const paths = patchPaths(patch);
    for (const p of paths) doc.touch(p);
    return paths.length > 0 ? paths.map((path) => ({ name, path })) : [{ name }];
  }
  return [{ name, summary: toolSummary(input) }];
}

export function createOpencodeSource(exec: OpencodeExec = defaultExec): TranscriptSource {
  return {
    platform: 'opencode',

    // shortcut: `opencode session list` only lists the project of `cwd`, so a
    // sweep sees the sessions of the directory the hook fired in; reading
    // OpenCode's storage directly would cover all projects.
    async enumerate({ home, since, cwd, env }: EnumerateOptions): Promise<TranscriptEntry[]> {
      // Without a data dir OpenCode was never used, and the CLI would cost up to 15s and create its config dir.
      if (!(await mtimeOf(opencodeDataDir(env, home)))) return [];
      let list: unknown;
      try {
        list = parseJson(await exec(['session', 'list', '--format', 'json'], cwd));
      } catch {
        return [];
      }
      if (!Array.isArray(list)) return [];
      const out: TranscriptEntry[] = [];
      for (const raw of list) {
        const s = asObj(raw);
        const id = asStr(s?.id);
        const updated = s?.updated;
        if (!id || typeof updated !== 'number') continue;
        const mtime = new Date(updated);
        if (since && mtime <= since) continue;
        out.push({ sessionId: id, path: id, mtime, cwd: asStr(s?.directory) });
      }
      return out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    },

    async parseSession(entry: TranscriptEntry): Promise<TranscriptDoc | null> {
      let data: Json | undefined;
      try {
        data = asObj(parseJson(await exec(['export', entry.sessionId], entry.cwd)));
      } catch {
        return null;
      }
      if (!data) return null;
      const info = asObj(data.info);
      const doc = new DocBuilder();
      for (const rawMsg of Array.isArray(data.messages) ? data.messages : []) {
        const msg = asObj(rawMsg);
        const mInfo = asObj(msg?.info);
        const role = asStr(mInfo?.role) ?? 'assistant';
        const ts = isoFromMs(asObj(mInfo?.time)?.created);
        let text = '';
        const tools: TranscriptTool[] = [];
        for (const rawPart of Array.isArray(msg?.parts) ? msg.parts : []) {
          const part = asObj(rawPart);
          if (!part || part.synthetic) continue;
          if (part.type === 'text') text += asStr(part.text) ?? '';
          else if (part.type === 'tool') tools.push(...toolEntry(doc, asStr(part.tool) ?? 'tool', asObj(asObj(part.state)?.input)));
        }
        doc.addTurn(role, text, ts, tools);
      }
      const updated = isoFromMs(asObj(info?.time)?.updated);
      const entryOut = updated ? { ...entry, mtime: new Date(updated) } : entry;
      return doc.build(entryOut, asStr(info?.directory), asStr(info?.title));
    },
  };
}

export const opencodeSource = createOpencodeSource();
