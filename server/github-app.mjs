import {createPrivateKey} from 'node:crypto';
import {SignJWT} from 'jose';

// GitHub App client for one job: read skills from a source repository, and
// write only the paths Satchel generated. Tokens are minted per request and
// never stored. fetchImpl is injectable so every call is testable offline.

const API='https://api.github.com';
const ACCEPT='application/vnd.github+json';
const SKILL_PATH=/^skills\/([a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)\/SKILL\.md$/;

export class GitHubError extends Error {
  constructor(status,message,path) {super(message);this.status=status;this.path=path;}
}

// GitHub issues PKCS#1 keys ("BEGIN RSA PRIVATE KEY"); createPrivateKey accepts
// both that and PKCS#8, so the deployment value can be whichever they hand you.
export async function appJwt({appId,privateKey,now=Math.floor(Date.now()/1000)}) {
  return new SignJWT({})
    .setProtectedHeader({alg:'RS256'})
    .setIssuer(String(appId))
    // 60s back-dated for clock skew, which GitHub's own guidance asks for.
    .setIssuedAt(now-60).setExpirationTime(now+540)
    .sign(createPrivateKey(privateKey));
}

// Frontmatter only needs name and description. This is deliberately not a YAML
// parser: it reads top-level scalars, including block scalars, and ignores
// anything else rather than pretending to understand it.
export function readFrontmatter(text) {
  if(!text.startsWith('---\n')&&!text.startsWith('---\r\n'))return {};
  const lines=text.split(/\r?\n/).slice(1);
  const end=lines.findIndex(line=>line.trim()==='---');
  if(end<0)return {};
  const fields={};
  for(let i=0;i<end;i++) {
    const match=lines[i].match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/);
    if(!match)continue;
    const [,key,raw]=match;
    if(raw==='>'||raw==='|'||raw==='>-'||raw==='|-') {
      const block=[];
      while(i+1<end&&(lines[i+1].trim()===''||/^\s+/.test(lines[i+1])))block.push(lines[++i].trim());
      fields[key]=block.join(' ').trim();
    } else {
      fields[key]=raw.trim().replace(/^(['"])(.*)\1$/,'$2');
    }
  }
  return fields;
}

export function githubApp({appId,privateKey,fetchImpl=fetch}) {
  async function call({path,method='GET',body,token,appAuth}) {
    const authorization=appAuth?`Bearer ${await appJwt({appId,privateKey})}`:`Bearer ${token}`;
    const response=await fetchImpl(API+path,{
      method,headers:{authorization,accept:ACCEPT,'user-agent':'satchel',
        ...(body?{'content-type':'application/json'}:{})},
      ...(body?{body:JSON.stringify(body)}:{}),
      signal:AbortSignal.timeout(15000),
    });
    if(response.status===204)return null;
    const text=await response.text();
    let data=null;
    try {data=text?JSON.parse(text):null;}catch{/* Non-JSON errors still carry a status. */}
    if(!response.ok)
      throw new GitHubError(response.status,data?.message??`GitHub request failed (${response.status})`,path);
    return data;
  }

  const repoPath=repository=>{
    if(!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository))throw Error('Invalid repository');
    return `/repos/${repository}`;
  };

  return {
    async installationToken(installationId) {
      const data=await call({path:`/app/installations/${Number(installationId)}/access_tokens`,
        method:'POST',appAuth:true});
      if(!data?.token)throw new GitHubError(502,'Installation token missing from response');
      return data.token;
    },

    // The browser cannot be believed about installation_id: one it does not own
    // would otherwise let it write to someone else's repositories. Both checks
    // run on connect and again on every publish.
    async verifyInstallation({installationId,repository,login}) {
      const installation=await call({path:`/app/installations/${Number(installationId)}`,appAuth:true});
      const account=installation?.account?.login;
      if(!account||!login||account.toLowerCase()!==String(login).toLowerCase())
        throw new GitHubError(403,'That installation belongs to a different GitHub account');
      const token=await this.installationToken(installationId);
      const wanted=repository.toLowerCase();
      for(let page=1;page<=20;page++) {
        const listed=await call({path:`/installation/repositories?per_page=100&page=${page}`,token});
        const repositories=listed?.repositories??[];
        if(repositories.some(r=>String(r.full_name).toLowerCase()===wanted))return {token,account};
        if(repositories.length<100)break;
      }
      throw new GitHubError(403,'The Satchel app is not installed on that repository');
    },

    async defaultBranch({token,repository}) {
      const repo=await call({path:repoPath(repository),token});
      return repo?.default_branch??'main';
    },

    async resolveBranch({token,repository,branch}) {
      const name=branch??await this.defaultBranch({token,repository});
      try {
        const ref=await call({path:`${repoPath(repository)}/git/ref/heads/${encodeURIComponent(name)}`,token});
        const commit=await call({path:`${repoPath(repository)}/git/commits/${ref.object.sha}`,token});
        return {branch:name,commitSha:ref.object.sha,treeSha:commit.tree.sha,empty:false};
      } catch(error) {
        // A repository the user just created has no commits yet. That is the
        // expected first-publish state, not a failure.
        if(error.status===404||error.status===409)
          return {branch:name,commitSha:null,treeSha:null,empty:true};
        throw error;
      }
    },

    // Discovery reads skills/<name>/SKILL.md only. A truncated tree is reported
    // rather than silently returning a partial shelf.
    async listSkills({token,repository,commitSha}) {
      const tree=await call({path:`${repoPath(repository)}/git/trees/${commitSha}?recursive=1`,token});
      const entries=(tree?.tree??[]).filter(e=>e.type==='blob'&&SKILL_PATH.test(e.path));
      const skills=[];
      for(let start=0;start<entries.length;start+=8) {
        const batch=await Promise.all(entries.slice(start,start+8).map(async entry=>{
          const blob=await call({path:`${repoPath(repository)}/git/blobs/${entry.sha}`,token});
          const content=Buffer.from(blob.content??'',blob.encoding==='base64'?'base64':'utf8').toString('utf8');
          const front=readFrontmatter(content);
          const name=entry.path.match(SKILL_PATH)[1];
          return {name,path:entry.path,blobSha:entry.sha,content,
            description:(front.description??'').slice(0,280),
            // Claude uses frontmatter name for a plugin skill's invocation name,
            // so a mismatch with the directory is worth surfacing, not fixing.
            nameMismatch:Boolean(front.name)&&front.name!==name};
        }));
        skills.push(...batch);
      }
      return {skills:skills.sort((a,b)=>a.name.localeCompare(b.name)),
        truncated:Boolean(tree?.truncated)};
    },

    // Live listing of what Satchel previously generated under one target, used
    // to compute deletions exactly rather than from bookkeeping that can drift.
    async listTreePaths({token,repository,treeSha,prefix}) {
      if(!treeSha)return [];
      const tree=await call({path:`${repoPath(repository)}/git/trees/${treeSha}?recursive=1`,token});
      if(tree?.truncated)throw new GitHubError(409,
        'The delivery repository is too large to publish into safely: its tree listing was truncated');
      return (tree?.tree??[]).filter(e=>e.type==='blob'&&e.path.startsWith(prefix)).map(e=>e.path).sort();
    },

    async readSkill({token,repository,blobSha}) {
      const blob=await call({path:`${repoPath(repository)}/git/blobs/${blobSha}`,token});
      return Buffer.from(blob.content??'',blob.encoding==='base64'?'base64':'utf8').toString('utf8');
    },

    // base_tree is the safety property. The repository also holds the user's
    // skills/ directory, so the commit starts from the current tree and changes
    // only the paths passed in. Never call this with a full replacement.
    async commitRelease({token,repository,branch,parent,files,deletions=[],message}) {
      const tree=[
        ...Object.keys(files).sort().map(path=>({path,mode:'100644',type:'blob',content:files[path]})),
        ...[...deletions].sort().map(path=>({path,mode:'100644',type:'blob',sha:null})),
      ];
      if(!tree.length)throw Error('Refusing to commit an empty change');
      if(parent.empty&&deletions.length)throw Error('Cannot delete paths in a repository with no commits');
      const created=await call({path:`${repoPath(repository)}/git/trees`,method:'POST',token,
        body:{...(parent.treeSha?{base_tree:parent.treeSha}:{}),tree}});
      const commit=await call({path:`${repoPath(repository)}/git/commits`,method:'POST',token,
        body:{message,tree:created.sha,parents:parent.commitSha?[parent.commitSha]:[]}});
      const ref=`heads/${branch}`;
      if(parent.empty)
        await call({path:`${repoPath(repository)}/git/refs`,method:'POST',token,
          body:{ref:`refs/${ref}`,sha:commit.sha}});
      else
        await call({path:`${repoPath(repository)}/git/refs/${encodeURIComponent(ref)}`,method:'PATCH',
          token,body:{sha:commit.sha}});
      return commit.sha;
    },

    // A retried publish must not fail on its own tag. An existing tag pointing
    // at this commit is success; one pointing elsewhere is a real conflict.
    async createTag({token,repository,commitSha,tag}) {
      try {
        await call({path:`${repoPath(repository)}/git/refs`,method:'POST',token,
          body:{ref:`refs/tags/${tag}`,sha:commitSha}});
        return {tag,created:true};
      } catch(error) {
        if(error.status!==422)throw error;
        const existing=await call({path:`${repoPath(repository)}/git/ref/tags/${encodeURIComponent(tag)}`,token});
        if(existing?.object?.sha!==commitSha)
          throw new GitHubError(409,`Tag ${tag} already points at a different commit`);
        return {tag,created:false};
      }
    },
  };
}
