import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  spawn: () => {
    const child = { once: (event: string, cb: () => void) => { if (event === 'exit') setTimeout(cb, 0); return child; }, unref: () => {} };
    return child;
  },
}));

const { spawnInit } = await import('../src/connect.js');

describe.skipIf(process.platform === 'win32')('spawnInit', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // The log carries the sign-in URL and code, which together let any AgentDrive account claim the login.
  it('keeps the sign-in log and its folder private to the user, even when an older log was readable', async () => {
    dir = mkdtempSync(join(tmpdir(), 'adrive-connect-'));
    const fresh = join(dir, 'fresh', 'connect.log');
    await spawnInit(fresh);
    expect(statSync(fresh).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'fresh')).mode & 0o777).toBe(0o700);

    const old = join(dir, 'connect.log');
    writeFileSync(old, 'https://app.agentdrive.sh/cli-auth?id=cli_old', { mode: 0o644 });
    await spawnInit(old);
    expect(statSync(old).mode & 0o777).toBe(0o600);
  });
});
