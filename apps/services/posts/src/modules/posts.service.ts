import { Injectable } from '@nestjs/common';

/**
 * Posts, replies, and interactions.
 * Skeleton - Prisma persistence, interaction rules, and Kafka events land with
 * the posts feature ticket.
 */
@Injectable()
export class PostsService {
  getPost(postId: string): { id: string } {
    return { id: postId };
  }

  placeholder(postId?: string): { ok: boolean; postId?: string } {
    return { ok: true, ...(postId ? { postId } : {}) };
  }
}
