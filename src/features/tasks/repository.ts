import type {SupabaseClient} from '@supabase/supabase-js';
import {requestWithTimeout} from '../../request.mjs';
import type {Task,TaskDetail,TaskDraft,TaskResource,TaskStatus,TaskSummary} from './model';

type TaskMutationResult={task:Task};
type ResourceMutationResult=TaskMutationResult&{resource:TaskResource};

async function sha256(file:File):Promise<string> {
  const digest=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());
  return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

function downloadBlob(blob:Blob,name:string) {
  const url=URL.createObjectURL(blob);
  const link=document.createElement('a');
  link.href=url;link.download=name;link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

export function createTaskRepository(db:SupabaseClient) {
  async function rpc<T>(name:string,args:Record<string,unknown>):Promise<T> {
    const {data,error}=await db.rpc(name,args);
    if(error)throw error;
    if(!data)throw new Error(`Missing ${name} result`);
    return data as T;
  }
  return {
    async list(projectId:string|null):Promise<TaskSummary[]> {
      const base=db.from('tasks')
        .select('id,project_id,title,status,priority,next_action,blocked_reason,revision,updated_at');
      const scoped=projectId===null?base.is('project_id',null):base.eq('project_id',projectId);
      const {data,error}=await requestWithTimeout(signal=>scoped
        .order('updated_at',{ascending:false}).limit(201).abortSignal(signal));
      if(error)throw error;
      return (data??[]) as TaskSummary[];
    },
    async read(projectId:string|null,id:string):Promise<TaskDetail> {
      const taskBase=db.from('tasks').select('*').eq('id',id);
      const handoffBase=db.from('task_handoffs').select('*').eq('task_id',id);
      const resourceBase=db.from('task_resources').select('*').eq('task_id',id);
      const eventBase=db.from('task_events').select('*').eq('task_id',id);
      const taskQuery=(projectId===null?taskBase.is('project_id',null):taskBase.eq('project_id',projectId)).maybeSingle();
      const handoffQuery=(projectId===null?handoffBase.is('project_id',null):handoffBase.eq('project_id',projectId)).order('created_at');
      const resourceQuery=(projectId===null?resourceBase.is('project_id',null):resourceBase.eq('project_id',projectId)).order('created_at');
      const eventQuery=(projectId===null?eventBase.is('project_id',null):eventBase.eq('project_id',projectId)).order('created_at');
      const [task,handoffs,resources,events]=await Promise.all([taskQuery,handoffQuery,resourceQuery,eventQuery]);
      for(const response of [task,handoffs,resources,events])if(response.error)throw response.error;
      if(!task.data)throw {code:'P0002'};
      return {...task.data,handoffs:handoffs.data??[],resources:resources.data??[],events:events.data??[]} as TaskDetail;
    },
    create(projectId:string|null,id:string,requestId:string,draft:TaskDraft):Promise<Task> {
      return rpc('create_task',{p_project_id:projectId,p_id:id,p_request_id:requestId,
        p_title:draft.title.trim(),p_outcome:draft.outcome,p_why:draft.why,
        p_done_when:draft.done_when,p_next_action:draft.next_action,p_priority:draft.priority});
    },
    update(task:Task,requestId:string,draft:TaskDraft):Promise<Task> {
      return rpc('update_task',{p_id:task.id,p_expected_revision:task.revision,p_request_id:requestId,
        p_title:draft.title.trim(),p_outcome:draft.outcome,p_why:draft.why,
        p_done_when:draft.done_when,p_next_action:draft.next_action,p_priority:draft.priority});
    },
    transition(task:Task,requestId:string,status:TaskStatus,blockedReason=''):Promise<Task> {
      return rpc('transition_task',{p_id:task.id,p_expected_revision:task.revision,
        p_request_id:requestId,p_status:status,p_blocked_reason:blockedReason});
    },
    handoff(task:Task,requestId:string,handoffId:string,input:{summary:string;completed:string[];remaining:string[];nextAction:string}):Promise<TaskMutationResult> {
      return rpc('record_task_handoff',{p_request_id:requestId,p_id:handoffId,p_task_id:task.id,
        p_expected_revision:task.revision,p_supersedes_ids:[],p_completed:input.completed,
        p_decisions:[],p_validation:[],p_remaining:input.remaining,p_blockers:[],
        p_next_action:input.nextAction,p_summary:input.summary,p_status:null,
        p_blocked_reason:'',p_resource_ids:[]});
    },
    addLink(task:Task,requestId:string,resourceId:string,label:string,url:string):Promise<ResourceMutationResult> {
      return rpc('add_task_resource',{p_request_id:requestId,p_id:resourceId,p_task_id:task.id,
        p_expected_revision:task.revision,p_label:label.trim(),p_url:url.trim(),
        p_resource_type:'reference',p_provider:null});
    },
    async upload(task:Task,requestId:string,resourceId:string,label:string,file:File):Promise<ResourceMutationResult> {
      if(file.size>6*1024*1024)throw new Error('Files are limited to 6 MB in this first slice.');
      const checksum=await sha256(file);
      const reserved=await rpc<ResourceMutationResult>('reserve_task_file',{
        p_request_id:requestId,p_id:resourceId,p_task_id:task.id,p_expected_revision:task.revision,
        p_label:label.trim()||file.name,p_original_filename:file.name,p_media_type:file.type||'application/octet-stream',
        p_expected_bytes:file.size,p_checksum_sha256:checksum,p_resource_type:'document',
      });
      const objectKey=reserved.resource.object_key;
      if(!objectKey)throw new Error('Missing upload path');
      const {error}=await db.storage.from('task-files').upload(objectKey,file,{
        upsert:false,contentType:file.type||'application/octet-stream',metadata:{sha256:checksum},
      });
      if(error) {
        await rpc('fail_task_file',{p_request_id:crypto.randomUUID(),p_resource_id:resourceId,p_reason:error.message})
          .catch(()=>undefined);
        throw error;
      }
      const verified=await rpc<TaskResource>('finalize_task_file',{
        p_request_id:crypto.randomUUID(),p_resource_id:resourceId,
      });
      if(verified.upload_status!=='verified')throw new Error('The uploaded file did not pass size and checksum verification.');
      return {task:reserved.task,resource:verified};
    },
    async download(resource:TaskResource):Promise<void> {
      if(!resource.object_key)throw new Error('Missing object path');
      const {data,error}=await db.storage.from('task-files').download(resource.object_key);
      if(error)throw error;
      downloadBlob(data,resource.original_filename??resource.label);
    },
    async exportProject(projectId:string|null):Promise<number> {
      const manifest=await rpc<Record<string,unknown>&{resources?:TaskResource[]}>('export_tasks',{p_project_id:projectId});
      downloadBlob(new Blob([JSON.stringify(manifest,null,2)],{type:'application/json'}),`satchel-tasks-${projectId??'personal'}.json`);
      let files=0;
      for(const resource of manifest.resources??[]) {
        if(resource.kind!=='storage_object'||resource.upload_status!=='verified'||!resource.object_key)continue;
        const {data,error}=await db.storage.from('task-files').download(resource.object_key);
        if(error)throw error;
        downloadBlob(data,`${resource.id}-${resource.original_filename??resource.label}`);files++;
      }
      return files;
    },
  };
}
