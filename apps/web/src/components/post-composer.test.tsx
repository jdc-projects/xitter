import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider, createTheme } from '@mantine/core';
import { describe, expect, it } from 'vitest';
import { MEDIA_ALT_TEXT_MAX } from '@xitter/api-contracts';
import { PostComposer } from './post-composer';

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
