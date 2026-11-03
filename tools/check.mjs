import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const roots = ['public', 'server', 'relay', 'tests', 'tools'];
const files = ['server.mjs'];
for (const root of roots) for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
  if (entry.isFile() && /\.(mjs|js)$/.test(entry.name)) files.push(`${entry.parentPath}/${entry.name}`);
}
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding:'utf8' });
  if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(result.status || 1); }
}
console.log(`Syntax checked: ${files.length} JavaScript files`);
