import { Inject, Injectable } from '@nestjs/common';
import type { Profile } from '@xitter/api-contracts';
import { encodeCursor, decodeCursor } from '@xitter/service-kit';
import type { PrismaClient, Prisma } from '../../generated/prisma/client.js';

/** DI token for the service-owned Prisma client (tests provide their own). */
export const SOCIAL_PRISMA = 'SOCIAL_PRISMA';

export type SocialPrismaClient = PrismaClient & { $disconnect(): Promise<void> };

type ProfileRow = Prisma.ProfileGetPayload<Record<string, never>>;

export type SocialDb = Pick<PrismaClient, 'profile' | 'follow' | 'block'>;

/**
 * Prisma data access for profiles and the follow/block graph. Business rules
 * (block semantics, events) live in SocialService; this layer is queries only.
 */
@Injectable()
export class SocialRepository {
  constructor(@Inject(SOCIAL_PRISMA) private readonly db: SocialDb) {}

  findProfile(id: string): Promise<ProfileRow | null> {
    return this.db.profile.findUnique({ where: { id } });
  }

  findProfileByUsername(username: string): Promise<ProfileRow | null> {
    return this.db.profile.findUnique({ where: { username } });
  }

  createProfile(data: { id: string; username: string; displayName: string; bio: string | null }) {
    return this.db.profile.create({ data });
  }

  updateProfile(
    id: string,
    data: { displayName?: string; bio?: string | null },
  ): Promise<ProfileRow> {
    return this.db.profile.update({ where: { id }, data });
  }

  findFollow(followerId: string, followeeId: string) {
    return this.db.follow.findUnique({
      where: { followerId_followeeId: { followerId, followeeId } },
    });
  }

  /** Idempotent: returns false when the follow already exists. */
  async createFollow(followerId: string, followeeId: string): Promise<boolean> {
    const result = await this.db.follow.createMany({
      data: { followerId, followeeId },
      skipDuplicates: true,
    });
    return result.count > 0;
  }

  /** Returns true when a follow row was actually removed. */
  async deleteFollow(followerId: string, followeeId: string): Promise<boolean> {
    const result = await this.db.follow.deleteMany({ where: { followerId, followeeId } });
    return result.count > 0;
  }

  findBlock(blockerId: string, blockedId: string) {
    return this.db.block.findUnique({
      where: { blockerId_blockedId: { blockerId, blockedId } },
    });
  }

  /** Idempotent: returns false when the block already exists. */
  async createBlock(blockerId: string, blockedId: string): Promise<boolean> {
    const result = await this.db.block.createMany({
      data: { blockerId, blockedId },
      skipDuplicates: true,
    });
    return result.count > 0;
  }

  /** Returns true when a block row was actually removed. */
  async deleteBlock(blockerId: string, blockedId: string): Promise<boolean> {
    const result = await this.db.block.deleteMany({ where: { blockerId, blockedId } });
    return result.count > 0;
  }

  /** Removes follows in both directions between two users. */
  async deleteFollowsBetween(a: string, b: string): Promise<number> {
    const result = await this.db.follow.deleteMany({
      where: {
        OR: [
          { followerId: a, followeeId: b },
          { followerId: b, followeeId: a },
        ],
      },
    });
    return result.count;
  }

  async counts(id: string): Promise<{ following: number; followers: number }> {
    const [following, followers] = await Promise.all([
      this.db.follow.count({ where: { followerId: id } }),
      this.db.follow.count({ where: { followeeId: id } }),
    ]);
    return { following, followers };
  }

  /**
   * Newest-first keyset page over the follow rows joined to profiles.
   * `mode: 'following'` lists profiles the target follows; `'followers'` the
   * target's followers.
   */
  async followPage(
    mode: 'following' | 'followers',
    userId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ items: ProfileRow[]; nextCursor: string | null }> {
    const position = cursor ? decodeCursor(cursor) : null;
    const where: Prisma.FollowWhereInput = {
      ...(mode === 'following' ? { followerId: userId } : { followeeId: userId }),
      ...(position
        ? {
            OR: [
              { createdAt: { lt: new Date(position.createdAt) } },
              { createdAt: new Date(position.createdAt), id: { lt: position.id } },
            ],
          }
        : {}),
    };
    const orderBy: Prisma.FollowOrderByWithRelationInput[] = [
      { createdAt: 'desc' },
      { id: 'desc' },
    ];

    // Explicit branches (not a computed include key) so Prisma's generated
    // types resolve the joined profile correctly.
    const follows =
      mode === 'following'
        ? await this.db.follow.findMany({
            where,
            orderBy,
            take: limit + 1,
            include: { followee: true },
          })
        : await this.db.follow.findMany({
            where,
            orderBy,
            take: limit + 1,
            include: { follower: true },
          });

    const hasMore = follows.length > limit;
    const page = hasMore ? follows.slice(0, limit) : follows;
    const items = page.map((row) => ('followee' in row ? row.followee : row.follower));
    const last = page.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? encodeCursor(last) : null,
    };
  }

  followerIds(userId: string): Promise<string[]> {
    return this.db.follow
      .findMany({ where: { followeeId: userId }, select: { followerId: true } })
      .then((rows) => rows.map((row) => row.followerId));
  }

  blockedIds(userId: string): Promise<string[]> {
    return this.db.block
      .findMany({ where: { blockerId: userId }, select: { blockedId: true } })
      .then((rows) => rows.map((row) => row.blockedId));
  }

  /** Nightly reset: profiles and graph go away together (reset job only). */
  async truncate(): Promise<void> {
    await this.db.follow.deleteMany();
    await this.db.block.deleteMany();
    await this.db.profile.deleteMany();
  }

  toProfile(row: ProfileRow): Profile {
    return {
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      bio: row.bio,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
