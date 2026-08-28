/**
 * About preview-param handling (Payload live preview, #153): the About page
 * hosts both CMS collections (sections + FAQ), so both live-preview there.
 *
 * `/about?preview=<docId>`: present means render the DRAFT (uncached; an
 * accepted-exposure preview link - see spec 04); absent means the cached
 * published copy.
 */
export async function resolvePreviewId(
  searchParams: Promise<{ preview?: string | string[] }>,
): Promise<string | undefined> {
  const params = await searchParams;
  const raw = Array.isArray(params.preview) ? params.preview[0] : params.preview;
  // `?preview=` (empty) still renders the page's draft data client-side.
  return raw === '' || raw === undefined ? undefined : raw;
}
