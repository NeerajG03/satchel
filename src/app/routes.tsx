import { createBrowserRouter, Navigate, useLocation, useSearchParams } from 'react-router';
import { Shell } from '../shell/Shell';
import { LeftOff } from '../features/leftoff/LeftOff';
import { Book } from '../features/memories/Book';
import { Archive } from '../features/memories/Archive';
import { TaskList } from '../features/tasks/TaskList';
import { TaskDetail } from '../features/tasks/TaskDetail';
import { TaskEdit } from '../features/tasks/TaskEdit';
import { TaskDelete } from '../features/tasks/TaskDelete';
import { TopicList } from '../features/topics/TopicList';
import { TopicPage } from '../features/topics/TopicPage';
import { TopicDelete } from '../features/topics/TopicDelete';
import { Apps } from '../features/connections/Apps';
import { Consent } from '../features/connections/Consent';
import { Connected } from '../features/connections/Connected';
import { Settings } from '../features/settings/Settings';
import { ConsolidationCallback } from '../features/settings/ConsolidationCallback';
import { Activity } from '../features/activity/Activity';

function AuthorizeRedirect() {
  const [params] = useSearchParams();
  const id = params.get('authorization_id');
  return <Navigate replace to={id ? `/apps/consent?authorization_id=${encodeURIComponent(id)}` : '/apps'} />;
}

// Topics are called topics now. Old /topics links still land on the
// same page, with the rest of the path and the query kept.
function TopicsRedirect() {
  const { pathname, search, hash } = useLocation();
  return <Navigate replace to={pathname.replace(/^\/topics/, '/topics') + search + hash} />;
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
      { path: 'topics', Component: TopicList },
      { path: 'topics/new', Component: TopicList },
      { path: 'topics/:id', Component: TopicPage },
      { path: 'topics/:id/delete', Component: TopicDelete },
      { path: 'topics/*', Component: TopicsRedirect },
      { path: 'topics', Component: TopicsRedirect },
      { path: 'apps', Component: Apps },
      { path: 'apps/consent', Component: Consent },
      { path: 'authorize', Component: AuthorizeRedirect },
      { path: 'settings', Component: Settings },
      { path: 'settings/consolidation', Component: ConsolidationCallback },
      // Reachable by address whether or not developer mode is on. The switch
      // reveals the rail item; it is not a permission, and a page that 404s
      // depending on a localStorage key would be a bad thing to debug.
      { path: 'activity', Component: Activity },
      { path: '*', element: <Navigate replace to="/" /> },
    ],
  },
]);
