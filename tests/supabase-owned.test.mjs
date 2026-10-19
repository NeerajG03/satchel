import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';

// Supabase owns the storage and auth schemas and changes their rules under
// us. A plain SQL delete on storage.objects worked until Supabase added a
// guard, and then every topic with a file became impossible to delete, shown
// to the person as a sign-in problem. The shared test fake carries the guard,
// but only for routines a test happens to run. This catches the rest: our SQL
// goes through Supabase's own API for these tables, never around it.
//
// Migrations are append only, so the ones written before the fix are history
// and are left alone; the routine that broke was replaced in the fix itself.
const FIXED='20261019090000_task_files_leave_through_storage.sql';
const WRITE=/\b(insert\s+into|update|delete\s+from|truncate(\s+table)?)\s+(storage|auth)\./i;

test('migrations never write to tables Supabase owns',async()=>{
  const dir=new URL('../supabase/migrations/',import.meta.url);
  const names=(await readdir(dir)).filter(name=>name.endsWith('.sql')&&name>=FIXED).sort();
  assert.ok(names.includes(FIXED));
  const found=[];
  for(const name of names) {
    const lines=(await readFile(new URL(name,dir),'utf8')).split('\n');
    lines.forEach((line,index)=>{
      const code=line.replace(/--.*$/,'');
      if(WRITE.test(code))found.push(`${name}:${index+1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(found,[],'Use the Storage or Auth API from the app instead of SQL on these tables.');
});
