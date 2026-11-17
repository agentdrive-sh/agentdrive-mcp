import { describe, it, expect } from 'vitest';
import { redact } from '../src/redactor.js';

describe('redactor', () => {
  it('catches AWS access key ids', () => {
    const { redacted, hits } = redact('aws id: AKIAIOSFODNN7EXAMPLE\n');
    expect(redacted).toMatch(/\[redacted:aws-access-key-id\]/);
    expect(hits.some((h) => h.kind === 'aws-access-key-id')).toBe(true);
  });

  it('catches Stripe live secrets', () => {
    const sample = `STRIPE_SECRET=sk_live_${'a'.repeat(40)}`;
    const { redacted, hits } = redact(sample);
    expect(redacted).toMatch(/\[redacted:stripe-secret\]/);
    expect(hits.some((h) => h.kind === 'stripe-secret')).toBe(true);
  });

  it('catches GitHub personal access tokens', () => {
    const { redacted, hits } = redact(`token = ghp_${'A'.repeat(40)}`);
    expect(redacted).toMatch(/\[redacted:github-token\]/);
    expect(hits.length).toBe(1);
  });

  it('catches Anthropic and OpenAI keys', () => {
    const ant = redact(`KEY=sk-ant-${'a'.repeat(40)}`);
    expect(ant.redacted).toMatch(/\[redacted:anthropic-key\]/);
    const oai = redact(`KEY=sk-proj-${'a'.repeat(40)}`);
    expect(oai.redacted).toMatch(/\[redacted:(openai|anthropic)-key\]/);
  });

  it('catches AgentDrive own keys', () => {
    const { redacted } = redact(`x=agentdrive_live_abcdef0123456789`);
    expect(redacted).toMatch(/\[redacted:agentdrive-key\]/);
  });

  it('catches JWTs', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'; // gitleaks:allow
    const { redacted } = redact(jwt);
    expect(redacted).toMatch(/\[redacted:jwt\]/);
  });

  it('catches private key PEM blocks (single line)', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END PRIVATE KEY-----';
    const { redacted } = redact(pem);
    expect(redacted).toMatch(/\[redacted:private-key\]/);
  });

  it('redacts generic env-style secrets (length gate)', () => {
    const { redacted } = redact('DB_PASSWORD=hunter2longenoughtomatch1234'); // gitleaks:allow
    expect(redacted).toMatch(/\[redacted:env-secret\]/);
  });

  it('leaves non-secret text alone', () => {
    const text = 'Hello world.\nThis is a doc with no secrets in it.';
    const { redacted, hits } = redact(text);
    expect(redacted).toBe(text);
    expect(hits.length).toBe(0);
  });

  it('reports line/column for each hit', () => {
    const text = `line one\nAKIAIOSFODNN7EXAMPLE here\nline three`;
    const { hits } = redact(text);
    expect(hits[0]!.line).toBe(2);
    expect(hits[0]!.column).toBeGreaterThan(0);
  });
});
