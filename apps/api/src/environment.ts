import {config} from 'dotenv';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const root=fileURLToPath(new URL('../../../',import.meta.url));
config({path:resolve(root,process.env.HIVE_ENV_FILE||'.env')});
