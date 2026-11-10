/**
 * Persistence layer: SQLite via better-sqlite3. One file per budget + one system database.
 * Schema changes go through numbered migrations (PRAGMA user_version), each applied atomically.
 */
import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';

export type DB = Database.Database;
export const newId = () => randomBytes(12).toString('hex');
export const nowIso = () => new Date().toISOString();

const BUDGET_MIGRATIONS: string[] = [
  `
  CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE accounts(
    id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(length(name) > 0), type TEXT NOT NULL,
    on_budget INTEGER NOT NULL CHECK(on_budget IN (0,1)), closed INTEGER NOT NULL DEFAULT 0 CHECK(closed IN (0,1)),
    sort_order INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '', source_id TEXT);
  CREATE TABLE category_groups(
    id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(length(name) > 0), sort_order INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1)), note TEXT NOT NULL DEFAULT '',
    system INTEGER NOT NULL DEFAULT 0, source_id TEXT);
  CREATE TABLE categories(
    id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES category_groups(id), name TEXT NOT NULL CHECK(length(name) > 0),
    sort_order INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1)),
    note TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'normal' CHECK(kind IN ('normal','income_this','income_next')),
    source_id TEXT);
  CREATE TABLE payees(
    id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(length(name) > 0), norm TEXT NOT NULL,
    auto_category_id TEXT REFERENCES categories(id), source_id TEXT);
  CREATE UNIQUE INDEX payees_name ON payees(name COLLATE NOCASE);
  CREATE INDEX payees_norm ON payees(norm);
  CREATE TABLE transactions(
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    date TEXT NOT NULL CHECK(date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    payee_id TEXT REFERENCES payees(id),
    category_id TEXT REFERENCES categories(id),
    memo TEXT NOT NULL DEFAULT '',
    amount INTEGER NOT NULL CHECK(typeof(amount) = 'integer'),
    cleared TEXT NOT NULL DEFAULT 'uncleared' CHECK(cleared IN ('uncleared','cleared','reconciled')),
    flag TEXT CHECK(flag IS NULL OR flag IN ('red','orange','yellow','green','blue','purple')),
    transfer_account_id TEXT REFERENCES accounts(id),
    transfer_txn_id TEXT,
    parent_id TEXT REFERENCES transactions(id),
    is_split INTEGER NOT NULL DEFAULT 0 CHECK(is_split IN (0,1)),
    import_id TEXT, source TEXT, source_id TEXT,
    created_at TEXT NOT NULL,
    CHECK(NOT (is_split = 1 AND category_id IS NOT NULL)),
    CHECK(NOT (is_split = 1 AND parent_id IS NOT NULL)),
    CHECK((transfer_account_id IS NULL) = (transfer_txn_id IS NULL)),
    CHECK(transfer_account_id IS NULL OR transfer_account_id <> account_id));
  CREATE INDEX tx_account_date ON transactions(account_id, date, seq);
  CREATE INDEX tx_category_date ON transactions(category_id, date) WHERE category_id IS NOT NULL;
  CREATE INDEX tx_parent ON transactions(parent_id) WHERE parent_id IS NOT NULL;
  CREATE INDEX tx_transfer ON transactions(transfer_txn_id) WHERE transfer_txn_id IS NOT NULL;
  CREATE INDEX tx_import ON transactions(account_id, import_id) WHERE import_id IS NOT NULL;
  CREATE INDEX tx_payee ON transactions(payee_id);
  CREATE INDEX tx_date ON transactions(date);
  CREATE TABLE monthly_budgets(
    month TEXT NOT NULL CHECK(month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
    category_id TEXT NOT NULL REFERENCES categories(id),
    budgeted INTEGER NOT NULL DEFAULT 0 CHECK(typeof(budgeted) = 'integer'),
    overspending TEXT CHECK(overspending IS NULL OR overspending IN ('affects_buffer','confined')),
    note TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(month, category_id));
  CREATE TABLE month_notes(month TEXT PRIMARY KEY, note TEXT NOT NULL DEFAULT '');
  CREATE TABLE scheduled(
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), next_date TEXT NOT NULL,
    frequency TEXT NOT NULL, anchor_day INTEGER, payee_id TEXT REFERENCES payees(id),
    category_id TEXT REFERENCES categories(id), memo TEXT NOT NULL DEFAULT '',
    amount INTEGER NOT NULL CHECK(typeof(amount) = 'integer'), flag TEXT,
    transfer_account_id TEXT REFERENCES accounts(id), splits TEXT NOT NULL DEFAULT '[]', source_id TEXT);
  CREATE TABLE reconciliations(
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), at TEXT NOT NULL,
    statement_balance INTEGER NOT NULL, cleared_before INTEGER NOT NULL, adjustment INTEGER NOT NULL DEFAULT 0,
    adjustment_txn_id TEXT, tx_count INTEGER NOT NULL);
  CREATE TABLE imports(
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, fingerprint TEXT NOT NULL, at TEXT NOT NULL, summary TEXT NOT NULL);
  CREATE INDEX imports_fp ON imports(fingerprint);
  CREATE TABLE payee_rules(
    id TEXT PRIMARY KEY, match_type TEXT NOT NULL CHECK(match_type IN ('exact','contains','regex')),
    pattern TEXT NOT NULL, payee_name TEXT, category_id TEXT REFERENCES categories(id),
    transfer_account_id TEXT REFERENCES accounts(id),
    origin TEXT NOT NULL DEFAULT 'user' CHECK(origin IN ('user','learned')), uses INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE undo_state(id INTEGER PRIMARY KEY CHECK(id = 1), active INTEGER NOT NULL, grp INTEGER NOT NULL);
  INSERT INTO undo_state VALUES(1, 0, 0);
  CREATE TABLE undo_groups(grp INTEGER PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL, at TEXT NOT NULL);
  CREATE TABLE undo_log(seq INTEGER PRIMARY KEY AUTOINCREMENT, grp INTEGER NOT NULL, sql TEXT NOT NULL);
  CREATE INDEX undo_log_grp ON undo_log(grp);
  INSERT INTO category_groups(id, name, sort_order, system) VALUES('group:income', 'Income', -1, 1);
  INSERT INTO categories(id, group_id, name, sort_order, kind) VALUES
    ('income:this', 'group:income', 'Available this month', 0, 'income_this'),
    ('income:next', 'group:income', 'Available next month', 1, 'income_next');
  `,
];

/** Tables whose changes are recorded for undo/redo. */
const UNDO_TABLES = ['accounts', 'category_groups', 'categories', 'payees', 'transactions', 'monthly_budgets',
  'month_notes', 'scheduled', 'reconciliations', 'payee_rules', 'meta'];

const SYSTEM_MIGRATIONS: string[] = [
  `
  CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE users(
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
    totp_secret TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0, totp_last_step INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL);
  CREATE TABLE sessions(
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf TEXT NOT NULL,
    created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, ip TEXT, user_agent TEXT);
  CREATE TABLE passkeys(
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, public_key BLOB NOT NULL,
    counter INTEGER NOT NULL, transports TEXT, name TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE budgets(id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, last_opened TEXT);
  CREATE TABLE audit(seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, event TEXT NOT NULL, ip TEXT, detail TEXT);
  `,
];

function migrate(db: DB, migrations: string[]) {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > migrations.length) throw new Error(`Database schema (v${current}) is newer than this application supports (v${migrations.length}).`);
  for (let v = current; v < migrations.length; v++) {
    db.transaction(() => { db.exec(migrations[v]); db.pragma(`user_version = ${v + 1}`); })();
  }
}

function open(file: string): DB {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

export const BUDGET_SCHEMA_VERSION = BUDGET_MIGRATIONS.length;

export function openBudgetDb(file: string): DB {
  const db = open(file);
  migrate(db, BUDGET_MIGRATIONS);
  installUndoTriggers(db);
  return db;
}
export function openSystemDb(file: string): DB {
  const db = open(file);
  migrate(db, SYSTEM_MIGRATIONS);
  return db;
}

/** (Re)creates temp-free, persistent undo triggers. Idempotent; regenerated on open so they follow the schema. */
function installUndoTriggers(db: DB) {
  db.transaction(() => {
    for (const t of UNDO_TABLES) {
      const info = db.pragma(`table_info(${t})`) as { name: string; type: string; pk: number }[];
      const cols = info.map(c => c.name);
      const pks = info.filter(c => c.pk > 0);
      // a single INTEGER PRIMARY KEY column *is* the rowid; listing both would name the column twice
      const rowidCol = pks.length === 1 && pks[0].type.toUpperCase() === 'INTEGER' ? '' : 'rowid,';
      const rowidVal = rowidCol ? `' || OLD.rowid || ',` : '';
      const when = `WHEN (SELECT active FROM undo_state) = 1`;
      const grp = `(SELECT grp FROM undo_state)`;
      db.exec(`DROP TRIGGER IF EXISTS _undo_${t}_i; DROP TRIGGER IF EXISTS _undo_${t}_u; DROP TRIGGER IF EXISTS _undo_${t}_d;`);
      db.exec(`CREATE TRIGGER _undo_${t}_i AFTER INSERT ON ${t} ${when} BEGIN
        INSERT INTO undo_log(grp, sql) VALUES(${grp}, 'DELETE FROM ${t} WHERE rowid=' || NEW.rowid); END;`);
      db.exec(`CREATE TRIGGER _undo_${t}_u AFTER UPDATE ON ${t} ${when} BEGIN
        INSERT INTO undo_log(grp, sql) VALUES(${grp}, 'UPDATE ${t} SET ${cols.map(c => `${c}=' || quote(OLD.${c}) || '`).join(',')} WHERE rowid=' || OLD.rowid); END;`);
      db.exec(`CREATE TRIGGER _undo_${t}_d BEFORE DELETE ON ${t} ${when} BEGIN
        INSERT INTO undo_log(grp, sql) VALUES(${grp}, 'INSERT INTO ${t}(${rowidCol}${cols.join(',')}) VALUES(${rowidVal}${cols.map(c => `' || quote(OLD.${c}) || '`).join(',')})'); END;`);
    }
  })();
}
