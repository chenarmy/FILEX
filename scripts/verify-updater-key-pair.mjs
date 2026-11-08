import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseUpdaterPublicKey,
  signedVersionFromTrustedComment,
  verifyUpdaterSignature,
} from './updater-signature.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = (process.argv[2] ?? process.env.GITHUB_REF_NAME ?? '').replace(/^v/i, '');
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error('Usage: node scripts/verify-updater-key-pair.mjs <major.minor.patch>');
}

const publicKey = parseUpdaterPublicKey(process.env.FILEX_UPDATER_PUBLIC_KEY ?? '');
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'filex-updater-keypair-'));
const fixturePath = path.join(temporaryDirectory, 'release-signature-fixture.bin');

try {
  await writeFile(fixturePath, randomBytes(256));
  const result = spawnSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'tauri', 'signer', 'sign', fixturePath, '--app-version', version],
    {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (result.status !== 0) {
    throw new Error('Tauri could not sign with the configured private key');
  }

  const signatureFile = await readFile(`${fixturePath}.sig`, 'utf8');
  const fixture = await readFile(fixturePath);
  const trustedComment = verifyUpdaterSignature(fixture, signatureFile, publicKey);
  const signedVersion = signedVersionFromTrustedComment(trustedComment);
  if (signedVersion === null || signedVersion.replace(/^v/i, '') !== version) {
    throw new Error('The configured Tauri CLI did not sign the expected application version');
  }

  console.log(`Updater key pair matches and signs version ${version}.`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

