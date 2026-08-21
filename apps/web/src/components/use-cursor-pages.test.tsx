import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useCursorPages, type CursorPage } from './use-cursor-pages';

interface Row {
  id: string;
}

/**
 * Harness binding the hook to a button + item dump, mirroring how the
 * paginated lists consume it (initial page from the server, appends from
 * the fetcher).
 */
function Harness({
  initialItems,
  initialCursor,
  fetchPage,
}: {
  initialItems: Row[];
  initialCursor: string | null;
  fetchPage: (cursor: string) => Promise<CursorPage<Row>>;
}) {
  const { items, cursor, loading, error, loadMore } = useCursorPages(
    initialItems,
    initialCursor,
    fetchPage,
  );
  return (
    <div>
      <ul>
        {items.map((row) => (
          <li key={row.id}>{row.id}</li>
        ))}
      </ul>
      <output>{cursor ?? 'end'}</output>
      <span>{loading ? 'loading' : 'idle'}</span>
      {error ? <p>{error}</p> : null}
      <button type="button" onClick={() => void loadMore()}>
        more
      </button>
    </div>
  );
}

const page = (ids: string[], nextCursor: string | null): CursorPage<Row> => ({
  items: ids.map((id) => ({ id })),
  nextCursor,
});

describe('useCursorPages (#41 append-in-place pagination)', () => {
  it('renders the server page and appends fetched pages in place', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(page(['b1', 'b2'], 'c2'))
      .mockResolvedValueOnce(page(['b3'], null));
    render(
      <Harness initialItems={[{ id: 'a1' }]} initialCursor="c1" fetchPage={fetchPage} />,
    );

    expect(screen.getByText('a1')).toBeTruthy();
    expect(screen.getByText('c1')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'more' }));
    });
    expect(fetchPage).toHaveBeenCalledWith('c1');
    expect(screen.getByText('b1')).toBeTruthy();
    expect(screen.getByText('b2')).toBeTruthy();
    expect(screen.getByText('c2')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'more' }));
    });
    expect(screen.getByText('b3')).toBeTruthy();
    // No next cursor left: the list is complete.
    expect(screen.getByText('end')).toBeTruthy();
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('shows the fetch error and keeps the loaded pages for a retry', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ items: [], nextCursor: null, error: 'Service unreachable.' });
    render(<Harness initialItems={[{ id: 'a1' }]} initialCursor="c1" fetchPage={fetchPage} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'more' }));
    });

    expect(screen.getByText('Service unreachable.')).toBeTruthy();
    expect(screen.getByText('a1')).toBeTruthy();
  });

  it('resets to the fresh page 1 when the server re-renders it', async () => {
    const fetchPage = vi.fn().mockResolvedValue(page(['b1'], null));
    const view = render(
      <Harness initialItems={[{ id: 'a1' }]} initialCursor="c1" fetchPage={fetchPage} />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'more' }));
    });
    expect(screen.getByText('b1')).toBeTruthy();

    // A revalidation (delete) re-renders page 1: new identity, fewer rows.
    view.rerender(
      <Harness initialItems={[{ id: 'a1' }]} initialCursor={null} fetchPage={fetchPage} />,
    );
    expect(screen.queryByText('b1')).toBeNull();
    expect(screen.getByText('end')).toBeTruthy();
  });

  it('ignores Load-more clicks while a fetch is in flight', async () => {
    let release: (() => void) | undefined;
    const fetchPage = vi.fn().mockImplementation(
      () =>
        new Promise<CursorPage<Row>>((resolve) => {
          release = () => resolve(page(['b1'], null));
        }),
    );
    render(<Harness initialItems={[{ id: 'a1' }]} initialCursor="c1" fetchPage={fetchPage} />);

    fireEvent.click(screen.getByRole('button', { name: 'more' }));
    expect(screen.getByText('loading')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'more' }));
    expect(fetchPage).toHaveBeenCalledTimes(1);

    await waitFor(() => release?.());
    await act(async () => {});
    expect(screen.getByText('idle')).toBeTruthy();
  });
});
