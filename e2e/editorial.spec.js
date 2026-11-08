'use strict';

const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

test('fresh install through publishing, moderation, federation, and authenticated export', async ({ page }) => {
  const pageErrors = [];
  const cspViolations = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && /content security policy/i.test(message.text())) {
      cspViolations.push(message.text());
    }
  });

  await test.step('install a fresh node through the browser wizard', async () => {
    await page.goto('/installer');
    await expect(page.getByText('PROVISION DEADLETTERS')).toBeVisible();
    await page.locator('#btn-step-next').click();

    await page.locator('#input-title').fill('E2E Deadletters');
    await page.locator('#input-tagline').fill('A browser-tested editorial node.');
    await page.locator('#input-handle').fill('@e2e/node');
    await page.locator('#btn-step-next').click();

    await page.locator('#input-login').fill('e2eadmin');
    await page.locator('#input-email').fill('e2e@example.com');
    await page.locator('#input-password').fill('e2e-password-123');
    await page.locator('#btn-step-next').click();

    await expect(page.locator('#select-theme')).toHaveValue('deadplug-editorial');
    await page.locator('#btn-execute-install').click();
    await expect(page.getByText('COMMAND & TELEMETRY HUD')).toBeVisible();
    await expect(page.getByText('Operators & Access')).toBeVisible();
  });

  await test.step('serve seeded editorials at home and canonical direct URLs', async () => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'E2E Deadletters' })).toBeVisible();
    await expect(page.getByRole('link', { name: /THE PLUG IS DEAD/ }).first()).toBeVisible();

    await page.goto('/letter/the-plug-is-dead-manifesto');
    await expect(page).toHaveTitle(/THE PLUG IS DEAD/);
    await expect(page.locator('h1')).toContainText('THE PLUG IS DEAD');
    await expect(page.locator('.dl-post-body')).toContainText('algorithmic feed');
    await expect(page.locator('.dl-post-body script')).toHaveCount(0);
    const canonical = page.locator('link[rel="canonical"]');
    await expect(canonical).toHaveAttribute('href', /\/letter\/the-plug-is-dead-manifesto$/);
  });

  await test.step('display a signed public re-letter with local envelope verification', async () => {
    await page.goto('/reshares');
    const reshareLink = page.getByRole('link', { name: /^Reshare:/ }).first();
    await expect(reshareLink).toBeVisible();
    await reshareLink.click();
    await expect(page.getByText('QUOTED ORIGINAL TRANSMISSION')).toBeVisible();
    await expect(page.getByText('PROVENANCE SUMMARY')).toBeVisible();
    await expect(page.getByText('NODE ENVELOPE VERIFIED')).toBeVisible();
    await expect(page.getByText(/does not prove factual authorship/i)).toBeVisible();
  });

  await test.step('moderate a public comment end to end', async () => {
    await page.goto('/letter/the-plug-is-dead-manifesto');
    const adminToken = await page.evaluate(() => API.token);
    await page.evaluate(() => API.setToken(null));
    await page.locator('#comment-author').fill('E2E Reader');
    await page.locator('#comment-email').fill('reader@example.com');
    await page.locator('#comment-content').fill('A thoughtful browser-tested comment.');
    await page.locator('#btn-submit-comment').click();
    await expect(page.locator('#comment-feedback')).toContainText('queued for editorial clearance');

    await page.evaluate(token => API.setToken(token), adminToken);
    await page.goto('/admin');
    await page.locator('a[href="#/admin/comments"]').click();
    await expect(page.getByRole('heading', { name: 'COMMENT MODERATION' })).toBeVisible();
    const commentRow = page.locator('tr', { hasText: 'A thoughtful browser-tested comment.' });
    await expect(commentRow).toContainText('E2E Reader');
    await commentRow.getByRole('button', { name: 'APPROVE' }).click();
    await expect(commentRow.getByText('APPROVED')).toBeVisible();

    await page.goto('/letter/the-plug-is-dead-manifesto');
    await expect(page.getByText('A thoughtful browser-tested comment.')).toBeVisible();
  });

  await test.step('publish a sanitized letter using the editor and secure preview', async () => {
    await page.goto('/admin');
    await page.locator('a[href="#/admin/editor"]').click();
    await page.locator('#post-title').fill('E2E Published Letter');
    await page.locator('#post-slug').fill('e2e-published-letter');
    await page.locator('#post-content').fill([
      '## Browser-safe editorial',
      '',
      '**Published through Chromium.**',
      '',
      '[callout type="alert"]A tested callout.[/callout]',
      '',
      '<script>window.__unsafe = true</script>'
    ].join('\n'));

    await page.getByRole('button', { name: 'LIVE PREVIEW' }).click();
    await expect(page.locator('#post-preview')).toContainText('Browser-safe editorial');
    await expect(page.locator('#post-preview .dl-callout-alert')).toBeVisible();
    await expect(page.locator('#post-preview script')).toHaveCount(0);
    await page.getByRole('button', { name: 'MARKDOWN / CODE' }).click();

    await page.locator('#btn-publish').click();
    await page.waitForURL(/#\/admin\/editor\/\d+/);

    const response = await page.goto('/letter/e2e-published-letter');
    expect(response.status()).toBe(200);
    await expect(page.locator('h1')).toHaveText('E2E Published Letter');
    await expect(page.locator('.dl-post-body strong')).toHaveText('Published through Chromium.');
    await expect(page.locator('.dl-post-body .dl-callout-alert')).toBeVisible();
    await expect(page.locator('.dl-post-body script')).toHaveCount(0);
    expect(await page.evaluate(() => window.__unsafe)).toBeUndefined();
  });

  await test.step('expose the federation control surface without false peer claims', async () => {
    await page.goto('/admin');
    await page.locator('a[href="#/admin/federation"]').click();
    await expect(page.getByRole('heading', { name: 'FEDERATION & PEERS' })).toBeVisible();
    await expect(page.locator('#federation-peer-form')).toBeVisible();
    await expect(page.getByText(/out-of-band/i).first()).toBeVisible();
    await expect(page.locator('#btn-register-peer')).toBeVisible();
  });

  await test.step('download a protected engine export with bearer authentication', async () => {
    await page.goto('/#/admin/settings');
    await expect(page.getByRole('heading', { name: 'SITE SETTINGS & ENGINE PACKAGER' })).toBeVisible();
    const dialogs = [];
    page.on('dialog', async dialog => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    });
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#btn-export-engine-zip').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^deadletters-engine-v.*\.zip$/);
    expect(dialogs).toEqual([]);
    await expect(page.getByText(/Engine distribution downloaded \(\d+ KB\)\./)).toBeVisible();
  });

  await test.step('report no runtime page or CSP errors', async () => {
    expect(pageErrors).toEqual([]);
    expect(cspViolations).toEqual([]);
  });
});
