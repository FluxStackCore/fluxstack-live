import { test, expect } from '@playwright/test'

test.describe('RoomChatDemo', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/room-chat')
    // Wait for the Room Chat heading and username to render (connection indicator is a green dot, no "Conectado" text)
    await page.locator('h2:has-text("Room Chat")').waitFor({ timeout: 15_000 })
    // Wait for the username to appear next to the green dot (means component is connected)
    await page.locator('.bg-emerald-400').first().waitFor({ timeout: 15_000 })
  })

  test('shows room list', async ({ page }) => {
    await expect(page.locator('text=Geral')).toBeVisible()
    await expect(page.locator('text=Tecnologia')).toBeVisible()
    await expect(page.locator('text=Random')).toBeVisible()
    await expect(page.locator('text=VIP')).toBeVisible()
  })

  test('joining a room shows chat area', async ({ page }) => {
    // Click on Geral room
    await page.locator('text=Geral').first().click()

    // Chat area should appear — look for the message input
    await expect(page.locator('input[placeholder="Digite uma mensagem..."]')).toBeVisible({ timeout: 5_000 })
  })

  test('sends message in a room', async ({ page }) => {
    // Join Geral
    await page.locator('text=Geral').first().click()
    await page.locator('input[placeholder="Digite uma mensagem..."]').waitFor({ timeout: 5_000 })

    // Send message
    await page.fill('input[placeholder="Digite uma mensagem..."]', 'Room test message')
    await page.click('button:has-text("Enviar")')

    // Message should appear
    await expect(page.locator('text=Room test message')).toBeVisible({ timeout: 5_000 })
  })
})
