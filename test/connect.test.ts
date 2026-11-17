import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnector, extractSignIn, waitFor } from '../src/connect.js';

const SIGN_IN = 'Opening browser to log in...\n  https://agentdrive.sh/cli-auth?id=abc\n\n  Code: WXYZ-2345\n';

describe('extractSignIn', () => {
  it('finds the cli-auth URL and the code in CLI output, colored or not', () => {
    expect(extractSignIn(SIGN_IN)).toEqual({ url: 'https://agentdrive.sh/cli-auth?id=abc', code: 'WXYZ-2345' });
    const colored = '  \x1b[36mhttps://app.agentdrive.sh/cli-auth?id=x-9\x1b[39m\n\n  Code: \x1b[1m\x1b[33mABCD-EFGH\x1b[39m\x1b[22m\n';
    expect(extractSignIn(colored)).toEqual({ url: 'https://app.agentdrive.sh/cli-auth?id=x-9', code: 'ABCD-EFGH' });
  });

  it('returns undefined until both the URL and the code have been printed', () => {
    expect(extractSignIn('npm warn exec The following package was not found\nhttps://agentdrive.sh')).toBeUndefined();
    expect(extractSignIn('Opening browser to log in...\n  https://agentdrive.sh/cli-auth?id=abc\n')).toBeUndefined();
  });
});

describe('waitFor', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('gives up with undefined after the timeout', async () => {
    const probe = vi.fn(() => undefined);
    const result = waitFor(probe, { intervalMs: 2_000, timeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await result).toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(6);
  });
});

describe('createConnector', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    let log = '';
    let apiKey: string | undefined;
    let finishInit: () => void = () => {};
    const spawnInit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishInit = resolve;
        }),
    );
    const onConnected = vi.fn();
    const connect = createConnector({
      logPath: '/cfg/connect.log',
      spawnInit,
      readLog: () => log,
      probeConnected: () => (apiKey ? { apiKey } : undefined),
      onConnected,
    });
    return {
      connect,
      spawnInit,
      onConnected,
      setLog: (text: string) => (log = text),
      setKey: (key: string) => (apiKey = key),
      finishInit: () => finishInit(),
    };
  }

  it('returns the sign-in URL and code once the CLI prints them', async () => {
    const t = setup();
    const result = t.connect();
    await vi.advanceTimersByTimeAsync(500);
    t.setLog(SIGN_IN);
    await vi.advanceTimersByTimeAsync(500);
    const text = await result;
    expect(text).toContain('A browser window was opened');
    expect(text).toContain('URL: https://agentdrive.sh/cli-auth?id=abc');
    expect(text).toContain('Code: WXYZ-2345');
  });

  it('points at the log when no URL shows up in time', async () => {
    const t = setup();
    const result = t.connect();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(await result).toContain('/cfg/connect.log');
  });

  it('does not spawn a second init while one is in flight, and respawns after it exits', async () => {
    const t = setup();
    t.setLog(SIGN_IN);
    await t.connect();
    const second = await t.connect();
    expect(t.spawnInit).toHaveBeenCalledTimes(1);
    expect(second).toContain('already in progress');
    expect(second).toContain('cli-auth?id=abc');
    expect(second).toContain('WXYZ-2345');

    t.finishInit();
    await vi.advanceTimersByTimeAsync(0);
    await t.connect();
    expect(t.spawnInit).toHaveBeenCalledTimes(2);
  });

  it('calls onConnected once when the API key lands in the config', async () => {
    const t = setup();
    t.setLog(SIGN_IN);
    await t.connect();
    await t.connect();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(t.onConnected).not.toHaveBeenCalled();

    t.setKey('agentdrive_live_k');
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.onConnected).toHaveBeenCalledTimes(1);
    expect(t.onConnected).toHaveBeenCalledWith({ apiKey: 'agentdrive_live_k' });
  });
});
