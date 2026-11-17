import { spawn } from 'node:child_process';
import { closeSync, fchmodSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

export const CONNECT_INSTRUCTIONS =
  'AgentDrive is installed but not connected to an account yet, so it runs in local mode. ' +
  'When the user asks to continue work from another agent or session, call `drive_sessions` and `drive_resume`: they read the other agents\' transcripts on this machine and need no account. ' +
  'The workspace tools need an account. When the user wants them, or wants sessions synced across machines or shared with teammates, offer to connect and call `drive_connect`. ' +
  'It opens the user\'s browser to sign in once and returns a code the user types on that page, then connects all of their installed agent tools; the AgentDrive tools appear in this session when sign-in completes.';

export const CONNECT_DESCRIPTION =
  'Connect AgentDrive to the user\'s account: opens their browser to sign in once and returns the sign-in URL and a code, then connects all their installed agent tools. Call this when the user wants to use AgentDrive, and show the user both the URL and the code it returns.';

// Unref'd so a pending sign-in watch never keeps the server alive after its client disconnects.
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

export function extractSignIn(log: string): { url: string; code: string } | undefined {
  // The CLI may color its output, so stop at an ANSI escape as well as whitespace.
  const url = log.match(/https?:\/\/[^\s\x1b]*\/cli-auth\?id=[^\s\x1b]+/)?.[0];
  const code = log.match(/Code:\s*(?:\x1b\[[\d;]*m)*([A-Z0-9]{4}-[A-Z0-9]{4})/)?.[1];
  return url && code ? { url, code } : undefined;
}

export async function waitFor<T>(
  probe: () => T | undefined,
  { intervalMs, timeoutMs }: { intervalMs: number; timeoutMs: number },
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined || Date.now() >= deadline) return value;
    await sleep(intervalMs);
  }
}

export function spawnInit(logPath: string): Promise<void> {
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  // Truncated per attempt so a sign-in URL from an earlier run is never mistaken for the current one.
  // Private: the log holds the sign-in URL and code, which together let any AgentDrive account claim this login.
  const fd = openSync(logPath, 'w', 0o600);
  try {
    // Windows has no POSIX modes; there the profile directory's ACL already keeps the log private.
    if (process.platform !== 'win32') fchmodSync(fd, 0o600);
    const child = spawn('npx', ['-y', '@adrive/cli', 'init', '--yes'], {
      detached: true,
      stdio: ['ignore', fd, fd],
      shell: process.platform === 'win32',
    });
    child.unref();
    return new Promise((resolve) => {
      child.once('exit', () => resolve());
      child.once('error', () => resolve());
    });
  } finally {
    closeSync(fd);
  }
}

export interface ConnectorDeps<C> {
  logPath: string;
  spawnInit: () => Promise<void>;
  readLog: () => string;
  probeConnected: () => C | undefined;
  onConnected: (client: C) => void;
  urlWait?: { intervalMs: number; timeoutMs: number };
  connectWait?: { intervalMs: number; timeoutMs: number };
}

export function createConnector<C>(deps: ConnectorDeps<C>): () => Promise<string> {
  const urlWait = deps.urlWait ?? { intervalMs: 250, timeoutMs: 8_000 };
  const connectWait = deps.connectWait ?? { intervalMs: 2_000, timeoutMs: 15 * 60_000 };
  let initRunning = false;
  let watching = false;

  return async () => {
    const alreadyRunning = initRunning;
    if (!initRunning) {
      initRunning = true;
      void deps.spawnInit().then(() => {
        initRunning = false;
      });
    }
    if (!watching) {
      watching = true;
      void waitFor(deps.probeConnected, connectWait).then((client) => {
        watching = false;
        if (client !== undefined) deps.onConnected(client);
      });
    }

    const signIn = await waitFor(() => extractSignIn(deps.readLog()), urlWait);
    const after =
      'After sign-in, AgentDrive connects the user\'s agent tools automatically and its tools appear in this session. ' +
      'If they do not appear, reconnect the agentdrive MCP server or start a new session.';
    if (signIn) {
      const lead = alreadyRunning ? 'Sign-in is already in progress.' : 'A browser window was opened to sign in to AgentDrive.';
      return (
        `${lead} Show the user this URL and code now; they open the URL if the browser did not, and type the code on that page to finish signing in.\n` +
        `URL: ${signIn.url}\nCode: ${signIn.code}\n${after}`
      );
    }
    return `AgentDrive sign-in is starting, but the sign-in URL and code are not ready yet. Progress, the URL and the code are written to ${deps.logPath}.\n${after}`;
  };
}
