import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const budgetKb = Number(process.env.BUNDLE_BUDGET_KB || 250);
const buildRoot = join(root, '.next', 'static', 'chunks');
const lockPath = join(root, 'package-lock.json');

function filesIn(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesIn(path) : [path];
  });
}

const bundles = filesIn(buildRoot).filter((file) => file.endsWith('.js'))
  .map((file) => ({ file: relative(root, file), bytes: statSync(file).size }))
  .sort((a, b) => b.bytes - a.bytes);
const largest = bundles[0]?.bytes ?? 0;
console.log(`Bundle budget: ${budgetKb} KB`);
for (const bundle of bundles.slice(0, 20)) console.log(`${(bundle.bytes / 1024).toFixed(1).padStart(8)} KB  ${bundle.file}`);

const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const versions = new Map();
for (const [path, packageInfo] of Object.entries(lock.packages ?? {})) {
  const match = path.match(/node_modules\/((?:@[^/]+\/)?[^/]+)$/);
  if (!match || !packageInfo.version) continue;
  const name = match[1];
  if (!versions.has(name)) versions.set(name, new Set());
  versions.get(name).add(packageInfo.version);
}
const duplicates = [...versions.entries()].filter(([, values]) => values.size > 1);
if (duplicates.length) {
  console.log('\nDuplicate transitive dependency versions:');
  for (const [name, values] of duplicates) console.log(`- ${name}: ${[...values].join(', ')}`);
}

if (largest > budgetKb * 1024) {
  console.error(`\nBundle budget exceeded: largest chunk is ${(largest / 1024).toFixed(1)} KB.`);
  process.exit(1);
}
console.log(`\nBundle budget passed; ${bundles.length} JavaScript chunks checked.`);
