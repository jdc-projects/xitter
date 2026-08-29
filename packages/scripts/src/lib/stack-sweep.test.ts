import { describe, expect, it } from 'vitest';
import { parseDockerCreatedAt, parsePublishedHostPort } from './stack-sweep.js';

describe('parsePublishedHostPort (#175)', () => {
  it('extracts the host port from docker-port mappings', () => {
    expect(parsePublishedHostPort('80/tcp -> 0.0.0.0:38080')).toBe(38080);
  });

  it('extracts the host port from ipv6 mappings', () => {
    expect(parsePublishedHostPort('[::]:38080->80/tcp, [::]:38081->81/tcp')).toBe(38080);
  });

  it('returns null when nothing is published', () => {
    expect(parsePublishedHostPort('')).toBeNull();
    expect(parsePublishedHostPort('9000/tcp')).toBeNull();
  });
});

describe('parseDockerCreatedAt (#175)', () => {
  it('parses podman BST-style stamps', () => {
    const ms = parseDockerCreatedAt('2026-08-29 01:04:06 +0100 BST');
    expect(ms).not.toBeNull();
    expect(new Date(ms!).toISOString()).toContain('2026-08-29');
  });

  it('parses RFC3339 stamps', () => {
    expect(parseDockerCreatedAt('2026-08-29T00:04:06Z')).not.toBeNull();
  });

  it('returns null for garbage (conservative live path)', () => {
    expect(parseDockerCreatedAt('')).toBeNull();
    expect(parseDockerCreatedAt('not a date')).toBeNull();
  });
});
