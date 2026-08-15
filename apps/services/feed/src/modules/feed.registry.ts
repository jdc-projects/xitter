import { OpenAPIRegistry, extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { postSchema, profileSchema } from "@xitter/api-contracts";

extendZodWithOpenApi(z);

const feedPage = z.object({
  items: z.array(z.object({ post: postSchema, author: profileSchema })),
  nextCursor: z.string().nullable(),
});

export const feedApi = new OpenAPIRegistry("feed");

feedApi.registerPath({
  method: "GET",
  path: "/feed",
  tags: ["feed"],
  security: [{ bearerAuth: [] }],
  request: { query: z.object({ cursor: z.string().optional(), limit: z.coerce.number().optional() }) },
  responses: {
    200: { description: "Feed page", content: { "application/json": { schema: feedPage } } },
  },
});
