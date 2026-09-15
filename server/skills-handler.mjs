import {createRemoteJWKSet,jwtVerify} from 'jose';
import {createClient} from '@supabase/supabase-js';
import {RESOURCE,SUPABASE_URL} from './http-handler.mjs';
import {skillsService} from './skills-service.mjs';
import {githubApp,GitHubError} from './github-app.mjs';
import {buildRelease,deletions,TARGETS} from './release-builder.mjs';

const issuer=SUPABASE_URL+'/auth/v1';
const keys=createRemoteJWKSet(new URL(issuer+'/.well-known/jwks.json'));

// The inverse of verifyAgentToken. That one REQUIRES client_id and a grant;
// this one must REJECT any token carrying client_id, matching the row-level
// policies. Getting the inversion wrong would let an agent grant publish.
export async function verifyCompanionToken(token,verificationKeys=keys) {
  const {payload}=await jwtVerify(token,verificationKeys,{issuer,
    algorithms:['ES256','RS256'],requiredClaims:['exp','sub']});
  if(payload.client_id!==undefined)
    throw Error('Agent tokens cannot manage skills');
  if(typeof payload.sub!=='string'||!payload.sub)throw Error('Missing subject');
  return payload;
}

// GitHub login comes from the user's own Supabase identity, never from the
// request body, because it is half of the installation-ownership check.
export function githubLogin(payload) {
  const meta=payload.user_metadata??{};
  const login=meta.user_name??meta.preferred_username??meta.nickname;
  if(typeof login!=='string'||!/^[A-Za-z0-9-]{1,39}$/.test(login))
    throw Error('No GitHub identity on this Satchel account');
  return login;
}

const json=(res,status,body)=>{
  res.writeHead(status,{'content-type':'application/json'});
  res.end(JSON.stringify(body));
};
const message=error=>error instanceof GitHubError
  ? error.message
  : ({'42501':'Access denied. Sign in to Satchel again.',
      'P0002':'That source is unavailable. Reload the shelf.',
      'PT409':'This release was already delivered. Reload before retrying.',
      '40001':'Request conflict. Reload the shelf; do not overwrite blindly.',
      '23505':'That repository is already used for this purpose.',
      '23514':'A value exceeded the permitted limits.',
    }[error?.code]??'Satchel could not complete that request.');

function parse(body,limit=65536) {
  let value=body;
  if(Buffer.isBuffer(value))value=value.toString('utf8');
  if(typeof value==='string') {
    if(Buffer.byteLength(value,'utf8')>limit)throw Error('Request too large');
    value=JSON.parse(value);
  }
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid request');
  return value;
}

export function createSkillsHandler({makeClient=createClient,makeService=skillsService,
  verify=verifyCompanionToken,makeApp=githubApp,env=process.env}={}) {
  return async function handle(req,res) {
    res.setHeader('Cache-Control','no-store');
    if(req.method!=='POST'){res.writeHead(405,{Allow:'POST'});return res.end();}

    const token=req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
    let claims;
    try {
      if(!token)throw Error('Missing token');
      claims=await verify(token);
    } catch {
      res.writeHead(401,{'WWW-Authenticate':`Bearer resource_metadata="${RESOURCE}"`});
      return res.end('Authentication required');
    }

    const key=env.VITE_SUPABASE_PUBLISHABLE_KEY;
    const appId=env.SATCHEL_GITHUB_APP_ID;
    const privateKey=env.SATCHEL_GITHUB_APP_PRIVATE_KEY;
    if(!key||!appId||!privateKey)return json(res,503,{error:'Skill delivery is not configured on this deployment.'});

    let body;
    try {body=parse(req.body);}
    catch {return json(res,400,{error:'Invalid request.'});}

    const db=makeClient(SUPABASE_URL,key,{
      auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
      global:{headers:{Authorization:`Bearer ${token}`}}});
    const service=makeService(db);
    const app=makeApp({appId,privateKey});

    // Ownership is re-verified on every operation that uses the installation,
    // because the stored row is a claim the browser wrote, not a verified fact.
    async function authorizedDelivery() {
      const delivery=await service.delivery();
      if(!delivery||delivery.revoked_at)throw new GitHubError(409,'Connect a delivery repository in Satchel first');
      const {token:installationToken}=await app.verifyInstallation({
        installationId:delivery.installation_id,repository:delivery.repository,
        login:githubLogin(claims)});
      return {delivery,installationToken};
    }

    try {
      if(body.action==='connect') {
        const repository=String(body.repository??'').trim().toLowerCase();
        const installationId=Number(body.installation_id);
        if(!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository)||!Number.isSafeInteger(installationId)||installationId<=0)
          return json(res,400,{error:'Enter a GitHub repository as owner/name.'});
        await app.verifyInstallation({installationId,repository,login:githubLogin(claims)});
        const row=await service.connectDelivery(repository,installationId);
        return json(res,200,{delivery:{repository:row.repository,branch:row.branch}});
      }

      if(body.action==='sync') {
        const {installationToken}=await authorizedDelivery();
        const sources=await service.sources();
        const source=sources.find(s=>s.id===body.source_id);
        if(!source)return json(res,404,{error:'That source is not on your shelf.'});
        const parent=await app.resolveBranch({token:installationToken,repository:source.repository});
        if(parent.empty)return json(res,200,{synced:0,empty:true,skills:[]});
        const {skills,truncated}=await app.listSkills({token:installationToken,
          repository:source.repository,commitSha:parent.commitSha});
        const rows=await service.syncSource(source.id,parent.commitSha,
          skills.map(s=>({name:s.name,path:s.path,description:s.description})));
        return json(res,200,{synced:rows.length,truncated,commit_sha:parent.commitSha,
          warnings:skills.filter(s=>s.nameMismatch).map(s=>
            `${s.name}: its frontmatter name differs from its directory, so the host will use the frontmatter name`)});
      }

      if(body.action==='publish') {
        const target=String(body.target??'');
        if(!TARGETS.includes(target))return json(res,400,{error:'Unknown target.'});
        if(typeof body.release_id!=='string')return json(res,400,{error:'Supply a release id.'});
        const {delivery,installationToken}=await authorizedDelivery();

        const [chosen,shelf,previous,live]=await Promise.all([
          service.kit(target),service.skills(),service.previousRelease(target),service.liveTargets()]);
        const wanted=new Set(chosen.map(item=>item.skill_id));
        const selected=shelf.filter(skill=>wanted.has(skill.id));
        if(!selected.length)return json(res,400,{error:'Tick at least one skill before publishing.'});

        // Content is read at publish time and frozen into the release, so the
        // release survives the source moving or disappearing later.
        const skills=[];
        for(const skill of selected)
          skills.push({name:skill.name,content:await app.readSkill({token:installationToken,
            repository:skill.repository,blobSha:body.blob_shas?.[skill.id]??skill.seen_sha})});

        const openArgs=version=>{
          const built=buildRelease({target,version,repository:delivery.repository,skills,liveTargets:live});
          return {built,manifest:{target,repository:delivery.repository,
            skills:selected.map(s=>({name:s.name,repository:s.repository,seen_sha:s.seen_sha}))}};
        };
        // open_skill_release allocates the version itself, so build twice:
        // once to get a checksum to reserve against, once at the real version.
        const provisional=openArgs(1);
        const reserved=await service.openRelease({id:body.release_id,target,
          manifest:provisional.manifest,files:provisional.built.files,
          generatedPaths:provisional.built.generatedPaths,checksum:provisional.built.checksum});
        const {built}=openArgs(reserved.version);

        const parent=await app.resolveBranch({token:installationToken,
          repository:delivery.repository,branch:delivery.branch});
        const removing=deletions({previousPaths:previous?.generated_paths??[],
          generatedPaths:built.generatedPaths,target});
        const commitSha=await app.commitRelease({token:installationToken,
          repository:delivery.repository,branch:parent.branch,parent,files:built.files,
          deletions:parent.empty?[]:removing,
          message:`Satchel ${target} release v${reserved.version}`});
        await app.createTag({token:installationToken,repository:delivery.repository,
          commitSha,tag:`${target}-v${reserved.version}`});
        const row=await service.finishRelease(body.release_id,commitSha,null);
        return json(res,200,{release:{version:row.version,commit_sha:commitSha,
          checksum:row.checksum,removed:removing}});
      }

      return json(res,400,{error:'Unknown action.'});
    } catch(error) {
      // A failed commit leaves a reserved, undelivered release. That is an
      // uncertain outcome and is reported as one, never as published.
      const status=error instanceof GitHubError?(error.status===403?403:502):400;
      return json(res,status,{error:message(error)});
    }
  };
}
