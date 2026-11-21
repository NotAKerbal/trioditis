import { Segmented, SegmentedItem } from '@trioditis/ui/segmented'
import { Switch } from '@trioditis/ui/switch'
import { toast } from '@trioditis/ui/toast'
import { useState } from 'react'
import { canNotify, notificationsAvailable } from '~/features/shell/notifications.ts'
import { setPref, usePrefs, type NotificationDetail } from '~/lib/prefs.ts'
import { Group, Heading, Setting } from './layout.tsx'

// What each choice puts in the system's notification history, outside what Trioditis seals.
const ABOUT: Record<NotificationDetail, string> = {
  hidden: 'Says only that a message came.',
  sender: 'Shows who sent it, which your system may keep.',
  message: 'Shows who sent it and what they said, which your system may keep.',
}

export function Notifications() {
  const prefs = usePrefs()
  const supported = notificationsAvailable()
  // The browser's answer, asked again only when the person turns notifications on.
  const [allowed, setAllowed] = useState(canNotify)
  async function turn(on: boolean) {
    if (!on) return setPref('notifications', false)
    const granted = allowed || (await Notification.requestPermission()) === 'granted'
    setAllowed(granted)
    if (granted) setPref('notifications', true)
    else toast('Notifications are blocked for this site. Allow them in your browser’s site settings, then try again.')
  }
  const on = prefs.notifications && allowed
  return (
    <>
      <Heading title="Notifications" />
      <Group>
        <Setting
          title="Desktop notifications"
          about={supported ? undefined : 'This browser can’t show notifications.'}
        >
          <Switch
            checked={on}
            disabled={!supported}
            onCheckedChange={(v) => void turn(v)}
            aria-label="Desktop notifications"
          />
        </Setting>
        {on ? (
          // Kept in view: what a notification shows can stay in the system's own history.
          <Setting title="Show" about={ABOUT[prefs.notificationDetail]}>
            <Segmented
              value={prefs.notificationDetail}
              onValueChange={(v) => setPref('notificationDetail', v as NotificationDetail)}
              className="w-[260px]"
              aria-label="What notifications show"
            >
              <SegmentedItem value="hidden">Nothing</SegmentedItem>
              <SegmentedItem value="sender">Sender</SegmentedItem>
              <SegmentedItem value="message">Message</SegmentedItem>
            </Segmented>
          </Setting>
        ) : null}
      </Group>
    </>
  )
}
