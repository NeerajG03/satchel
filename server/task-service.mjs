// Request-scoped task adapter. Database RLS and mutation functions remain authoritative.
export function taskService(db, connectionStatus) {
  async function result(query) {
    const {data,error}=await query.abortSignal(AbortSignal.timeout(8000));
    if(error)throw error;
    return data;
  }
  async function requireScope(topicId, capability='read') {
    const status=await connectionStatus();
    if(!status)throw {code:'42501',message:'Connection unavailable'};
    // A blanket task grant covers every topic, including ones made after the
    // grant, so it is checked before the list. The database enforces the same
    // rule in private.agent_can_access_tasks; this is the early, readable no.
    const topics=Array.isArray(status.task_topic_ids)?status.task_topic_ids:[];
    const inScope=topicId===null?status.task_personal:(status.task_all_topics||topics.includes(topicId));
    if(!inScope)throw {code:'42501',message:topicId===null?'Personal tasks unavailable':'Topic tasks unavailable'};
    if(capability==='write'&&!status.task_can_write)throw {code:'42501',message:'Task write unavailable'};
    if(capability==='upload'&&!status.task_can_upload)throw {code:'42501',message:'Task upload unavailable'};
  }
  return {
    async list(topicId,statuses) {
      await requireScope(topicId);
      let query=db.from('task_planning').select(
        'id,slug,topic_id,title,status,priority,next_action,blocked_reason,revision,updated_at,last_activity_at,parent_id,dependency_ids,blocked_by_ids,child_count,actionable',
        {count:'exact'},
      );
      query=(topicId===null?query.is('topic_id',null):query.eq('topic_id',topicId))
        .order('last_activity_at',{ascending:false}).order('id').range(0,200);
      if(statuses?.length)query=query.in('status',statuses);
      const {data,error,count}=await query.abortSignal(AbortSignal.timeout(8000));
      if(error)throw error;
      return {tasks:data??[],complete:count!==null&&count===(data??[]).length&&(data??[]).length<201};
    },
    async read(topicId,id) {
      await requireScope(topicId);
      const taskBase=db.from('task_planning').select('*').eq('id',id);
      const task=await result((topicId===null?taskBase.is('topic_id',null):taskBase.eq('topic_id',topicId)).maybeSingle());
      if(!task)throw {code:'P0002',message:'Task unavailable'};
      const planningBase=db.from('task_planning').select('id,slug,title,status,parent_id,dependency_ids,blocked_by_ids,child_count,actionable');
      const [scopeTasks,handoffs,updates,resources,updateResourceRefs,events]=await Promise.all([
        result((topicId===null?planningBase.is('topic_id',null):planningBase.eq('topic_id',topicId)).order('last_activity_at',{ascending:false}).limit(201)),
        result((topicId===null?db.from('task_handoffs').select('*').is('topic_id',null):db.from('task_handoffs').select('*').eq('topic_id',topicId)).eq('task_id',id).order('created_at')),
        result((topicId===null?db.from('task_updates').select('*').is('topic_id',null):db.from('task_updates').select('*').eq('topic_id',topicId)).eq('task_id',id).order('created_at')),
        result((topicId===null?db.from('task_resources').select('*').is('topic_id',null):db.from('task_resources').select('*').eq('topic_id',topicId)).eq('task_id',id).order('created_at')),
        result((topicId===null?db.from('task_update_resource_refs').select('update_id,resource_id').is('topic_id',null):db.from('task_update_resource_refs').select('update_id,resource_id').eq('topic_id',topicId)).eq('task_id',id)),
        result((topicId===null?db.from('task_events').select('*').is('topic_id',null):db.from('task_events').select('*').eq('topic_id',topicId)).eq('task_id',id).order('created_at')),
      ]);
      return {...task,scope_tasks:scopeTasks,handoffs,updates,resources,update_resource_refs:updateResourceRefs,events};
    },
    async create(args) {
      await requireScope(args.topic_id,'write');
      // One round trip and one transaction: a slug collision rolls the create
      // back rather than leaving a task named after its own title.
      return result(db.rpc('create_task_with_slug',{
        p_slug:args.slug,
        p_request_id:args.request_id,p_id:args.id,p_topic_id:args.topic_id,
        p_title:args.title,p_outcome:args.outcome,p_why:args.why,
        p_done_when:args.done_when,p_next_action:args.next_action,p_priority:args.priority,
      }).single());
    },
    async update(args) {
      await requireScope(args.topic_id,'write');
      return result(db.rpc('update_task',{
        p_request_id:args.request_id,p_id:args.id,p_expected_revision:args.revision,
        p_title:args.title,p_outcome:args.outcome,p_why:args.why,
        p_done_when:args.done_when,p_next_action:args.next_action,p_priority:args.priority,
      }).single());
    },
    async transition(args) {
      await requireScope(args.topic_id,'write');
      return result(db.rpc('transition_task',{
        p_request_id:args.request_id,p_id:args.id,p_expected_revision:args.revision,
        p_status:args.status,p_blocked_reason:args.blocked_reason,
      }).single());
    },
    async handoff(args) {
      await requireScope(args.topic_id,'write');
      return result(db.rpc('record_task_handoff',{
        p_request_id:args.request_id,p_id:args.handoff_id,p_task_id:args.id,
        p_expected_revision:args.revision,p_supersedes_ids:args.supersedes_ids,
        p_completed:args.completed,p_decisions:args.decisions,p_validation:args.validation,
        p_remaining:args.remaining,p_blockers:args.blockers,p_next_action:args.next_action,
        p_summary:args.summary,p_status:args.status,p_blocked_reason:args.blocked_reason,
        p_resource_ids:args.resource_ids,
      }));
    },
    async comment(args) {
      await requireScope(args.topic_id,'write');
      return result(db.rpc('add_task_comment',{
        p_request_id:args.request_id,p_id:args.update_id,p_task_id:args.id,
        p_body:args.body,p_resource_ids:args.resource_ids,
      }).single());
    },
    async progress(args) {
      await requireScope(args.topic_id,'write');
      return result(db.rpc('record_task_progress',{
        p_request_id:args.request_id,p_id:args.update_id,p_task_id:args.id,
        p_expected_revision:args.revision,p_summary:args.summary,
        p_completed:args.completed,p_decisions:args.decisions,p_remaining:args.remaining,
        p_blockers:args.blockers,p_next_action:args.next_action,p_status:args.status,
        p_blocked_reason:args.blocked_reason,p_resource_ids:args.resource_ids,
      }));
    },
    async setParent(args) {
      await requireScope(args.topic_id,'write');
      return result(db.rpc('set_task_parent',{
        p_request_id:args.request_id,p_task_id:args.id,p_expected_revision:args.revision,
        p_parent_task_id:args.parent_id,
      }));
    },
    async addDependency(args) {
      await requireScope(args.topic_id,'write');
      return result(db.rpc('add_task_dependency',{
        p_request_id:args.request_id,p_task_id:args.id,p_expected_revision:args.revision,
        p_depends_on_task_id:args.depends_on_task_id,
      }));
    },
    async removeDependency(args) {
      await requireScope(args.topic_id,'write');
      return result(db.rpc('remove_task_dependency',{
        p_request_id:args.request_id,p_task_id:args.id,p_expected_revision:args.revision,
        p_depends_on_task_id:args.depends_on_task_id,
      }));
    },
    async addResource(args) {
      await requireScope(args.topic_id,'write');
      return result(db.rpc('add_task_resource',{
        p_request_id:args.request_id,p_id:args.resource_id,p_task_id:args.id,
        p_expected_revision:args.revision,p_label:args.label,p_url:args.url,
        p_resource_type:args.resource_type,p_provider:args.provider,
      }));
    },
  };
}
