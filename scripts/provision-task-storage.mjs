import {createClient} from '@supabase/supabase-js';

const url=process.env.SUPABASE_URL;
const key=process.env.SUPABASE_SERVICE_ROLE_KEY;
if(!url||!key)throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the shell.');

const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
const {data,error}=await db.storage.getBucket('task-files');
if(error&&error.statusCode!=='404')throw error;
if(data) {
  if(data.public)throw new Error('The existing task-files bucket is public. Make it private before continuing.');
  console.log('Private task-files bucket already exists.');
} else {
  const {error:createError}=await db.storage.createBucket('task-files',{
    public:false,fileSizeLimit:6*1024*1024,
  });
  if(createError)throw createError;
  console.log('Created private task-files bucket with a 6 MB limit.');
}
