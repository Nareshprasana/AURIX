// Standard-library cryptography only (node:crypto). No custom primitives:
// ed25519 signatures, X25519 ECDH → HKDF-SHA256 → AES-256-GCM authenticated
// encryption. Envelope version 'gcm-ed25519-v1' (see plan §8 re age/XChaCha).
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign as edSignRaw,
  verify as edVerifyRaw
} from 'node:crypto';

export function sha256hexText(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function generateSignKeypair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  };
}

export function generateBoxKeypair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  };
}

export function edSign(privatePem: string, data: Buffer): string {
  return edSignRaw(null, data, createPrivateKey(privatePem)).toString('base64');
}

export function edVerify(publicPem: string, data: Buffer, sigB64: string): boolean {
  try {
    return edVerifyRaw(null, data, createPublicKey(publicPem), Buffer.from(sigB64, 'base64'));
  } catch {
    return false;
  }
}

export interface SealedEnvelope {
  ephemeral_pub: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

export function sealToRecipient(recipientX25519PubPem: string, plaintext: Buffer): SealedEnvelope {
  const ephemeral = generateKeyPairSync('x25519');
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: createPublicKey(recipientX25519PubPem) });
  const key = hkdfSync('sha256', shared, Buffer.from('aurix-sync-v1'), 'aurix-sync-enc', 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ephemeral_pub: ephemeral.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64')
  };
}

export function openSealed(ownX25519PrivPem: string, env: SealedEnvelope): Buffer {
  const shared = diffieHellman({
    privateKey: createPrivateKey(ownX25519PrivPem),
    publicKey: createPublicKey(env.ephemeral_pub)
  });
  const key = hkdfSync('sha256', shared, Buffer.from('aurix-sync-v1'), 'aurix-sync-enc', 32);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
  // Throws on wrong key / tampered bytes (GCM auth) — fail closed.
  return Buffer.concat([decipher.update(Buffer.from(env.ciphertext, 'base64')), decipher.final()]);
}
