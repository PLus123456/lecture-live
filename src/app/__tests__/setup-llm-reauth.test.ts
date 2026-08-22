import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../setup/page.tsx', import.meta.url),
  'utf8'
);

describe('setup LLM current-password UI contract', () => {
  it('uses a separate current-password field and submits that value', () => {
    expect(source).toContain(
      "const [llmCurrentPassword, setLlmCurrentPassword] = useState('')"
    );
    expect(source).toMatch(/name="currentPassword"[\s\S]*?type="password"/);
    expect(source).toContain('autoComplete="current-password"');
    expect(source).toContain('currentPassword: llmCurrentPassword');
    expect(source).not.toContain('currentPassword: adminPassword');
  });

  it('clears both the completed admin password and each submitted reauth proof', () => {
    expect(source).toContain("setAdminPassword('')");
    expect(source).toMatch(/finally \{[\s\S]*?setLlmCurrentPassword\(''\)/);
  });
});
