import { test, expect } from '@playwright/test'

test.describe('TodoListDemo', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/todo')
    // Wait for "Todo List Colaborativo" heading and connected indicator
    await page.locator('h2:has-text("Todo List Colaborativo")').waitFor({ timeout: 15_000 })
    await page.locator('text=Conectado').first().waitFor({ timeout: 15_000 })
  })

  test('adds a todo item', async ({ page }) => {
    const input = page.locator('input[placeholder="Nova tarefa..."]')
    await input.fill('Buy groceries')
    await page.click('button:has-text("+")')

    await expect(page.locator('text=Buy groceries')).toBeVisible({ timeout: 5_000 })
  })

  test('toggles todo completion', async ({ page }) => {
    // Add a todo
    const input = page.locator('input[placeholder="Nova tarefa..."]')
    await input.fill('Test toggle')
    await page.click('button:has-text("+")')
    await page.locator('span:has-text("Test toggle")').waitFor({ timeout: 5_000 })

    // Click the checkbox button (w-5 h-5 rounded-md) inside the todo item row
    const todoRow = page.locator('div.flex.items-center.gap-3', { hasText: 'Test toggle' })
    const checkbox = todoRow.locator('button.rounded-md').first()
    await checkbox.click()

    // Should show line-through styling on the span
    await expect(page.locator('span.line-through').filter({ hasText: 'Test toggle' })).toBeVisible({ timeout: 5_000 })
  })

  test('removes a todo', async ({ page }) => {
    const input = page.locator('input[placeholder="Nova tarefa..."]')
    await input.fill('To be removed')
    await page.click('button:has-text("+")')
    await page.locator('span:has-text("To be removed")').waitFor({ timeout: 5_000 })

    // Click the delete (X svg) button — last button in the todo item row
    const todoRow = page.locator('div.flex.items-center.gap-3', { hasText: 'To be removed' })
    const deleteBtn = todoRow.locator('button').last()
    await deleteBtn.click()

    await expect(page.locator('text=To be removed')).not.toBeVisible({ timeout: 5_000 })
  })

  test('collaborative sync across tabs', async ({ page, browser }) => {
    const context2 = await browser.newContext()
    const page2 = await context2.newPage()
    await page2.goto('/todo')
    await page2.locator('h2:has-text("Todo List Colaborativo")').waitFor({ timeout: 15_000 })
    await page2.locator('text=Conectado').first().waitFor({ timeout: 15_000 })

    // Add on page1
    const input = page.locator('input[placeholder="Nova tarefa..."]')
    await input.fill('Shared todo item')
    await page.click('button:has-text("+")')

    // page2 should see it
    await expect(page2.locator('text=Shared todo item')).toBeVisible({ timeout: 5_000 })

    await context2.close()
  })
})
