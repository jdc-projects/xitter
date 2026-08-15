import { Controller, Get } from "@nestjs/common";
import { SearchService } from "./search.service.js";

/**
 * Full-text search over posts, backed by OpenSearch.
 * Skeleton controller - the search feature ticket fills in querying.
 * Contract: docs/specs/architecture/03-service-interfaces.md.
 */
@Controller()
export class SearchController {
  constructor(private readonly service: SearchService) {}

  @Get("posts")
  search() {
    return this.service.placeholder();
  }
}
