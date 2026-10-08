// Transports move opaque immutable files. They never parse knowledge and never
// touch live databases. SyncthingTransport is the folder-integration point for a
// Syncthing-shared directory (no dependency on Syncthing internals/daemon).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KnowledgeTransferTransport } from '@aurix/sync-protocol';
import { isValidPackageName } from '@aurix/sync-protocol';

const DIRS = ['outgoing', 'incoming', 'processed', 'rejected'] as const;

export function ensureLayout(root: string): void {
  for (const d of DIRS) mkdirSync(join(root, d), { recursive: true });
}

export class LocalFilesystemTransport implements KnowledgeTransferTransport {
  readonly kind: string = 'local-filesystem';
  constructor(private rootDir: string) {
    ensureLayout(rootDir);
  }
  root(): string { return this.rootDir; }
  outgoingDir(): string { return join(this.rootDir, 'outgoing'); }
  incomingDir(): string { return join(this.rootDir, 'incoming'); }
  processedDir(): string { return join(this.rootDir, 'processed'); }
  rejectedDir(): string { return join(this.rootDir, 'rejected'); }

  stageOutgoing(packageId: string, content: string): string {
    const name = `${packageId}.akpkg.json`;
    if (!isValidPackageName(name)) throw new Error(`INVALID_PACKAGE_NAME: ${packageId}`);
    const path = join(this.outgoingDir(), name);
    if (existsSync(path)) throw new Error(`PACKAGE_EXISTS: immutable packages are never overwritten (${name})`);
    writeFileSync(path, content);
    return path;
  }

  listIncoming(): string[] {
    return readdirSync(this.incomingDir()).filter((f) => isValidPackageName(f)).sort();
  }

  /** Files Syncthing may have dropped that are NOT valid packages (audited, ignored). */
  listUnexpected(): string[] {
    return readdirSync(this.incomingDir()).filter((f) => !isValidPackageName(f)).sort();
  }

  readIncoming(name: string): string {
    if (!isValidPackageName(name)) throw new Error(`INVALID_PACKAGE_NAME: ${name}`);
    return readFileSync(join(this.incomingDir(), name), 'utf8');
  }

  markProcessed(name: string): void {
    renameSync(join(this.incomingDir(), name), join(this.processedDir(), name));
  }

  markRejected(name: string): void {
    renameSync(join(this.incomingDir(), name), join(this.rejectedDir(), name));
  }

  /** Simulate transport delivery (used by tests; Syncthing does this in production). */
  deliver(outgoingName: string, to: LocalFilesystemTransport): void {
    copyFileSync(join(this.outgoingDir(), outgoingName), join(to.incomingDir(), outgoingName));
  }
}

export const STIGNORE = `# AURIX Syncthing rules — transfer dirs ONLY. Live databases are NEVER synced.
!/outgoing/*.akpkg.json
!/incoming/*.akpkg.json
!/processed/*.akpkg.json
!/rejected/*.akpkg.json
*.db
*.db-wal
*.db-shm
*.log
node_modules
.venv
*.pem
*.key
secrets
*
`;

export class SyncthingTransport extends LocalFilesystemTransport {
  override readonly kind = 'syncthing-folder';
  override deliver(_outgoingName: string, _to: LocalFilesystemTransport): void {
    throw new Error('SYNCTHING_TRANSPORT: delivery is performed by the Syncthing daemon, not AURIX');
  }
  stignore(): string {
    return STIGNORE;
  }
  /** Fail closed if a live database ever appears under the sync root. */
  assertNoLiveDb(): string[] {
    const found: string[] = [];
    for (const d of DIRS) {
      const dir = join(this.root(), d);
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (/\.db(-wal|-shm)?$/i.test(f)) found.push(join(d, f));
      }
    }
    if (found.length > 0) throw new Error(`LIVE_DB_IN_SYNC_ROOT: ${found.join(',')}`);
    return found;
  }
}
