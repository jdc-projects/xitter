import { OpenAPIRegistry, extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { profileSchema } from "@xitter/api-contracts";

extendZodWithOpenApi(z);

const profilePage = z.object({
  items: z.array(profileSchema),
  nextCursor: z.string().nullable(),
});

export const socialApi = new OpenAPIRegistry("social");

socialApi.registerPath({
  method: "GET",
  path: "/profiles/{userId}",
  tags: ["profiles"],
  request: { params: z.object({ userId: z.string().uuid() }) },
  responses: {
    200: { description: "Profile", content: { "application/json": { schema: profileSchema } } },
    404: { description: "Not found" },
  },
});

socialApi.registerPath({
  method: "GET",
  path: "/profiles/username/{username}",
  tags: ["profiles"],
  request: { params: z.object({ username: z.string() }) },
  responses: {
    200: { description: "Profile", content: { "application/json": { schema: profileSchema } } },
    404: { description: "Not found" },
  },
});

socialApi.registerPath({
  method: "POST",
  path: "/profiles/{userId}/follow",
  tags: ["relationships"],
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ userId: z.string().uuid() }) },
  responses: { 204: { description: "Following" }, 409: { description: "Conflict" } },
});

socialApi.registerPath({
  method: "DELETE",
  path: "/profiles/{userId}/follow",
  tags: ["relationships"],
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ userId: z.string().uuid() }) },
  responses: { 204: { description: "Unfollowed" } },
});

socialApi.registerPath({
  method: "POST",
  path: "/profiles/{userId}/block",
  tags: ["relationships"],
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ userId: z.string().uuid() }) },
  responses: { 204: { description: "Blocked" } },
});

socialApi.registerPath({
  method: "GET",
  path: "/profiles/{userId}/following",
  tags: ["relationships"],
  request: { params: z.object({ userId: z.string().uuid() }) },
  responses: {
    200: { description: "Following page", content: { "application/json": { schema: profilePage } } },
  },
});

socialApi.registerPath({
  method: "GET",
  path: "/profiles/{userId}/followers",
  tags: ["relationships"],
  request: { params: z.object({ userId: z.string().uuid() }) },
  responses: {
    200: { description: "Followers page", content: { "application/json": { schema: profilePage } } },
  },
});
