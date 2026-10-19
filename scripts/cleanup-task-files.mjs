import {createClient} from '@supabase/supabase-js';
import {cleanAbandonedReservations,removeOrphanedFiles} from './task-files.mjs';

const url=process.env.SUPABASE_URL;
const key=process.env.SUPABASE_SERVICE_ROLE_KEY;
if(!url||!key)throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the shell.');

const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
console.log(`Cleaned ${await cleanAbandonedReservations(db)} abandoned task file reservation(s).`);
console.log(`Removed ${await removeOrphanedFiles(db)} file(s) no task points at, such as those of deleted accounts.`);
