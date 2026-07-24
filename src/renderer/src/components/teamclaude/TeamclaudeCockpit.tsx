import React, { useEffect, useState } from 'react'

import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { useCliproxy } from '@/hooks/useCliproxy'
import { useTeamclaude } from '@/hooks/useTeamclaude'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { useAppStore, type AppState } from '@/store'
import { OPEN_TEAMCLAUDE_COCKPIT_EVENT } from './teamclaude-cockpit-event'
import { TeamclaudeFlyout } from './TeamclaudeFlyout'
import { TeamclaudePanel } from './TeamclaudePanel'
import { TeamclaudeWidget } from './TeamclaudeWidget'

function isLocalLaunchContext(state: AppState): boolean {
  const activeRepo = state.activeRepoId
    ? state.repos.find((repo) => repo.id === state.activeRepoId)
    : null
  if (activeRepo && getRepoExecutionHostId(activeRepo) !== LOCAL_EXECUTION_HOST_ID) {
    return false
  }
  const projectRuntime = getLocalProjectExecutionRuntimeContext(state)
  if (projectRuntime?.status === 'resolved') {
    return projectRuntime.runtime.kind !== 'wsl'
  }
  if (projectRuntime?.status === 'repair-required') {
    return projectRuntime.repair.preferredRuntime.kind !== 'wsl'
  }
  return true
}

// Why: the single cockpit mount owns both service hooks so renderer bridge access
// remains centralized even though lifecycle and backend data live in separate tabs.
export function TeamclaudeCockpit(): React.JSX.Element | null {
  const { state, activity, controls, controlError, bridgeAvailable } = useTeamclaude()
  const { state: cpaState, controls: cpaControls, controlError: cpaControlError } = useCliproxy()
  const localLaunchAvailable = useAppStore(isLocalLaunchContext)
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
        cpaState={cpaState}
        cpaControls={cpaControls}
        cpaControlError={cpaControlError}
        localLaunchAvailable={localLaunchAvailable}
      />
    </>
  )
}
