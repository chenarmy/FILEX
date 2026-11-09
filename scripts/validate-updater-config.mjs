import fs from 'node:fs';
import process from 'node:process';
import { parseUpdaterPublicKey } from './updater-signature.mjs';

function args() {
  const parsed = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    parsed.set(process.argv[index], process.argv[index + 1]);
  }
  return parsed;
}

function requireHttpsUrl(name, expected) {
  const value = process.env[name] ?? '';
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTPS URL`);
  }
  if (
    url.protocol !== 'https:'
    || !url.hostname
    || url.username
    || url.password
    || url.search
    || url.hash
    || value !== expected
  ) {
    throw new Error(`${name} does not match the approved FILEX release feed`);
  }
}

function containsTauriPrivateKey(value) {
  const matchesSecretKeyHeader = (text) => (
    /^untrusted comment: (?:minisign|rsign) (?:encrypted )?secret key(?=\s|:|$)/.test(text.trimStart())
  );
  if (matchesSecretKeyHeader(value)) return true;

  const normalized = value.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    return false;
  }
  return matchesSecretKeyHeader(Buffer.from(normalized, 'base64').toString('utf8'));
}

const flags = args();
const githubRepository = flags.get('--github-repository');
const cnbRepository = flags.get('--cnb-repository');
if (!githubRepository || !cnbRepository) {
  throw new Error('--github-repository and --cnb-repository are required');
}

const privateKey = process.env.TAURI_SIGNING_PRIVATE_KEY ?? '';
if (!privateKey || (!containsTauriPrivateKey(privateKey) && !fs.existsSync(privateKey))) {
  throw new Error('TAURI_SIGNING_PRIVATE_KEY must contain key content or an existing runner path');
}

parseUpdaterPublicKey(process.env.FILEX_UPDATER_PUBLIC_KEY ?? '');
requireHttpsUrl(
  'FILEX_UPDATER_STABLE_ENDPOINT',
  `https://github.com/${githubRepository}/releases/latest/download/latest.json`,
);
requireHttpsUrl(
  'FILEX_UPDATER_STABLE_MIRROR_ENDPOINT',
  `https://cnb.cool/${cnbRepository}/-/releases/latest/download/latest.json`,
);

console.log('Signed updater release configuration is valid.');

