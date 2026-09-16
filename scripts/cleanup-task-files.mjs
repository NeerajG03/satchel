import {createClient} from '@supabase/supabase-js';

const url=process.env.SUPABASE_URL;
const key=process.env.SUPABASE_SERVICE_ROLE_KEY;
if(!url||!key)throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the shell.');

const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
const cutoff=new Date(Date.now()-24*60*60*1000).toISOString();
const {data:resources,error}=await db.from('task_resources')
  .select('owner_id,project_id,task_id,id,object_key')
  .eq('kind','storage_object').in('upload_status',['pending','failed'])
  .lt('created_at',cutoff).limit(500);
if(error)throw error;

for(const resource of resources??[]) {
  if(resource.object_key) {
    const {error:removeError}=await db.storage.from('task-files').remove([resource.object_key]);
    if(removeError)throw removeError;
  }
  const {error:cleanupError}=await db.rpc('cleanup_task_file',{
    p_owner_id:resource.owner_id,p_resource_id:resource.id,
  });
  if(cleanupError)throw cleanupError;
}
console.log(`Cleaned ${resources?.length??0} abandoned task file reservation(s).`);
