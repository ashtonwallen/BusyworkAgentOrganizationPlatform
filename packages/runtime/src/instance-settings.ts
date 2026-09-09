import {z} from 'zod';

export function parseInstanceSettings(env:NodeJS.ProcessEnv) {
 const companyName=z.string().trim().min(1).max(100).refine(value=>!/[\r\n]/.test(value)).parse(env.HIVE_COMPANY_NAME||'My business');
 const mailbox=env.HIVE_BUSINESS_EMAIL?.trim().toLowerCase()||'';
 if(mailbox)z.email().max(254).parse(mailbox);
 return Object.freeze({companyName,mailbox});
}

// A process runs one business instance. The API loads its selected environment
// before importing the runtime. Tests supply an explicit synthetic identity.
export const instanceSettings=parseInstanceSettings(process.env);
