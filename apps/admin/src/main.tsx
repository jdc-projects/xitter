import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { Refine } from '@refinedev/core';
import routerProvider from '@refinedev/react-router';
import { adminBasePath } from './env.js';
import { authProvider } from './auth/auth-provider.js';
import { dataProvider } from './data/data-provider.js';
import { App } from './App.js';

const container = document.getElementById('root');
if (!container) throw new Error('#root missing in index.html');

// The router basename must match the serving base (/admin via the edge and
// vite's base) so in-app paths (/login, /posts, ...) resolve under it.
createRoot(container).render(
  <React.StrictMode>
    <BrowserRouter basename={adminBasePath}>
      <Refine
        authProvider={authProvider}
        dataProvider={dataProvider}
        routerProvider={routerProvider}
        resources={[
          { name: 'posts', list: '/posts', show: '/posts/show/:id' },
          { name: 'media', list: '/media' },
          { name: 'users', list: '/users', show: '/users/show/:id' },
        ]}
        options={{ syncWithLocation: true, disableTelemetry: true }}
      >
        <App />
      </Refine>
    </BrowserRouter>
  </React.StrictMode>,
);
