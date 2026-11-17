// Functional TranscriptSource interface — per eng-review decision E4.
//
// A source knows two things:
// 1. `enumerate(opts)` — find candidate sessions on disk
// 2. `parseSession(entry)` — turn one session into a TranscriptDoc
//
// Everything else (redact, encrypt, manifest, upload, run upsert) is
// centralized in packages/cli/src/lib/sync.ts so the cross-cutting concerns can't drift
// between harnesses.

import type { SessionHarness, SessionTool, SessionTurn } from '../session.js';

export type TranscriptPlatform = SessionHarness;
export type TranscriptTurn = SessionTurn;
export type TranscriptTool = SessionTool;

export interface TranscriptEntry {
  sessionId: string;
  // Absolute transcript path; for OpenCode, which has no transcript file,
  // the session id.
  path: string;
  mtime: Date;
  // Known cwd when the transcript itself doesn't carry one (from the hook
  // payload, or Gemini's project hash).
  cwd?: string;
}

export interface TranscriptDoc {
  entry: TranscriptEntry;
  turns: TranscriptTurn[];
  cwd?: string;
  title?: string;
  // As written by the agent: absolute, or relative to `cwd`.
  filesTouched: string[];
}

export interface EnumerateOptions {
  home: string;
  since?: Date;
  configDir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface TranscriptSource {
  platform: TranscriptPlatform;
  enumerate(opts: EnumerateOptions): Promise<TranscriptEntry[]>;
  parseSession(entry: TranscriptEntry): Promise<TranscriptDoc | null>;
}
