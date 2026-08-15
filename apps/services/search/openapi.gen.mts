import { buildServiceDocument } from "@xitter/api-contracts";
import { searchApi } from "./modules/search.registry.js";
import { writeFileSync } from "node:fs";

const document = buildServiceDocument(
  {
    service: "search",
    title: "xitter search API",
    description: "Full-text search over posts, backed by OpenSearch.",
    basePath: "/api/search",
  },
  searchApi,
);

writeFileSync(new URL("../../openapi.json", import.meta.url), JSON.stringify(document, null, 2));
console.log("wrote openapi.json");
