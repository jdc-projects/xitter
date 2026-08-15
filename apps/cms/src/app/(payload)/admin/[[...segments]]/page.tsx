/* THIS FILE IS MAINTAINED MANUALLY - generated variants are gitignored. */
import config from "@payloadcms/next";
import "@payloadcms/next/css";
import { pathToFileURL } from "node:url";

const configFile = pathToFileURL(new URL("../../../../payload.config.ts", import.meta.url)).toString();

export default config({ configFile });
export const dynamic = "force-dynamic";
