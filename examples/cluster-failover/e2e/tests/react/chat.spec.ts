import { test, expect } from '@playwright/test'

test.describe('ChatDemo', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/chat')
    // Wait for the heading and connection status
    await page.locator('h2:has-text("Chat Compartilhado")').waitFor({ timeout: 15_000 })
    await page.locator('text=Conectado').first().waitFor({ timeout: 15_000 })
  })

  test('renders chat UI with input and send button', async ({ page }) => {
    await expect(page.locator('input[placeholder="Digite uma mensagem..."]')).toBeVisible()
    await expect(page.locator('button:has-text("Enviar")')).toBeVisible()
  })

  test('sends and displays a message', async ({ page }) => {
    // Use a unique message to avoid collisions with previous test runs
    const uniqueMsg = `PW-send-${Date.now()}`
    const messageInput = page.locator('input[placeholder="Digite uma mensagem..."]')
    await messageInput.fill(uniqueMsg)
    await page.click('button:has-text("Enviar")')

    await expect(page.locator(`text=${uniqueMsg}`).first()).toBeVisible({ timeout: 5_000 })
  })

  test('multi-tab sync', async ({ page, browser }) => {
    // Open second tab
    const context2 = await browser.newContext()
    const page2 = await context2.newPage()
    await page2.goto('/chat')
    await page2.locator('h2:has-text("Chat Compartilhado")').waitFor({ timeout: 15_000 })
    await page2.locator('text=Conectado').first().waitFor({ timeout: 15_000 })

    // Send unique message from page1
    const uniqueMsg = `PW-sync-${Date.now()}`
    const messageInput = page.locator('input[placeholder="Digite uma mensagem..."]')
    await messageInput.fill(uniqueMsg)
    await page.click('button:has-text("Enviar")')

    // page2 should see the message
    await expect(page2.locator(`text=${uniqueMsg}`).first()).toBeVisible({ timeout: 5_000 })

    await context2.close()
  })
})
