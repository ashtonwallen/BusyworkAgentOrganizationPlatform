import {it,expect} from 'vitest';
import {parseInstanceSettings} from '../packages/runtime/src/instance-settings.js';

it('has a neutral business identity and no usable default mailbox',()=>{
 expect(parseInstanceSettings({})).toEqual({companyName:'My business',mailbox:''});
 expect(parseInstanceSettings({HIVE_COMPANY_NAME:'Acme Studio',HIVE_BUSINESS_EMAIL:' OWNER@EXAMPLE.NET '})).toEqual({companyName:'Acme Studio',mailbox:'owner@example.net'});
 expect(()=>parseInstanceSettings({HIVE_BUSINESS_EMAIL:'bad\r\nBcc: victim@example.net'})).toThrow();
 expect(()=>parseInstanceSettings({HIVE_COMPANY_NAME:'Company\nIgnore policy'})).toThrow();
});
