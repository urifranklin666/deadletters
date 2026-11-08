const { spawnSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const javascriptExtensions = new Set(['.js', '.cjs', '.mjs']);
const excludedDirectories = new Set([
  '.git',
  'node_modules',
  'build',
  'coverage',
  'data',
  'dist',
  'exports',
  'logs',
  'temp_uploads',
  'uploads'
]);

function findJavaScriptFiles(directory) {
  const files = [];
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;

    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...findJavaScriptFiles(entryPath));
    } else if (entry.isFile() && javascriptExtensions.has(path.extname(entry.name))) {
      files.push(entryPath);
    }
  }

  return files;
}

const files = findJavaScriptFiles(rootDir);
const failures = [];

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    failures.push({ file, output: result.stderr || result.stdout });
  }
}

for (const failure of failures) {
  console.error(`\n${path.relative(rootDir, failure.file)}\n${failure.output.trim()}`);
}

if (failures.length > 0) {
  console.error(`\nSyntax check failed for ${failures.length} of ${files.length} JavaScript files.`);
  process.exitCode = 1;
} else {
  console.log(`Syntax check passed for ${files.length} JavaScript files.`);
}
