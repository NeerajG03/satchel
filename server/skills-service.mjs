// Request-scoped adapter, mirroring memory-service.mjs. RLS remains
// authoritative: this holds no service-role key and no owner filter of its own.
export function skillsService(db) {
  async function result(query) {
    const {data,error}=await query.abortSignal(AbortSignal.timeout(8000));
    if(error)throw error;
    return data;
  }
  return {
    sources: () => result(db.from('skill_sources').select('id,repository,commit_sha,is_delivery_target,synced_at').order('repository')),
    skills: () => result(db.rpc('list_skills')),
    delivery: () => result(db.from('skill_delivery').select('repository,installation_id,branch,revoked_at').maybeSingle()),
    kit: target => result(db.from('skill_kit_items').select('skill_id').eq('target',target)),
    addSource: (id,repository) =>
      result(db.rpc('add_skill_source',{p_id:id,p_repository:repository}).single()),
    setDeliverySource: sourceId => result(db.rpc('set_delivery_source',{p_source_id:sourceId})),
    syncSource: (sourceId,commitSha,skills) =>
      result(db.rpc('sync_skill_source',{p_source_id:sourceId,p_commit_sha:commitSha,p_skills:skills})),
    setKitItem: (target,skillId,included) =>
      result(db.rpc('set_kit_item',{p_target:target,p_skill_id:skillId,p_included:included})),
    connectDelivery: (repository,installationId,branch) =>
      result(db.rpc('connect_skill_delivery',{p_repository:repository,
        p_installation_id:installationId,p_branch:branch}).single()),
    openRelease: args => result(db.rpc('open_skill_release',
      {p_id:args.id,p_target:args.target,p_manifest:args.manifest}).single()),
    finishRelease: args => result(db.rpc('finish_skill_release',{p_id:args.id,
      p_commit_sha:args.commitSha,p_files:args.files,p_checksum:args.checksum,
      p_generated_paths:args.generatedPaths,p_archive_sha256:args.archiveSha256??null}).single()),
    async deliveredCount(target) {
      const {count,error}=await db.from('skill_releases').select('id',{count:'exact',head:true})
        .eq('target',target).not('commit_sha','is',null).abortSignal(AbortSignal.timeout(8000));
      if(error)throw error;
      return count??0;
    },
    async liveTargets() {
      const rows=await result(db.from('skill_releases').select('target')
        .not('commit_sha','is',null));
      return [...new Set(rows.map(r=>r.target))];
    },
  };
}
