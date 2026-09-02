import { describe, expect, it } from 'vitest';
import { isReservedWebSlug, RESERVED_WEB_SLUGS } from './reserved-slugs';

describe('reserved web slugs', () => {
  it('covers every fixed top-level route segment', () => {
    // Mirrors apps/web/src/app (marketing roots + (app) group routes +
    // probes) and the edge's sibling-app paths (infra/proxy routes.yml).
    expect(RESERVED_WEB_SLUGS).toEqual(
      expect.arrayContaining([
        'about',
        'login',
        'feed',
        'post',
        'profile',
        'search',
        'bookmarks',
        'api',
        'media',
        'cms',
        'admin',
        'healthz',
        'readyz',
      ]),
    );
  });

  it('is a unique, lowercase, kebab-free set', () => {
    expect(new Set(RESERVED_WEB_SLUGS).size).toBe(RESERVED_WEB_SLUGS.length);
    for (const slug of RESERVED_WEB_SLUGS) expect(slug).toMatch(/^[a-z]+$/);
  });

  it('classifies reserved and free slugs', () => {
    expect(isReservedWebSlug('about')).toBe(true);
    expect(isReservedWebSlug('feed')).toBe(true);
    expect(isReservedWebSlug('changelog')).toBe(false);
    expect(isReservedWebSlug('demo-page')).toBe(false);
    // Exact match only - case variants are distinct URLs.
    expect(isReservedWebSlug('About')).toBe(false);
  });
});
