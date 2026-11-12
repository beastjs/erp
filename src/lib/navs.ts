import type { IconName } from '@/lib/icons'

export type NavItem = {
  href: string
  icon: IconName
  label: string
  value: string
  tags: string[]
  description?: string
  short?: string
  disabled?: boolean
}

export type NavGroup = {
  title: string
  items: NavItem[]
  label?: string
}
export const navGroups: NavGroup[] = [
  {
    title: '',
    items: [
      {
        href: '/',
        value: 'overview',
        icon: 'menu',
        label: 'Overview',
        short: 'Overview',
        description: '',
        tags: ['create', 'new file', 'new folder']
      }
    ]
  },
  {
    title: '',
    items: []
  }
]

export const branches: NavGroup[] = [
  {
    title: 'Getting started',
    items: [
      {
        short: 'install',
        value: 'install',
        href: 'install',
        label: 'Installation',
        icon: 'menu',
        description: 'settings',
        tags: ['tags']
      },
      {
        short: 'quick',
        value: 'quick',
        href: 'quick',
        label: 'Quick start',
        icon: 'menu',
        description: 'settings',
        tags: ['tags']
      },
      {
        short: 'config',
        value: 'config',
        href: 'config',
        label: 'Configuration',
        icon: 'menu',
        description: 'settings',
        tags: ['tags']
      }
    ]
  },
  {
    title: 'Components',
    items: [
      {
        short: 'buttons',
        value: 'buttons',
        href: 'buttons',
        label: 'Buttons',
        icon: 'menu',
        description: 'settings',
        tags: ['tags']
      },
      {
        short: 'overlays',
        value: 'overlays',
        href: 'overlays',
        label: 'Overlays',
        icon: 'menu',
        description: 'settings',
        tags: ['tags']
      }
    ]
  }
]
