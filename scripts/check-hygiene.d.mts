export interface HygieneFinding {
  file: string;
  line: number;
  rule: string;
  message: string;
}

export interface HygieneResult {
  ok: boolean;
  scannedCount: number;
  findings: HygieneFinding[];
}

export interface HygieneOptions {
  cwd?: string;
  denylistPath?: string;
  files?: string[];
}

export function checkForbiddenPath(relPath: string): string | null;
export function loadDenylist(denylistPath: string): string[];
export function scanContent(
  relPath: string,
  content: string,
  denylistTerms?: string[],
): HygieneFinding[];
export function listTrackedFiles(cwd: string): string[];
export function runHygieneCheck(options?: HygieneOptions): HygieneResult;
