import { Alert, Button, Result, Spin } from 'antd';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { isAdminRole } from '@xitter/auth/admin';
import { accessTokenRoles, userManager } from '../auth/session.js';

/**
 * PKCE redirect target: completes the code exchange, then enforces the role
 * gate. A role-less admin-realm account authenticates fine at Keycloak -
 * this is where it stops (e2e proves localuser lands here and sees the
 * rejection, not the panel).
 */
export function CallbackPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const user = await userManager().signinCallback();
        if (cancelled) return;
        if (!user || !isAdminRole(accessTokenRoles(user))) {
          // Reject explicitly and clear the session: leaving it would let
          // check() re-admit via a loop.
          await userManager().removeUser();
          setError('This account does not have an admin role (system-admin or app-admin).');
          return;
        }
        navigate('/health');
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Sign-in failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  if (error) {
    return (
      <Result
        status="403"
        title="Not an admin"
        subTitle={error}
        data-testid="admin-callback-rejected"
        extra={
          <Button
            type="primary"
            onClick={() => navigate('/login')}
            data-testid="admin-back-to-login"
          >
            Back to login
          </Button>
        }
      />
    );
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      role="status"
      aria-label="Completing sign-in"
    >
      <Spin size="large" tip="Completing sign-in...">
        <Alert style={{ minWidth: 300 }} type="info" message="Completing sign-in" banner={false} />
      </Spin>
    </div>
  );
}
