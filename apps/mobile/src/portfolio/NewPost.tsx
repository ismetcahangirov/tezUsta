import { skipToken } from '@reduxjs/toolkit/query';

import { useOwnMasterQuery } from '../master-jobs/master-jobs-endpoints';
import { useMasterProfileQuery } from './master-profile-endpoints';
import { PostEditor } from './PostEditor';

export interface NewPostProps {
  readonly onClose: () => void;
}

/**
 * The post editor, given the master's active services for its optional tag.
 *
 * The services come from the master's own public profile, which carries their
 * names and is already cached from the profile screen this is pushed from.
 * While it is not there yet the editor opens without the tag rather than
 * waiting: photos are what the master came for.
 */
export function NewPost({ onClose }: NewPostProps): React.JSX.Element {
  const own = useOwnMasterQuery();
  const profile = useMasterProfileQuery(own.currentData?.id ?? skipToken);

  return <PostEditor services={profile.currentData?.services ?? []} onClose={onClose} />;
}
