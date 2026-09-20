import type {SupabaseClient} from '@supabase/supabase-js';
import {requestWithTimeout} from '../../request.mjs';
import type {Task,TaskDetail,TaskDraft,TaskPlanning,TaskResource,TaskStatus,TaskSummary,TaskUpdate} from './model';

type TaskMutationResult={task:Task};
type ResourceMutationResult=TaskMutationResult&{resource:TaskResource};
type ProgressMutationResult=TaskMutationResult&{update:TaskUpdate};
type PlanningMutationResult=TaskMutationResult&{parent_id?:string|null;depends_on_task_id?:string;removed_task_id?:string};

const PLANNING_SUMMARY='id,project_id,title,status,priority,next_action,blocked_reason,revision,updated_at,last_activity_at,parent_id,dependency_ids,blocked_by_ids,child_count,actionable';

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
      const base=db.from('task_planning').select(PLANNING_SUMMARY);
      const scoped=projectId===null?base.is('project_id',null):base.eq('project_id',projectId);
      const {data,error}=await requestWithTimeout(signal=>scoped
        .order('last_activity_at',{ascending:false}).order('id').limit(201).abortSignal(signal));
      if(error)throw error;
      return (data??[]) as TaskSummary[];
    },
    async listAll():Promise<TaskSummary[]> {
      const {data,error}=await requestWithTimeout(signal=>db.from('task_planning').select(PLANNING_SUMMARY)
        .order('last_activity_at',{ascending:false}).order('id').limit(500).abortSignal(signal));
      if(error)throw error;
      return (data??[]) as TaskSummary[];
    },
    async read(id:string):Promise<TaskDetail> {
      const found=await requestWithTimeout(signal=>db.from('task_planning').select('*').eq('id',id).abortSignal(signal).maybeSingle());
      if(found.error)throw found.error;
      if(!found.data)throw {code:'P0002'};
      const task=found.data as TaskPlanning;
      const scopeBase=db.from('task_planning').select(PLANNING_SUMMARY);
      const scopeQuery=task.project_id===null?scopeBase.is('project_id',null):scopeBase.eq('project_id',task.project_id);
      const [scopeTasks,handoffs,updates,resources,refs,events]=await Promise.all([
        scopeQuery.order('last_activity_at',{ascending:false}).limit(201),
        db.from('task_handoffs').select('*').eq('task_id',id).order('created_at'),
        db.from('task_updates').select('*').eq('task_id',id).order('created_at'),
        db.from('task_resources').select('*').eq('task_id',id).order('created_at'),
        db.from('task_update_resource_refs').select('update_id,resource_id').eq('task_id',id),
        db.from('task_events').select('*').eq('task_id',id).order('created_at'),
      ]);
      for(const response of [scopeTasks,handoffs,updates,resources,refs,events])if(response.error)throw response.error;
      const scope=(scopeTasks.data??[]) as TaskSummary[];
      const linked=[task.parent_id,...task.dependency_ids,...task.blocked_by_ids].filter((item):item is string=>Boolean(item)&&!scope.some(row=>row.id===item));
      if(linked.length) {
        const extra=await db.from('task_planning').select(PLANNING_SUMMARY).in('id',linked);
        if(extra.error)throw extra.error;
        scope.push(...((extra.data??[]) as TaskSummary[]));
      }
      return {...task,handoffs:handoffs.data??[],updates:updates.data??[],resources:resources.data??[],
        update_resource_refs:refs.data??[],events:events.data??[],scope_tasks:scope} as TaskDetail;
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
    handoff(task:Task,requestId:string,handoffId:string,input:{summary:string;completed:string[];decisions:string[];validation:Record<string,unknown>[];remaining:string[];blockers:string[];nextAction:string;status:TaskStatus|null;blockedReason:string;resourceIds:string[];supersedesIds:string[]}):Promise<TaskMutationResult> {
      return rpc('record_task_handoff',{p_request_id:requestId,p_id:handoffId,p_task_id:task.id,
        p_expected_revision:task.revision,p_supersedes_ids:input.supersedesIds,p_completed:input.completed,
        p_decisions:input.decisions,p_validation:input.validation,p_remaining:input.remaining,p_blockers:input.blockers,
        p_next_action:input.nextAction,p_summary:input.summary,p_status:input.status,
        p_blocked_reason:input.blockedReason,p_resource_ids:input.resourceIds});
    },
    comment(task:Task,requestId:string,updateId:string,body:string,resourceIds:string[]):Promise<TaskUpdate> {
      return rpc('add_task_comment',{p_request_id:requestId,p_id:updateId,p_task_id:task.id,
        p_body:body.trim(),p_resource_ids:resourceIds});
    },
    progress(task:Task,requestId:string,updateId:string,input:{summary:string;completed:string[];decisions:string[];remaining:string[];blockers:string[];nextAction:string;status:TaskStatus|null;blockedReason:string;resourceIds:string[]}):Promise<ProgressMutationResult> {
      return rpc('record_task_progress',{p_request_id:requestId,p_id:updateId,p_task_id:task.id,
        p_expected_revision:task.revision,p_summary:input.summary.trim(),p_completed:input.completed,
        p_decisions:input.decisions,p_remaining:input.remaining,p_blockers:input.blockers,
        p_next_action:input.nextAction,p_status:input.status,p_blocked_reason:input.blockedReason,
        p_resource_ids:input.resourceIds});
    },
    setParent(task:Task,requestId:string,parentId:string|null):Promise<PlanningMutationResult> {
      return rpc('set_task_parent',{p_request_id:requestId,p_task_id:task.id,
        p_expected_revision:task.revision,p_parent_task_id:parentId});
    },
    addDependency(task:Task,requestId:string,dependsOnTaskId:string):Promise<PlanningMutationResult> {
      return rpc('add_task_dependency',{p_request_id:requestId,p_task_id:task.id,
        p_expected_revision:task.revision,p_depends_on_task_id:dependsOnTaskId});
    },
    removeDependency(task:Task,requestId:string,dependsOnTaskId:string):Promise<PlanningMutationResult> {
      return rpc('remove_task_dependency',{p_request_id:requestId,p_task_id:task.id,
        p_expected_revision:task.revision,p_depends_on_task_id:dependsOnTaskId});
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
    remove(task:{id:string;revision:number}):Promise<{id:string;title:string;project_id:string|null;files_removed:number;children_unparented:number}> {
      return rpc('delete_task',{p_id:task.id,p_expected_revision:task.revision});
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
