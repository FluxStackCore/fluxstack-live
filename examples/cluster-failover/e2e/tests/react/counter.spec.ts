import { test, expect } from '@playwright/test'

test.describe('CounterDemo', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/counter')
    // Wait for WebSocket connection — any "Conectado" badge
    await page.locator('text=Conectado').first().waitFor({ timeout: 15_000 })
  })

  test('renders three counter cards', async ({ page }) => {
    await expect(page.locator('h2:has-text("Contador Local")')).toBeVisible()
    await expect(page.locator('h2:has-text("Contador Isolado")')).toBeVisible()
    await expect(page.locator('h2:has-text("Contador Compartilhado")')).toBeVisible()
  })

  test('local counter increments', async ({ page }) => {
    const localCard = page.locator('div:has(> h2:has-text("Contador Local"))')
    const incButton = localCard.locator('button:has-text("+")')
    const countDisplay = localCard.locator('.text-6xl, .sm\\:text-8xl').first()

    await expect(countDisplay).toHaveText('0')
    await incButton.click()
    await expect(countDisplay).toHaveText('1')
  })

  test('shared counter syncs across tabs', async ({ page, browser }) => {
    const sharedCard = page.locator('div:has(> h2:has-text("Contador Compartilhado"))')
    const incButton = sharedCard.locator('button:has-text("+")')

    // Open second tab
    const context2 = await browser.newContext()
    const page2 = await context2.newPage()
    await page2.goto('/counter')
    await page2.locator('text=Conectado').first().waitFor({ timeout: 15_000 })

    const sharedCard2 = page2.locator('div:has(> h2:has-text("Contador Compartilhado"))')
    const countDisplay2 = sharedCard2.locator('.text-6xl, .sm\\:text-8xl').first()

    // Increment on page1
    await incButton.click()

    // page2 should see the update
    await expect(countDisplay2).toHaveText('1', { timeout: 5_000 })

    await context2.close()
  })

  test('shows connected badge', async ({ page }) => {
    const badge = page.locator('text=Conectado').first()
    await expect(badge).toBeVisible()
  })
})
