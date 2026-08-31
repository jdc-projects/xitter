import { describe, expect, it } from 'vitest';
import type { TextField } from 'payload';
import { AboutContent } from './about-content';
import { Faq } from './faq';
import { Pages } from './pages';
import { Users } from './users';

/** The access functions only destructure `req`, so a minimal object suffices. */
function args(req: { user?: unknown; query?: Record<string, unknown> }) {
  return { req } as never;
}

/** Extract a named text field's config (slug validation lives there). */
function textField(
  collection: typeof AboutContent | typeof Pages,
  name: string,
): TextField | undefined {
  return collection.fields.find((f): f is TextField => 'name' in f && f.name === name);
}

describe('CMS collections', () => {
  it('exposes the expected content collections', () => {
    expect(AboutContent.slug).toBe('about-content');
    expect(Faq.slug).toBe('faq');
    expect(Pages.slug).toBe('pages');
    expect(Users.slug).toBe('users');
  });

  it('published site content is publicly readable (served through the web app)', () => {
    // Published reads are anonymous but where-constrained (see access test).
    expect(AboutContent.access?.read?.(args({ query: { draft: 'false' } }))).toEqual({
      _status: { equals: 'published' },
    });
  });

  it('draft reads require an authenticated CMS user', () => {
    expect(AboutContent.access?.read?.(args({ query: { draft: 'true' } }))).toBe(false);
    expect(Faq.access?.read?.(args({ query: { draft: true } }))).toBe(false);
    expect(AboutContent.access?.read?.(args({ user: { id: 1 }, query: { draft: 'true' } }))).toBe(
      true,
    );
  });

  it('anonymous published reads are constrained to published docs (draft leak closed)', () => {
    expect(AboutContent.access?.read?.(args({}))).toEqual({
      _status: { equals: 'published' },
    });
    expect(Faq.access?.read?.(args({}))).toEqual({ _status: { equals: 'published' } });
    expect(Pages.access?.read?.(args({}))).toEqual({ _status: { equals: 'published' } });
    // Authenticated users see the latest versions, filtered or not.
    expect(AboutContent.access?.read?.(args({ user: { id: 1 } }))).toBe(true);
  });

  it('site content mutations require an authenticated CMS user', () => {
    for (const op of ['create', 'update', 'delete'] as const) {
      expect(AboutContent.access?.[op]?.(args({}))).toBe(false);
      expect(Faq.access?.[op]?.(args({}))).toBe(false);
      expect(Pages.access?.[op]?.(args({}))).toBe(false);
      expect(AboutContent.access?.[op]?.(args({ user: { id: 1 } }))).toBe(true);
    }
  });

  it('user management requires an authenticated CMS user', () => {
    expect(Users.access?.read?.(args({}))).toBe(false);
    expect(Users.access?.read?.(args({ user: { id: 1 } }))).toBe(true);
  });

  it('site content enables drafts (live preview) and stable promotion slugs', () => {
    for (const collection of [AboutContent, Faq, Pages]) {
      const versions = collection.versions as { drafts?: unknown } | boolean | undefined;
      expect(Boolean(typeof versions === 'object' ? versions.drafts : versions)).toBe(true);
      const slugs = collection.fields.filter((f) => 'name' in f && f.name === 'slug');
      expect(slugs).toHaveLength(1);
      expect(slugs[0]).toMatchObject({ unique: true, required: true });
    }
  });

  it('page slugs are kebab-case and never a fixed web route (#215)', async () => {
    const slug = textField(Pages, 'slug');
    expect(slug).toBeDefined();
    const validate = slug!.validate!;

    // Reserved: every fixed top-level segment is rejected with the reason.
    for (const reserved of [
      'about',
      'login',
      'feed',
      'post',
      'profile',
      'search',
      'bookmarks',
      'api',
      'media',
      'admin',
      'cms',
      'healthz',
      'readyz',
    ]) {
      await expect(validate(reserved, {} as never)).resolves.toMatch(/fixed route/i);
    }

    // Not a URL segment.
    await expect(validate('Not A Slug', {} as never)).resolves.toMatch(/kebab-case/i);
    await expect(validate('--leading', {} as never)).resolves.toMatch(/kebab-case/i);

    // A free slug passes.
    await expect(validate('changelog', {} as never)).resolves.toBe(true);
    await expect(validate('release-notes-2026', {} as never)).resolves.toBe(true);
  });
});
