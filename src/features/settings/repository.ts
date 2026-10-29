import type { SupabaseClient } from '@supabase/supabase-js';
import { requestWithTimeout } from '../../request.mjs';
import { Sentence } from '../../client';
import { consolidationEndpoint } from './consolidationConnect';
import { hourMinute, tidy, type Schedule } from './schedule.mjs';

/** The overnight pass as consolidation_status() reports it. No row means it is
 *  off and was never on, or was switched off. */
export type Overnight = Schedule & {
  enabled: boolean; endpoint: string; idle_minutes: number; last_run_at: string | null;
  last_status: number | null; last_error: string | null; failures: number; scheduled: boolean;
  client_id: string;
};

// The sentences the schedule routines raise for a person. Anything else they
// raise is mapped from its code, never shown.
const OURS = /^(Choose |Two passes|That time zone|Switch the overnight pass|The overnight pass can only)/;
function plain(error: { code?: string; message?: string }): never {
  if (error.message && OURS.test(error.message)) throw new Sentence(error.message);
  throw error;
}

export function createOvernightRepository(db: SupabaseClient) {
  return {
    async status(): Promise<Overnight | null> {
      const { data, error } = await requestWithTimeout(signal => db.rpc('consolidation_status').abortSignal(signal));
      if (error) throw error;
      const row = (data as (Omit<Overnight, 'times'> & { times: string[] })[] | null)?.[0];
      if (!row) return null;
      // A row without times came from the database before the schedule
      // migration. Say the database needs setting up, the way every other page
      // does, rather than failing on undefined.
      if (!Array.isArray(row.times)) throw Object.assign(new Error('The schedule columns are missing'), { code: 'PGRST202' });
      return { ...row, times: row.times.map(hourMinute) };
    },
    async setSchedule(schedule: Schedule): Promise<void> {
      const tidied = tidy(schedule);
      const { error } = await requestWithTimeout(signal => db.rpc('set_consolidation_schedule', {
        p_days: tidied.days, p_times: tidied.times, p_timezone: tidied.timezone,
      }).abortSignal(signal));
      if (error) plain(error);
    },
    /** Called once the person has allowed the connection and the browser holds
     *  the refresh token. It goes straight into the Vault and is not kept. */
    async enable(input: { clientId: string; refreshToken: string; schedule: Schedule }): Promise<void> {
      const tidied = tidy(input.schedule);
      const { error } = await requestWithTimeout(signal => db.rpc('enable_consolidation', {
        p_client_id: input.clientId, p_refresh_token: input.refreshToken,
        p_endpoint: consolidationEndpoint(), p_idle_minutes: 30,
        p_days: tidied.days, p_times: tidied.times, p_timezone: tidied.timezone,
      }).abortSignal(signal));
      if (error) plain(error);
    },
    async disable(): Promise<void> {
      const { error } = await requestWithTimeout(signal => db.rpc('disable_consolidation').abortSignal(signal));
      if (error) throw error;
    },
  };
}
export type OvernightRepository = ReturnType<typeof createOvernightRepository>;
