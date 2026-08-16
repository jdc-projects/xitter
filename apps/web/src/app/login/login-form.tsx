'use client';

import { Button, Text } from '@mantine/core';
import { useEffect } from 'react';

export interface CaptchaConfig {
  siteKey: string;
  apiEndpoint: string;
}

/**
 * Login form: plain form POST to the BFF start route. When Cap.js is enabled
 * the widget injects its solved token as the `capToken` hidden field
 * (`data-cap-hidden-field-name`); the server verifies it before the OIDC
 * redirect. The widget script only loads client-side (it registers a custom
 * element at import time).
 */
export function LoginForm({
  next,
  captcha,
}: {
  next: string;
  captcha: CaptchaConfig | null;
}) {
  useEffect(() => {
    if (captcha) void import('@cap.js/widget');
  }, [captcha]);

  return (
    <form action="/api/auth/start" method="post">
      <input type="hidden" name="next" value={next} />
      {captcha ? (
        <cap-widget
          data-cap-api-endpoint={captcha.apiEndpoint}
          data-cap-site-key={captcha.siteKey}
          data-cap-hidden-field-name="capToken"
        />
      ) : (
        <Text size="xs" c="dimmed">
          Bot protection is disabled in this environment.
        </Text>
      )}
      <Button type="submit" fullWidth mt="md" data-testid="login-submit">
        Log in
      </Button>
    </form>
  );
}
