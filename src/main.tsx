import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { AuthProvider } from './app/auth';
import { router } from './app/routes';
import { isDesktop } from './platform';
import './styles/index.css';

// The shell owns the window, so the notebook frame fills it edge to edge.
if (isDesktop) document.documentElement.dataset.desktop = 'true';

createRoot(document.getElementById('root')!).render(
  <AuthProvider><RouterProvider router={router} /></AuthProvider>,
);
