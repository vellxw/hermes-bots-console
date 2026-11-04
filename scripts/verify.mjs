import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
const project = join(script, '..', '..');
const forbidden = [/\/home\/[A-Za-z0-9._-]+(?:\/|$)/, /\/run\/user\/\d+(?:\/|$)/];
const secretAssignment = /(?:api[_-]?key|password|passwd|secret|token|connection[_-]?string)\s*[:=]\s*['"](?!\[REDACTED\]|FAKE_|CHANGE_ME|YOUR_|<)[^'"]{8,}['"]/i;
// Git reports tracked paths with forward slashes even on Windows.
// Never scan this verifier for the command patterns it deliberately detects.
const ignored = new Set(['scripts/verify.mjs', 'dashboard/novnc/rfb.bundle.js']);

function trackedFiles() {
  const output = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: project, encoding: 'utf8' });
  return output.split('\n').map((value) => value.trim()).filter(Boolean);
}

const manifest = JSON.parse(await readFile(join(project, 'dashboard', 'manifest.json'), 'utf8'));
const entryPath = join(project, 'dashboard', manifest.entry);
const entryBytes = await readFile(entryPath);
const actualSri = `sha384-${createHash('sha384').update(entryBytes).digest('base64')}`;
if (manifest.integrity !== actualSri) throw new Error('manifest.json integrity does not match its entry');
for (const required of ['LICENSE', 'NOTICE', 'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'README.md', 'catalog-entry.yaml', 'dashboard/novnc/LICENSE.txt', 'dashboard/novnc/vendor/pako/LICENSE']) {
  try { await stat(join(project, required)); } catch { throw new Error(`Missing required distribution file: ${required}`); }
}

const failures = [];
for (const file of trackedFiles()) {
  if (ignored.has(file)) continue;
  const path = join(project, file);
  const info = await stat(path);
  if (!info.isFile() || info.size > 30 * 1024 * 1024) continue;
  const contents = await readFile(path, 'utf8');
  for (const marker of forbidden) if (marker.test(contents)) failures.push(`${file}: private marker ${marker}`);
  if (secretAssignment.test(contents)) failures.push(`${file}: secret-like assignment`);
  if (/\b(?:auth|credentials|cookies?|sessions?)\.json\b/i.test(file)) failures.push(`${file}: private state filename`);
  if (/\b(?:systemctl|sudo\s+-S|sshpass)\b/.test(contents)) failures.push(`${file}: host-specific or secret-taking command`);
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

for (const file of trackedFiles().filter((value) => !ignored.has(value) && ['.js', '.mjs'].includes(extname(value)))) {
  execFileSync(process.execPath, ['--check', join(project, file)], { stdio: 'inherit' });
}
console.log(`Public distribution verification passed for ${trackedFiles().length} tracked files`);
console.log(`Entry SRI: ${manifest.integrity}`);
