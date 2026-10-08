// @aurix/sync-manager — deterministic knowledge sync engine.
// Transport moves opaque files; this engine validates, detects divergence and
// conflicts, and merges. Knowledge writes go only through KnowledgeStore.
export { SyncManager, SyncError, EVENT_SCHEMA_VERSION, PACKAGE_VERSION } from './manager.js';
export type { SyncManagerOptions, MergeResult } from './manager.js';
export { ensureIdentity, type IdentityStore } from './identity.js';
export {
  generateSignKeypair, generateBoxKeypair, edSign, edVerify,
  sealToRecipient, openSealed, sha256hexText, type SealedEnvelope
} from './crypto.js';
export { LocalFilesystemTransport, SyncthingTransport, STIGNORE, ensureLayout } from './transport.js';
