import React from 'react';
import { createRoot } from 'react-dom/client';
import { Refine } from '@refinedev/core';
import routerProvider from '@refinedev/react-router';
import { authProvider } from './auth/auth-provider.js';
import { dataProvider } from './data/data-provider.js';
import { App } from './App.js';

const container = document.getElementById('root');
if (!container) throw new Error('#root missing in index.html');

createRoot(container).render(
  <React.StrictMode>
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
  </React.StrictMode>,
);
