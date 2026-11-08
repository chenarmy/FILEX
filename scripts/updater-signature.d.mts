export interface UpdaterPublicKey {
  keyId: Buffer;
  ed25519Key: Buffer;
}

export function parseUpdaterPublicKey(publicKeyBase64: string): UpdaterPublicKey;

export function normalizeUpdaterSignature(signatureValue: string): string;

export function verifyUpdaterSignature(
  data: Buffer,
  signatureFileText: string,
  publicKey: UpdaterPublicKey,
): string;

export function signedVersionFromTrustedComment(trustedComment: string): string | null;

