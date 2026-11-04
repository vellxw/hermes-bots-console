import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
const project = join(dirname(script), '..');
const dist = join(project, 'dist');
const packageJson = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
const archiveRoot = `${packageJson.name}-${packageJson.version}`;
const archivePath = join(dist, `${archiveRoot}.tar.gz`);

execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: project, stdio: 'inherit' });
execFileSync(process.execPath, ['scripts/verify.mjs'], { cwd: project, stdio: 'inherit' });

const manifest = JSON.parse(await readFile(join(project, 'dashboard/manifest.json'), 'utf8'));
const activeAssetNames = new Set([
  manifest.entry, manifest.css, manifest.interaction_core,
  manifest.contracts, manifest.browser_flow,
  // ChatView loads this separately; it is not named in the manifest.
  'chat-core-v023.mjs',
]);
const excluded = (name) => name === 'catalog-entry.yaml'
  || name.startsWith('backups/')
  || name.startsWith('reports/')
  || name.startsWith('dist/')
  || name.startsWith('.git/')
  // User-facing install archives do not need development-only tooling.
  || name.startsWith('.github/')
  || name.startsWith('tests/')
  || name.startsWith('scripts/')
  || name.startsWith('launch/')
  || name === '.gitignore'
  || name === '.gitattributes'
  // Keep sources and active versioned bundles, but not historical bundle copies.
  || (/^dashboard\/(?:index|style|chat-core|interaction-core|contracts|browser-flow)-v\d+\.(?:js|css|mjs)$/.test(name)
      && !activeAssetNames.has(name.slice('dashboard/'.length)));
const tracked = execFileSync('git', ['ls-files', '--cached'], { cwd: project, encoding: 'utf8' })
  .split('\n')
  .map((value) => value.trim())
  .filter(Boolean)
  .filter((name) => !excluded(name))
  .sort();

function writeOctal(header, offset, length, value) {
  const encoded = `${value.toString(8).padStart(length - 1, '0')}\0`;
  header.write(encoded, offset, length, 'ascii');
}

function tarHeader(name, size) {
  const header = Buffer.alloc(512);
  const fullName = `${archiveRoot}/${name}`;
  const nameBytes = Buffer.byteLength(fullName);
  if (nameBytes <= 100) {
    header.write(fullName, 0, nameBytes, 'utf8');
  } else {
    const slash = fullName.lastIndexOf('/');
    const prefix = fullName.slice(0, slash);
    const suffix = fullName.slice(slash + 1);
    if (Buffer.byteLength(prefix) > 155 || Buffer.byteLength(suffix) > 100) throw new Error(`Archive path is too long: ${fullName}`);
    header.write(suffix, 0, Buffer.byteLength(suffix), 'utf8');
    header.write(prefix, 345, Buffer.byteLength(prefix), 'utf8');
  }
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((total, byte) => total + byte, 0);
  const encoded = `${checksum.toString(8).padStart(6, '0')}\0 `;
  header.write(encoded, 148, 8, 'ascii');
  return header;
}

const chunks = [];
for (const name of tracked) {
  const path = join(project, name);
  const info = await lstat(path);
  if (!info.isFile()) throw new Error(`Release input is not a regular file: ${name}`);
  const data = await readFile(path);
  chunks.push(tarHeader(name, data.length), data);
  const padding = (512 - (data.length % 512)) % 512;
  if (padding) chunks.push(Buffer.alloc(padding));
}
chunks.push(Buffer.alloc(1024));
const archive = gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
await mkdir(dist, { recursive: true });
await writeFile(archivePath, archive);
const digest = createHash('sha256').update(archive).digest('hex');
console.log(`Release archive: ${archivePath}`);
console.log(`SHA-256: ${digest}`);
console.log(`Files: ${tracked.length}`);
