import * as migration_20260831_153636_init from './20260831_153636_init';
import * as migration_20260831_160431_drop_users_sessions from './20260831_160431_drop_users_sessions';
import * as migration_20260831_233655_pages from './20260831_233655_pages';

export const migrations = [
  {
    up: migration_20260831_153636_init.up,
    down: migration_20260831_153636_init.down,
    name: '20260831_153636_init',
  },
  {
    up: migration_20260831_160431_drop_users_sessions.up,
    down: migration_20260831_160431_drop_users_sessions.down,
    name: '20260831_160431_drop_users_sessions',
  },
  {
    up: migration_20260831_233655_pages.up,
    down: migration_20260831_233655_pages.down,
    name: '20260831_233655_pages',
  },
];
