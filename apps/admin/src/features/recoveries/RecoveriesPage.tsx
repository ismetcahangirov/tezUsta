import { Link } from 'react-router';

import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Table, TD_CLASS, TH_CLASS } from '../../components/Table';
import { formatDateTime } from '../../format';
import { PageFrame } from '../../shell/PageFrame';
import { useSignedInAdmin } from '../../shell/Shell';
import { useListRecoveriesQuery } from './api';
import { recoveriesCopy } from './copy';
import { adminName, holdLeft } from './rules';

/**
 * Open account recoveries, oldest first (#517, ADR-0074 § 2): each with its
 * state, who opened it and the time left in its hold.
 */
export function RecoveriesPage() {
  const me = useSignedInAdmin();
  const { data, error, isLoading, isFetching, refetch } = useListRecoveriesQuery();
  const now = new Date();

  return (
    <PageFrame title={recoveriesCopy.title}>
      <p className="text-body text-text-muted">{recoveriesCopy.intro}</p>
      {isLoading ? (
        <p role="status" className="text-body text-text-muted">
          {recoveriesCopy.loading}
        </p>
      ) : error !== undefined && data === undefined ? (
        <div className="flex flex-col items-start gap-3">
          <Banner tone="danger" message={recoveriesCopy.loadFailed} />
          <Button label={recoveriesCopy.retry} variant="secondary" onClick={() => void refetch()} />
        </div>
      ) : data === undefined || data.length === 0 ? (
        <p className="text-body text-text-muted">{recoveriesCopy.empty}</p>
      ) : (
        <Table caption={recoveriesCopy.tableCaption}>
          <thead>
            <tr>
              {Object.values(recoveriesCopy.columns).map((column) => (
                <th key={column} scope="col" className={TH_CLASS}>
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody aria-busy={isFetching || undefined}>
            {data.map((recovery) => (
              <tr key={recovery.id} className="hover:bg-surface-alt">
                <td className={TD_CLASS}>
                  <Link
                    to={`/recoveries/${recovery.id}`}
                    className="font-semibold underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    {recovery.accountName ?? recoveriesCopy.unknownAccount}
                  </Link>
                  <div className="text-caption text-text-muted">{recovery.oldEmailMasked}</div>
                </td>
                <td className={TD_CLASS}>{recoveriesCopy.status[recovery.status]}</td>
                <td className={TD_CLASS}>
                  {adminName(me, recovery.openedByAdminId, recovery.openedByName)}
                </td>
                <td className={TD_CLASS}>{formatDateTime(recovery.openedAt)}</td>
                <td className={TD_CLASS}>{holdLeft(recovery, now) ?? recoveriesCopy.none}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </PageFrame>
  );
}
