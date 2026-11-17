// Secret redactor. Runs on every payload before capture features upload
// content. Patterns are intentionally conservative — false positives are
// tagged and replaced with a safe marker; false negatives are the risk we
// optimize against.
//
// IMPORTANT: redaction is best-effort, not a security boundary. It is one
// layer in a defense-in-depth stack: .adriveignore for path-level deny,
// redactor for content-level scrub, optional client-side encryption for
// confidentiality.

export interface RedactionHit {
  kind: string;
  line: number;
  column: number;
  // The matched span's length, not the secret itself — we never persist the
  // plaintext anywhere outside the original buffer.
  length: number;
}

export interface RedactionResult {
  redacted: string;
  hits: RedactionHit[];
}

// Order matters: more specific patterns first so they win over the generic
// high-entropy fallback.
const PATTERNS: Array<{ kind: string; re: RegExp; marker: (m: string) => string }> = [
  // Provider-specific keys
  { kind: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{16}\b/g, marker: () => '[redacted:aws-access-key-id]' },
  { kind: 'aws-secret', re: /\b(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)[\s:=]+['"]?[A-Za-z0-9/+=]{40}['"]?/g, marker: () => '[redacted:aws-secret]' },
  { kind: 'gcp-service-account', re: /"private_key":\s*"-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----[^"]*"/g, marker: () => '"private_key":"[redacted:gcp-service-account]"' }, // gitleaks:allow
  { kind: 'stripe-secret', re: /\bsk_(?:live|test)_[A-Za-z0-9]{16,99}\b/g, marker: () => '[redacted:stripe-secret]' },
  { kind: 'stripe-restricted', re: /\brk_(?:live|test)_[A-Za-z0-9]{16,99}\b/g, marker: () => '[redacted:stripe-restricted]' },
  { kind: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g, marker: () => '[redacted:github-token]' },
  { kind: 'github-fine-grained', re: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g, marker: () => '[redacted:github-fine-grained]' },
  { kind: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, marker: () => '[redacted:anthropic-key]' },
  { kind: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, marker: () => '[redacted:openai-key]' },
  { kind: 'agentdrive-key', re: /\bagentdrive_live_[A-Za-z0-9]{16,}/g, marker: () => '[redacted:agentdrive-key]' },
  { kind: 'slack-bot-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, marker: () => '[redacted:slack-token]' },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, marker: () => '[redacted:jwt]' },
  // Private keys (PEM-style blocks). Match the whole block.
  { kind: 'private-key-pem', re: /-----BEGIN (?:RSA |OPENSSH |EC |DSA |ENCRYPTED |PRIVATE)?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |EC |DSA |ENCRYPTED |PRIVATE)?PRIVATE KEY-----/g, marker: () => '[redacted:private-key]' },
  // Generic high-entropy assignment forms: VAR=secret-looking-string
  { kind: 'env-secret', re: /\b(?:[A-Z][A-Z0-9_]*_(?:KEY|SECRET|TOKEN|PASS(?:WORD)?|PWD|CREDENTIAL))\s*[:=]\s*['"]?([A-Za-z0-9+/_=-]{16,})['"]?/g, marker: (m: string) => m.replace(/(.*?[:=]\s*['"]?)([A-Za-z0-9+/_=-]{16,})(['"]?)/, '$1[redacted:env-secret]$3') },
];

function offsetToLineCol(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lastNewline = i;
    }
  }
  return { line, column: offset - lastNewline };
}

export function redact(input: string): RedactionResult {
  let out = input;
  const hits: RedactionHit[] = [];

  for (const p of PATTERNS) {
    out = out.replace(p.re, (match, ..._args) => {
      // Locate this match in the *original* input for line/col reporting.
      // Using the original gives stable coordinates the user can verify.
      const idx = input.indexOf(match);
      if (idx >= 0) {
        const { line, column } = offsetToLineCol(input, idx);
        hits.push({ kind: p.kind, line, column, length: match.length });
      }
      return p.marker(match);
    });
  }

  return { redacted: out, hits };
}

export function summarizeHits(hits: RedactionHit[]): string {
  if (hits.length === 0) return 'no secrets detected';
  const counts: Record<string, number> = {};
  for (const h of hits) counts[h.kind] = (counts[h.kind] ?? 0) + 1;
  return Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .map(([k, n]) => `${k}×${n}`)
    .join(', ');
}
