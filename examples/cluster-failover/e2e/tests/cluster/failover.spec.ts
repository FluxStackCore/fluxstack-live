import { test, expect } from '../../fixtures/cluster'
import { CLUSTER as S } from '../../helpers/selectors'
import { createRedisClient, getSingletonState } from '../../helpers/redis'

test.describe('SharedCounter - Failover', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector(S.dotConnected, { timeout: 10_000 })
    await page.locator(S.logSuccess).filter({ hasText: 'Mounted!' }).waitFor({ timeout: 10_000 })
  })

  test('rapid switching does not corrupt state', async ({ page }) => {
    // Increment to 2 on A
    await page.click(S.btnInc)
    await expect(page.locator(S.count)).toHaveText('1')
    await page.click(S.btnInc)
    await expect(page.locator(S.count)).toHaveText('2')

    // Switch A -> B
    await page.click(S.btnB)
    await page.waitForSelector(S.dotConnected, { timeout: 10_000 })
    await page.locator(S.logSuccess).filter({ hasText: 'Mounted!' }).nth(1).waitFor({ timeout: 10_000 })
    await page.click(S.btnInc)
    await expect(page.locator(S.count)).toHaveText('3')

    // Switch B -> A
    await page.click(S.btnA)
    await page.waitForSelector(S.dotConnected, { timeout: 10_000 })
    await page.locator(S.logSuccess).filter({ hasText: 'Mounted!' }).nth(2).waitFor({ timeout: 10_000 })
    await page.click(S.btnInc)
    await expect(page.locator(S.count)).toHaveText('4')

    // Switch A -> B again
    await page.click(S.btnB)
    await page.waitForSelector(S.dotConnected, { timeout: 10_000 })
    await page.locator(S.logSuccess).filter({ hasText: 'Mounted!' }).nth(3).waitFor({ timeout: 10_000 })

    await expect(page.locator(S.count)).toHaveText('4')
  })

  test('Redis contains correct singleton state', async ({ page }) => {
    await page.click(S.btnInc)
    await expect(page.locator(S.count)).toHaveText('1')
    await page.click(S.btnInc)
    await expect(page.locator(S.count)).toHaveText('2')

    // Give Redis time to persist
    await page.waitForTimeout(500)

    // Verify Redis state directly
    const redis = createRedisClient()
    const state = await getSingletonState(redis, 'SharedCounter')
    redis.disconnect()

    expect(state).not.toBeNull()
    expect(state.count).toBe(2)
  })
})
