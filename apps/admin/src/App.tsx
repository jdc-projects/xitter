import { Navigate, Route, Routes } from 'react-router';
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
 * everything else renders inside it (Refine's authProvider.check gates the
 * session - the layout assumes an authenticated operator).
 */
export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/callback" element={<CallbackPage />} />
      <Route element={<PanelLayout />}>
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
