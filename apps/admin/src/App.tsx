import { Navigate, Route, Routes } from 'react-router';
import { Authenticated } from '@refinedev/core';
import { CatchAllNavigate } from '@refinedev/react-router';
import { PanelLayout } from './components/layout.js';
import { CallbackPage } from './pages/callback.js';
import { LoginPage } from './pages/login.js';
import { PostsListPage } from './pages/posts/list.js';
import { PostsShowPage } from './pages/posts/show.js';
import { MediaListPage } from './pages/media/list.js';
import { UsersListPage } from './pages/users/list.js';
import { UsersShowPage } from './pages/users/show.js';
import { HealthPage } from './pages/health.js';
import { AuditPage } from './pages/audit.js';

/**
 * Panel routes. /login and /callback stay outside the authenticated layout;
 * everything else renders inside <Authenticated>, which runs the
 * authProvider's check() (OIDC session + admin role) and bounces to /login
 * otherwise - the layout assumes an authenticated operator. The APIs
 * re-verify the role server-side regardless.
 */
export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/callback" element={<CallbackPage />} />
      <Route
        element={
          // refine's AuthenticatedProps declares key as required (their
          // convention for same-level instances); a static key is neutral.
          <Authenticated key="panel" fallback={<CatchAllNavigate to="/login" />}>
            <PanelLayout />
          </Authenticated>
        }
      >
        <Route path="/" element={<Navigate to="/health" replace />} />
        <Route path="/health" element={<HealthPage />} />
        <Route path="/posts" element={<PostsListPage />} />
        <Route path="/posts/show/:id" element={<PostsShowPage />} />
        <Route path="/media" element={<MediaListPage />} />
        <Route path="/users" element={<UsersListPage />} />
        <Route path="/users/show/:id" element={<UsersShowPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="*" element={<Navigate to="/health" replace />} />
      </Route>
    </Routes>
  );
}
