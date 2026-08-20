import { App as AntApp, Layout, Menu, Space, Typography } from 'antd';
import {
  AuditOutlined,
  DashboardOutlined,
  FileImageOutlined,
  LogoutOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { useLogout, useGetIdentity } from '@refinedev/core';
import { Outlet, useLocation, useNavigate } from 'react-router';

const NAV = [
  { key: '/health', label: 'Health', icon: <DashboardOutlined /> },
  { key: '/posts', label: 'Posts', icon: <AuditOutlined /> },
  { key: '/media', label: 'Media', icon: <FileImageOutlined /> },
  { key: '/users', label: 'Users', icon: <TeamOutlined /> },
];

/**
 * Shell for the authenticated panel: sidebar navigation + identity/logout
 * header. antd components carry the a11y baseline (roles, labels); the
 * @a11y suite scans every page rendered inside this layout.
 */
export function PanelLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { data: identity } = useGetIdentity<{ id?: string; name?: string }>();
  const { mutate: logout } = useLogout();

  const selected = NAV.find((item) => location.pathname.startsWith(item.key))?.key;

  return (
    // AntApp provides the context the hook-based modal/message APIs (and
    // antd v5 statics) need - pages under this layout call modal.confirm.
    <AntApp>
      <Layout style={{ minHeight: '100vh' }}>
        <Layout.Sider
          breakpoint="lg"
          theme="light"
          aria-label="Admin navigation"
          style={{ borderRight: '1px solid #f0f0f0' }}
        >
          <div style={{ padding: 16 }}>
            <Typography.Title level={4} style={{ margin: 0 }}>
              xitter admin
            </Typography.Title>
          </div>
          <Menu
            mode="inline"
            selectedKeys={selected ? [selected] : []}
            items={NAV}
            onClick={({ key }) => navigate(key)}
          />
        </Layout.Sider>
        <Layout>
          <Layout.Header
            style={{
              background: '#fff',
              display: 'flex',
              justifyContent: 'flex-end',
              alignItems: 'center',
              borderBottom: '1px solid #f0f0f0',
            }}
          >
            <Space aria-label="Signed in admin">
              <Typography.Text>{identity?.name ?? ''}</Typography.Text>
              <Typography.Link
                role="button"
                tabIndex={0}
                aria-label="Log out"
                onClick={() => logout()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') logout();
                }}
              >
                <LogoutOutlined aria-hidden /> Log out
              </Typography.Link>
            </Space>
          </Layout.Header>
          <Layout.Content style={{ padding: 24 }} role="main">
            <Outlet />
          </Layout.Content>
        </Layout>
      </Layout>
    </AntApp>
  );
}
