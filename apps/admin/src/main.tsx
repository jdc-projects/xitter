import React from "react";
import { createRoot } from "react-dom/client";
import { Refine } from "@refinedev/core";
import { routerProvider } from "@refinedev/react-router";
import { authProvider } from "./auth-provider.js";
import { dataProvider } from "./data-provider.js";
import { App } from "./App.js";

const container = document.getElementById("root");
if (!container) throw new Error("#root missing in index.html");

createRoot(container).render(
  <React.StrictMode>
    <Refine
      authProvider={authProvider}
      dataProvider={dataProvider}
      routerProvider={routerProvider}
      resources={[
        { name: "posts", list: "/posts" },
        { name: "users", list: "/users" },
        { name: "media", list: "/media" },
      ]}
      options={{ syncWithLocation: true }}
    >
      <App />
    </Refine>
  </React.StrictMode>,
);
