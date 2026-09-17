import {cp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const out=resolve(process.argv[2]??join(root,'dist/plugins'));
const repo='NeerajG03/satchel-plugins';
const description='Personal and project memory across your agents.';

const version=async host=>JSON.parse(await readFile(join(root,'integrations',host,'satchel',`.${host}-plugin`,'plugin.json'),'utf8')).version;

await rm(out,{recursive:true,force:true});
await mkdir(join(out,'.claude-plugin'),{recursive:true});
await mkdir(join(out,'.agents/plugins'),{recursive:true});
for(const host of ['claude','codex']) await cp(join(root,'integrations',host,'satchel'),join(out,host,'satchel'),{recursive:true});

await writeFile(join(out,'.claude-plugin/marketplace.json'),JSON.stringify({
  name:'satchel',
  owner:{name:'Satchel',url:`https://github.com/${repo}`},
  plugins:[{name:'satchel',source:'./claude/satchel',description,version:await version('claude'),category:'productivity'}],
},null,2)+'\n');

await writeFile(join(out,'.agents/plugins/marketplace.json'),JSON.stringify({
  name:'satchel',
  interface:{displayName:'Satchel'},
  plugins:[{name:'satchel',source:{source:'local',path:'./codex/satchel'},policy:{installation:'AVAILABLE',authentication:'ON_INSTALL'},category:'Productivity'}],
},null,2)+'\n');

await writeFile(join(out,'README.md'),`# Satchel plugins

Install catalog for the Satchel plugin. It gives Claude Code and Codex the address of your Satchel, loads your memory index when a session starts, and teaches the agent how to save and read memories and tasks. No memory or credentials live here. Sign in happens in your browser after install.

## Claude Code

\`\`\`sh
claude plugin marketplace add ${repo}
claude plugin install satchel@satchel
claude mcp login plugin:satchel:satchel
\`\`\`

## Codex

\`\`\`sh
codex plugin marketplace add ${repo}
codex plugin add satchel@satchel
codex mcp login satchel
\`\`\`

Then allow access on the Satchel page that opens, and start a fresh session. Manage or revoke access at https://satchel-pi.vercel.app/apps.

Generated from the Satchel repository by \`scripts/publish-plugins.mjs\`. Do not edit here.
`);
console.log(`Wrote ${out}`);
