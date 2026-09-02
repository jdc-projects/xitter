import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider, createTheme } from '@mantine/core';
import { describe, expect, it, vi } from 'vitest';
import { MEDIA_ALT_TEXT_MAX } from '@xitter/api-contracts';
import { PostComposer } from './post-composer';

// #148: the composer hands each successful result to the host surface; the
// action itself is a seam - stub its result per test.
const composerAction = vi.hoisted(() => ({ result: undefined as unknown }));
vi.mock('@/lib/posts/actions', () => ({
  createPostAction: vi.fn(async () => composerAction.result as never),
}));

// happy-dom ships no ResizeObserver (Mantine autosize) nor document.fonts
// (the autosize font listener) - stub the pieces the composer needs.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (!('ResizeObserver' in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
}
if (!('fonts' in document)) {
  Object.defineProperty(document, 'fonts', {
    value: new EventTarget(),
    configurable: true,
  });
}

/** The composer needs the provider context (Mantine v9 requirement). */
function renderComposer() {
  return render(
    <MantineProvider theme={createTheme({})}>
      <PostComposer />
    </MantineProvider>,
  );
}

const imageFile = (name = 'kite.png') =>
  new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });

/** Pick files through the real hidden input, like the browser would. */
function pick(file: File) {
  const input = screen.getByTestId('composer-file-input') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

describe('PostComposer onPosted (#148)', () => {
  const created = {
    id: '33333333-3333-4333-8333-333333333333',
    authorId: 'v1',
    text: 'hello fresh',
    media: [],
    replyToId: null,
    repostOfId: null,
    counts: { replies: 0, likes: 0, reposts: 0 },
    createdAt: '2026-08-27T12:00:00.000Z',
    deletedAt: null,
  };
  const author = { id: 'v1', username: 'viewer', displayName: 'Viewer' };

  // 15s headroom: these two drive the full submit state machine and have
  // timed out under CI load on five separate PRs (all passed on retry).
  it('fires onPosted once with the created post after a successful submit', async () => {
    composerAction.result = { ok: true, post: created, author };
    const onPosted = vi.fn();
    render(
      <MantineProvider theme={createTheme({})}>
        <PostComposer onPosted={onPosted} />
      </MantineProvider>,
    );

    fireEvent.change(screen.getByTestId('composer-textarea'), {
      target: { value: created.text },
    });
    fireEvent.submit(screen.getByTestId('composer-form'));

    // runSubmit defers the real submission to a macrotask; the action result
    // then lands in useActionState state, which the effect hands over.
    await waitFor(() => {
      expect(onPosted).toHaveBeenCalledTimes(1);
    });
    expect(onPosted).toHaveBeenCalledWith({ post: created, author });
    // The draft cleared with the same success.
    expect((screen.getByTestId('composer-textarea') as HTMLTextAreaElement).value).toBe('');
  }, 15000);

  it('never fires onPosted for a failed submission', async () => {
    composerAction.result = { error: 'Could not publish your post. Try again shortly.' };
    const onPosted = vi.fn();
    render(
      <MantineProvider theme={createTheme({})}>
        <PostComposer onPosted={onPosted} />
      </MantineProvider>,
    );

    fireEvent.change(screen.getByTestId('composer-textarea'), {
      target: { value: 'never lands' },
    });
    fireEvent.submit(screen.getByTestId('composer-form'));

    await waitFor(() => {
      expect(screen.getByTestId('composer-error').textContent).toContain('Could not publish');
    });
    expect(onPosted).not.toHaveBeenCalled();
    // Failure keeps the draft (acceptance: draft preserved).
    expect((screen.getByTestId('composer-textarea') as HTMLTextAreaElement).value).toBe(
      'never lands',
    );
  }, 15000);
});

describe('PostComposer alt text (#133)', () => {
  it('shows an alt input per staged attachment once an image is picked', async () => {
    renderComposer();
    expect(screen.queryAllByTestId('composer-alt-input')).toHaveLength(0);

    pick(imageFile());
    await waitFor(() => {
      expect(screen.getAllByTestId('composer-alt-input')).toHaveLength(1);
    });
    // Present and labelled for screen readers (getByLabelText throws if absent).
    expect(screen.getByLabelText('Describe kite.png for screen readers')).toBeTruthy();
  });

  it('nudges the author that descriptive alt helps screen readers', async () => {
    renderComposer();
    pick(imageFile());

    await waitFor(() => {
      expect(screen.getByTestId('composer-previews')).toBeTruthy();
    });
    expect(screen.getByTestId('composer-pii-reminder').textContent).toContain(
      'Describing your images (alt text) helps people using screen readers',
    );
  });

  it('keeps typing within the contract limit', async () => {
    renderComposer();
    pick(imageFile());

    const altInput = await screen.findByTestId('composer-alt-input');
    fireEvent.change(altInput, {
      target: { value: 'x'.repeat(MEDIA_ALT_TEXT_MAX + 50) },
    });

    expect((screen.getByTestId('composer-alt-input') as HTMLInputElement).value).toHaveLength(
      MEDIA_ALT_TEXT_MAX,
    );
  });

  it('removes the alt input together with its attachment', async () => {
    renderComposer();
    pick(imageFile());
    await screen.findByTestId('composer-alt-input');

    fireEvent.click(screen.getByTestId('composer-remove'));

    await waitFor(() => {
      expect(screen.queryByTestId('composer-alt-input')).toBeNull();
    });
  });
});
