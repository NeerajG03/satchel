import { useMemo } from 'react';
import { useDb } from './auth';
import { createMemoryRepository } from '../features/memories/repository';
import { createProjectRepository } from '../features/projects/repository';
import { createTaskRepository } from '../features/tasks/repository';
import { createConnectionRepository } from '../features/connections/repository';

export function useStores() {
  const db = useDb();
  return useMemo(() => ({
    db,
    memories: createMemoryRepository(db),
    projects: createProjectRepository(db),
    tasks: createTaskRepository(db),
    connections: createConnectionRepository(db),
  }), [db]);
}
export type Stores = ReturnType<typeof useStores>;
