import { render, screen } from '@testing-library/react';
import { MantineProvider, createTheme } from '@mantine/core';
import { describe, expect, it, vi } from 'vitest';
import { isNavCurrent, PublicHeader } from './public-header';

let mockPathname = '/';

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

/** The header needs the provider context (Mantine v9 requirement). */
function renderHeader(props: { username: string | null }) {
  return render(
    <MantineProvider theme={createTheme({})}>
      <PublicHeader username={props.username} />
    </MantineProvider>,
  );
}

describe('isNavCurrent (#38)', () => {
  it('marks only the exact destination current', () => {
    expect(isNavCurrent('/about', '/about')).toBe(true);
    expect(isNavCurrent('/feed', '/about')).toBe(false);
    expect(isNavCurrent(null, '/about')).toBe(false);
  });
});

describe('PublicHeader (#38 session-aware CTA)', () => {
  it('offers Log in to signed-out visitors', () => {
    mockPathname = '/';
    renderHeader({ username: null });

    expect(screen.getByTestId('public-login-link').textContent).toBe('Log in');
    expect(screen.queryByTestId('public-profile-link')).toBeNull();
    expect(screen.queryByTestId('public-feed-link')).toBeNull();
  });

  it('swaps Log in for the handle and a way back into the app', () => {
    mockPathname = '/';
    renderHeader({ username: 'demo1' });

    expect(screen.queryByTestId('public-login-link')).toBeNull();
    // Handle only - no avatar (#141): the session carries just the
    // username, and an avatar would render its initial as if it were a
    // display name.
    expect(screen.getByTestId('public-profile-link').textContent).toBe('@demo1');
    expect(screen.getByTestId('public-profile-link').getAttribute('href')).toBe('/profile/demo1');
    expect(screen.getByTestId('public-feed-link').textContent).toBe('Back to the feed');
    expect(screen.getByTestId('public-feed-link').getAttribute('href')).toBe('/feed');
  });

  it('marks the About link current only on /about', () => {
    mockPathname = '/about';
    renderHeader({ username: null });
    expect(screen.getByTestId('public-about-link').getAttribute('aria-current')).toBe('page');
  });

  it('marks the brand current on the landing page, not About', () => {
    mockPathname = '/';
    renderHeader({ username: null });

    expect(screen.getByTestId('public-brand').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('public-about-link').getAttribute('aria-current')).toBeNull();
  });
});
