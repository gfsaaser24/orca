import type { EntrypointResolutionResult } from './supervisor-types'

export function resolverFailureDetail(
  result: Exclude<EntrypointResolutionResult, { kind: 'resolved' }>
): string {
  const attempted = result.attemptedCandidates.length
    ? result.attemptedCandidates.join(', ')
    : '(none)'
  return `resolver=${result.kind}; found=${result.foundPath ?? '(none)'}; node=${result.nodeFallback}; attempted=${attempted}`
}
