import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkForbiddenPath, runHygieneCheck, scanContent } from '../check-hygiene.mjs';

const tempDirs: string[] = [];

function createTempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-kanban-hygiene-'));
  tempDirs.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('checkForbiddenPath', () => {
  it('flags env files, firebaserc, denylist, service accounts, and private key files', () => {
    expect(checkForbiddenPath('.env')).not.toBeNull();
    expect(checkForbiddenPath('.env.local')).not.toBeNull();
    expect(checkForbiddenPath('apps/api/.env.production')).not.toBeNull();
    expect(checkForbiddenPath('.firebaserc')).not.toBeNull();
    expect(checkForbiddenPath('.hygiene-denylist.local')).not.toBeNull();
    expect(checkForbiddenPath('secrets/prod-service-account.json')).not.toBeNull();
    expect(checkForbiddenPath('my-app-firebase-adminsdk-abc12.json')).not.toBeNull();
    expect(checkForbiddenPath('certs/local.pem')).not.toBeNull();
    expect(checkForbiddenPath('certs/private.key')).not.toBeNull();
  });

  it('allows safe example templates and normal source files', () => {
    expect(checkForbiddenPath('.env.example')).toBeNull();
    expect(checkForbiddenPath('.firebaserc.example')).toBeNull();
    expect(checkForbiddenPath('packages/shared/src/index.ts')).toBeNull();
  });
});

describe('scanContent', () => {
  it('detects secret patterns', () => {
    const fakePem = '-----BEGIN RSA PRIVATE ' + 'KEY-----\nMIIEowIBAAK...';
    const fakeLiveKey = 'token = "sk_' + 'live_1234567890abcdef"';
    const fakeTestKey = 'token = "sk_' + 'test_abcdef1234567890"';
    const fakeApiKey = 'key = "ak_' + '1234abcd_0123456789abcdefghij"';
    const fakeGoogleKey = 'apiKey = "AI' + 'zaSyA12345678901234567890123456789012"';

    expect(scanContent('a.txt', fakePem)).toHaveLength(1);
    expect(scanContent('a.txt', fakeLiveKey)).toHaveLength(1);
    expect(scanContent('a.txt', fakeTestKey)).toHaveLength(1);
    expect(scanContent('a.txt', fakeApiKey)).toHaveLength(1);
    expect(scanContent('a.txt', fakeGoogleKey)).toHaveLength(1);
  });

  it('allows placeholder email domains and flags non-placeholder emails', () => {
    const safeContent = [
      'alex@example.test',
      'sam@example.com',
      'contact@example.org',
      '12345+dev@users.noreply.github.com',
      'some-pkg@1.2.3-rc.alpha',
    ].join('\n');
    expect(scanContent('safe.ts', safeContent)).toHaveLength(0);

    const leakedEmail = 'owner = "someone' + '@' + 'personal-mail.invalid"';
    const findings = scanContent('bad.ts', leakedEmail);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('non-placeholder-email');
  });

  it('matches local denylist terms case-insensitively', () => {
    const findings = scanContent('notes.md', 'Contains ForbiddenToken42 inside prose.', [
      'forbiddentoken42',
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('local-denylist');
  });
});

describe('runHygieneCheck end-to-end against a git repo', () => {
  it('passes on clean tracked files and fails when a deliberate test secret or denylist term is tracked', () => {
    const repoDir = createTempGitRepo();
    fs.writeFileSync(
      path.join(repoDir, 'clean.ts'),
      'export const fixtureEmail = "alex@example.test";\n',
    );
    fs.writeFileSync(
      path.join(repoDir, '.hygiene-denylist.local'),
      '# Local private guard\nSecretTownName\n',
    );
    execFileSync('git', ['add', 'clean.ts'], { cwd: repoDir });

    const cleanResult = runHygieneCheck({ cwd: repoDir });
    expect(cleanResult.ok).toBe(true);
    expect(cleanResult.scannedCount).toBe(1);

    // Introduce a deliberate temporary test string matching the local denylist and secret rule
    const badFile = path.join(repoDir, 'leaked.ts');
    fs.writeFileSync(
      badFile,
      `export const leak = "Visiting secrettownname";\nexport const k = "sk_${'live_'}demo987654321";\n`,
    );
    execFileSync('git', ['add', 'leaked.ts'], { cwd: repoDir });

    const badResult = runHygieneCheck({ cwd: repoDir });
    expect(badResult.ok).toBe(false);
    expect(badResult.findings.map((f) => f.rule)).toEqual(
      expect.arrayContaining(['local-denylist', 'secret-key-prefix']),
    );
  });
});
