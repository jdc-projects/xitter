import { fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider, createTheme } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShellFrame, isNavActive } from './app-shell';
import { HeaderSearch } from './header-search';

let mockPathname = '/feed';

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

/** The app shell needs the provider context (Mantine v9 requirement). */
function renderShell(props: { username: string | null }) {
  return render(
    <MantineProvider theme={createTheme({})}>
      <AppShellFrame username={props.username}>main</AppShellFrame>
    </MantineProvider>,
  );
}

describe('isNavActive (#39)', () => {
  it('marks only the exact destination active', () => {
    expect(isNavActive('/feed', '/feed')).toBe(true);
    expect(isNavActive('/bookmarks', '/feed')).toBe(false);
    // Detail pages belong to no nav item; queries never reach usePathname.
    expect(isNavActive('/post/abc', '/feed')).toBe(false);
    expect(isNavActive(null, '/feed')).toBe(false);
  });
});

describe('HeaderSearch (#39 single search input per page)', () => {
  it('renders the box away from /search', () => {
    mockPathname = '/feed';
    render(
      <MantineProvider theme={createTheme({})}>
        <HeaderSearch />
      </MantineProvider>,
    );
    expect(screen.getByTestId('search-input')).toBeTruthy();
  });

  it('hides on /search so the page box is the only labelled input', () => {
    mockPathname = '/search';
    const { container } = render(<HeaderSearch />);
    expect(container.querySelector('input[name="q"]')).toBeNull();
  });
});

describe('AppShellFrame (#39 navigation polish)', () => {
  beforeEach(() => {
    mockPathname = '/feed';
  });

  it('marks the current page and not its siblings', () => {
    mockPathname = '/bookmarks';
    renderShell({ username: 'demo1' });

    const active = screen.getByTestId('header-nav-bookmarks');
    expect(active.getAttribute('aria-current')).toBe('page');
    expect(active.getAttribute('data-active')).toBeTruthy();
    expect(screen.getByTestId('header-nav-feed').getAttribute('aria-current')).toBeNull();
    expect(screen.getByTestId('header-nav-about').getAttribute('aria-current')).toBeNull();
  });

  it('hides session-only navigation when signed out', () => {
    renderShell({ username: null });
    expect(screen.queryByTestId('header-nav-bookmarks')).toBeNull();
    expect(screen.queryByTestId('logout-button')).toBeNull();
    // Public destinations stay reachable from the shell.
    expect(screen.getByTestId('header-nav-feed')).toBeTruthy();
    expect(screen.getByTestId('header-nav-about')).toBeTruthy();
  });

  it('keeps search reachable below the xs breakpoint', () => {
    renderShell({ username: 'demo1' });
    expect(screen.getByTestId('mobile-search-link').getAttribute('href')).toBe('/search');
    expect(screen.getByTestId('nav-burger')).toBeTruthy();
    expect(screen.getByTestId('logout-button')).toBeTruthy();
    expect(screen.getByTestId('nav-username').textContent).toBe('@demo1');
  });

  it('carries the identity row in the drawer when the header drops the handle (#151)', async () => {
    // jsdom does not apply Mantine's media-query classes, so both the
    // (visibleFrom xs) header handle and the drawer identity render - the
    // responsive truth is the Playwright mobile matrix's job. Here we pin
    // the drawer contract: opening it surfaces the handle + a logout that
    // nothing below the xs breakpoint can lose access to.
    renderShell({ username: 'demo1' });
    fireEvent.click(screen.getByTestId('nav-burger'));

    expect(await screen.findByTestId('drawer-username')).toBeTruthy();
    expect(screen.getByTestId('drawer-username').textContent).toBe('@demo1');
    expect(screen.getByTestId('drawer-username').getAttribute('href')).toBe('/profile/demo1');
    const logout = await screen.findByTestId('drawer-logout-button');
    const form = logout.closest('form');
    expect(form?.getAttribute('action')).toBe('/api/auth/logout');
  });

  it('renders no drawer identity row when signed out', () => {
    renderShell({ username: null });
    expect(screen.queryByTestId('drawer-username')).toBeNull();
    expect(screen.queryByTestId('drawer-logout-button')).toBeNull();
  });

  it('renders both brands with an explicit colour (#200)', async () => {
    // Text sets no colour, so a Text-as-anchor brand falls through to the
    // browser's default blue/purple link palette - the brand must carry the
    // themed text colour itself.
    renderShell({ username: null });
    const brand = screen.getByTestId('app-brand');
    expect(brand.getAttribute('href')).toBe('/feed');
    expect(brand.style.color).toBe('var(--mantine-color-text)');

    fireEvent.click(screen.getByTestId('nav-burger'));
    const drawerBrand = await screen.findByTestId('drawer-brand');
    expect(drawerBrand.getAttribute('href')).toBe('/feed');
    expect(drawerBrand.style.color).toBe('var(--mantine-color-text)');
  });
});
