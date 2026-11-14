import { Database } from 'bun:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { ProtocolError } from '../../dopame/src/domain/collaboration'

/** One process owns the SQLite connection and its exclusive OS lock for its entire lifetime. */
export function openStore(stateDir: string) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  chmodSync(stateDir, 0o700)
  const path = join(stateDir, 'documents.sqlite')
  const db = new Database(path, { strict: true })
  try {
    chmodSync(path, 0o600)
    db.exec('PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;')
    const journal = db.query('PRAGMA journal_mode').get() as { journal_mode: string }
    const locking = db.query('PRAGMA locking_mode').get() as { locking_mode: string }
    const synchronous = db.query('PRAGMA synchronous').get() as { synchronous: number }
    const foreignKeys = db.query('PRAGMA foreign_keys').get() as { foreign_keys: number }
    if (journal.journal_mode !== 'wal' || locking.locking_mode !== 'exclusive'
      || synchronous.synchronous !== 2 || foreignKeys.foreign_keys !== 1) {
      throw new ProtocolError('RECOVERY_REQUIRED', 'The target store does not provide the required locking and durability settings.')
    }
    const version = db.query('PRAGMA user_version').get() as { user_version: number }
    if (version.user_version !== 0 && version.user_version !== 1) {
      throw new ProtocolError('RECOVERY_REQUIRED', 'The stored collaboration schema is not supported.')
    }
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS principals (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1, generation INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS credential_records (
          hash TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES principals(id),
          expires_at TEXT NOT NULL, generation INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS grants (
          id TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES principals(id),
          scope TEXT NOT NULL, actions TEXT NOT NULL, expires_at TEXT NOT NULL,
          generation INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0,
          delegation_depth INTEGER NOT NULL DEFAULT 0, parent_id TEXT REFERENCES grants(id)
        );
        CREATE TABLE IF NOT EXISTS pairings (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, claim_hash TEXT NOT NULL,
          expires_at TEXT NOT NULL, state TEXT NOT NULL, principal_id TEXT REFERENCES principals(id)
        );
        CREATE TABLE IF NOT EXISTS documents (
          id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, epoch TEXT NOT NULL,
          revision TEXT NOT NULL, title TEXT NOT NULL, creator_id TEXT NOT NULL REFERENCES principals(id),
          workflow_id TEXT, saved_revision TEXT, binding_id TEXT, fence TEXT NOT NULL DEFAULT '0',
          sources TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS snapshots (
          doc_id TEXT NOT NULL REFERENCES documents(id), epoch TEXT NOT NULL,
          revision TEXT NOT NULL, data TEXT NOT NULL,
          PRIMARY KEY(doc_id,epoch,revision)
        );
        CREATE TABLE IF NOT EXISTS proposals (
          id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, epoch TEXT NOT NULL, base_revision TEXT NOT NULL,
          author_id TEXT NOT NULL REFERENCES principals(id), workflow_id TEXT,
          operations TEXT NOT NULL, reason TEXT NOT NULL, sources TEXT NOT NULL,
          digest TEXT NOT NULL, state TEXT NOT NULL, applied_revision TEXT, diff TEXT NOT NULL, created_at TEXT NOT NULL,
          FOREIGN KEY(doc_id,epoch,base_revision) REFERENCES snapshots(doc_id,epoch,revision)
        );
        CREATE TABLE IF NOT EXISTS approval_tickets (
          id TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES principals(id),
          binding TEXT NOT NULL, policy_version TEXT NOT NULL, consumed_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES principals(id),
          credential_hash TEXT NOT NULL, request_id TEXT NOT NULL, request TEXT NOT NULL,
          scope TEXT NOT NULL, action TEXT NOT NULL, state TEXT NOT NULL,
          cancel_requested INTEGER NOT NULL DEFAULT 0, result TEXT, error TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS idempotency_records (
          principal_id TEXT NOT NULL REFERENCES principals(id), request_id TEXT NOT NULL,
          digest TEXT NOT NULL, task_id TEXT REFERENCES tasks(id), result TEXT,
          PRIMARY KEY(principal_id,request_id)
        );
        CREATE TABLE IF NOT EXISTS events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          principal_id TEXT, scope TEXT NOT NULL, action TEXT NOT NULL,
          type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS event_cursors (
          hash TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES principals(id),
          sequence INTEGER NOT NULL, expires_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS page_cursors (
          hash TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES principals(id),
          kind TEXT NOT NULL, context TEXT NOT NULL, position INTEGER NOT NULL, expires_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS writer_leases (
          doc_id TEXT PRIMARY KEY REFERENCES documents(id), owner_session TEXT NOT NULL,
          fence TEXT NOT NULL, service_epoch TEXT NOT NULL, expires_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS window_sessions (
          id TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES principals(id),
          doc_id TEXT NOT NULL REFERENCES documents(id), data TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS recovery_drafts (
          id TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES principals(id),
          doc_id TEXT NOT NULL REFERENCES documents(id), base TEXT NOT NULL,
          markdown TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS artifacts (
          id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, epoch TEXT NOT NULL, revision TEXT NOT NULL,
          data BLOB NOT NULL, digest TEXT NOT NULL, filename TEXT NOT NULL, creator_id TEXT NOT NULL REFERENCES principals(id),
          created_at TEXT NOT NULL,
          FOREIGN KEY(doc_id,epoch,revision) REFERENCES snapshots(doc_id,epoch,revision)
        );
        CREATE TABLE IF NOT EXISTS handoffs (
          id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES artifacts(id),
          sender_id TEXT NOT NULL REFERENCES principals(id), recipient_id TEXT NOT NULL REFERENCES principals(id),
          purpose TEXT NOT NULL, expires_at TEXT NOT NULL, grant_id TEXT NOT NULL REFERENCES grants(id),
          state TEXT NOT NULL, receipt TEXT, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS resource_bindings (
          id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES documents(id), workspace_id TEXT NOT NULL,
          alias TEXT, data TEXT NOT NULL, UNIQUE(workspace_id,alias)
        );
        CREATE TABLE IF NOT EXISTS save_outbox (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
          doc_id TEXT NOT NULL, epoch TEXT NOT NULL, revision TEXT NOT NULL,
          binding_id TEXT NOT NULL REFERENCES resource_bindings(id), state TEXT NOT NULL,
          before_digest TEXT, after_digest TEXT NOT NULL, result TEXT,
          FOREIGN KEY(doc_id,epoch,revision) REFERENCES snapshots(doc_id,epoch,revision)
        );
        CREATE TABLE IF NOT EXISTS undo_records (
          id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES documents(id),
          before_ref TEXT NOT NULL, after_ref TEXT NOT NULL, inverse_changes TEXT NOT NULL,
          proposal_id TEXT NOT NULL REFERENCES proposals(id), undone INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS reverse_proposals (
          undo_id TEXT PRIMARY KEY REFERENCES undo_records(id),
          proposal_id TEXT NOT NULL UNIQUE REFERENCES proposals(id)
        );
        PRAGMA user_version=1;
      `)
    })()
    return db
  } catch (error) {
    db.close()
    if (error instanceof ProtocolError) throw error
    throw new ProtocolError('WRITER_BUSY', 'The collaboration store is locked or unavailable.', true)
  }
}
