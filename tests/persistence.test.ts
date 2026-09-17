import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, HiveService, createModels, one, writeDocument, createStaticRelease } from '../packages/runtime/src/index.js';
it('reopens durable state without duplicating migrations or losing exact money and approvals', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hive-persistence-')); let db: Awaited<ReturnType<typeof openDatabase>> | undefined;
  try {
    db = await openDatabase(join(directory, 'postgres')); let service = new HiveService(db, createModels({}));
    await service.recordMoney({ kind: 'FUNDING', amountUsd: '123.123456', description: 'Offline persistence fixture', externalReference: 'fixture-persist', idempotencyKey: 'fixture-persist' });
    const { id } = await service.createAction({ actionType: 'PUBLISH', target: 'fixture-site', payload: { text: 'Draft' }, rationale: 'Fixture', maxCostUsd: '0', expiresAt: new Date(Date.now() + 3600000).toISOString() });
    const release=await db.transaction(async tx=>{await writeDocument(tx,{path:'index.html',title:'Page',content:'<h1>Durable release</h1>',expectedVersion:0},'owner');return createStaticRelease(tx,{requestId:'33333333-3333-4333-8333-333333333333',title:'Persisted release',siteId:'22222222-2222-4222-8222-222222222222',files:[{path:'index.html',documentPath:'index.html',version:1}]},'owner');});
    const a = await one(db, 'SELECT * FROM actions WHERE id=$1', [id]); await service.approveAction(id, a.action_hash, 'APPROVE', 'Fixture'); await db.close(); db = undefined;
    db = await openDatabase(join(directory, 'postgres')); service = new HiveService(db, createModels({}));
    expect((await service.snapshot()).metrics.availableCapitalUsd).toBe('123.123456'); expect((await one(db, 'SELECT status FROM actions WHERE id=$1', [id])).status).toBe('APPROVED');
    const restored=await one(db,'SELECT * FROM static_releases WHERE id=$1',[release.id]);expect(restored.content_hash).toBe(release.content_hash);expect(restored.manifest.files[0].content).toBe('<h1>Durable release</h1>');
    expect((await db.query('SELECT * FROM hive_migrations')).rows).toHaveLength(17);
    await expect(db.query("UPDATE actions SET target='changed' WHERE id=$1", [id])).rejects.toThrow(); await expect(db.query('DELETE FROM approvals')).rejects.toThrow('append-only');
  } finally { await db?.close(); await rm(directory, { recursive: true, force: true }); }
});
