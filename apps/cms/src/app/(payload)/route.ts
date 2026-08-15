import { notFound } from "next/navigation";
import { pathToFileURL } from "node:url";
import root from "@payloadcms/next/root";

const configFile = pathToFileURL(new URL("../../../../payload.config.ts", import.meta.url)).toString();

export const GET = async (request: Request) => {
  if (!new URL(request.url).pathname.startsWith("/admin")) notFound();
  return root({ configFile, request })();
};
