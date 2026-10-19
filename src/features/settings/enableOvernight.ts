import type { OvernightRepository } from './repository';
import type { ConnectionRepository } from '../connections/repository';
import type { Finished } from './consolidationConnect';

/** Stores the overnight sign-in. Allowing it on the consent page already made
 *  a connection, so if storing fails, that connection would sit on the Apps
 *  page with nothing behind it. It is taken back, unless it is the one a
 *  running pass already uses. */
export async function enableOvernight(overnight: Pick<OvernightRepository, 'status' | 'enable'>,
  connections: Pick<ConnectionRepository, 'revoke'>, done: Finished): Promise<void> {
  const before = await overnight.status().catch(() => null);
  try {
    await overnight.enable(done);
  } catch (error) {
    if (before?.client_id !== done.clientId) await connections.revoke({ client_id: done.clientId }).catch(() => undefined);
    throw error;
  }
}
