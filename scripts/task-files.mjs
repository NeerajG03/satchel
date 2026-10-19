// The two ways a file in task-files can outlive the reason it was there, and
// how the cleanup command finds each one.

const BUCKET='task-files';
const DAY=24*60*60*1000;

/** Uploads that were reserved and never finished: the row and any file. */
export async function cleanAbandonedReservations(db,{now=Date.now()}={}) {
  const cutoff=new Date(now-DAY).toISOString();
  const {data:resources,error}=await db.from('task_resources')
    .select('owner_id,topic_id,task_id,id,object_key')
    .eq('kind','storage_object').in('upload_status',['pending','failed'])
    .lt('created_at',cutoff).limit(500);
  if(error)throw error;
  for(const resource of resources??[]) {
    if(resource.object_key) {
      const {error:removeError}=await db.storage.from(BUCKET).remove([resource.object_key]);
      if(removeError)throw removeError;
    }
    const {error:cleanupError}=await db.rpc('cleanup_task_file',{
      p_owner_id:resource.owner_id,p_resource_id:resource.id,
    });
    if(cleanupError)throw cleanupError;
  }
  return resources?.length??0;
}

async function list(db,prefix) {
  const entries=[];
  for(let offset=0;;offset+=1000) {
    const {data,error}=await db.storage.from(BUCKET).list(prefix,{limit:1000,offset});
    if(error)throw error;
    entries.push(...(data??[]));
    if(!data||data.length<1000)return entries;
  }
}

/** Files no task_resources row points at. Deleting an account cascades
 *  through every row but cannot reach the bucket, and a delete whose file
 *  removal failed leaves the same thing. The row is always written before the
 *  upload starts, so a file with no row is never one still on its way in. The
 *  hour is only a margin. Keys are owner/task/resource. */
export async function removeOrphanedFiles(db,{now=Date.now(),olderThanMs=60*60*1000}={}) {
  const cutoff=now-olderThanMs;
  const keys=[];
  for(const owner of await list(db,''))
    for(const task of await list(db,owner.name))
      for(const file of await list(db,`${owner.name}/${task.name}`))
        if(file.id&&Date.parse(file.created_at)<cutoff)keys.push(`${owner.name}/${task.name}/${file.name}`);
  const orphans=[];
  for(let start=0;start<keys.length;start+=100) {
    const batch=keys.slice(start,start+100);
    const {data,error}=await db.from('task_resources').select('object_key').in('object_key',batch);
    if(error)throw error;
    const known=new Set((data??[]).map(row=>row.object_key));
    orphans.push(...batch.filter(key=>!known.has(key)));
  }
  for(let start=0;start<orphans.length;start+=1000) {
    const {error}=await db.storage.from(BUCKET).remove(orphans.slice(start,start+1000));
    if(error)throw error;
  }
  return orphans.length;
}
