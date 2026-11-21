import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

export default defineConfig({
  site: 'https://docs.trioditis.app',
  integrations: [
    starlight({
      title: 'Trioditis',
      description: 'Open-source, self-hosted universal messaging hub with sealed storage.',
      logo: {
        light: './src/assets/lockup.svg',
        dark: './src/assets/lockup-dark.svg',
        replacesTitle: true,
      },
      favicon: '/icon.svg',
      head: [
        { tag: 'meta', attrs: { name: 'theme-color', content: '#ffffff', media: '(prefers-color-scheme: light)' } },
        { tag: 'meta', attrs: { name: 'theme-color', content: '#0f1115', media: '(prefers-color-scheme: dark)' } },
        { tag: 'link', attrs: { rel: 'icon', href: '/favicon.ico', sizes: '48x48' } },
        { tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' } },
        { tag: 'meta', attrs: { property: 'og:image', content: 'https://docs.trioditis.app/social-card.png' } },
        { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
        { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
        {
          tag: 'meta',
          attrs: { property: 'og:image:alt', content: 'Trioditis: a crossroads for all of your conversations.' },
        },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: 'https://docs.trioditis.app/social-card.png' } },
      ],
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/NotAKerbal/trioditis',
        },
        {
          icon: 'external',
          label: 'trioditis.app',
          href: 'https://trioditis.app',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/NotAKerbal/trioditis/edit/dev/apps/docs/',
      },
      customCss: ['@fontsource-variable/dm-sans', './src/styles/custom.css'],
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Introduction', slug: 'getting-started/introduction' },
            { label: 'Quickstart', slug: 'getting-started/quickstart' },
          ],
        },
        {
          label: 'Self-Hosting',
          items: [
            { label: 'Installation & Modes', slug: 'self-hosting/installation' },
            { label: 'Proxmox VE', slug: 'self-hosting/proxmox' },
            { label: 'Operations & Auto-Updates', slug: 'self-hosting/operations' },
            { label: 'Backups, Restore & Keys', slug: 'self-hosting/backup-and-keys' },
          ],
        },
        {
          label: 'Networks',
          items: [
            { label: 'Overview', slug: 'networks' },
            { label: 'WhatsApp', slug: 'networks/whatsapp' },
            { label: 'Signal', slug: 'networks/signal' },
            { label: 'Google Messages', slug: 'networks/gmessages' },
            { label: 'Google Voice', slug: 'networks/gvoice' },
            { label: 'Telegram', slug: 'networks/telegram' },
            { label: 'Messenger', slug: 'networks/meta' },
            { label: 'Instagram', slug: 'networks/instagram' },
            { label: 'Slack', slug: 'networks/slack' },
            { label: 'GroupMe', slug: 'networks/groupme' },
            { label: 'LinkedIn', slug: 'networks/linkedin' },
            { label: 'X', slug: 'networks/twitter' },
            { label: 'Bluesky', slug: 'networks/bluesky' },
          ],
        },
        {
          label: 'Security & Privacy',
          items: [
            { label: 'Security Model', slug: 'security/overview' },
            { label: 'Sealed Storage Spec', slug: 'security/sealing' },
          ],
        },
        {
          label: 'Architecture',
          items: [
            { label: 'System Overview', slug: 'architecture/overview' },
            { label: 'Bridge Protocol (v1)', slug: 'architecture/bridge-protocol' },
            { label: 'Client API', slug: 'architecture/client-api' },
            { label: 'Sign-in Browser', slug: 'architecture/signin-browser' },
            { label: 'Bridge Host Internals', slug: 'architecture/bridge-host' },
          ],
        },
        {
          label: 'Contributing',
          items: [
            { label: 'Local Development', slug: 'contributing/local-development' },
            { label: 'Workflow & Checks', slug: 'contributing/workflow' },
            { label: 'Brand Guide', slug: 'contributing/brand' },
            { label: 'Roadmap & Decisions', slug: 'contributing/roadmap' },
          ],
        },
      ],
    }),
  ],
})
