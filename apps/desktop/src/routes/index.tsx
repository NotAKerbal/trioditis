import { createFileRoute } from '@tanstack/react-router'
import { AppGate } from '~/features/auth/app-gate.tsx'
import { Shell } from '~/features/shell/shell.tsx'
import { isPeopleView, type PeopleView } from '~/features/people/people-dialog.tsx'
import { SETTINGS_SECTIONS, type SettingsSection } from '~/features/settings/settings-dialog.tsx'

// The app: the open chat, the open settings section and the People window live in the URL, so reloads and the
// back button keep them.
export const Route = createFileRoute('/')({
  validateSearch: (
    search: Record<string, unknown>,
  ): { chat?: string; settings?: SettingsSection; connect?: true; people?: PeopleView } => ({
    ...(typeof search.chat === 'string' ? { chat: search.chat } : {}),
    ...(SETTINGS_SECTIONS.some((s) => s.id === search.settings)
      ? { settings: search.settings as SettingsSection }
      : {}),
    // Only Accounts reads it, so it goes nowhere else (a chat opened later doesn't carry it along).
    ...(search.settings === 'accounts' && (search.connect === true || search.connect === 'true')
      ? { connect: true as const }
      : {}),
    ...(isPeopleView(search.people) ? { people: search.people } : {}),
  }),
  component: () => (
    <AppGate>
      <Shell />
    </AppGate>
  ),
})
