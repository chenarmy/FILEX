import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { normalizeUpdaterSignature } from './updater-signature.mjs';

function args() {
  const parsed = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    parsed.set(process.argv[index], process.argv[index + 1]);
  }
  return parsed;
}

const flags = args();
const assetsDirectory = path.resolve(flags.get('--assets-dir') ?? 'release-assets');
const latestFile = path.resolve(flags.get('--latest-file') ?? path.join(assetsDirectory, 'latest.json'));
const repository = flags.get('--repository') ?? '';
const tag = flags.get('--tag') ?? '';

if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
  throw new Error('--repository must use owner/name format');
}
if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
  throw new Error('--tag must be a stable vMAJOR.MINOR.PATCH tag');
}

const assets = await readdir(assetsDirectory);
const signatures = new Map();
for (const signatureName of assets.filter((name) => name.endsWith('.sig'))) {
  const signature = normalizeUpdaterSignature(
    await readFile(path.join(assetsDirectory, signatureName), 'utf8'),
  );
  const matches = signatures.get(signature) ?? [];
  matches.push(signatureName);
  signatures.set(signature, matches);
}

const manifest = JSON.parse(await readFile(latestFile, 'utf8'));
if (!manifest.platforms || typeof manifest.platforms !== 'object') {
  throw new Error('latest.json has no platform map');
}

const releaseBase = `https://github.com/${repository}/releases/download/${tag}`;
for (const [platform, entry] of Object.entries(manifest.platforms)) {
  if (!entry || typeof entry !== 'object' || typeof entry.signature !== 'string') {
    throw new Error(`${platform} manifest entry has no signature`);
  }
  const matches = signatures.get(normalizeUpdaterSignature(entry.signature)) ?? [];
  if (matches.length !== 1) {
    throw new Error(`${platform} signature matches ${matches.length} detached signature assets`);
  }
  const assetName = matches[0].slice(0, -'.sig'.length);
  if (!assets.includes(assetName)) {
    throw new Error(`${platform} detached signature has no matching updater asset`);
  }
  entry.url = `${releaseBase}/${encodeURIComponent(assetName)}`;
}

await writeFile(latestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Normalized ${Object.keys(manifest.platforms).length} updater URLs for ${tag}.`);
