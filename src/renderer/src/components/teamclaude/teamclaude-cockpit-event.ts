export const OPEN_TEAMCLAUDE_COCKPIT_EVENT = 'orca:teamclaude:open-cockpit'

export function openTeamclaudeCockpit(): void {
  window.dispatchEvent(new Event(OPEN_TEAMCLAUDE_COCKPIT_EVENT))
}
