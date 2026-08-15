import { BrowserRouter, Outlet, Route, Routes } from "react-router";
import { Layout } from "antd";

export function App() {
  return (
    <BrowserRouter>
      <Layout style={{ minHeight: "100vh" }}>
        <Layout.Content style={{ padding: 24 }}>
          <Routes>
            <Route path="/" element={<Outlet />} />
            {/* Resource list/show/edit views land with the admin feature ticket. */}
          </Routes>
        </Layout.Content>
      </Layout>
    </BrowserRouter>
  );
}
