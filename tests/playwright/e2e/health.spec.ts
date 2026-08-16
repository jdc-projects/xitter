import { expect, test } from '@playwright/test';
import { localPort } from '@xitter/config';

/**
 * Service smoke: each API service answers its infrastructure probes at the
 * service root (outside the versioned prefix, spec 03). This is the
 * regression net for guard/probe interplay - a global auth guard that 401s
 * /healthz turns every kubelet probe into a crash loop in-cluster, which no
 * unit test catches because guards are wired at bootstrap.
 */
const services = ['social', 'posts', 'media', 'feed', 'search'] as const;

test.describe('service health probes', () => {
  for (const service of services) {
    test(`${service} /healthz answers 200 without a token`, async ({ request }) => {
      const res = await request.get(`http://localhost:${localPort(service)}/healthz`);
      expect(res.status()).toBe(200);
    });
  }
});
