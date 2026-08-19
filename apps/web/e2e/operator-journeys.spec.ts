import { expect, test } from '@playwright/test'
import {
  E2E_AGENT_ID,
  E2E_CONTINUED_THREAD_ID,
  E2E_FAILED_THREAD_ID,
  E2E_QUEUE_THREAD_ID,
  E2E_SOURCE_THREAD_ID,
} from '../scripts/e2e-fixtures'

function chatUrl(threadId: string): string {
  return `/organization/${E2E_AGENT_ID}?section=chat&thread=${threadId}`
}

test.beforeEach(async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Email').fill('owner@bunkhouse.local')
  await page.getByLabel('Password').fill('correct-horse-battery-staple')
  await page.getByRole('button', { name: /sign in/i }).click()
  await expect(page).toHaveURL(/\/$/)
})

test('operator can reach the primary governed surfaces', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Work' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Nobody has a face yet' })).toBeVisible()

  await page.goto('/organization/chart')
  await expect(page.getByRole('heading', { name: 'Org chart' })).toBeVisible()

  await page.goto('/approvals')
  await expect(page.getByRole('heading', { name: 'Approvals' })).toBeVisible()

  await page.goto('/observatory')
  await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible()

  await page.goto('/admin/settings?section=features')
  await expect(page.getByRole('heading', { name: 'Features' })).toBeVisible()
  await expect(page.getByText('Agent desks', { exact: true })).toBeVisible()
})

test('conversation components cover search, provenance, export, and archive states', async ({ page }) => {
  await page.goto(chatUrl(E2E_CONTINUED_THREAD_ID))
  await expect(page.getByText('Continued from an earlier conversation')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open earlier' })).toBeVisible()

  const search = page.getByRole('searchbox', { name: 'Search conversations' })
  await search.fill('$1,240')
  await expect(page.getByRole('button', { name: /Dawson receivable review Avery Chen/ })).toHaveCount(1)
  await expect(page.getByRole('button', { name: /Continuation of Dawson/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'Clear conversation search' }).click()

  await page.getByRole('button', { name: 'Actions for Dawson receivable review' }).click()
  await expect(page.getByRole('menuitem', { name: 'Continue in new conversation' })).toBeVisible()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('menuitem', { name: 'Download transcript (.md)' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('dawson-receivable-review.md')

  await page.getByRole('button', { name: 'Actions for Dawson receivable review' }).click()
  await page.getByRole('menuitem', { name: 'Archive' }).click()
  await expect(page.getByRole('button', { name: 'Actions for Dawson receivable review' })).toHaveCount(0)
  await page.goto(chatUrl(E2E_SOURCE_THREAD_ID))
  await expect(page.getByRole('button', { name: /Dawson receivable review.*archived/ })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Message Avery Chen…' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Actions for Dawson receivable review' }).click()
  await expect(page.getByRole('menuitem', { name: 'Unarchive' })).toBeVisible()
  await page.getByRole('menuitem', { name: 'Unarchive' }).click()
  await expect(page.getByRole('button', { name: 'Actions for Dawson receivable review' })).toBeVisible()

  await page.goto(chatUrl(E2E_CONTINUED_THREAD_ID))
  await page.getByRole('button', { name: 'Open earlier' }).click()
  await expect(page).toHaveURL(new RegExp(`thread=${E2E_SOURCE_THREAD_ID}$`))
})

test('conversation queue components cover running, waiting, and recovery states', async ({ page }) => {
  await page.goto(chatUrl(E2E_QUEUE_THREAD_ID))
  const queue = page.getByRole('region', { name: 'Up next' })
  await expect(queue).toBeVisible()
  await expect(queue.getByText('Working now')).toBeVisible()
  await expect(queue.getByText('Starting')).toBeVisible()
  await expect(queue.getByText('Do this next')).toBeVisible()
  await expect(queue.getByText('Queued')).toBeVisible()
  await expect(queue.getByRole('button', { name: 'Edit queued message' })).toHaveCount(1)
  await expect(queue.getByRole('button', { name: 'Remove queued message' })).toHaveCount(1)

  await page.goto(chatUrl(E2E_FAILED_THREAD_ID))
  const recovery = page.getByRole('region', { name: 'Up next' })
  await expect(recovery.getByText('Needs attention')).toBeVisible()
  await expect(recovery.getByText('The provider timed out.')).toBeVisible()
  await expect(recovery.getByRole('button', { name: 'Retry queued message' })).toBeVisible()
  await expect(recovery.getByRole('button', { name: 'Edit queued message' })).toBeVisible()
  await expect(recovery.getByRole('button', { name: 'Remove queued message' })).toBeVisible()
})
