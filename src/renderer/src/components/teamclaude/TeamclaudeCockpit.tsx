import React, { useEffect, useState } from 'react'

import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { useTeamclaude } from '@/hooks/useTeamclaude'
import { TeamclaudeWidget } from './TeamclaudeWidget'
import { TeamclaudeFlyout } from './TeamclaudeFlyout'
import { TeamclaudePanel } from './TeamclaudePanel'
import { OPEN_TEAMCLAUDE_COCKPIT_EVENT } from './teamclaude-cockpit-event'

// Why: the single mount entry for the TeamClaude cockpit. Owns the hook, wires
// the compact widget to the flyout popover, and hosts the management panel.
// Renders nothing when the preload bridge is absent (e.g. web build) so the
// mount point stays inert until the main-process module is present.

export function TeamclaudeCockpit(): React.JSX.Element | null {
  const { state, activity, controls, controlError, bridgeAvailable } = useTeamclaude()
  const [flyoutOpen, setFlyoutOpen] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)

  useEffect(() => {
    const openPanel = (): void => {
      setFlyoutOpen(false)
      setPanelOpen(true)
    }
    window.addEventListener(OPEN_TEAMCLAUDE_COCKPIT_EVENT, openPanel)
    return () => window.removeEventListener(OPEN_TEAMCLAUDE_COCKPIT_EVENT, openPanel)
  }, [])

  if (!bridgeAvailable) {
    return null
  }

  return (
    <>
      <Popover open={flyoutOpen} onOpenChange={setFlyoutOpen}>
        <PopoverTrigger asChild>
          <TeamclaudeWidget state={state} />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-auto p-3">
          <TeamclaudeFlyout
            state={state}
            controls={controls}
            onOpenPanel={() => {
              setFlyoutOpen(false)
              setPanelOpen(true)
            }}
          />
        </PopoverContent>
      </Popover>
      <TeamclaudePanel
        open={panelOpen}
        onOpenChange={setPanelOpen}
        state={state}
        activity={activity}
        controls={controls}
        controlError={controlError}
      />
    </>
  )
}
