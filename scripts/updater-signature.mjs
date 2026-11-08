import { createHash, createPublicKey, verify } from 'node:crypto';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const TRUSTED_COMMENT_PREFIX = 'trusted comment: ';

function decodeBase64Bytes(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is empty`);
  }
  const normalized = value.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw new Error(`${label} is not valid base64`);
  }
  return Buffer.from(normalized, 'base64');
}

function decodeBase64Text(value, label) {
  const bytes = decodeBase64Bytes(value, label);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} does not contain UTF-8 text`);
  }
}

export function normalizeUpdaterSignature(signatureValue) {
  const trimmed = signatureValue.trim();
  if (trimmed.startsWith('untrusted comment:')) {
    return trimmed;
  }
  return decodeBase64Text(trimmed, 'Detached signature').trim();
}

export function parseUpdaterPublicKey(publicKeyBase64) {
  const publicKeyFile = decodeBase64Text(publicKeyBase64, 'FILEX_UPDATER_PUBLIC_KEY');
  const [comment, encodedKey] = publicKeyFile.trim().split(/\r?\n/);
  if (!comment?.startsWith('untrusted comment: minisign public key')) {
    throw new Error('FILEX_UPDATER_PUBLIC_KEY does not contain a Minisign public-key file');
  }

  const keyBytes = decodeBase64Bytes(encodedKey, 'Minisign public key');
  if (keyBytes.length !== 42) {
    throw new Error(`Minisign public key has ${keyBytes.length} bytes; expected 42`);
  }
  const algorithm = keyBytes.subarray(0, 2);
  if (!isSupportedAlgorithm(algorithm)) {
    throw new Error('Minisign public key uses an unsupported algorithm');
  }

  return {
    keyId: keyBytes.subarray(2, 10),
    ed25519Key: keyBytes.subarray(10, 42),
  };
}

function isSupportedAlgorithm(algorithm) {
  return (algorithm[0] === 0x45 && algorithm[1] === 0x44)
    || (algorithm[0] === 0x45 && algorithm[1] === 0x64);
}

export function verifyUpdaterSignature(data, signatureFileText, publicKey) {
  const lines = normalizeUpdaterSignature(signatureFileText).split(/\r?\n/);
  if (lines.length < 4 || !lines[0].startsWith('untrusted comment:')) {
    throw new Error('Detached signature is not a Minisign signature');
  }
  if (!lines[2].startsWith(TRUSTED_COMMENT_PREFIX)) {
    throw new Error('Detached signature has no trusted comment');
  }

  const signatureBytes = decodeBase64Bytes(lines[1], 'Minisign signature');
  const globalSignature = decodeBase64Bytes(lines[3], 'Minisign global signature');
  if (signatureBytes.length !== 74 || globalSignature.length !== 64) {
    throw new Error('Detached signature has invalid field lengths');
  }

  const algorithm = signatureBytes.subarray(0, 2);
  if (!isSupportedAlgorithm(algorithm)) {
    throw new Error('Detached signature uses an unsupported algorithm');
  }
  const keyId = signatureBytes.subarray(2, 10);
  if (!keyId.equals(publicKey.keyId)) {
    throw new Error('Detached signature was created with a different public key');
  }

  const signature = signatureBytes.subarray(10, 74);
  const message = algorithm[1] === 0x44
    ? createHash('blake2b512').update(data).digest()
    : data;
  const keyObject = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey.ed25519Key]),
    format: 'der',
    type: 'spki',
  });
  if (!verify(null, message, keyObject, signature)) {
    throw new Error('Artifact signature verification failed');
  }

  const trustedComment = lines[2].slice(TRUSTED_COMMENT_PREFIX.length);
  const globalMessage = Buffer.concat([signature, Buffer.from(trustedComment, 'utf8')]);
  if (!verify(null, globalMessage, keyObject, globalSignature)) {
    throw new Error('Trusted-comment signature verification failed');
  }

  return trustedComment;
}

export function signedVersionFromTrustedComment(trustedComment) {
  return trustedComment
    .split('\t')
    .find((field) => field.startsWith('version:'))
    ?.slice('version:'.length) ?? null;
}

