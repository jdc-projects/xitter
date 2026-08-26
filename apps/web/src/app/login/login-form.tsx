'use client';

import { Button, Stack, Text } from '@mantine/core';
import { useEffect } from 'react';
import { loadCaptchaWidget } from './load-widget';

export interface CaptchaConfig {
  /**
   * Full widget endpoint `<cap instance>/<siteKey>` (composed server-side in
   * webEnv). The widget appends `challenge`/`redeem` to it - it has no
   * separate site-key attribute, so the key must live in the path.
   */
  apiEndpoint: string;
}

/**
 * Login form: plain form POST to the BFF start route. When Cap.js is enabled
 * the widget injects its solved token as the `capToken` hidden field
 * (`data-cap-hidden-field-name`); the server verifies it before the OIDC
 * redirect. The widget script only loads client-side (it registers a custom
 * element at import time).
 */
export function LoginForm({ next, captcha }: { next: string; captcha: CaptchaConfig | null }) {
  useEffect(() => {
    if (captcha) void loadCaptchaWidget();
  }, [captcha]);

  return (
    <form action="/api/auth/start" method="post">
      <input type="hidden" name="next" value={next} />
      {captcha ? (
        <Stack gap={6}>
          <cap-widget
            data-cap-api-endpoint={captcha.apiEndpoint}
            data-cap-hidden-field-name="capToken"
          />
          {/* Cap.js is a proof-of-work challenge, not a captcha - the copy
              stays honest about what the visitor actually experiences. */}
          <Text size="xs" c="dimmed">
            A quick verification runs in your browser before sign-in - there is nothing to solve.
          </Text>
        </Stack>
      ) : null}
      <Button type="submit" fullWidth mt="md" data-testid="login-submit">
        Log in
      </Button>
    </form>
  );
}
