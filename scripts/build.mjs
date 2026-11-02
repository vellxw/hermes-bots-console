import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const project = dirname(root);
const dashboard = join(project, 'dashboard');
const manifestPath = join(dashboard, 'manifest.json');
const packagePath = join(project, 'package.json');

const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
const sri = (bytes) => `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
const text = async (path) => readFile(path, 'utf8');

const manifest = JSON.parse(await text(manifestPath));
const packageJson = JSON.parse(await text(packagePath));
if (manifest.version !== packageJson.version) {
  throw new Error(`Manifest/package version mismatch: ${manifest.version} != ${packageJson.version}`);
}

const generatedAssets = new Map([
  [manifest.entry, 'index.js'],
  [manifest.css, 'style.css'],
  [manifest.interaction_core, 'interaction-core.mjs'],
  [manifest.contracts, 'contracts.mjs'],
  [manifest.browser_flow, 'browser-flow.mjs'],
]);
const assertAssetName = async (name, role, { allowMissing = false } = {}) => {
  if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\\')) throw new Error(`Invalid ${role} asset name: ${name}`);
  const path = join(dashboard, name);
  let info;
  try { info = await lstat(path); } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return path;
    throw error;
  }
  if (!info.isFile()) throw new Error(`${role} asset is not a regular file: ${name}`);
  return path;
};
for (const [targetName, sourceName] of generatedAssets) {
  const sourcePath = await assertAssetName(sourceName, 'source');
  const targetPath = await assertAssetName(targetName, 'generated', { allowMissing: true });
  const sourceBytes = await readFile(sourcePath);
  if (sourceName !== targetName) await writeFile(targetPath, sourceBytes);
}

const assetNames = [...generatedAssets.keys(), manifest.api];
const assets = [];
for (const name of assetNames) {
  const path = await assertAssetName(name, 'manifest');
  const bytes = await readFile(path);
  assets.push({ path: relative(project, path), sha256: digest('sha256', bytes), bytes: bytes.length });
}
const entryBytes = await readFile(join(dashboard, manifest.entry));
const cssBytes = await readFile(join(dashboard, manifest.css));
const sourceEntry = await readFile(join(dashboard, 'index.js'));
const sourceCss = await readFile(join(dashboard, 'style.css'));
if (!entryBytes.equals(sourceEntry)) throw new Error(`Cache-busted entry is not reproducible: ${manifest.entry}`);
if (!cssBytes.equals(sourceCss)) throw new Error(`Cache-busted CSS is not reproducible: ${manifest.css}`);
const entrySri = sri(entryBytes);
if (manifest.integrity !== entrySri) {
  manifest.integrity = entrySri;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

const output = {
  name: packageJson.name,
  version: packageJson.version,
  manifest: relative(project, manifestPath),
  entry: manifest.entry,
  css: manifest.css,
  entry_sri: manifest.integrity,
  assets,
};
const outputPath = join(project, 'dist', 'build-manifest.json');
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

const revision = (() => {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return 'working-tree'; }
})();
console.log(`Hermes Bot Command ${packageJson.version}: ${assets.length} assets verified; revision ${revision}`);
console.log(`Build manifest: ${relative(project, outputPath)}`);
