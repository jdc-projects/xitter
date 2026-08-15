import { describe, expect, it } from 'vitest';
import { SocialService } from './social.service.js';

describe('SocialService (skeleton)', () => {
  it('returns follow and block results', () => {
    const service = new SocialService();
    expect(service.follow('abc')).toEqual({ followed: 'abc' });
    expect(service.block('abc')).toEqual({ blocked: 'abc' });
  });
});
