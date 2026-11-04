import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A catalog pointing to a published tag must describe THAT tag's asset,
// not an unreleased dashboard bundle from a development branch.
const project = dirname(dirname(fileURLToPath(import.meta.url)));
const catalog = await readFile(join(project, 'catalog-entry.yaml'), 'utf8');
function required(field, pattern) {
  const match = catalog.match(pattern);
  if (!match) throw new Error(`catalog-entry.yaml: missing or invalid ${field}`);
  return match[1];
}
const version = required('version', /^version:\s*(\d+\.\d+\.\d+(?:-[\w.-]+)?)\s*$/m);
const ref = required('source.ref', /^\s+ref:\s*(v[\w.-]+)\s*$/m);
const sri = required('integrity.entry_sri', /^\s+entry_sri:\s*(sha384-[a-zA-Z0-9+/=]+)\s*$/m);
const manifestPath = required('integrity.manifest', /^\s+manifest:\s*(dashboard\/[\w.-]+\.json)\s*$/m);
if (ref !== `v${version}`) throw new Error(`catalog ref ${ref} does not match version ${version}`);
function taggedFile(path) {
  return execFileSync('git', ['show', `refs/tags/${ref}:${path}`], { cwd: project });
}
const manifest = JSON.parse(taggedFile(manifestPath).toString('utf8'));
if (manifest.version !== version) throw new Error('tagged manifest and catalog versions differ');
if (!/^[\w.-]+\.js$/.test(manifest.entry)) throw new Error('tagged manifest has invalid entry');
const actual = `sha384-${createHash('sha384').update(taggedFile(`dashboard/${manifest.entry}`)).digest('base64')}`;
if (manifest.integrity !== actual) throw new Error('published-tag manifest SRI does not match entry');
if (sri !== actual) throw new Error('catalog entry_sri differs from the pinned published tag');
console.log(`Published tag integrity verified: ${ref} ${actual}`);
