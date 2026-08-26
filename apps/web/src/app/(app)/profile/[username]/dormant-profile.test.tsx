import { render, screen } from '@testing-library/react';
import { MantineProvider, createTheme } from '@mantine/core';
import { describe, expect, it } from 'vitest';
import { DormantProfile } from './dormant-profile';
import { isDemoUsername } from './load-profile';

describe('isDemoUsername (#36 dormant-profile detection)', () => {
  it('matches the demo range demo1..demo10', () => {
    expect(['demo1', 'demo5', 'demo9', 'demo10'].every(isDemoUsername)).toBe(true);
  });

  it('rejects everything outside the range', () => {
    expect(
      ['demo0', 'demo11', 'demo100', 'demo01', 'demo', 'Demo1', 'alice'].map(isDemoUsername),
    ).toEqual([false, false, false, false, false, false, false]);
  });
});

describe('DormantProfile (#36)', () => {
  it('renders the empty-profile shell with next actions, not a dead end', () => {
    render(
      <MantineProvider theme={createTheme({})}>
        <DormantProfile username="demo7" />
      </MantineProvider>,
    );

    expect(screen.getByTestId('dormant-username').textContent).toBe('@demo7');
    expect(screen.getByText('This account has not logged in yet.')).toBeTruthy();
    // The explanation names the account (the "log in as demo7" nudge).
    expect(screen.getByTestId('dormant-explain').textContent).toContain('demo7');
    expect(screen.getByTestId('dormant-feed-link').getAttribute('href')).toBe('/feed');
    expect(screen.getByTestId('dormant-about-link').getAttribute('href')).toBe('/about');
  });
});
