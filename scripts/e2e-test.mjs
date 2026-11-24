import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const scratchDir =
  process.env.E2E_OUT_DIR || path.join(os.tmpdir(), 'chaptermind-e2e-shots');

function findChromiumExecutable() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (!fs.existsSync(base)) {
    throw new Error(`ms-playwright folder not found at ${base}`);
  }
  const dirs = fs
    .readdirSync(base)
    .filter((d) => d.startsWith('chromium-'))
    .sort()
    .reverse();

  for (const d of dirs) {
    for (const sub of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']) {
      const candidate = path.join(base, d, sub);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  throw new Error(`No chromium executable found inside ${base}`);
}

async function launchWithExtension(headless) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chaptermind-e2e-'));
  const executablePath = findChromiumExecutable();

  const args = [
    `--disable-extensions-except=${distDir}`,
    `--load-extension=${distDir}`,
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (headless) {
    args.push('--headless=new');
  }

  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath,
    headless: false, // use --headless=new explicitly so MV3 extensions load
    args,
    viewport: { width: 1366, height: 860 },
  });

  return { context, userDataDir };
}

async function waitForServiceWorker(context, timeoutMs = 10000) {
  const existing = context.serviceWorkers();
  if (existing.length > 0) return existing[0];

  try {
    return await context.waitForEvent('serviceworker', { timeout: timeoutMs });
  } catch {
    return null;
  }
}

async function run() {
  assert.ok(fs.existsSync(path.join(distDir, 'manifest.json')), 'dist/manifest.json must exist');
  fs.mkdirSync(scratchDir, { recursive: true });

  let { context, userDataDir } = await launchWithExtension(true);
  let sw = await waitForServiceWorker(context, 8000);
  if (!sw) {
    console.log('Service worker not exposed in --headless=new; retrying in headed mode...');
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    ({ context, userDataDir } = await launchWithExtension(false));
    sw = await waitForServiceWorker(context, 12000);
  }

  assert.ok(sw, 'MV3 Service Worker must start');
  const extensionId = new URL(sw.url()).host;
  console.log('1) Extension loaded, service worker active:', extensionId);

  const ytErrors = [];
  const spErrors = [];

  try {
    const ytPage = await context.newPage();
    ytPage.on('pageerror', (err) => ytErrors.push(`pageerror: ${err.message}`));
    ytPage.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (!text.includes('ERR_BLOCKED_BY_CLIENT') && !text.includes('doubleclick')) {
          ytErrors.push(`console.error: ${text}`);
        }
      }
    });

    console.log('2) Navigating to https://www.youtube.com/watch?v=7n3cZzR0tVE ...');
    await ytPage.goto('https://www.youtube.com/watch?v=7n3cZzR0tVE', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Dismiss YouTube cookie consent if presented
    const rejectBtn = ytPage.getByRole('button', { name: /reject all/i }).first();
    if (await rejectBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
      console.log('   Dismissing YouTube cookie consent ("Reject all")...');
      await rejectBtn.click();
      await ytPage.waitForTimeout(1500);
    }

    // Check for bot/CAPTCHA wall (do not bypass)
    const bodyText = await ytPage.evaluate(() => document.body?.innerText?.slice(0, 1500) || '');
    if (
      /sign in to confirm you.?re not a bot/i.test(bodyText) ||
      /unusual traffic from your computer/i.test(bodyText)
    ) {
      throw new Error('BLOCKED: YouTube presented a bot verification / CAPTCHA check.');
    }

    // Wait for ChapterMind in-page HUD and timeline overlay
    try {
      await ytPage.waitForSelector('#chaptermind-inpage-host', { timeout: 25000 });
      await ytPage.waitForSelector('#chaptermind-timeline-overlay', { timeout: 20000 });
    } catch (waitErr) {
      await ytPage.screenshot({ path: path.join(scratchDir, 'e2e-fail-yt.png') }).catch(() => {});
      console.error('Debug on wait failure:', {
        url: ytPage.url(),
        ytErrors,
        hasBelow: await ytPage.evaluate(() => Boolean(document.querySelector('#below'))),
        hasProgressBar: await ytPage.evaluate(() => Boolean(document.querySelector('.ytp-progress-bar'))),
        bodyPreview: await ytPage.evaluate(() => document.body?.innerText?.slice(0, 400) || ''),
      });
      throw waitErr;
    }

    // Dismiss YouTube cookie consent lightbox if it appeared asynchronously after domcontentloaded
    const lateReject = ytPage.locator('ytd-consent-bump-v2-lightbox button', { hasText: /reject all/i }).first();
    if (await lateReject.isVisible({ timeout: 2500 }).catch(() => false)) {
      console.log('   Dismissing late YouTube cookie consent lightbox...');
      await lateReject.click();
      await ytPage.locator('ytd-consent-bump-v2-lightbox').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
      await ytPage.waitForTimeout(800);
    }

    // Open Side Panel page
    const spPage = await context.newPage();
    spPage.on('pageerror', (err) => spErrors.push(`pageerror: ${err.message}`));
    spPage.on('console', (msg) => {
      if (msg.type() === 'error') {
        spErrors.push(`console.error: ${msg.text()}`);
      }
    });
    await spPage.goto(`chrome-extension://${extensionId}/sidepanel.html`, {
      waitUntil: 'domcontentloaded',
    });
    await spPage.waitForTimeout(1000);

    // Poll live active state from YouTube tab until transcript extraction settles
    let liveState = null;
    for (let i = 0; i < 24; i++) {
      liveState = await spPage.evaluate(async () => {
        const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
        const ytTab = tabs[0];
        if (!ytTab?.id) return null;
        const res = await chrome.tabs.sendMessage(ytTab.id, { type: 'GET_ACTIVE_VIDEO_STATE' });
        return { tabId: ytTab.id, state: res?.state ?? null };
      });
      if (
        liveState?.state?.meta &&
        liveState.state.transcriptStatus !== 'loading' &&
        liveState.state.transcriptStatus !== 'idle'
      ) {
        break;
      }
      await ytPage.waitForTimeout(500);
    }

    assert.ok(liveState?.state?.meta, 'Live YouTube video metadata must be populated');
    const st = liveState.state;
    console.log('3) Live video state received:', {
      videoId: st.meta.videoId,
      title: st.meta.title,
      channelName: st.meta.channelName,
      durationSec: st.meta.durationSec,
      youtubeChapters: st.youtubeChapters.length,
      first5Chapters: st.youtubeChapters.slice(0, 5).map((c) => `${c.startTime}s:${c.title}`),
      sponsorSegments: st.sponsorSegments.map((s) => `${s.category}[${s.startTime.toFixed(1)}-${s.endTime.toFixed(1)}]`),
      transcriptStatus: st.transcriptStatus,
      transcriptCues: st.transcript.length,
      transcriptError: st.transcriptError,
    });

    assert.equal(st.meta.videoId, '7n3cZzR0tVE');
    assert.ok(st.sponsorSegments.length >= 1, 'Expected live SponsorBlock segments for 7n3cZzR0tVE');
    assert.equal(st.transcriptStatus, 'ready', 'Expected transcriptStatus to be ready');
    assert.ok(st.transcript.length >= 50, `Expected >= 50 transcript cues, got ${st.transcript.length}`);

    // Inspect in-page DOM elements
    const domCheck = await ytPage.evaluate(() => {
      const host = document.getElementById('chaptermind-inpage-host');
      const overlay = document.getElementById('chaptermind-timeline-overlay');
      const shadowText = host?.shadowRoot?.textContent || '';
      const pillCount = host?.shadowRoot?.querySelectorAll('.cm-pill').length ?? 0;
      const barCount = overlay?.children.length ?? 0;
      return {
        hasHost: Boolean(host),
        hasShadow: Boolean(host?.shadowRoot),
        pillCount,
        barCount,
        shadowPreview: shadowText.slice(0, 200),
      };
    });
    console.log('4) In-page DOM check:', domCheck);
    assert.ok(domCheck.hasHost && domCheck.hasShadow, 'Shadow DOM HUD must mount');
    assert.ok(domCheck.barCount >= 1, 'Timeline overlay must contain SponsorBlock/chapter bars');

    // Test SponsorBlock auto-skip + Undo using ChapterMind's SEEK_TO / movie_player.seekTo
    const skipSeg = st.sponsorSegments.find((s) => s.category === 'sponsor' && s.actionType === 'skip');
    assert.ok(skipSeg, 'Expected a sponsor skip segment');

    await ytPage.bringToFront();
    await spPage.evaluate(
      async ({ tabId, targetSec }) => {
        await chrome.tabs.sendMessage(tabId, { type: 'SEEK_TO', seconds: targetSec });
      },
      { tabId: liveState.tabId, targetSec: skipSeg.startTime + 2 }
    );

    await ytPage.waitForTimeout(600);
    await ytPage.evaluate(() => {
      const video = document.querySelector('video');
      if (video) video.dispatchEvent(new Event('timeupdate'));
    });

    await ytPage.waitForSelector('#chaptermind-skip-toast button', { timeout: 5000 });
    const afterSkip = await ytPage.evaluate(() => {
      const video = document.querySelector('video');
      const toast = document.getElementById('chaptermind-skip-toast');
      return {
        currentTime: video ? video.currentTime : -1,
        toastText: toast?.textContent || '',
      };
    });
    console.log('5) After SponsorBlock auto-skip:', afterSkip);
    assert.ok(
      afterSkip.currentTime >= skipSeg.endTime - 1.5,
      `Expected video time >= ${skipSeg.endTime - 1.5}, got ${afterSkip.currentTime}`
    );
    assert.ok(afterSkip.toastText.includes('Skipped'), 'Expected Skip Toast to appear');

    // Click Undo inside toast
    await ytPage.click('#chaptermind-skip-toast button');
    await ytPage.waitForTimeout(400);
    const afterUndoTime = await ytPage.evaluate(() => document.querySelector('video')?.currentTime ?? -1);
    console.log('6) After clicking Undo:', { afterUndoTime, expectedStart: skipSeg.startTime });
    assert.ok(
      Math.abs(afterUndoTime - skipSeg.startTime) < 3,
      `Expected Undo to restore near ${skipSeg.startTime}, got ${afterUndoTime}`
    );

    // Test clicking a chapter pill in shadow DOM (if native chapters exist)
    if (domCheck.pillCount >= 2) {
      const pillTarget = await ytPage.evaluate(() => {
        const host = document.getElementById('chaptermind-inpage-host');
        const pills = host?.shadowRoot?.querySelectorAll('.cm-pill');
        const second = pills?.[1];
        if (!second) return null;
        const txt = second.textContent || '';
        second.click();
        return txt;
      });
      await ytPage.waitForTimeout(400);
      const afterPillTime = await ytPage.evaluate(() => document.querySelector('video')?.currentTime ?? -1);
      console.log('7) Clicked chapter pill:', { pillTarget, afterPillTime });
      assert.ok(afterPillTime > 0, 'Clicking chapter pill should seek video');
    }

    // Save YouTube screenshot
    await ytPage.screenshot({ path: path.join(scratchDir, 'e2e-youtube.png') });

    // Side Panel tests: all 4 tabs, settings save, manual AI subscription import -> APPLY_ANALYSIS -> KB search
    const tabsCheck = await spPage.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('.tab'));
      return tabs.map((t) => t.textContent?.trim());
    });
    console.log('8) Side Panel tabs:', tabsCheck);
    assert.equal(tabsCheck.length, 4);

    // Test Settings persistence
    await spPage.click('.tab[data-tab="settings"]');
    await spPage.locator('details.accordion summary', { hasText: 'AI Subscription Bridge' }).click();
    await spPage.selectOption('#set-sub-provider', 'claude');
    await spPage.click('#save-settings-btn');
    await spPage.waitForTimeout(400);
    await spPage.reload({ waitUntil: 'domcontentloaded' });
    await spPage.waitForTimeout(500);
    const savedSubProvider = await spPage.$eval('#set-sub-provider', (el) => el.value);
    assert.equal(savedSubProvider, 'claude', 'Saved settings must persist across reload');

    // Test PARSE_MANUAL_ANALYSIS + APPLY_ANALYSIS + KB search
    const mockAiJson = JSON.stringify({
      tldr: 'Weekly AI roundup covering Gemini 5 leaks, GLM 5.4, OpenAI updates, and Nano Banana Pro 2.',
      chapters: [
        {
          title: 'Gemini 5 Leaks',
          startSec: 10,
          endSec: 250,
          summary: 'Rumor breakdown and benchmarks',
          relevance: 'must_watch',
          topicTags: ['frontier LLMs'],
        },
        {
          title: 'GLM 5.4 Release',
          startSec: 350,
          endSec: 600,
          summary: 'Open weights & coding specs',
          relevance: 'must_watch',
          topicTags: ['coding agents'],
        },
        {
          title: 'Nano Banana Pro 2',
          startSec: 600,
          endSec: 900,
          summary: 'Image generation demo',
          relevance: 'skip',
          relevanceReason: 'Image generation model',
          topicTags: ['image models'],
        },
        {
          title: 'OpenAI Frontier Safety',
          startSec: 900,
          endSec: 1200,
          summary: 'Safety thresholds update',
          relevance: 'normal',
        },
      ],
      detectedSponsors: [
        { startSec: 910, endSec: 960, category: 'sponsor', reason: 'AI-detected newsletter promo' },
      ],
      keyTakeaways: [
        { text: 'GLM 5.4 achieves top open-weight coding scores', timestampSec: 365 },
        { text: 'Nano Banana Pro 2 improves text rendering', timestampSec: 620 },
      ],
      entities: [
        { name: 'GLM 5.4', type: 'model', note: 'Open-weight release', timestampSec: 350 },
        { name: 'Nano Banana Pro 2', type: 'model', note: 'Image model', timestampSec: 600 },
      ],
      tags: ['ai-news', 'models'],
    });

    const importRes = await spPage.evaluate(
      async ({ meta, transcript, sponsorSegments, rawText }) => {
        return await chrome.runtime.sendMessage({
          type: 'PARSE_MANUAL_ANALYSIS',
          rawText,
          meta,
          transcript,
          sponsorSegments,
          providerLabel: 'subscription:gemini',
        });
      },
      {
        meta: st.meta,
        transcript: st.transcript,
        sponsorSegments: st.sponsorSegments,
        rawText: '```json\n' + mockAiJson + '\n```',
      }
    );
    assert.ok(importRes?.ok && importRes?.entry, 'PARSE_MANUAL_ANALYSIS must succeed');
    console.log('9) Imported AI analysis to KB:', {
      chapters: importRes.entry.chapters.length,
      aiSponsors: importRes.entry.aiSponsors.length,
      entities: importRes.entry.entities.length,
    });

    await ytPage.waitForTimeout(600);
    const updatedYouTubeHud = await ytPage.evaluate(() => {
      const host = document.getElementById('chaptermind-inpage-host');
      const pills = Array.from(host?.shadowRoot?.querySelectorAll('.cm-pill') || []).map(
        (p) => p.textContent
      );
      const bars = document.getElementById('chaptermind-timeline-overlay')?.children.length ?? 0;
      return { pills, bars };
    });
    console.log('10) YouTube HUD after APPLY_ANALYSIS:', updatedYouTubeHud);
    assert.ok(
      updatedYouTubeHud.pills.some((t) => t?.includes('GLM 5.4 Release')),
      'AI chapters must appear live on YouTube in-page strip'
    );

    // Switch to KB tab, verify search + readable entity chips
    await spPage.click('.tab[data-tab="kb"]');
    await spPage.waitForTimeout(400);
    await spPage.fill('#kb-search-input', 'Nano Banana');
    await spPage.waitForTimeout(300);
    const kbText = await spPage.textContent('#kb-list');
    assert.ok(kbText?.includes('Nano Banana') || kbText?.includes(st.meta.title), 'KB search must render saved video');

    // Expand the KB entry and verify entity chip contrast is light (not dark-on-dark)
    await spPage.locator('#kb-list .item-card').first().click();
    await spPage.waitForTimeout(250);
    const chipColor = await spPage.locator('.entity-chip').first().evaluate((el) => getComputedStyle(el).color);
    console.log('10a) KB entity chip computed color:', chipColor);
    assert.notEqual(chipColor, 'rgb(0, 0, 0)', 'Entity chip text must not be black on dark card');

    // Switch back to Now Watching tab & click a chapter card directly inside the Side Panel
    await spPage.click('.tab[data-tab="watching"]');
    await spPage.waitForTimeout(400);
    const spChapterCards = spPage.locator('#chapters-list .item-card');
    const spCardCount = await spChapterCards.count();
    assert.ok(spCardCount >= 3, `Expected >= 3 chapter cards in Side Panel, got ${spCardCount}`);
    const thirdCardClass = await spChapterCards.nth(2).getAttribute('class');
    assert.ok(thirdCardClass?.includes('is-skip'), `Expected Nano Banana Pro 2 card to have is-skip class, got ${thirdCardClass}`);

    // Open the Auto-Skip Filter drawer and add a custom ignore topic
    await spPage.click('#interest-drawer summary');
    await spPage.waitForTimeout(200);
    await spPage.fill('#quick-ignore-input', 'useless small models');
    await spPage.click('#quick-ignore-add-btn');
    await spPage.waitForTimeout(300);
    const chipsText = await spPage.textContent('#quick-ignore-chips');
    assert.ok(chipsText?.includes('useless small models'), 'Quick ignore chips must include new custom topic');

    // Click the 2nd AI chapter ("GLM 5.4 Release" at 350s)
    await spChapterCards.nth(1).click();
    await ytPage.waitForTimeout(600);
    const timeAfterSpClick = await ytPage.evaluate(
      () => document.querySelector('video')?.currentTime ?? -1
    );
    console.log('10b) After clicking chapter card in Side Panel:', { timeAfterSpClick });
    assert.ok(
      Math.abs(timeAfterSpClick - 350) < 5,
      `Expected clicking 2nd Side Panel chapter to seek near 350s, got ${timeAfterSpClick}`
    );

    // Test Chapter Auto-Skip when seeking into "Nano Banana Pro 2" (600-900s) -> jumps to 900s!
    await ytPage.bringToFront();
    await spPage.evaluate(
      async ({ tabId }) => {
        await chrome.tabs.sendMessage(tabId, { type: 'SEEK_TO', seconds: 605 });
      },
      { tabId: liveState.tabId }
    );
    await ytPage.waitForTimeout(600);
    await ytPage.evaluate(() => {
      const video = document.querySelector('video');
      if (video) video.dispatchEvent(new Event('timeupdate'));
    });
    await ytPage.waitForSelector('#chaptermind-skip-toast', { timeout: 5000 });
    const afterChapterSkip = await ytPage.evaluate(() => ({
      currentTime: document.querySelector('video')?.currentTime ?? -1,
      toastText: document.getElementById('chaptermind-skip-toast')?.textContent || '',
    }));
    console.log('10c) After Don’t Care Chapter Auto-Skip:', afterChapterSkip);
    assert.ok(
      afterChapterSkip.currentTime >= 898,
      `Expected chapter auto-skip past Nano Banana Pro 2 (>=898s), got ${afterChapterSkip.currentTime}`
    );
    assert.ok(
      afterChapterSkip.toastText.includes('Watch Anyway'),
      'Expected Watch Anyway button in chapter skip toast'
    );

    await spPage.screenshot({ path: path.join(scratchDir, 'e2e-sidepanel.png') });

    console.log('11) Console/page errors:', { ytErrors, spErrors });
    console.log('E2E_SUCCESS');
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error('E2E_FAILED:', err);
  process.exit(1);
});
