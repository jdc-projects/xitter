import { buildServiceDocument } from "@xitter/api-contracts";
import { postsApi } from "./modules/posts.registry.js";
import { writeFileSync } from "node:fs";

const document = buildServiceDocument(
  {
    service: "posts",
    title: "xitter posts API",
    description: "Posts, replies, and interactions (likes, bookmarks, reposts).",
    basePath: "/api/posts",
  },
  postsApi,
);

writeFileSync(new URL("../../openapi.json", import.meta.url), JSON.stringify(document, null, 2));
console.log("wrote openapi.json");
