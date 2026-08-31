import * as migration_20260831_153636_init from './20260831_153636_init';
import * as migration_20260831_160431_drop_users_sessions from './20260831_160431_drop_users_sessions';

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
];
