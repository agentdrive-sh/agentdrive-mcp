import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it.each(['agentdrive-session-handoff', 'agentdrive-artifact-search'])('publishes install instructions for %s', name => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  expect(readme).toContain(`skills add agentdrive-sh/agentdrive-mcp --skill ${name}`);
  const skill = readFileSync(new URL(`../plugins/agentdrive/skills/${name}/SKILL.md`, import.meta.url), 'utf8');
  expect(skill).toContain(`\nname: ${name}\n`);
  expect(skill).toMatch(/\ndescription: .+\n/);
  expect(skill).toContain('https://agentdrive.sh/docs/');
});
