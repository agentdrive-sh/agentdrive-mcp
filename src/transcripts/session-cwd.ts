import { promises as fs } from 'node:fs';
import { join } from 'node:path';

// Hooks see each session's cwd, but some transcripts (Cursor, Gemini, Antigravity) never
// record it, so `adrive hook` remembers `<harness>:<session id> -> cwd` here
// for sync to fall back on.

const MAX_ENTRIES = 500;

export function sessionCwdPath(configDir: string): string {
  return join(configDir, 'session-cwd.json');
}

export async function readSessionCwds(configDir: string): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(sessionCwdPath(configDir), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export async function recordSessionCwd(configDir: string, key: string, cwd: string): Promise<void> {
  const map = await readSessionCwds(configDir);
  if (map[key] === cwd) return;
  delete map[key];
  map[key] = cwd;
  const keys = Object.keys(map);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete map[old];
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  // Concurrent hooks may race; rename keeps the file whole even if one update is lost.
  const tmp = `${sessionCwdPath(configDir)}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(map), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, sessionCwdPath(configDir));
}
