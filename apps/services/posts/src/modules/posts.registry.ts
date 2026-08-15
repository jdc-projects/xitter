import { OpenAPIRegistry, extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { createPostRequestSchema, postSchema } from "@xitter/api-contracts";

extendZodWithOpenApi(z);

const postPage = z.object({
  items: z.array(z.object({ post: postSchema })),
  nextCursor: z.string().nullable(),
});

export const postsApi = new OpenAPIRegistry("posts");

postsApi.registerPath({
  method: "POST",
  path: "/posts",
  tags: ["posts"],
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: createPostRequestSchema } } } },
  responses: {
    201: { description: "Created post", content: { "application/json": { schema: postSchema } } },
    400: { description: "Validation error" },
  },
});

postsApi.registerPath({
  method: "GET",
  path: "/posts/{postId}",
  tags: ["posts"],
  request: { params: z.object({ postId: z.string().uuid() }) },
  responses: {
    200: { description: "Post", content: { "application/json": { schema: postSchema } } },
    404: { description: "Not found" },
  },
});

postsApi.registerPath({
  method: "GET",
  path: "/users/{userId}/posts",
  tags: ["posts"],
  request: { params: z.object({ userId: z.string().uuid() }) },
  responses: {
    200: { description: "User posts page", content: { "application/json": { schema: postPage } } },
  },
});
