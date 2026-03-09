import { test, expect } from '@playwright/test'

test.describe('FormDemo', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/form')
    // Wait for the "Live Form" heading and connected badge
    await page.locator('h2:has-text("Live Form")').waitFor({ timeout: 15_000 })
    await page.locator('text=Conectado').first().waitFor({ timeout: 15_000 })
  })

  test('renders form with name, email, message fields', async ({ page }) => {
    await expect(page.locator('input[placeholder="Seu nome"]')).toBeVisible()
    await expect(page.locator('input[placeholder="seu@email.com"]')).toBeVisible()
    await expect(page.locator('textarea[placeholder="Sua mensagem..."]')).toBeVisible()
  })

  test('submits form and shows success', async ({ page }) => {
    // Fill name and blur to trigger sync
    const nameInput = page.locator('input[placeholder="Seu nome"]')
    await nameInput.fill('Test User')
    await nameInput.blur()

    // Fill email (syncs on change with debounce)
    const emailInput = page.locator('input[placeholder="seu@email.com"]')
    await emailInput.fill('test@example.com')

    // Fill message and blur to trigger sync
    const messageInput = page.locator('textarea[placeholder="Sua mensagem..."]')
    await messageInput.fill('Hello world')
    await messageInput.blur()

    // Wait for sync debounce to complete
    await page.waitForTimeout(1_000)

    await page.click('button:has-text("Enviar")')

    // Should show success
    await expect(page.locator('text=Enviado!')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('text=Obrigado')).toBeVisible()
  })

  test('reset returns to input mode', async ({ page }) => {
    // Submit first
    const nameInput = page.locator('input[placeholder="Seu nome"]')
    await nameInput.fill('Test User')
    await nameInput.blur()

    const emailInput = page.locator('input[placeholder="seu@email.com"]')
    await emailInput.fill('test@example.com')

    const messageInput = page.locator('textarea[placeholder="Sua mensagem..."]')
    await messageInput.fill('Hello')
    await messageInput.blur()

    await page.waitForTimeout(1_000)
    await page.click('button:has-text("Enviar")')
    await page.locator('text=Enviado!').waitFor({ timeout: 10_000 })

    // Reset
    await page.click('button:has-text("Novo Formulário")')

    // Form fields should be visible again
    await expect(page.locator('input[placeholder="Seu nome"]')).toBeVisible({ timeout: 5_000 })
  })
})
