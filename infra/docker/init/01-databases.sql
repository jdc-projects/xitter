-- Per-service databases and users: one Postgres instance per environment copy,
-- but every service owns an isolated database and credentials (no shared access).
-- Idempotent: re-runs on fresh volumes only (docker-entrypoint-initdb.d).

SELECT 'CREATE ROLE social CREATEDB LOGIN PASSWORD ''social-local''' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'social')\gexec
SELECT 'CREATE ROLE posts CREATEDB LOGIN PASSWORD ''posts-local''' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'posts')\gexec
SELECT 'CREATE ROLE media CREATEDB LOGIN PASSWORD ''media-local''' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'media')\gexec
SELECT 'CREATE ROLE feed CREATEDB LOGIN PASSWORD ''feed-local''' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'feed')\gexec
SELECT 'CREATE ROLE search CREATEDB LOGIN PASSWORD ''search-local''' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'search')\gexec
SELECT 'CREATE ROLE cms CREATEDB LOGIN PASSWORD ''cms-local''' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cms')\gexec

SELECT 'CREATE DATABASE social OWNER social' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'social')\gexec
SELECT 'CREATE DATABASE posts OWNER posts' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'posts')\gexec
SELECT 'CREATE DATABASE media OWNER media' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'media')\gexec
SELECT 'CREATE DATABASE feed OWNER feed' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'feed')\gexec
SELECT 'CREATE DATABASE search OWNER search' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'search')\gexec
SELECT 'CREATE DATABASE cms OWNER cms' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'cms')\gexec
