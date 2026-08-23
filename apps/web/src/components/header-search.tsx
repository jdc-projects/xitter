'use client';

import { usePathname } from 'next/navigation';
import { SearchBox } from './search-box';

/**
 * The header search box (#39): hidden on /search, where the page's own
 * query box is the single input. The old header + page pair rendered two
 * identical labelled inputs on /search - screen-reader duplication and a
 * Playwright strict-mode hazard.
 */
export function HeaderSearch() {
  const pathname = usePathname();
  if (pathname === '/search') return null;
  return <SearchBox visibleFrom="xs" />;
}
