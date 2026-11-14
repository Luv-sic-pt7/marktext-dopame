import type { AppWindow } from 'acde/test'

export async function clickCommand(app: AppWindow, menu: string, label: string) {
  await app.getByRole('button', { name: menu, exact: true }).click()
  await app
    .getByRole('menu', { name: menu, exact: true })
    .getByRole('menuitem', { name: label, exact: true })
    .click()
}
