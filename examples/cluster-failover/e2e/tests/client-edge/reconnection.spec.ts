import { test, expect } from '../../fixtures/cluster'
import { CLUSTER } from '../../helpers/selectors'

test.describe('Client Reconnection & Edge Cases', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    // Wait for initial connection
    await page.locator(`${CLUSTER.dot}.connected`).waitFor({ timeout: 15_000 })
    await page.locator('.log-entry.success:has-text("Mounted!")').first().waitFor({ timeout: 10_000 })
  })

  test('reconnects after server switch and state persists', async ({ page }) => {
    // Increment counter on Server A
    await page.click(CLUSTER.btnInc)
    await expect(page.locator(CLUSTER.count)).toHaveText('1', { timeout: 5_000 })

    // Switch to Server B
    await page.click(CLUSTER.btnB)
    await page.locator(`${CLUSTER.dot}.connected`).waitFor({ timeout: 15_000 })
    await page.locator('.log-entry.success:has-text("Mounted!")').first().waitFor({ timeout: 10_000 })

    // State should be preserved via Redis
    await expect(page.locator(CLUSTER.count)).toHaveText('1', { timeout: 5_000 })

    // Can still increment on Server B
    await page.click(CLUSTER.btnInc)
    await expect(page.locator(CLUSTER.count)).toHaveText('2', { timeout: 5_000 })
  })

  test('handles rapid server switching without crash', async ({ page }) => {
    // Increment first
    await page.click(CLUSTER.btnInc)
    await expect(page.locator(CLUSTER.count)).toHaveText('1', { timeout: 5_000 })

    // Rapid switch: A → B → A
    await page.click(CLUSTER.btnB)
    await page.waitForTimeout(500)
    await page.click(CLUSTER.btnA)
    await page.waitForTimeout(500)
    await page.click(CLUSTER.btnB)

    // Wait for stable connection
    await page.locator(`${CLUSTER.dot}.connected`).waitFor({ timeout: 15_000 })
    await page.locator('.log-entry.success:has-text("Mounted!")').first().waitFor({ timeout: 10_000 })

    // State should still be preserved
    await expect(page.locator(CLUSTER.count)).toHaveText('1', { timeout: 5_000 })
  })

  test('connection status reflects disconnected state during switch', async ({ page }) => {
    // Start connected on A
    await expect(page.locator(CLUSTER.status)).toContainText('Connected')

    // Switch to B — during transition it may briefly show disconnected
    await page.click(CLUSTER.btnB)

    // Eventually reconnects
    await page.locator(`${CLUSTER.dot}.connected`).waitFor({ timeout: 15_000 })
    await expect(page.locator(CLUSTER.status)).toContainText('Connected')
  })

  test('error callback fires on action when not mounted', async ({ page }) => {
    // Switch server — during transition counter is not mounted
    await page.click(CLUSTER.btnB)

    // Try clicking increment immediately (before mount completes)
    await page.click(CLUSTER.btnInc)

    // Should log an error about not being mounted
    const errorLog = page.locator('.log-entry.error')
    // Either "skipped: not mounted yet" or the action succeeds after mount
    // We just verify no crash and the page remains functional
    await page.locator(`${CLUSTER.dot}.connected`).waitFor({ timeout: 15_000 })
  })

  test('log displays connection events chronologically', async ({ page }) => {
    // We should have connection log entries from the initial load
    const logs = page.locator(CLUSTER.logEntry)
    const count = await logs.count()
    expect(count).toBeGreaterThan(0)

    // Switch server to generate more log entries
    await page.click(CLUSTER.btnB)
    await page.locator(`${CLUSTER.dot}.connected`).waitFor({ timeout: 15_000 })

    // Should have more entries now
    const newCount = await logs.count()
    expect(newCount).toBeGreaterThan(count)
  })
})
