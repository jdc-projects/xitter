import { render, screen } from '@testing-library/react';
import { MantineProvider, createTheme } from '@mantine/core';
import { describe, expect, it } from 'vitest';
import { UserAvatar } from './UserAvatar.js';

function renderAvatar(props: Parameters<typeof UserAvatar>[0]) {
  return render(
    <MantineProvider theme={createTheme({})}>
      <UserAvatar {...props} />
    </MantineProvider>,
  );
}

describe('UserAvatar initials (#141: display-name initial, never the username)', () => {
  it("shows the display name's initial when one is passed", () => {
    renderAvatar({ username: 'demo1', displayName: 'Nikita Crist' });
    expect(screen.getByText('N')).toBeTruthy();
    expect(screen.queryByText('D')).toBeNull();
  });

  it('falls back to the username initial where no display name exists (dormant accounts)', () => {
    renderAvatar({ username: 'demo1' });
    expect(screen.getByText('D')).toBeTruthy();
  });

  it('treats a blank display name as absent', () => {
    renderAvatar({ username: 'demo1', displayName: '   ' });
    expect(screen.getByText('D')).toBeTruthy();
  });
});
