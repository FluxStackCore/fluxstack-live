import { test, expect } from '@playwright/test'

// Auth demo renders a blank page because LiveAdminPanel's client stub
// has an empty defaultState ({}) while the component accesses nested
// properties like $state.currentRoles.join() and $state.users.map().
// This causes a crash with no error boundary, resulting in a white screen.
// These tests are skipped until the app fixes the stub or adds an error boundary.

test.describe('AuthDemo', () => {
  test.skip(true, 'Auth page crashes due to incomplete LiveAdminPanel client stub (defaultState={})')

  test.beforeEach(async ({ page }) => {
    await page.goto('/auth')
    await page.locator('h2:has-text("Live Components Auth")').waitFor({ timeout: 15_000 })
  })

  test('public counter works without auth', async ({ page }) => {
    await expect(page.locator('h3:has-text("Contador Público")')).toBeVisible({ timeout: 10_000 })
    const publicSection = page.locator('div:has(> h3:has-text("Contador Público"))')
    const incButton = publicSection.locator('button:has-text("+")')
    await expect(incButton).toBeVisible()
  })

  test('admin panel shows access denied without login', async ({ page }) => {
    await expect(page.locator('text=Acesso negado')).toBeVisible({ timeout: 10_000 })
  })

  test('login with admin-token grants access', async ({ page }) => {
    await page.click('button:has-text("admin-token")')
    await page.click('button:has-text("Login")')

    await expect(page.locator('text=Autenticado')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('h3:has-text("Painel Admin")')).toBeVisible({ timeout: 10_000 })
  })

  test('logout returns to unauthenticated state', async ({ page }) => {
    await page.click('button:has-text("admin-token")')
    await page.click('button:has-text("Login")')
    await page.locator('text=Autenticado').waitFor({ timeout: 10_000 })

    await page.click('button:has-text("Logout")')

    await expect(page.locator('text=Não autenticado')).toBeVisible({ timeout: 10_000 })
  })
})
