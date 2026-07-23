export type TcNativeAccountIdentity = {
  id: string
  email: string
  accountUuid?: string | null
  organizationUuid?: string | null
  organizationName?: string | null
}

type FleetAccountIdentity = {
  id?: string
  email?: string | null
}

export function findOrcaAccountId(
  fleetAccount: FleetAccountIdentity,
  nativeAccounts: readonly TcNativeAccountIdentity[]
): string | null {
  const stable = parseStableAccountId(fleetAccount.id)
  if (stable) {
    const uuidMatches = nativeAccounts.filter(
      (account) => account.accountUuid === stable.accountUuid
    )
    if (stable.organizationKey) {
      const organizationMatches = uuidMatches.filter(
        (account) =>
          account.organizationUuid === stable.organizationKey ||
          account.organizationName === stable.organizationKey
      )
      if (organizationMatches.length === 1) {
        return organizationMatches[0]?.id ?? null
      }
      const onlyMatchHasNoOrganization =
        uuidMatches.length === 1 &&
        !uuidMatches[0]?.organizationUuid &&
        !uuidMatches[0]?.organizationName
      if (uuidMatches.length > 0 && !onlyMatchHasNoOrganization) {
        return null
      }
    }
    if (uuidMatches.length === 1) {
      return uuidMatches[0]?.id ?? null
    }
  }

  const email = fleetAccount.email?.trim().toLocaleLowerCase()
  if (!email) {
    return null
  }
  const matches = nativeAccounts.filter(
    (account) => account.email.trim().toLocaleLowerCase() === email
  )
  return matches.length === 1 ? (matches[0]?.id ?? null) : null
}

function parseStableAccountId(
  id: string | undefined
): { accountUuid: string; organizationKey: string } | null {
  if (!id) {
    return null
  }
  const separator = id.indexOf('::')
  if (separator <= 0) {
    return null
  }
  return {
    accountUuid: id.slice(0, separator),
    organizationKey: id.slice(separator + 2)
  }
}
