import { expect, test, type Page } from '@playwright/test';
import { loginViaKeycloak } from './helpers';

/**
 * Media upload flows against the real stack (services + RustFS + Kafka +
 * media-process worker): the composer's client-side checks (type, size,
 * count) reject bad files before any upload, and a good image completes the
 * full lifecycle - presigned PUT, worker variants, ready, attached post -
 * with the thumb rendered in the feed and the original on the detail page.
 */

const PASSWORD = 'DemoPass123!';

async function login(page: Page, username: string) {
  await loginViaKeycloak(page, username, PASSWORD);
  await page.waitForURL(/\/feed$/);
}

/** Minimal valid 1x1 transparent PNG (70 bytes). */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** Valid PNG header padded past the 5MB cap - rejected on size alone. */
function oversizedPng(): Buffer {
  return Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024 + 1)]);
}

test('attach image: post shows thumb in feed, original on detail, served from /media', async ({
  page,
}) => {
  await login(page, 'demo9');
  const text = `t5 e2e media lifecycle ${crypto.randomUUID()}`;

  await page.getByTestId('composer-textarea').fill(text);
  await page
    .getByTestId('composer-file-input')
    .setInputFiles([{ name: 'e2e.png', mimeType: 'image/png', buffer: PNG }]);
  // Local preview appears immediately; the upload itself happens on submit.
  await expect(page.getByTestId('composer-attachment-new')).toHaveCount(1);

  await page.getByTestId('composer-submit').click();

  const item = page.locator('[data-testid^="post-item-"]', { hasText: text }).first();
  // Real-stack cycle: slot -> PUT -> complete -> worker variants -> ready ->
  // submit. Kafka consumer lag + sharp make this multi-second, not instant.
  await expect(item).toBeVisible({ timeout: 45_000 });
  const postId = (await item.getAttribute('data-testid'))!.replace('post-item-', '');

  // Feed cards render the thumb variant through the public /media path.
  const thumb = page.locator(`[data-testid="post-image-${postId}"]`).first();
  await expect(thumb).toBeVisible();
  await expect(thumb).toHaveAttribute('src', /\/media\/.+\/thumb\.png$/);
  // The object actually resolves through the edge route (not a broken img).
  expect(await thumb.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

  // Detail cards render the original variant.
  await page.goto(`/post/${postId}`);
  const original = page.locator(`[data-testid="post-image-${postId}"]`).first();
  await expect(original).toHaveAttribute('src', /\/media\/.+\/original\.png$/);
  expect(await original.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
});

test('wrong type, oversize and 5th image are rejected before any upload', async ({ page }) => {
  await login(page, 'demo10');
  const error = page.getByTestId('composer-upload-error');

  // Wrong type: never starts an upload (no attachment, no pending state).
  await page
    .getByTestId('composer-file-input')
    .setInputFiles([
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') },
    ]);
  await expect(error).toContainText('png, jpeg, webp or gif');
  await expect(page.getByTestId('composer-attachment-new')).toHaveCount(0);

  // Oversize: client-side size check fires before a slot is ever requested.
  await page
    .getByTestId('composer-file-input')
    .setInputFiles([{ name: 'big.png', mimeType: 'image/png', buffer: oversizedPng() }]);
  await expect(error).toContainText('5MB');
  await expect(page.getByTestId('composer-attachment-new')).toHaveCount(0);

  // Four images fit; a fifth is refused and the four survive.
  await page.getByTestId('composer-file-input').setInputFiles([
    { name: 'one.png', mimeType: 'image/png', buffer: PNG },
    { name: 'two.png', mimeType: 'image/png', buffer: PNG },
    { name: 'three.png', mimeType: 'image/png', buffer: PNG },
    { name: 'four.png', mimeType: 'image/png', buffer: PNG },
  ]);
  await expect(page.getByTestId('composer-attachment-new')).toHaveCount(4);

  await page
    .getByTestId('composer-file-input')
    .setInputFiles([{ name: 'fifth.png', mimeType: 'image/png', buffer: PNG }]);
  await expect(error).toContainText('at most 4');
  await expect(page.getByTestId('composer-attachment-new')).toHaveCount(4);
});
