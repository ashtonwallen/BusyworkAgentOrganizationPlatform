import {migration21} from './mission-attribution-schema.js';
import {migration20} from './campaign-schema.js';
import { PGlite, type Transaction } from "@electric-sql/pglite";
import {migration17} from './mission-schema.js';
import {migration18} from './delegation-schema.js';
import {migration19} from './evidence-schema.js';
import { migration1, migration2, migration3, migration4, migration5, migration6, migration7, migration8, migration9, migration10, migration11, migration12, migration13, migration14, migration15, migration16 } from "./schema.js";

export type Tx = Transaction;
export type Row = Record<string, any>;

export async function openDatabase(dataDir?: string) {
  const db = await PGlite.create({ dataDir: dataDir ?? "memory://", parsers: { 20: (value: string) => value } });
  await db.exec("CREATE TABLE IF NOT EXISTS hive_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  await db.transaction(async (tx) => {
    const applied = await tx.query("SELECT version FROM hive_migrations WHERE version = 1");
    if (!applied.rows.length) {
      await tx.exec(migration1);
      await tx.query("INSERT INTO company(id, daily_cap) VALUES (1, 10000000)");
      await tx.query("INSERT INTO hive_migrations(version) VALUES(1)");
      await event(tx, "company.initialized", "company", { status: "PAUSED" });
    }
  });
  await db.transaction(async (tx) => {
    const applied = await tx.query("SELECT version FROM hive_migrations WHERE version = 2");
    if (!applied.rows.length) {
      await tx.exec(migration2);
      await tx.query("INSERT INTO hive_migrations(version) VALUES(2)");
      await event(tx, "company.approval_defaults_enabled", "company");
    }
  });
  await db.transaction(async (tx) => {
    if (!(await tx.query("SELECT version FROM hive_migrations WHERE version=3")).rows.length) { await tx.exec(migration3); await tx.query("INSERT INTO hive_migrations(version) VALUES(3)"); }
  });
  await db.transaction(async (tx) => {
    if (!(await tx.query("SELECT version FROM hive_migrations WHERE version=4")).rows.length) { await tx.exec(migration4); await tx.query("INSERT INTO hive_migrations(version) VALUES(4)"); }
  });
  await db.transaction(async (tx) => {
    if (!(await tx.query("SELECT version FROM hive_migrations WHERE version=5")).rows.length) { await tx.exec(migration5); await tx.query("INSERT INTO hive_migrations(version) VALUES(5)"); }
  });
  // Most task updates did not maintain updated_at, so "what changed since" was unreliable.
  await db.transaction(async (tx) => {
    if (!(await tx.query("SELECT version FROM hive_migrations WHERE version=6")).rows.length) { await tx.exec(migration6); await tx.query("INSERT INTO hive_migrations(version) VALUES(6)"); }
  });
  // Agents are people with a working temperament, not interchangeable role slots.
  await db.transaction(async (tx) => {
    if (!(await tx.query("SELECT version FROM hive_migrations WHERE version=7")).rows.length) { await tx.exec(migration7); await tx.query("INSERT INTO hive_migrations(version) VALUES(7)"); }
  });
  // What the company already owns and is bound by. Agents read these; only the owner writes.
  await db.transaction(async (tx) => {
    if (!(await tx.query("SELECT version FROM hive_migrations WHERE version=8")).rows.length) { await tx.exec(migration8); await tx.query("INSERT INTO hive_migrations(version) VALUES(8)"); }
  });
  await db.transaction(async (tx) => {
    if (!(await tx.query("SELECT version FROM hive_migrations WHERE version=9")).rows.length) { await tx.exec(migration9); await tx.query("INSERT INTO hive_migrations(version) VALUES(9)"); }
  });
  await db.transaction(async tx => {
    if (!(await tx.query('SELECT version FROM hive_migrations WHERE version=10')).rows.length) { await tx.exec(migration10); await tx.query('INSERT INTO hive_migrations(version) VALUES(10)'); }
  });
  await db.transaction(async tx => {
    if (!(await tx.query('SELECT version FROM hive_migrations WHERE version=11')).rows.length) { await tx.exec(migration11); await tx.query('INSERT INTO hive_migrations(version) VALUES(11)'); }
  });
  await db.transaction(async tx => {
    if (!(await tx.query('SELECT version FROM hive_migrations WHERE version=12')).rows.length) { await tx.exec(migration12); await tx.query('INSERT INTO hive_migrations(version) VALUES(12)'); }
  });
  await db.transaction(async tx => {
    if (!(await tx.query('SELECT version FROM hive_migrations WHERE version=13')).rows.length) { await tx.exec(migration13); await tx.query('INSERT INTO hive_migrations(version) VALUES(13)'); }
  });
  await db.transaction(async tx => {
    if (!(await tx.query('SELECT version FROM hive_migrations WHERE version=14')).rows.length) { await tx.exec(migration14); await tx.query('INSERT INTO hive_migrations(version) VALUES(14)'); }
  });
  await db.transaction(async tx => {
    if (!(await tx.query('SELECT version FROM hive_migrations WHERE version=15')).rows.length) { await tx.exec(migration15); await tx.query('INSERT INTO hive_migrations(version) VALUES(15)'); }
  });
  await db.transaction(async tx => {
    if (!(await tx.query("SELECT version FROM hive_migrations WHERE version=16")).rows.length) { await tx.exec(migration16); await tx.query("INSERT INTO hive_migrations(version) VALUES(16)"); }
  });
  await db.transaction(async tx=>{
    if(!(await tx.query('SELECT version FROM hive_migrations WHERE version=17')).rows.length){await tx.exec(migration17);await tx.query('INSERT INTO hive_migrations(version) VALUES(17)');}
  });
  await db.transaction(async tx=>{
    if(!(await tx.query('SELECT version FROM hive_migrations WHERE version=18')).rows.length){await tx.exec(migration18);await tx.query('INSERT INTO hive_migrations(version) VALUES(18)');}
  });
  await db.transaction(async tx=>{
    if(!(await tx.query('SELECT version FROM hive_migrations WHERE version=19')).rows.length){await tx.exec(migration19);await tx.query('INSERT INTO hive_migrations(version) VALUES(19)');}
  });
  await db.transaction(async tx=>{if(!(await tx.query('SELECT version FROM hive_migrations WHERE version=20')).rows.length){await tx.exec(migration20);await tx.query('INSERT INTO hive_migrations(version) VALUES(20)');}});
  await db.transaction(async tx=>{if(!(await tx.query('SELECT version FROM hive_migrations WHERE version=21')).rows.length){await tx.exec(migration21);await tx.query('INSERT INTO hive_migrations(version) VALUES(21)');}});
  return db;
}

export async function one(tx: Pick<Tx, "query">, sql: string, args: unknown[] = []): Promise<Row> {
  const result = await tx.query<Row>(sql, args);
  if (!result.rows[0]) throw new Error("Record not found.");
  return result.rows[0];
}

export async function event(tx: Tx, type: string, entityId: string, payload: unknown = {}, actor = "system") {
  await tx.query("INSERT INTO events(type,entity_id,actor,payload) VALUES($1,$2,$3,$4)",
    [type, entityId, actor, JSON.stringify(payload)]);
}
