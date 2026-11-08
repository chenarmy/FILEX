import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  normalizeUpdaterSignature,
  parseUpdaterPublicKey,
  signedVersionFromTrustedComment,
  verifyUpdaterSignature,
} from './updater-signature.mjs';

const REQUIRED_ASSETS = [
  ['Windows NSIS installer', /_x64-setup\.exe$/],
  ['Windows NSIS signature', /_x64-setup\.exe\.sig$/],
  ['Windows MSI installer', /_x64_en-US\.msi$/],
  ['Windows MSI signature', /_x64_en-US\.msi\.sig$/],
  ['Linux AppImage', /_amd64\.AppImage$/],
  ['Linux AppImage signature', /_amd64\.AppImage\.sig$/],
  ['Linux DEB package', /_amd64\.deb$/],
  ['Linux DEB signature', /_amd64\.deb\.sig$/],
  ['macOS DMG', /\.dmg$/],
  ['macOS updater bundle', /\.app\.tar\.gz$/],
  ['macOS updater signature', /\.app\.tar\.gz\.sig$/],
  ['Updater manifest', /^latest\.json$/],
];

const REQUIRED_PLATFORMS = ['windows-x86_64', 'linux-x86_64', 'darwin-aarch64'];

function args() {
  const parsed = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    parsed.set(process.argv[index], process.argv[index + 1]);
  }
  return parsed;
}

function normalizeVersion(value) {
  return String(value).trim().replace(/^v/i, '');
}

function findAsset(assets, pattern, label) {
  const matches = assets.filter((name) => pattern.test(name));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label}, found ${matches.length}`);
  }
  return matches[0];
}

function assertReleaseUrl(rawUrl, expectedBase, assetName, platform) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${platform} manifest URL is invalid`);
  }
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error(`${platform} manifest URL must be a clean HTTPS URL`);
  }
  const normalizedBase = expectedBase.replace(/\/$/, '');
  if (!rawUrl.startsWith(`${normalizedBase}/`)) {
    throw new Error(`${platform} manifest URL points outside the approved release feed`);
  }
  const referencedName = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
  if (referencedName !== assetName) {
    throw new Error(`${platform} manifest references an unexpected asset name`);
  }
}

const flags = args();
const assetsDirectory = path.resolve(flags.get('--assets-dir') ?? 'release-assets');
const latestFile = path.resolve(flags.get('--latest-file') ?? path.join(assetsDirectory, 'latest.json'));
const expectedVersion = normalizeVersion(flags.get('--version') ?? process.env.GITHUB_REF_NAME ?? '');
const tag = flags.get('--tag') ?? (expectedVersion ? `v${expectedVersion}` : '');
const repository = flags.get('--repository');
const expectedBase = flags.get('--base-url')
  ?? (repository ? `https://github.com/${repository}/releases/download/${tag}` : '');
const publicKey = parseUpdaterPublicKey(flags.get('--public-key') ?? process.env.FILEX_UPDATER_PUBLIC_KEY ?? '');

if (!/^\d+\.\d+\.\d+$/.test(expectedVersion)) {
  throw new Error('--version must be a stable semantic version');
}
if (!expectedBase) {
  throw new Error('--base-url or --repository is required');
}

const directoryEntries = await fs.readdir(assetsDirectory, { withFileTypes: true });
const assets = directoryEntries.filter((entry) => entry.isFile()).map((entry) => entry.name);
if (assets.length !== REQUIRED_ASSETS.length) {
  throw new Error(`Release has ${assets.length} assets; expected exactly ${REQUIRED_ASSETS.length}`);
}
for (const [label, pattern] of REQUIRED_ASSETS) {
  findAsset(assets, pattern, label);
}

const manifest = JSON.parse(await fs.readFile(latestFile, 'utf8'));
if (normalizeVersion(manifest.version) !== expectedVersion) {
  throw new Error(`latest.json announces version ${manifest.version}; expected ${expectedVersion}`);
}
if (!manifest.pub_date || Number.isNaN(Date.parse(manifest.pub_date))) {
  throw new Error('latest.json has an invalid pub_date');
}
if (!manifest.platforms || typeof manifest.platforms !== 'object') {
  throw new Error('latest.json has no platform map');
}
for (const platform of REQUIRED_PLATFORMS) {
  if (!manifest.platforms[platform]) {
    throw new Error(`latest.json is missing ${platform}`);
  }
}

for (const [platform, entry] of Object.entries(manifest.platforms)) {
  if (
    !entry
    || typeof entry.url !== 'string'
    || typeof entry.signature !== 'string'
    || !entry.signature
  ) {
    throw new Error(`${platform} manifest entry is incomplete`);
  }

  const assetName = decodeURIComponent(new URL(entry.url).pathname.split('/').at(-1) ?? '');
  const assetPath = path.resolve(assetsDirectory, assetName);
  if (path.dirname(assetPath) !== assetsDirectory || !assets.includes(assetName)) {
    throw new Error(`${platform} references an asset outside the verified set`);
  }
  assertReleaseUrl(entry.url, expectedBase, assetName, platform);

  const signatureName = `${assetName}.sig`;
  const signaturePath = path.resolve(assetsDirectory, signatureName);
  if (path.dirname(signaturePath) !== assetsDirectory || !assets.includes(signatureName)) {
    throw new Error(`${platform} has no detached signature asset`);
  }

  const signatureFileText = await fs.readFile(signaturePath, 'utf8');
  if (
    normalizeUpdaterSignature(entry.signature)
    !== normalizeUpdaterSignature(signatureFileText)
  ) {
    throw new Error(`${platform} manifest signature differs from its detached signature`);
  }

  const artifact = await fs.readFile(assetPath);
  const trustedComment = verifyUpdaterSignature(artifact, signatureFileText, publicKey);
  const signedVersion = signedVersionFromTrustedComment(trustedComment);
  if (signedVersion === null) {
    throw new Error(`${platform} signature has no signed version`);
  }
  if (normalizeVersion(signedVersion) !== expectedVersion) {
    throw new Error(`${platform} artifact was signed for ${signedVersion}, not ${expectedVersion}`);
  }
}

console.log(
  `Verified FILEX ${expectedVersion}: ${assets.length} assets, `
  + `${Object.keys(manifest.platforms).length} update targets and all Minisign signatures.`,
);

