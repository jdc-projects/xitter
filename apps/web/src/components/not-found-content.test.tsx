import { render, screen } from '@testing-library/react';
import { MantineProvider, createTheme } from '@mantine/core';
import { describe, expect, it } from 'vitest';
import { NotFoundContent } from './not-found-content';

describe('NotFoundContent (shared 404 body, #135)', () => {
  it('renders the branded 404 copy with two ways out', () => {
    render(
      <MantineProvider theme={createTheme({})}>
        <NotFoundContent />
      </MantineProvider>,
    );

    expect(screen.getByTestId('not-found')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
    // Reset-aware copy: explains why a link may have vanished overnight.
    expect(screen.getByText(/nightly reset removed it/i)).toBeTruthy();

    const feed = screen.getByRole('link', { name: 'Go to the feed' });
    expect(feed.getAttribute('href')).toBe('/feed');
    expect(
      screen.getByRole('link', { name: 'Back to the landing page' }).getAttribute('href'),
    ).toBe('/');
  });
});
