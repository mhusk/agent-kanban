import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const dependencies = Object.keys(pkg.dependencies ?? {});

// Inline internal workspace packages (e.g., @agent-kanban/shared) into the bundle
// while keeping Firebase Admin/Functions, Express, Zod, and other npm deps external.
const external = dependencies.filter((dep) => !dep.startsWith('@agent-kanban/'));

await build({
  entryPoints: [path.join(__dirname, 'src/index.ts')],
  outfile: path.join(__dirname, 'dist/index.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external,
  logLevel: 'info',
});
