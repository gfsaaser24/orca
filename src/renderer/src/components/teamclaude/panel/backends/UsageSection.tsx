import React from 'react'
import { useTranslation } from 'react-i18next'

import type { CpaUsageAggregate } from '../../../../../../shared/cliproxy-types'
import { successRate } from './backend-readiness'

export function UsageSection({ usage }: { usage: CpaUsageAggregate[] }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <section className="space-y-2">
      <div>
        <h3 className="text-sm font-semibold">{t('cliproxy.stats.title', 'Stats')}</h3>
        <p className="text-xs text-muted-foreground">
          {t('cliproxy.stats.accountingHint', 'Accounting — not remaining quota')}
        </p>
      </div>
      {usage.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
          {t('cliproxy.stats.empty', 'No accounting data in this window.')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border scrollbar-sleek">
          <table className="w-full text-left text-xs">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{t('cliproxy.stats.backend', 'Backend')}</th>
                <th className="px-3 py-2 text-right font-medium">
                  {t('cliproxy.stats.requests', 'Requests')}
                </th>
                <th className="px-3 py-2 text-right font-medium">
                  {t('cliproxy.stats.successRate', 'Success rate')}
                </th>
                <th className="px-3 py-2 text-right font-medium">
                  {t('cliproxy.stats.tokensIn', 'Tokens in')}
                </th>
                <th className="px-3 py-2 text-right font-medium">
                  {t('cliproxy.stats.tokensOut', 'Tokens out')}
                </th>
                <th className="px-3 py-2 text-right font-medium">
                  {t('cliproxy.stats.p50', 'p50')}
                </th>
              </tr>
            </thead>
            <tbody>
              {usage.map((entry) => (
                <tr key={entry.key} className="border-t border-border">
                  <td className="px-3 py-2 font-medium">{entry.key}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {entry.requests.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {successRate(entry.requests, entry.failures).toFixed(1)}%
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {entry.tokensIn.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {entry.tokensOut.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {entry.p50LatencyMs == null
                      ? '—'
                      : t('cliproxy.stats.latencyMs', '{{value0}}ms', {
                          value0: Math.round(entry.p50LatencyMs)
                        })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
