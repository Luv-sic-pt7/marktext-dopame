export interface CommandMenuItem {
  id: string
  label: string
  shortcut?: string
  disabled?: boolean
  checked?: boolean
  /** Draw a divider before this item. */
  separator?: boolean
}

let dismissActiveMenu: (() => void) | undefined

export function claimCommandMenu(dismiss: () => void) {
  if (dismissActiveMenu !== dismiss) dismissActiveMenu?.()
  dismissActiveMenu = dismiss
}

export function releaseCommandMenu(dismiss: () => void) {
  if (dismissActiveMenu === dismiss) dismissActiveMenu = undefined
}
