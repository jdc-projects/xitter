import { Alert, Button, Card, Space, Typography } from 'antd';
import { useLogin } from '@refinedev/core';

/**
 * Login is a single SSO action: the panel never sees a password (ADR 0006,
 * admin realm via Keycloak). Errors from a previous round-trip surface here.
 */
export function LoginPage() {
  const { mutate: login, isPending } = useLogin();

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Card title="xitter admin" style={{ width: 360 }} data-testid="admin-login">
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <Typography.Paragraph style={{ marginBottom: 0 }}>
            Operator sign-in for moderation and system health. Sign in continues to the admin realm
            (Keycloak) - only the system-admin and app-admin roles may enter.
          </Typography.Paragraph>
          {typeof window !== 'undefined' && window.location.hash.includes('error=') ? (
            <Alert
              type="error"
              showIcon
              message="Sign-in failed"
              description="Keycloak rejected the login. Try again."
            />
          ) : null}
          <Button
            type="primary"
            block
            loading={isPending}
            onClick={() => login({})}
            data-testid="admin-login-button"
          >
            Sign in with SSO
          </Button>
        </Space>
      </Card>
    </div>
  );
}
