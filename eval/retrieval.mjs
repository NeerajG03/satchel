// Manual retrieval evaluation. Not part of `npm test`: it measures quality, and
// quality is read by a person, not asserted. See docs/memory-v2-build.md 4.6.
//
//   node eval/retrieval.mjs
//
// The corpus was written by an agent that was given no knowledge of the query
// design, so a query tuned to score well here is not scoring against itself.
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';

const corpus=JSON.parse(readFileSync(new URL('./corpus.json',import.meta.url),'utf8'));
const vague=corpus.prompts.filter(p=>p.text.split(/\s+/).length<=4);
const pct=x=>Math.round(100*x)+'%';
const heading=t=>console.log(`\n${t}\n${'-'.repeat(t.length)}`);

const db=new PGlite();
await db.exec(`
create table memories(
  id serial primary key, statement text not null, project text, task text,
  s_en tsvector generated always as (to_tsvector('english', statement)) stored,
  s_sm tsvector generated always as (to_tsvector('simple',  statement)) stored);
create index on memories using gin(s_en);
create index on memories using gin(s_sm);

-- A prompt is a bag of words, not a boolean expression. websearch_to_tsquery
-- ANDs every term, which is why stage 1 scores 5%.
create function or_tsquery(cfg regconfig, t text) returns tsquery language sql immutable as $$
  select coalesce(nullif(array_to_string(tsvector_to_array(to_tsvector(cfg,t)),' | '),'')::tsquery,
                  ''::tsquery) $$;`);
for(const m of corpus.memories)
  await db.query('insert into memories(statement,project,task) values($1,$2,$3)',[m.statement,m.project,m.task]);
await db.exec(`
create materialized view lexeme_df as select word lex, ndoc from ts_stat('select s_en from public.memories');
create unique index on lexeme_df(lex);
create table corpus_size as select count(*)::float n from memories;

-- total ranks, best gates. A sum rewards long prompts, so it cannot also be the
-- floor; the floor is "did this match anything actually rare".
create function m_score(p_query text, p_vec tsvector, out total float, out best float)
language sql stable as $$
  select coalesce(sum(i),0), coalesce(max(i),0) from (
    select ln((select n from corpus_size)/greatest(d.ndoc,1)) i
    from unnest(tsvector_to_array(to_tsvector('english',p_query))) q
    join lexeme_df d on d.lex=q
    where p_vec @@ (quote_literal(q)||'')::tsquery) x $$;`);

console.log(`corpus: ${corpus.projects.length} projects, ${corpus.tasks.length} tasks, `
  +`${corpus.memories.length} memories, ${corpus.prompts.length} prompts`);
const personal=corpus.memories.filter(m=>m.project===null&&m.task===null);
const chars=personal.reduce((a,m)=>a+m.statement.length+9,0)
  +corpus.projects.reduce((a,p)=>a+p.slug.length+p.brief.length+6,0);
console.log(`session start: ${personal.length} personal + ${corpus.projects.length} projects `
  +`= ${chars} chars, ~${Math.round(chars/3.8)} tokens `
  +`(server/mcp-server.mjs caps injection at 1800 BYTES)`);

heading('1. query construction');
const strategies={
  'websearch AND (english)': `m.s_en @@ websearch_to_tsquery('english',$1)`,
  'or-lexemes (english)':    `(or_tsquery('english',$1) <> ''::tsquery and m.s_en @@ or_tsquery('english',$1))`,
  'or-lexemes (simple)':     `(or_tsquery('simple',$1)  <> ''::tsquery and m.s_sm @@ or_tsquery('simple',$1))`,
};
console.log('strategy'.padEnd(26),'hit%','  zero','  avg@5');
for(const [name,pred] of Object.entries(strategies)) {
  let hits=0,rows=0;
  for(const p of corpus.prompts) {
    const n=(await db.query(`select 1 from memories m where ${pred} limit 5`,[p.text])).rows.length;
    rows+=n; if(n) hits++;
  }
  console.log(name.padEnd(26),pct(hits/corpus.prompts.length).padStart(4),
    String(corpus.prompts.length-hits).padStart(6),(rows/corpus.prompts.length).toFixed(2).padStart(7));
}

heading('2. ts_rank_cd has no corpus statistics, so it cannot rank');
const RANK_CD=`select m.project,m.statement,ts_rank_cd(m.s_en,or_tsquery('english',$1)) r
  from memories m where or_tsquery('english',$1) <> ''::tsquery and m.s_en @@ or_tsquery('english',$1)
  order by r desc, m.id limit 5`;
const all=[];
for(const p of corpus.prompts) for(const row of (await db.query(RANK_CD,[p.text])).rows) all.push(row.r);
all.sort((a,b)=>a-b);
const q=f=>all[Math.floor(f*(all.length-1))].toFixed(4);
console.log(`${all.length} rows returned; percentiles p10 ${q(.1)} p50 ${q(.5)} p90 ${q(.9)} max ${q(1)}`);
for(const x of (await db.query(RANK_CD,['go on'])).rows.slice(0,2))
  console.log(`  "go on" -> ${x.r.toFixed(4)} [${x.project??'personal'}] ${x.statement.slice(0,64)}`);

await db.exec(`
create function q_ceiling(p_query text) returns float language sql stable as $$
  select coalesce(sum(ln((select n from corpus_size)/greatest(d.ndoc,1))),0)
  from unnest(tsvector_to_array(to_tsvector('english',p_query))) q join lexeme_df d on d.lex=q $$;`);

heading('3. the floor: four candidate rules, none of them clearly right');
// Ranking is settled (summed IDF). The floor is not. These disagree on real
// cases and picking between them needs labelled relevance, which this corpus
// deliberately does not have.
const rules={
  'A best >= 4.6':             `(m_score($1,m.s_en)).best >= 4.6`,
  'B total >= 7':              `(m_score($1,m.s_en)).total >= 7`,
  'C coverage >= 0.35':        `(m_score($1,m.s_en)).total >= 0.35*greatest(q_ceiling($1),0.001)`,
  'D A or C':                  `((m_score($1,m.s_en)).best >= 4.6 or (m_score($1,m.s_en)).total >= 0.35*greatest(q_ceiling($1),0.001))`,
};
const PAYOUT='remind me why we cant get rid of that old payout table yet';
const TAX='how much am i short on my section 80C this year';
console.log('rule'.padEnd(22),'hits','  avg-rows','  vague-leak','  payout','  80C');
for(const [name,pred] of Object.entries(rules)) {
  const Q=`select m.statement,(m_score($1,m.s_en)).total t from memories m
           where ${pred} order by t desc, m.id limit 5`;
  let h=0,rows=0,vh=0;
  for(const p of corpus.prompts){const r=(await db.query(Q,[p.text])).rows;rows+=r.length;if(r.length)h++;}
  for(const p of vague){if((await db.query(Q,[p.text])).rows.length)vh++;}
  const top=async(text,word)=>{
    const r=(await db.query(Q,[text])).rows;
    return !r.length?'silent':(r[0].statement.toLowerCase().includes(word)?'right':'wrong');
  };
  console.log(name.padEnd(22),`${h}/${corpus.prompts.length}`.padStart(5),
    (rows/corpus.prompts.length).toFixed(2).padStart(10),`   ${vh}/${vague.length}`.padStart(11),
    `  ${await top(PAYOUT,'payouts_v1')}`.padEnd(9),` ${await top(TAX,'80c')}`);
}
console.log(`
  A silences vague prompts but loses the payout answer, whose correct rows
    score 8.49 on terms that are individually common.
  B is the only rule that gets both benchmarks and leaks no vague prompt,
    at a third of the coverage. Whether that is precision or blindness cannot
    be told apart without labelled relevance.
  C and D break on short prompts: "go on" has a ceiling of 3.9 and matching
    "go" alone is 100% coverage, so any ratio rule waves it through.`);

const GATE=Number(process.env.SATCHEL_EVAL_GATE??4.6);
heading(`4. what rule A at ${GATE} returns, for reading by eye`);
const RANK=`select m.project,m.statement,(m_score($1,m.s_en)).total t
  from memories m where (m_score($1,m.s_en)).best >= $2 order by t desc, m.id limit 5`;
const show=['go on','ok keep going','what was i doing last week',TAX,PAYOUT,
  'what was the deal with the double-charge thing we hit on capture'];
for(const text of show) {
  const r=(await db.query(RANK,[text,GATE])).rows;
  console.log(`\n"${text}"`);
  if(!r.length){console.log('   (nothing)');continue;}
  for(const x of r.slice(0,3))
    console.log(`   ${x.t.toFixed(1).padStart(5)}  [${x.project??'personal'}] ${x.statement.slice(0,72)}`);
}

heading('5. the paraphrase miss, which no FTS tuning reaches');
console.log('the last prompt says "double-charge". the corpus holds the answer under "idempotency":');
for(const x of (await db.query(
  `select project,statement from memories where statement ~* 'idempotenc' order by id limit 3`)).rows)
  console.log(`   [${x.project??'personal'}] ${x.statement.slice(0,86)}`);
console.log('\nzero lexical overlap. this is the trigger memory-v2.md section 11 defers pgvector behind.');
