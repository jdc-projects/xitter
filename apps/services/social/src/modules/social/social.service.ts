import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  usernameSchema,
  type Profile,
  type Relationship,
  type UpdateProfileRequest,
} from '@xitter/api-contracts';
import { createLogger } from '@xitter/observability';
import { SOCIAL_EVENTS, type SocialEvents } from './social-events.js';
import { SocialRepository } from './social.repository.js';

const logger = createLogger({ service: 'social' });

export interface CreateProfileInput {
  displayName?: string;
  bio?: string | null;
}

export interface PageRequest {
  cursor?: string;
  limit: number;
}

export interface ProfilePage {
  items: Profile[];
  nextCursor: string | null;
}

const notFound = (message: string) =>
  new NotFoundException({ error: { code: 'NOT_FOUND', message } });

const forbidden = (message: string) =>
  new ForbiddenException({ error: { code: 'FORBIDDEN', message } });

const badRequest = (message: string, details?: object) =>
  new BadRequestException({
    error: { code: 'VALIDATION_ERROR', message, ...(details ? { details } : {}) },
  });

/** Organic profiles get the same faker-generated look as seeded ones. */
async function generatedDisplayName(): Promise<string> {
  // faker v10 is ESM-only; this service compiles to CJS, so load it lazily.
  const { faker } = await import('@faker-js/faker');
  return `${faker.person.firstName()} ${faker.person.lastName()}`;
}

/**
 * Profiles, follows, blocks - the rules from spec 03 / product 02 §7:
 *
 * - usernames are immutable (Keycloak-owned) and validated against
 *   `usernameSchema` at profile creation;
 * - following is rejected when a block exists in EITHER direction;
 * - blocking removes existing follows in both directions;
 * - follow/unfollow/block/unblock are idempotent - events fire only on real
 *   state transitions;
 * - events are best-effort after commit: a Kafka outage logs but never fails
 *   the mutation (at-least-once consumers must be idempotent anyway).
 */
@Injectable()
export class SocialService {
  constructor(
    private readonly repo: SocialRepository,
    @Inject(SOCIAL_EVENTS) private readonly events: SocialEvents,
  ) {}

  /** Idempotent upsert of the caller's own profile (web calls this after login). */
  async ensureProfile(
    caller: { id: string; username: string },
    input: CreateProfileInput,
  ): Promise<{ profile: Profile; created: boolean }> {
    const username = usernameSchema.safeParse(caller.username);
    if (!username.success) {
      throw badRequest('Identity username is not a valid xitter username', {
        username: username.error.flatten(),
      });
    }

    const existing = await this.repo.findProfile(caller.id);
    if (existing) return { profile: this.repo.toProfile(existing), created: false };

    const profile = await this.repo.createProfile({
      id: caller.id,
      username: username.data,
      displayName: input.displayName ?? (await generatedDisplayName()),
      bio: input.bio ?? null,
    });
    return { profile: this.repo.toProfile(profile), created: true };
  }

  async getProfile(
    userId: string,
  ): Promise<{ profile: Profile; counts: { following: number; followers: number } }> {
    const [row, counts] = await Promise.all([
      this.repo.findProfile(userId),
      this.repo.counts(userId),
    ]);
    if (!row) throw notFound('Profile not found');
    return { profile: this.repo.toProfile(row), counts };
  }

  async getProfileByUsername(username: string): Promise<Profile> {
    const row = await this.repo.findProfileByUsername(username);
    if (!row) throw notFound('Profile not found');
    return this.repo.toProfile(row);
  }

  async updateProfile(
    callerId: string,
    targetId: string,
    input: UpdateProfileRequest,
  ): Promise<Profile> {
    if (callerId !== targetId) throw forbidden('You can only edit your own profile');
    await this.requireTarget(targetId);
    const row = await this.repo.updateProfile(targetId, {
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.bio !== undefined ? { bio: input.bio } : {}),
    });
    const profile = this.repo.toProfile(row);
    await this.emitSafe('social.profile.updated', {
      profileId: profile.id,
      username: profile.username,
      displayName: profile.displayName,
      bio: profile.bio,
      updatedAt: new Date().toISOString(),
    });
    return profile;
  }

  async follow(viewerId: string, targetId: string): Promise<void> {
    this.rejectSelf(viewerId, targetId, 'follow');
    await this.requireTarget(targetId);

    if (await this.repo.findFollow(viewerId, targetId)) return;

    const [iBlockedThem, theyBlockedMe] = await Promise.all([
      this.repo.findBlock(viewerId, targetId),
      this.repo.findBlock(targetId, viewerId),
    ]);
    if (iBlockedThem || theyBlockedMe) {
      throw forbidden('Cannot follow: a block exists between these accounts');
    }

    const created = await this.repo.createFollow(viewerId, targetId);
    if (created) {
      await this.emitSafe('social.follow.created', {
        followerId: viewerId,
        followeeId: targetId,
        createdAt: new Date().toISOString(),
      });
    }
  }

  async unfollow(viewerId: string, targetId: string): Promise<void> {
    this.rejectSelf(viewerId, targetId, 'unfollow');
    await this.requireTarget(targetId);
    const removed = await this.repo.deleteFollow(viewerId, targetId);
    if (removed) {
      await this.emitSafe('social.follow.deleted', {
        followerId: viewerId,
        followeeId: targetId,
        deletedAt: new Date().toISOString(),
      });
    }
  }

  async block(viewerId: string, targetId: string): Promise<void> {
    this.rejectSelf(viewerId, targetId, 'block');
    await this.requireTarget(targetId);

    // Follows die in both directions; emit their deletions first so consumers
    // see why the feed entries vanish (spec 04: blocks are not feed-rewritten
    // by the block event itself - the follow deletions carry it).
    const [mine, theirs] = await Promise.all([
      this.repo.findFollow(viewerId, targetId),
      this.repo.findFollow(targetId, viewerId),
    ]);
    if (mine) {
      await this.emitSafe('social.follow.deleted', {
        followerId: viewerId,
        followeeId: targetId,
        deletedAt: new Date().toISOString(),
      });
    }
    if (theirs) {
      await this.emitSafe('social.follow.deleted', {
        followerId: targetId,
        followeeId: viewerId,
        deletedAt: new Date().toISOString(),
      });
    }
    await this.repo.deleteFollowsBetween(viewerId, targetId);

    const created = await this.repo.createBlock(viewerId, targetId);
    if (created) {
      await this.emitSafe('social.block.created', {
        blockerId: viewerId,
        blockedId: targetId,
        createdAt: new Date().toISOString(),
      });
    }
  }

  async unblock(viewerId: string, targetId: string): Promise<void> {
    this.rejectSelf(viewerId, targetId, 'unblock');
    await this.requireTarget(targetId);
    const removed = await this.repo.deleteBlock(viewerId, targetId);
    if (removed) {
      await this.emitSafe('social.block.deleted', {
        blockerId: viewerId,
        blockedId: targetId,
        deletedAt: new Date().toISOString(),
      });
    }
  }

  /** Viewer-relative relationship flags; self-relationships are all false. */
  async relationship(viewerId: string, targetId: string): Promise<Relationship> {
    if (viewerId === targetId) {
      return { following: false, followedBy: false, blocking: false, blockedBy: false };
    }
    const [follow, reverseFollow, myBlock, theirBlock] = await Promise.all([
      this.repo.findFollow(viewerId, targetId),
      this.repo.findFollow(targetId, viewerId),
      this.repo.findBlock(viewerId, targetId),
      this.repo.findBlock(targetId, viewerId),
    ]);
    return {
      following: follow !== null,
      followedBy: reverseFollow !== null,
      blocking: myBlock !== null,
      blockedBy: theirBlock !== null,
    };
  }

  async following(targetId: string, page: PageRequest): Promise<ProfilePage> {
    await this.requireTarget(targetId);
    const result = await this.repo.followPage('following', targetId, page.cursor, page.limit);
    return {
      items: result.items.map((row) => this.repo.toProfile(row)),
      nextCursor: result.nextCursor,
    };
  }

  async followers(targetId: string, page: PageRequest): Promise<ProfilePage> {
    await this.requireTarget(targetId);
    const result = await this.repo.followPage('followers', targetId, page.cursor, page.limit);
    return {
      items: result.items.map((row) => this.repo.toProfile(row)),
      nextCursor: result.nextCursor,
    };
  }

  /** Internal (fanout worker): follower ids for feed fanout. */
  followerIds(userId: string): Promise<string[]> {
    return this.repo.followerIds(userId);
  }

  /** Internal (posts #5, workers #8): pair relationship for block enforcement. */
  relationshipPair(userId: string, otherId: string): Promise<Relationship> {
    return this.relationship(userId, otherId);
  }

  /** Internal (feed #7, search #9): ids this user has blocked. */
  blockedIds(userId: string): Promise<string[]> {
    return this.repo.blockedIds(userId);
  }

  /** Internal (reset job): wipe profiles + graph; reseed runs via the seed script. */
  async reseed(): Promise<void> {
    await this.repo.truncate();
  }

  private rejectSelf(viewerId: string, targetId: string, action: string): void {
    if (viewerId === targetId) throw badRequest(`Cannot ${action} yourself`);
  }

  private async requireTarget(targetId: string): Promise<void> {
    const target = await this.repo.findProfile(targetId);
    if (!target) throw notFound('Profile not found');
  }

  private async emitSafe(
    eventType: Parameters<SocialEvents['emit']>[0],
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.events.emit(eventType, payload);
    } catch (err) {
      // The DB write already committed; a missed event degrades downstream
      // views until the nightly reset rather than failing the user's action.
      logger.error({ err, eventType }, 'event emission failed');
    }
  }
}
