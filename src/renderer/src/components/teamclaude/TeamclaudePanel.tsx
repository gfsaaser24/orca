import React from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import type { CpaState } from '../../../../shared/cliproxy-types'
import type { TcActivityRow, TcState } from '../../../../shared/teamclaude-types'
import type { CliproxyControlError, CliproxyControls } from '@/hooks/useCliproxy'
import type { TeamclaudeControlError, TeamclaudeControls } from '@/hooks/useTeamclaude'
import { AccountsTab } from './panel/AccountsTab'
import { ActivityTab } from './panel/ActivityTab'
import { BackendsTab } from './panel/BackendsTab'
import { RoutesTab } from './panel/RoutesTab'
import { ServicesTab } from './panel/ServicesTab'
import { surfaceGates } from './teamclaude-model'

export type TeamclaudePanelProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  state: TcState | null
  activity: TcActivityRow[]
  controls: TeamclaudeControls
  controlError: TeamclaudeControlError | null
  cpaState: CpaState | null
  cpaControls: CliproxyControls
  cpaControlError: CliproxyControlError | null
  localLaunchAvailable: boolean
  cpaBinaryPath?: string
  onSaveCpaBinaryPath?: (path: string) => Promise<void>
}

export function TeamclaudePanel({
  open,
  onOpenChange,
  state,
  activity,
  controls,
  controlError,
  cpaState,
  cpaControls,
  cpaControlError,
  localLaunchAvailable,
  cpaBinaryPath,
  onSaveCpaBinaryPath
}: TeamclaudePanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const gates = surfaceGates(state)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t('teamclaude.panel.title', 'TeamClaude')}</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="accounts" className="w-full">
          <TabsList>
            <TabsTrigger value="accounts">{t('teamclaude.panel.accounts', 'Accounts')}</TabsTrigger>
            <TabsTrigger value="routes">{t('teamclaude.panel.routes', 'Routes')}</TabsTrigger>
            <TabsTrigger value="activity">{t('teamclaude.panel.activity', 'Activity')}</TabsTrigger>
            <TabsTrigger value="services">{t('teamclaude.panel.services', 'Services')}</TabsTrigger>
            <TabsTrigger value="backends">{t('teamclaude.panel.backends', 'Backends')}</TabsTrigger>
          </TabsList>
          <TabsContent value="accounts">
            <AccountsTab state={state} controls={controls} />
          </TabsContent>
          <TabsContent value="routes">
            <RoutesTab state={state} controls={controls} />
          </TabsContent>
          <TabsContent value="activity">
            <ActivityTab activity={activity} offline={gates.offline} />
          </TabsContent>
          <TabsContent value="services">
            <ServicesTab
              state={state}
              activity={activity}
              controls={controls}
              controlError={controlError}
              cpaState={cpaState}
              cpaControls={cpaControls}
              cpaControlError={cpaControlError}
            />
          </TabsContent>
          <TabsContent value="backends">
            <BackendsTab
              state={cpaState}
              controls={cpaControls}
              localLaunchAvailable={localLaunchAvailable}
              binaryPath={cpaBinaryPath}
              onSaveBinaryPath={onSaveCpaBinaryPath}
            />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
