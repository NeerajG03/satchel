import { useMemo } from 'react';
import { useDb } from './auth';
import { createMemoryRepository } from '../features/memories/repository';
import { createTopicRepository } from '../features/topics/repository';
import { createConnectionRepository } from '../features/connections/repository';
import { createActivityRepository } from '../features/activity/repository';
import { createOvernightRepository } from '../features/settings/repository';

export function useStores() {
  const db = useDb();
  return useMemo(() => ({
    db,
    memories: createMemoryRepository(db),
    topics: createTopicRepository(db),
    connections: createConnectionRepository(db),
    activity: createActivityRepository(db),
    overnight: createOvernightRepository(db),
  }), [db]);
}
export type Stores = ReturnType<typeof useStores>;
