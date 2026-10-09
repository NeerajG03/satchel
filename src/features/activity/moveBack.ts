import type { SupabaseClient } from '@supabase/supabase-js';
import { requestWithTimeout } from '../../request.mjs';
import type { MemoryEvent } from './model';

/** Undoes one move: the memory goes back where that move took it from. Only
 *  while it is still where the move put it, so an undo never drags a memory
 *  out of somewhere it was filed since. Returns where it went. */
export async function moveBack(db: SupabaseClient, event: MemoryEvent): Promise<string> {
  const read = async <T>(run: (signal: AbortSignal) => PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> => {
    const { data, error } = await requestWithTimeout(run);
    if (error) throw error;
    return (data ?? []) as T[];
  };
  const [memory] = await read<{ id: string; revision: number; topic_id: string | null; ended_at: string | null }>(signal =>
    db.from('memories').select('id,revision,topic_id,ended_at').eq('id', event.memory_id).limit(1).abortSignal(signal));
  const topics = await read<{ id: string; slug: string }>(signal => db.from('topics').select('id,slug').abortSignal(signal));
  if (!memory || memory.ended_at) throw new Error('That memory is not live any more, so there is nothing to move back.');
  const here = topics.find(t => t.id === memory.topic_id)?.slug ?? 'personal';
  if (here !== event.after) throw new Error(`It has moved since, and is in ${here} now. Nothing changed.`);
  const back = event.before === 'personal' ? null : topics.find(t => t.slug === event.before)?.id;
  if (back === undefined) throw new Error(`The topic ${event.before} is gone, so it cannot go back there.`);
  const { error } = await requestWithTimeout(signal => db.rpc('move_memory', {
    p_id: memory.id, p_revision: memory.revision, p_topic_id: back, p_note: 'moved back by hand',
  }).abortSignal(signal));
  if (error) throw error;
  return event.before ?? 'personal';
}
