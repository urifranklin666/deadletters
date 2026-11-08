'use strict';

const crypto = require('node:crypto');
const { test, expect } = require('@playwright/test');
const { AxeBuilder } = require('@axe-core/playwright');
const { canonicalJson } = require('../src/core/provenance');

async function expectNoSeriousAccessibilityViolations(page, label) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  const serious = results.violations.filter(violation => (
    violation.impact === 'serious' || violation.impact === 'critical'
  ));
  expect(serious, `${label}: ${JSON.stringify(serious, null, 2)}`).toEqual([]);
}

test.describe.configure({ mode: 'serial' });

test('fresh install through publishing, moderation, federation, and authenticated export', async ({ page, request }) => {
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

  await test.step('deliver, promote, display, and hide a signed remote envelope', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
    const keyId = `ed25519-${crypto.createHash('sha256').update(Buffer.from(publicKeyDer, 'base64url')).digest('hex').slice(0, 16)}`;
    const createdAt = new Date().toISOString();
    const sourceTitle = 'Remote Transmission from E2E';
    const curatorCommentary = 'A remote curator note delivered through the signed exchange test.';
    const envelope = {
      type: 'deadletters-reletter',
      spec: 'deadletters-reletter-v1',
      source: {
        url: 'https://remote.example/letters/e2e-remote',
        node: '@remote/e2e',
        author: 'Remote E2E Author',
        title: sourceTitle,
        excerpt: 'A signed remote excerpt that should never become a local post.'
      },
      curator: { id: 7001, commentary: curatorCommentary },
      created_at: createdAt,
      signing_node: { handle: '@remote/e2e', key_id: keyId },
      parent_envelope_hash: null,
      provenance_chain: [
        { action: 'original_drop', author: 'Remote E2E Author', node: '@remote/e2e', timestamp: createdAt },
        { action: 're_lettered', curator_id: 7001, node: '@remote/e2e', commentary: curatorCommentary, timestamp: createdAt }
      ]
    };
    const canonicalBytes = canonicalJson(envelope);
    const envelopeHash = crypto.createHash('sha256').update(canonicalBytes, 'utf8').digest('base64url');
    const signature = crypto.sign(null, Buffer.from(canonicalBytes, 'utf8'), privateKey).toString('base64url');

    await page.evaluate(async ({ publicKeyDer, keyId }) => API.post('/api/v1/federation/peers', {
      endpoint_url: 'https://remote.example',
      node_handle: '@remote/e2e',
      public_key: publicKeyDer,
      key_id: keyId,
      enabled: true
    }), { publicKeyDer, keyId });

    const delivery = await request.post('/api/v1/federation/inbox', {
      data: {
        spec: 'deadletters-federation-delivery-v1',
        delivery_id: 'dlv_e2e_remote_exchange_1',
        sent_at: createdAt,
        envelope,
        envelope_hash: envelopeHash,
        signature,
        signature_algorithm: 'Ed25519',
        key_id: keyId
      }
    });
    expect(delivery.status()).toBe(202);

    await page.goto('/#/admin/federation');
    const inboxRow = page.locator('tr', { hasText: sourceTitle });
    await expect(inboxRow).toContainText('ACCEPTED');
    await inboxRow.getByRole('button', { name: 'PUBLISH REMOTE' }).click();
    await expect(page.locator('#dl-confirm-ok')).toBeVisible();
    await page.locator('#dl-confirm-ok').click();
    await expect(page.getByText('Remote envelope published to the labeled exchange.')).toBeVisible();

    await page.goto('/');
    await expect(page.getByRole('link', { name: 'REMOTE EXCHANGE' }).first()).toBeVisible();
    await page.goto('/remote');
    await expect(page.getByRole('heading', { name: 'REMOTE EXCHANGE' })).toBeVisible();
    await expect(page.getByText(sourceTitle).first()).toBeVisible();
    await expect(page.getByText('Remote E2E Author').first()).toBeVisible();
    await expect(page.getByText(curatorCommentary).first()).toBeVisible();
    await expect(page.getByText('NOT A LOCAL POST')).toBeVisible();
    await expect(page.getByText(/SIGNED PEER \/\/ CURRENTLY TRUSTED/)).toBeVisible();
    await expect(page).toHaveTitle(/Deadletters/i);
    await expectNoSeriousAccessibilityViolations(page, 'remote exchange');

    await page.goto('/#/admin/federation');
    const promotedRow = page.locator('tr', { hasText: sourceTitle });
    await promotedRow.getByRole('button', { name: 'HIDE FROM PUBLIC' }).click();
    await page.locator('#dl-confirm-ok').click();
    await expect(page.getByText(/audit retained/)).toBeVisible();
    await page.goto('/remote');
    await expect(page.getByText(sourceTitle)).toHaveCount(0);
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

  await test.step('scan public and administrative surfaces for serious accessibility violations', async () => {
    await page.goto('/');
    await expectNoSeriousAccessibilityViolations(page, 'public home');
    await page.setViewportSize({ width: 390, height: 844 });
    const overflowDetails = await page.evaluate(() => ({
      amount: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      offenders: Array.from(document.querySelectorAll('body *'))
        .map(element => ({
          tag: element.tagName,
          id: element.id,
          className: typeof element.className === 'string' ? element.className : '',
          right: Math.round(element.getBoundingClientRect().right),
          width: Math.round(element.getBoundingClientRect().width)
        }))
        .filter(item => item.right > document.documentElement.clientWidth + 1)
        .slice(0, 20)
    }));
    expect(overflowDetails.amount, JSON.stringify(overflowDetails.offenders)).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 1280, height: 800 });

    await page.goto('/admin');
    await expectNoSeriousAccessibilityViolations(page, 'admin dashboard');
    await page.goto('/#/admin/comments');
    await expectNoSeriousAccessibilityViolations(page, 'comment moderation');
    await page.goto('/#/admin/federation');
    await expectNoSeriousAccessibilityViolations(page, 'federation controls');
    await page.goto('/#/admin/settings');
    await expectNoSeriousAccessibilityViolations(page, 'settings');
    await page.goto('/#/admin/editor');
    await expectNoSeriousAccessibilityViolations(page, 'editor');
    await page.goto('/#/admin/reshares');
    await expectNoSeriousAccessibilityViolations(page, 're-letter hub');
    await page.goto('/#/admin/media');
    await expectNoSeriousAccessibilityViolations(page, 'media vault');
    await page.goto('/#/admin/themes');
    await expectNoSeriousAccessibilityViolations(page, 'theme studio');
    await page.goto('/#/admin/addons');
    await expectNoSeriousAccessibilityViolations(page, 'addons');
    await page.goto('/#/admin/users');
    await expectNoSeriousAccessibilityViolations(page, 'users');
  });

  await test.step('enforce operator landing and denied admin routes in the browser', async () => {
    const created = await page.evaluate(async () => API.post('/api/v1/auth/users', {
      login: 'e2eoperator',
      email: 'operator@example.com',
      password: 'operator-password-123',
      displayName: 'E2E Operator',
      role: 'operator'
    }));
    expect(created.message).toContain('commissioned');

    await page.evaluate(() => API.setToken(null));
    await page.goto('/admin');
    await page.locator('#login-handle').fill('e2eoperator');
    await page.locator('#login-password').fill('operator-password-123');
    await page.locator('#admin-login-form button[type="submit"]').click();
    await expect(page.getByRole('heading', { name: 'RESHARE & PROVENANCE HUB' })).toBeVisible();
    await expect(page.locator('a[href="#/admin/federation"]')).toHaveCount(0);
    await expect(page.locator('a[href="#/admin/editor"]')).toHaveCount(0);

    await page.goto('/#/admin/federation');
    await expect(page.getByText('ACCESS DENIED')).toBeVisible();
  });

  await test.step('report no runtime page or CSP errors', async () => {
    expect(pageErrors).toEqual([]);
    expect(cspViolations).toEqual([]);
  });
});
