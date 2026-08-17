import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Email').fill('operator@bunkhouse.test')
  await page.getByLabel('Password').fill('correct-horse-battery-staple')
  await page.getByRole('button', { name: /sign in/i }).click()
  await expect(page).toHaveURL(/\/$/)
})

test('operator can reach the primary governed surfaces', async ({ page }) => {
  await expect(page.getByRole('link', { name: 'Observatory' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Nobody lives here yet' })).toBeVisible()

  await page.goto('/organization/chart')
  await expect(page.getByRole('heading', { name: 'Org chart' })).toBeVisible()

  await page.goto('/approvals')
  await expect(page.getByRole('heading', { name: 'Approvals' })).toBeVisible()

  await page.goto('/observatory')
  await expect(page.getByRole('heading', { name: 'Observatory' })).toBeVisible()

  await page.goto('/admin/settings?section=features')
  await expect(page.getByRole('heading', { name: 'Features' })).toBeVisible()
  await expect(page.getByText('Agent desks', { exact: true })).toBeVisible()
})
