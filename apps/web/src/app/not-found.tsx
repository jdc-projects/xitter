import { NotFoundContent } from '@/components/not-found-content';

/**
 * Root boundary: any notFound() thrown above the app group. The (app)
 * group has its own boundary (#135) so authenticated surfaces keep the
 * shell's nav around the same 404 body; this one stays the bare,
 * signed-out-appropriate render.
 */
export default function NotFoundPage() {
  return <NotFoundContent />;
}
