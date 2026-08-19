/**
 * Shared landing/About preview-param handling (Payload live preview).
 *
 * Both pages accept `?preview=<docId>`: present means render the DRAFT
 * (auth-gated, uncached); absent means the cached published copy. Extracted
 * because the two pages otherwise duplicated the parsing.
 */
export async function resolvePreviewId(
  searchParams: Promise<{ preview?: string | string[] }>,
): Promise<string | undefined> {
  const params = await searchParams;
  const raw = Array.isArray(params.preview) ? params.preview[0] : params.preview;
  // `?preview=` (empty) still renders the page's draft data client-side.
  return raw === '' || raw === undefined ? undefined : raw;
}
