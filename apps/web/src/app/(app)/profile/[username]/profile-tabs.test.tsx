import { render, screen } from '@testing-library/react';
import { MantineProvider, createTheme } from '@mantine/core';
import { describe, expect, it } from 'vitest';
import { ProfileTabs } from './profile-tabs';

/** Same harness as the other colocated component tests (Mantine 9). */
function renderTabs(active: string) {
  return render(
    <MantineProvider theme={createTheme({})}>
      <ProfileTabs
        active={active}
        profile={{ username: 'demo1' }}
        counts={{ following: 3, followers: 4 }}
      />
    </MantineProvider>,
  );
}

describe('ProfileTabs (#4 text tabs)', () => {
  it('links each list, keeping the query-string tabs addressable', () => {
    renderTabs('posts');
    expect(screen.getByTestId('tab-posts').getAttribute('href')).toBe('/profile/demo1');
    expect(screen.getByTestId('tab-following').getAttribute('href')).toBe(
      '/profile/demo1?tab=following',
    );
    expect(screen.getByTestId('tab-followers').getAttribute('href')).toBe(
      '/profile/demo1?tab=followers',
    );
    expect(screen.getByTestId('tab-following').textContent).toContain('3');
    expect(screen.getByTestId('tab-followers').textContent).toContain('4');
  });

  it('marks only the active tab current, and weights it heavier', () => {
    renderTabs('following');
    expect(screen.getByTestId('tab-following').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('tab-posts').getAttribute('aria-current')).toBeNull();
    expect(screen.getByTestId('tab-followers').getAttribute('aria-current')).toBeNull();
    expect(screen.getByTestId('tab-following').style.fontWeight).toBe('600');
    expect(screen.getByTestId('tab-posts').style.fontWeight).toBe('400');
  });

  it('carries an explicit colour on every tab - no UA link colours (#200)', () => {
    renderTabs('posts');
    // Regression guard: the tabs used to be `Anchor unstyled`, which drops
    // the anchor colour rule entirely and lets the browser's default
    // blue/purple palette through. Active = themed default text colour,
    // inactive = dimmed - both flip with the colour scheme.
    expect(screen.getByTestId('tab-posts').style.color).toBe('var(--mantine-color-text)');
    expect(screen.getByTestId('tab-following').style.color).toBe('var(--mantine-color-dimmed)');
    expect(screen.getByTestId('tab-followers').style.color).toBe('var(--mantine-color-dimmed)');
    expect(screen.getByTestId('tab-posts').getAttribute('data-underline')).toBe('never');
  });
});
