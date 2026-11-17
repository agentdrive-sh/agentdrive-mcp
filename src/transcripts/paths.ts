import { homedir } from 'node:os';
import { join } from 'node:path';

export function codexHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return env.CODEX_HOME || join(home, '.codex');
}

export function opencodeDataDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode');
}
