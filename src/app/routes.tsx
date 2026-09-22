import { createBrowserRouter, Navigate, useSearchParams } from 'react-router';
import { Shell } from '../shell/Shell';
import { LeftOff } from '../features/leftoff/LeftOff';
import { Book } from '../features/memories/Book';
import { Archive } from '../features/memories/Archive';
import { TaskList } from '../features/tasks/TaskList';
import { TaskDetail } from '../features/tasks/TaskDetail';
import { TaskEdit } from '../features/tasks/TaskEdit';
import { TaskDelete } from '../features/tasks/TaskDelete';
import { ProjectList } from '../features/projects/ProjectList';
import { ProjectPage } from '../features/projects/ProjectPage';
import { ProjectDelete } from '../features/projects/ProjectDelete';
import { Apps } from '../features/connections/Apps';
import { Consent } from '../features/connections/Consent';
import { Connected } from '../features/connections/Connected';
import { Settings } from '../features/settings/Settings';
import { Activity } from '../features/activity/Activity';

function AuthorizeRedirect() {
  const [params] = useSearchParams();
  const id = params.get('authorization_id');
  return <Navigate replace to={id ? `/apps/consent?authorization_id=${encodeURIComponent(id)}` : '/apps'} />;
}

export const router = createBrowserRouter([
  { path: '/apps/connected/:partner', Component: Connected },
  {
    path: '/', Component: Shell,
    children: [
      { index: true, Component: LeftOff },
      { path: 'book', Component: Book },
      { path: 'book/archive', Component: Archive },
      { path: 'tasks', Component: TaskList },
      { path: 'tasks/:id', Component: TaskDetail },
      { path: 'tasks/:id/edit', Component: TaskEdit },
      { path: 'tasks/:id/delete', Component: TaskDelete },
      { path: 'projects', Component: ProjectList },
      { path: 'projects/new', Component: ProjectList },
      { path: 'projects/:id', Component: ProjectPage },
      { path: 'projects/:id/delete', Component: ProjectDelete },
      { path: 'apps', Component: Apps },
      { path: 'apps/consent', Component: Consent },
      { path: 'authorize', Component: AuthorizeRedirect },
      { path: 'settings', Component: Settings },
      // Reachable by address whether or not developer mode is on. The switch
      // reveals the rail item; it is not a permission, and a page that 404s
      // depending on a localStorage key would be a bad thing to debug.
      { path: 'activity', Component: Activity },
      { path: '*', element: <Navigate replace to="/" /> },
    ],
  },
]);
