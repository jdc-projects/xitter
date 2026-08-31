import { render, screen } from '@testing-library/react';
import { MantineProvider, createTheme } from '@mantine/core';
import { describe, expect, it, vi } from 'vitest';
import { PaginatedPeopleList } from './paginated-people-list';

const people = [
  { id: 'u2', username: 'demo2', displayName: 'Demo Two' },
  { id: 'u3', username: 'demo3', displayName: 'Demo Three' },
];

/** Same harness as the other colocated component tests (Mantine 9). */
function renderList() {
  return render(
    <MantineProvider theme={createTheme({})}>
      <PaginatedPeopleList
        initialItems={people}
        initialCursor={null}
        fetchPage={vi.fn()}
        listTestId="profile-following"
      />
    </MantineProvider>,
  );
}

describe('PaginatedPeopleList (#41 cursor pages)', () => {
  it('renders each person linked to their profile', () => {
    renderList();
    const items = screen.getAllByTestId('profile-list-item');
    expect(items.map((item) => item.getAttribute('href'))).toEqual([
      '/profile/demo2',
      '/profile/demo3',
    ]);
    expect(items[0]?.textContent).toContain('Demo Two');
    expect(items[0]?.textContent).toContain('@demo2');
    // No next page: the shared load-more affordance stays hidden.
    expect(screen.queryByTestId('load-more')).toBeNull();
  });

  it('renders entries as neutral text, not raw hyperlinks (#200)', () => {
    renderList();
    const item = screen.getAllByTestId('profile-list-item')[0];
    // Entry root: themed text colour (not the anchor blue) and no
    // underline - the public-header profile-link idiom.
    expect(item?.style.color).toBe('var(--mantine-color-text)');
    expect(item?.getAttribute('data-underline')).toBe('never');
    // The handle is dimmed secondary text; the bold name keeps the default.
    expect(screen.getByText('@demo2').style.color).toBe('var(--mantine-color-dimmed)');
  });
});
