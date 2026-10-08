// Device identity: persistent, stable across restarts. Never hostname/IP/MAC.
// Keys: ed25519 (signing) + x25519 (ECDH) PEM files under keys/ (never in packages).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { DeviceIdentity, DeviceKeyPair } from '@aurix/sync-protocol';
import { generateBoxKeypair, generateSignKeypair } from './crypto.js';

export interface IdentityStore {
  identity: DeviceIdentity;
  keys: DeviceKeyPair;
}

function hex(n: number): string {
  return randomBytes(n).toString('hex');
}

export function ensureIdentity(syncDir: string): IdentityStore {
  mkdirSync(syncDir, { recursive: true });
  const identityFile = join(syncDir, 'identity.json');
  const keysDir = join(syncDir, 'keys');
  mkdirSync(keysDir, { recursive: true });
  let identity: DeviceIdentity;
  if (existsSync(identityFile)) {
    identity = JSON.parse(readFileSync(identityFile, 'utf8')) as DeviceIdentity;
    if (!identity.device_id || !identity.installation_id || identity.identity_version !== 1) {
      throw new Error('IDENTITY_CORRUPT: identity.json invalid');
    }
  } else {
    identity = {
      device_id: `dev-${hex(16)}`,
      installation_id: `inst-${hex(16)}`,
      created_at: Date.now(),
      identity_version: 1
    };
    writeFileSync(identityFile, JSON.stringify(identity, null, 2), { mode: 0o600 });
  }
  const signFile = join(keysDir, 'sign.json');
  const boxFile = join(keysDir, 'box.json');
  let sign: { publicKey: string; privateKey: string };
  let box: { publicKey: string; privateKey: string };
  if (existsSync(signFile) && existsSync(boxFile)) {
    sign = JSON.parse(readFileSync(signFile, 'utf8')) as { publicKey: string; privateKey: string };
    box = JSON.parse(readFileSync(boxFile, 'utf8')) as { publicKey: string; privateKey: string };
  } else {
    sign = generateSignKeypair();
    box = generateBoxKeypair();
    writeFileSync(signFile, JSON.stringify(sign, null, 2), { mode: 0o600 });
    writeFileSync(boxFile, JSON.stringify(box, null, 2), { mode: 0o600 });
  }
  const keys: DeviceKeyPair = {
    device_id: identity.device_id,
    ed25519_public: sign.publicKey,
    ed25519_private: sign.privateKey,
    x25519_public: box.publicKey,
    x25519_private: box.privateKey
  };
  return { identity, keys };
}
