import { createFileRoute } from '@tanstack/react-router'
import { AppGate } from '~/features/auth/app-gate.tsx'
import { Shell } from '~/features/shell/shell.tsx'
import { SETTINGS_SECTIONS, type SettingsSection } from '~/features/settings/settings-dialog.tsx'

// The app: the open chat and the open settings section live in the URL, so reloads and the
// back button keep them.
export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): { chat?: string; settings?: SettingsSection; connect?: true } => ({
    ...(typeof search.chat === 'string' ? { chat: search.chat } : {}),
    ...(SETTINGS_SECTIONS.some((s) => s.id === search.settings)
      ? { settings: search.settings as SettingsSection }
      : {}),
    ...(search.connect === true || search.connect === 'true' ? { connect: true as const } : {}),
  }),
  component: () => (
    <AppGate>
      <Shell />
    </AppGate>
  ),
})
