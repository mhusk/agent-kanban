import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
while (args[0] === '--') {
  args.shift();
}

const result = spawnSync('playwright', ['test', ...args], {
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
