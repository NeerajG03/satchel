// Request-scoped task adapter. Database RLS and mutation functions remain authoritative.
export function taskService(db, connectionStatus) {
  async function result(query) {
    const {data,error}=await query.abortSignal(AbortSignal.timeout(8000));
    if(error)throw error;
    return data;
  }
  async function requireScope(projectId, capability='read') {
    const status=await connectionStatus();
    if(!status)throw {code:'42501'};
    const projects=Array.isArray(status.task_project_ids)?status.task_project_ids:[];
    if(projectId===null?!status.task_personal:!projects.includes(projectId))throw {code:'42501'};
    if(capability==='write'&&!status.task_can_write)throw {code:'42501'};
    if(capability==='upload'&&!status.task_can_upload)throw {code:'42501'};
  }
  return {
    async list(projectId,statuses) {
      await requireScope(projectId);
      let query=db.from('tasks').select(
        'id,project_id,title,status,priority,next_action,blocked_reason,revision,updated_at',
        {count:'exact'},
      );
      query=(projectId===null?query.is('project_id',null):query.eq('project_id',projectId))
        .order('updated_at',{ascending:false}).order('id').range(0,200);
      if(statuses?.length)query=query.in('status',statuses);
      const {data,error,count}=await query.abortSignal(AbortSignal.timeout(8000));
      if(error)throw error;
      return {tasks:data??[],complete:count!==null&&count===(data??[]).length&&(data??[]).length<201};
    },
    async read(projectId,id) {
      await requireScope(projectId);
      const taskBase=db.from('tasks').select('*').eq('id',id);
      const task=await result((projectId===null?taskBase.is('project_id',null):taskBase.eq('project_id',projectId)).maybeSingle());
      if(!task)throw {code:'P0002'};
      const [handoffs,resources,events]=await Promise.all([
        result((projectId===null?db.from('task_handoffs').select('*').is('project_id',null):db.from('task_handoffs').select('*').eq('project_id',projectId)).eq('task_id',id).order('created_at')),
        result((projectId===null?db.from('task_resources').select('*').is('project_id',null):db.from('task_resources').select('*').eq('project_id',projectId)).eq('task_id',id).order('created_at')),
        result((projectId===null?db.from('task_events').select('*').is('project_id',null):db.from('task_events').select('*').eq('project_id',projectId)).eq('task_id',id).order('created_at')),
      ]);
      return {...task,handoffs,resources,events};
    },
    async create(args) {
      await requireScope(args.project_id,'write');
      return result(db.rpc('create_task',{
        p_request_id:args.request_id,p_id:args.id,p_project_id:args.project_id,
        p_title:args.title,p_outcome:args.outcome,p_why:args.why,
        p_done_when:args.done_when,p_next_action:args.next_action,p_priority:args.priority,
      }).single());
    },
    async update(args) {
      await requireScope(args.project_id,'write');
      return result(db.rpc('update_task',{
        p_request_id:args.request_id,p_id:args.id,p_expected_revision:args.revision,
        p_title:args.title,p_outcome:args.outcome,p_why:args.why,
        p_done_when:args.done_when,p_next_action:args.next_action,p_priority:args.priority,
      }).single());
    },
    async transition(args) {
      await requireScope(args.project_id,'write');
      return result(db.rpc('transition_task',{
        p_request_id:args.request_id,p_id:args.id,p_expected_revision:args.revision,
        p_status:args.status,p_blocked_reason:args.blocked_reason,
      }).single());
    },
    async handoff(args) {
      await requireScope(args.project_id,'write');
      return result(db.rpc('record_task_handoff',{
        p_request_id:args.request_id,p_id:args.handoff_id,p_task_id:args.id,
        p_expected_revision:args.revision,p_supersedes_ids:args.supersedes_ids,
        p_completed:args.completed,p_decisions:args.decisions,p_validation:args.validation,
        p_remaining:args.remaining,p_blockers:args.blockers,p_next_action:args.next_action,
        p_summary:args.summary,p_status:args.status,p_blocked_reason:args.blocked_reason,
        p_resource_ids:args.resource_ids,
      }));
    },
    async addResource(args) {
      await requireScope(args.project_id,'write');
      return result(db.rpc('add_task_resource',{
        p_request_id:args.request_id,p_id:args.resource_id,p_task_id:args.id,
        p_expected_revision:args.revision,p_label:args.label,p_url:args.url,
        p_resource_type:args.resource_type,p_provider:args.provider,
      }));
    },
  };
}
