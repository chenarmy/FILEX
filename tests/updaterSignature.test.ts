import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  normalizeUpdaterSignature,
  parseUpdaterPublicKey,
  signedVersionFromTrustedComment,
  verifyUpdaterSignature,
} from '../scripts/updater-signature.mjs';

function fixture(version = '0.1.0') {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicJwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;
  if (!publicJwk.x) throw new Error('Generated public key has no raw Ed25519 coordinate');

  const keyId = randomBytes(8);
  const publicKeyBytes = Buffer.concat([
    Buffer.from('ED'),
    keyId,
    Buffer.from(publicJwk.x, 'base64url'),
  ]);
  const publicKeyFile = [
    'untrusted comment: minisign public key: 0102030405060708',
    publicKeyBytes.toString('base64'),
    '',
  ].join('\n');

  const artifact = Buffer.from(`FILEX release fixture ${version}`, 'utf8');
  const signature = sign(
    null,
    createHash('blake2b512').update(artifact).digest(),
    privateKey,
  );
  const trustedComment = `timestamp:1770000000\tfile:FILEX.fixture\tversion:${version}`;
  const globalSignature = sign(
    null,
    Buffer.concat([signature, Buffer.from(trustedComment, 'utf8')]),
    privateKey,
  );
  const signatureFile = [
    'untrusted comment: signature from minisign secret key',
    Buffer.concat([Buffer.from('ED'), keyId, signature]).toString('base64'),
    `trusted comment: ${trustedComment}`,
    globalSignature.toString('base64'),
    '',
  ].join('\n');

  return {
    artifact,
    publicKeyBase64: Buffer.from(publicKeyFile, 'utf8').toString('base64'),
    signatureFile,
    trustedComment,
    version,
  };
}

describe('release updater signature verification', () => {
  it('verifies the artifact, trusted comment and signed version', () => {
    const release = fixture();
    const publicKey = parseUpdaterPublicKey(release.publicKeyBase64);
    const trustedComment = verifyUpdaterSignature(
      release.artifact,
      release.signatureFile,
      publicKey,
    );

    expect(trustedComment).toBe(release.trustedComment);
    expect(signedVersionFromTrustedComment(trustedComment)).toBe(release.version);
    expect(normalizeUpdaterSignature(Buffer.from(release.signatureFile).toString('base64')))
      .toBe(release.signatureFile.trim());
  });

  it('rejects modified update data', () => {
    const release = fixture();
    const publicKey = parseUpdaterPublicKey(release.publicKeyBase64);

    expect(() => verifyUpdaterSignature(
      Buffer.from('tampered release'),
      release.signatureFile,
      publicKey,
    )).toThrow('Artifact signature verification failed');
  });

  it('rejects a signature made by a different update key', () => {
    const release = fixture();
    const differentRelease = fixture();
    const differentPublicKey = parseUpdaterPublicKey(differentRelease.publicKeyBase64);

    expect(() => verifyUpdaterSignature(
      release.artifact,
      release.signatureFile,
      differentPublicKey,
    )).toThrow('different public key');
  });
});
