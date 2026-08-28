import { describe, expect, it } from 'vitest';
import { AboutContent } from './about-content';
import { Faq } from './faq';
import { Users } from './users';

/** The access functions only destructure `req`, so a minimal object suffices. */
function args(req: { user?: unknown; query?: Record<string, unknown> }) {
  return { req } as never;
}

describe('CMS collections', () => {
  it('exposes the expected content collections', () => {
    expect(AboutContent.slug).toBe('about-content');
    expect(Faq.slug).toBe('faq');
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
    // Authenticated users see the latest versions, filtered or not.
    expect(AboutContent.access?.read?.(args({ user: { id: 1 } }))).toBe(true);
  });

  it('site content mutations require an authenticated CMS user', () => {
    for (const op of ['create', 'update', 'delete'] as const) {
      expect(AboutContent.access?.[op]?.(args({}))).toBe(false);
      expect(Faq.access?.[op]?.(args({}))).toBe(false);
      expect(AboutContent.access?.[op]?.(args({ user: { id: 1 } }))).toBe(true);
    }
  });

  it('user management requires an authenticated CMS user', () => {
    expect(Users.access?.read?.(args({}))).toBe(false);
    expect(Users.access?.read?.(args({ user: { id: 1 } }))).toBe(true);
  });

  it('site content enables drafts (live preview) and stable promotion slugs', () => {
    for (const collection of [AboutContent, Faq]) {
      const versions = collection.versions as { drafts?: unknown } | boolean | undefined;
      expect(Boolean(typeof versions === 'object' ? versions.drafts : versions)).toBe(true);
      const slugs = collection.fields.filter((f) => 'name' in f && f.name === 'slug');
      expect(slugs).toHaveLength(1);
      expect(slugs[0]).toMatchObject({ unique: true, required: true });
    }
  });
});
