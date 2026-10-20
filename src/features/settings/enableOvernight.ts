import type { OvernightRepository } from './repository';
import type { ConnectionRepository } from '../connections/repository';
import type { Finished } from './consolidationConnect';

/** Stores the overnight sign-in. Allowing it on the consent page already made
 *  a connection, so if storing fails, that connection would sit on the Apps
 *  page with nothing behind it, and it is taken back. Not when a running pass
 *  already uses it, not when the store landed and only the answer was lost,
 *  and not when either of those cannot be told. */
export async function enableOvernight(overnight: Pick<OvernightRepository, 'status' | 'enable'>,
  connections: Pick<ConnectionRepository, 'revoke'>, done: Finished): Promise<void> {
  const before = await overnight.status().catch(() => undefined);
  try {
    await overnight.enable(done);
  } catch (error) {
    if (before === undefined || before?.client_id === done.clientId) throw error;
    const after = await overnight.status().catch(() => undefined);
    if (after === undefined) throw error;
    if (after?.client_id === done.clientId) return;
    await connections.revoke({ client_id: done.clientId }).catch(() => undefined);
    throw error;
  }
}
