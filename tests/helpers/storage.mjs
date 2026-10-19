// Supabase's storage schema as far as our SQL can see it, guards included.
//
// Every test used to make a bare storage.objects table of its own. When
// Supabase started refusing plain SQL deletes there, those tables did not, so
// the suite stayed green while deleting any topic with a file failed in
// production. One copy, shaped like the real one, means the next rule Supabase
// adds goes in here and every test sees it.
//
// The real guard is storage.protect_delete; the Storage API sets
// storage.allow_delete_query before it deletes, which tests do through
// storageApiRemove below.
export const SUPABASE_STORAGE=`
  create schema storage;
  create table storage.buckets(id text primary key,name text);
  create table storage.objects(bucket_id text,name text,metadata jsonb,user_metadata jsonb);
  create function storage.protect_delete() returns trigger language plpgsql as $guard$
  begin
    if coalesce(current_setting('storage.allow_delete_query',true),'false') <> 'true' then
      raise exception 'Direct deletion from storage tables is not allowed. Use the Storage API instead.'
        using errcode='42501';
    end if;
    return null;
  end $guard$;
  create trigger protect_objects_delete before delete on storage.objects
    for each statement execute function storage.protect_delete();
  create trigger protect_buckets_delete before delete on storage.buckets
    for each statement execute function storage.protect_delete();
  alter table storage.objects enable row level security;
`;

/** What the Storage API's remove() does: lifts the guard for this one
 *  transaction, then deletes as the caller so the storage policies decide. */
export async function storageApiRemove(db,claims,names) {
  await db.exec('begin; set local role authenticated;');
  try {
    await db.query("select set_config('request.jwt.claims',$1,true), set_config('storage.allow_delete_query','true',true)",[JSON.stringify(claims)]);
    const result=await db.query("delete from storage.objects where bucket_id='task-files' and name=any($1) returning name",[names]);
    await db.exec('commit');
    return result.rows.map(row=>row.name);
  } catch(error) { await db.exec('rollback'); throw error; }
}
