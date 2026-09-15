// Request-scoped adapter. RLS remains authoritative even for direct RPC calls.
export function memoryService(db) {
  async function result(query) {
    const {data,error} = await query.abortSignal(AbortSignal.timeout(8000));
    if (error) throw error;
    return data;
  }
  async function requireScope(projectId, write=false) {
    if (!await result(db.rpc('agent_can_access',{p_project_id:projectId,p_write:write})))
      throw {code:'42501'};
  }
  return {
    status: () => result(db.rpc('agent_connection_status')),
    projects: () => result(db.from('projects').select('id,name,brief').order('name')),
    activeProject: session => result(db.rpc('agent_active_project',{p_session_key:session})),
    repositoryHintExists: session => result(db.rpc('agent_repository_hint_exists',{p_session_key:session})),
    activateRepositoryHint: session => result(db.rpc('activate_agent_repository_hint',{p_session_key:session})),
    async selectProject(session,projectId) {
      await result(db.rpc('select_agent_project',{p_session_key:session,p_project_id:projectId}));
      return {project_id:projectId};
    },
    async selectRepository(session,provider,repository) {
      const projectId=await result(db.rpc('select_agent_repository',{
        p_session_key:session,p_provider:provider,p_repository:repository,
      }));
      return {project_id:projectId};
    },
    async index(projectId) {
      await requireScope(projectId);
      // A sentinel row detects PostgREST pagination instead of silently claiming completeness.
      const {data:rows,error,count}=await db.rpc('list_memories',{p_project_id:projectId},{count:'exact'})
        .range(0,500).abortSignal(AbortSignal.timeout(8000));
      if(error)throw error;
      return {memories:rows,complete:count!==null&&count===rows.length&&rows.length<501};
    },
    async read(projectId,name,id) {
      await requireScope(projectId);
      const row=await result(db.rpc('read_memory',{p_project_id:projectId,p_name:name}));
      if (!row || (id && row.id!==id)) throw {code:'P0002'};
      return row;
    },
    async save(args) {
      await requireScope(args.project_id,true);
      return result(db.rpc('save_memory',{p_id:args.id,p_project_id:args.project_id,
        p_name:args.name,p_description:args.description,p_more_info:args.more_info}));
    },
    async correct(args) {
      await requireScope(args.project_id,true);
      const row=await result(db.from('memories').select('id,project_id').eq('id',args.id).maybeSingle());
      if (!row || row.project_id!==args.project_id) throw {code:'P0002'};
      return result(db.rpc('correct_memory',{p_id:args.id,p_revision:args.revision,
        p_name:args.name,p_description:args.description,p_more_info:args.more_info}));
    },
    async remove(args) {
      await requireScope(args.project_id,true);
      let query=db.from('memories').delete().eq('id',args.id).eq('revision',args.revision);
      query=args.project_id===null?query.is('project_id',null):query.eq('project_id',args.project_id);
      const rows=await result(query.select('id'));
      if (!rows.length) throw {code:'PT409'};
      return {deleted_id:args.id};
    },
  };
}
