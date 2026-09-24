import { copy } from '../copy';
import { PageFrame } from './PageFrame';

/** Stands in for a section until its own issue builds it. */
export function PlaceholderPage({ title, issue }: { title: string; issue: number }) {
  return (
    <PageFrame title={title}>
      <p className="text-body text-text-muted">{copy.shell.comingIn(issue)}</p>
    </PageFrame>
  );
}
