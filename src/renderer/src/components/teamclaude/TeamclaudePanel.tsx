import React from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import type { TcActivityRow, TcState } from '../../../../shared/teamclaude-types'
import type { TeamclaudeControls } from '@/hooks/useTeamclaude'
import { AccountsTab } from './panel/AccountsTab'
import { RoutesTab } from './panel/RoutesTab'
import { ActivityTab } from './panel/ActivityTab'
import { ProxyTab } from './panel/ProxyTab'

// Why: the full management surface. A tabbed dialog keeping the four cockpit
// concerns (accounts, routes, activity, proxy) in one place; each tab is its
// own module so per-file line budgets stay comfortable.

export type TeamclaudePanelProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  state: TcState | null
  activity: TcActivityRow[]
  controls: TeamclaudeControls
}

export function TeamclaudePanel({
  open,
  onOpenChange,
  state,
  activity,
  controls
}: TeamclaudePanelProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('teamclaude.panel.title', 'TeamClaude')}</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="accounts" className="w-full">
          <TabsList>
            <TabsTrigger value="accounts">{t('teamclaude.panel.accounts', 'Accounts')}</TabsTrigger>
            <TabsTrigger value="routes">{t('teamclaude.panel.routes', 'Routes')}</TabsTrigger>
            <TabsTrigger value="activity">{t('teamclaude.panel.activity', 'Activity')}</TabsTrigger>
            <TabsTrigger value="proxy">{t('teamclaude.panel.proxy', 'Proxy')}</TabsTrigger>
          </TabsList>
          <TabsContent value="accounts">
            <AccountsTab state={state} controls={controls} />
          </TabsContent>
          <TabsContent value="routes">
            <RoutesTab state={state} controls={controls} />
          </TabsContent>
          <TabsContent value="activity">
            <ActivityTab activity={activity} />
          </TabsContent>
          <TabsContent value="proxy">
            <ProxyTab state={state} activity={activity} controls={controls} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
