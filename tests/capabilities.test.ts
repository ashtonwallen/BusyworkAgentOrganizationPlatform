import {it,expect} from 'vitest';
import {openDatabase,HiveService,createModels,Organization} from '../packages/runtime/src/index.js';
import {capabilityReport} from '../packages/runtime/src/capabilities.js';
it('reports current configuration separately from permissions without exposing secrets',async()=>{
 const db=await openDatabase();try{
 const service=new HiveService(db,createModels({})),org=new Organization(service);const ceo=await db.transaction(tx=>org.ensureCEO(tx));
 const first=await capabilityReport(db,service,ceo.id);expect(first.runtimeStatus).toBe('PAUSED');expect(first.internal.workspace.available).toBe(false);expect(first.external.email.mailboxConnected).toBe(false);expect(first.external.email.canRead).toBe(true);
 await db.query('INSERT INTO email_permissions(employee_id,can_read,can_send) VALUES($1,false,false)',[ceo.id]);
 service.browserAvailable=true;service.emailOAuthConfigured=true;service.hosting={enabled:true,ready:true,missing:[],siteId:'fixture-site',maxDeploymentUsd:'1',totalCapUsd:'10'};
 const second=await capabilityReport(db,service,ceo.id);expect(second.external.email.canRead).toBe(false);expect(second.external.email.canSend).toBe(false);expect(second.external.email.oauthConfigured).toBe(true);expect(second.external.renderedPages.adapterInstalled).toBe(true);expect(second.external.publishing.adapterConfigured).toBe(true);expect(second.external.otherActions.automaticExecutorInstalled).toBe(false);
 await expect(capabilityReport(db,service,'unknown')).rejects.toThrow();expect(JSON.stringify(second)).not.toMatch(/credential_ciphertext|authToken|clientSecret/);
 }finally{await db.close();}
});
