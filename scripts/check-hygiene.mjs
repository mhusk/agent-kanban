import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ALLOWED_EMAIL_DOMAINS = new Set([
  'example.test',
  'example.com',
  'example.org',
  'users.noreply.github.com',
]);

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.zip',
  '.gz',
  '.tar',
]);

// Construct sensitive literals dynamically so this scanner file never self-triggers.
const SECRET_RULES = [
  {
    name: 'private-key-header',
    pattern: new RegExp('BEGIN\\s+(?:[A-Z0-9]+\\s+)*PRIVATE ' + 'KEY'),
  },
  {
    name: 'secret-key-prefix',
    pattern: new RegExp('\\bsk_' + '(?:live|test|staging)_[A-Za-z0-9_-]+'),
  },
  {
    name: 'agent-kanban-api-key',
    pattern: new RegExp('\\bak_' + '[A-Za-z0-9]{8}_[A-Za-z0-9_-]{20,}\\b'),
  },
  {
    name: 'google-api-key',
    pattern: new RegExp('\\bAI' + 'za[0-9A-Za-z_-]{35,}\\b'),
  },
  {
    name: 'workos-client-id',
    pattern: new RegExp('\\bclient_' + '01[0-9A-HJKMNP-TV-Z]{24}\\b'),
  },
];

const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g;
const SEMVER_LIKE_DOMAIN = /^\d+\.\d+\.\d+/;

/**
 * Checks whether a git-tracked relative path is a forbidden env, config, or credential file.
 * @param {string} relPath
 * @returns {string | null}
 */
export function checkForbiddenPath(relPath) {
  const normalized = relPath.replace(/\\/g, '/');
  const base = path.posix.basename(normalized);

  if (base.startsWith('.env') && base !== '.env.example') {
    return `Tracked environment file is forbidden: ${normalized}`;
  }
  if (base === '.firebaserc') {
    return `Tracked .firebaserc is forbidden (use .firebaserc.example): ${normalized}`;
  }
  if (base === '.hygiene-denylist.local') {
    return `Tracked local denylist file is forbidden: ${normalized}`;
  }
  if (/service-account.*\.json$/i.test(base) || /firebase-adminsdk.*\.json$/i.test(base)) {
    return `Tracked service account credential file is forbidden: ${normalized}`;
  }
  if (/\.(?:pem|key)$/i.test(base)) {
    return `Tracked private key / certificate file is forbidden: ${normalized}`;
  }

  return null;
}

/**
 * Loads optional local denylist terms (one per line, ignoring blanks and `#` comments).
 * @param {string} denylistPath
 * @returns {string[]}
 */
export function loadDenylist(denylistPath) {
  if (!fs.existsSync(denylistPath)) {
    return [];
  }
  const raw = fs.readFileSync(denylistPath, 'utf8');
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * Scans text content for secret patterns, non-placeholder emails, and denylisted terms.
 * @param {string} relPath
 * @param {string} content
 * @param {string[]} denylistTerms
 * @returns {Array<{ file: string; line: number; rule: string; message: string }>}
 */
export function scanContent(relPath, content, denylistTerms = []) {
  const findings = [];
  const lines = content.split(/\r?\n/);
  const lowerDenylist = denylistTerms.map((term) => ({
    raw: term,
    lower: term.toLowerCase(),
  }));

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const lineNum = i + 1;

    for (const rule of SECRET_RULES) {
      if (rule.pattern.test(line)) {
        findings.push({
          file: relPath,
          line: lineNum,
          rule: rule.name,
          message: `Matched secret pattern (${rule.name})`,
        });
      }
    }

    EMAIL_PATTERN.lastIndex = 0;
    let emailMatch = EMAIL_PATTERN.exec(line);
    while (emailMatch !== null) {
      const domain = (emailMatch[1] ?? '').toLowerCase();
      if (!SEMVER_LIKE_DOMAIN.test(domain) && !ALLOWED_EMAIL_DOMAINS.has(domain)) {
        findings.push({
          file: relPath,
          line: lineNum,
          rule: 'non-placeholder-email',
          message: `Non-placeholder email domain detected (@${domain})`,
        });
      }
      emailMatch = EMAIL_PATTERN.exec(line);
    }

    if (lowerDenylist.length > 0) {
      const lowerLine = line.toLowerCase();
      for (const entry of lowerDenylist) {
        if (lowerLine.includes(entry.lower)) {
          findings.push({
            file: relPath,
            line: lineNum,
            rule: 'local-denylist',
            message: `Matched local denylist term (${entry.raw.length} chars)`,
          });
        }
      }
    }
  }

  return findings;
}

/**
 * Returns true if buffer appears to be binary (contains a NUL byte in the first 8KB).
 * @param {Buffer} buffer
 */
function isBinaryBuffer(buffer) {
  const checkLen = Math.min(buffer.length, 8192);
  for (let i = 0; i < checkLen; i += 1) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}

/**
 * Lists all git-tracked files in `cwd`.
 * @param {string} cwd
 * @returns {string[]}
 */
export function listTrackedFiles(cwd) {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return out.split('\0').filter((entry) => entry.length > 0);
}

/**
 * Runs the full hygiene check across all git-tracked files in `cwd`.
 * @param {{ cwd?: string; denylistPath?: string; files?: string[] }} [options]
 * @returns {{ ok: boolean; scannedCount: number; findings: Array<{ file: string; line: number; rule: string; message: string }> }}
 */
export function runHygieneCheck(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const denylistPath = options.denylistPath ?? path.join(cwd, '.hygiene-denylist.local');
  const files = options.files ?? listTrackedFiles(cwd);
  const denylistTerms = loadDenylist(denylistPath);

  const findings = [];
  let scannedCount = 0;

  for (const relPath of files) {
    const pathViolation = checkForbiddenPath(relPath);
    if (pathViolation) {
      findings.push({
        file: relPath,
        line: 0,
        rule: 'forbidden-path',
        message: pathViolation,
      });
    }

    const fullPath = path.join(cwd, relPath);
    if (!fs.existsSync(fullPath)) {
      continue;
    }

    const stat = fs.lstatSync(fullPath);
    if (!stat.isFile()) {
      continue;
    }

    const ext = path.extname(relPath).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) {
      continue;
    }

    const buf = fs.readFileSync(fullPath);
    if (isBinaryBuffer(buf)) {
      continue;
    }

    scannedCount += 1;
    const content = buf.toString('utf8');
    findings.push(...scanContent(relPath, content, denylistTerms));
  }

  return {
    ok: findings.length === 0,
    scannedCount,
    findings,
  };
}

function main() {
  const result = runHygieneCheck();
  if (!result.ok) {
    console.error(`Hygiene check FAILED (${result.findings.length} finding(s)):`);
    for (const finding of result.findings) {
      const loc = finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file;
      console.error(`  - [${finding.rule}] ${loc}: ${finding.message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Hygiene check passed (${result.scannedCount} tracked file(s) scanned).`);
}

const isDirectExecution =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  main();
}
