import {
  DEFAULT_SETTINGS,
  type BridgeTask,
  type Chapter,
  type ExtensionSettings,
  type KnowledgeEntry,
  type RuntimeMessage,
  type SponsorSegment,
  type SubscriptionProvider,
  type TranscriptCue,
  type VideoMetadata,
} from '../shared/types';
import {
  fetchSponsorBlockSegments,
  stripSponsorSegmentsFromTranscript,
} from '../shared/sponsorblock';
import { formatTranscriptForPrompt, parseJson3Transcript, parseXmlTranscript } from '../shared/transcript';
import { extractYouTubeVideoId } from '../shared/youtube-url';
import type { ActivityLogEntry, LogLevel, LogScope, QueueJob } from '../shared/types';
import { appendActivityLog } from '../shared/logs';
import {
  buildKbQuestionPrompt,
  buildVideoAnalysisPrompt,
  parseAiAnalysisResponse,
} from '../shared/prompts';
import { callAiProvider } from '../shared/ai-client';
import {
  deleteEntry,
  getActiveEntries,
  getAllEntries,
  getEntry,
  getExpiredTrashIds,
  getTrashedEntries,
  putEntry,
  searchKnowledgeBase,
} from '../shared/kb-storage';
import {
  fetchKnowledgeBaseFromGithub,
  pushKnowledgeBaseToGithub,
  testGithubConnection,
} from '../shared/github-sync';

const SETTINGS_STORAGE_KEY = 'chaptermind_settings';
const BRIDGE_TASK_KEY = 'chaptermind_bridge_task';
const ACTIVITY_LOGS_KEY = 'chaptermind_activity_logs_v1';

const sponsorCache = new Map<string, { fetchedAt: number; segments: SponsorSegment[] }>();
let memoryBridgeTasks: Partial<Record<SubscriptionProvider, BridgeTask>> = {};
let logStorageChain: Promise<void> = Promise.resolve();

async function loadActivityLogs(): Promise<ActivityLogEntry[]> {
  try {
    const res = await chrome.storage.local.get(ACTIVITY_LOGS_KEY);
    return Array.isArray(res[ACTIVITY_LOGS_KEY]) ? (res[ACTIVITY_LOGS_KEY] as ActivityLogEntry[]) : [];
  } catch {
    return [];
  }
}

function addActivityLog(
  scope: LogScope,
  level: LogLevel,
  message: string,
  videoId?: string
): void {
  const run = logStorageChain.then(async () => {
    const existing = await loadActivityLogs();
    const next = appendActivityLog(existing, { scope, level, message, videoId }, 120);
    await chrome.storage.local.set({ [ACTIVITY_LOGS_KEY]: next });
    chrome.runtime.sendMessage({ type: 'LOGS_UPDATED', logs: next }).catch(() => {});
  });
  logStorageChain = run.then(
    () => undefined,
    () => undefined
  );
}

function clearActivityLogs(): Promise<void> {
  const run = logStorageChain.then(async () => {
    await chrome.storage.local.set({ [ACTIVITY_LOGS_KEY]: [] });
    chrome.runtime.sendMessage({ type: 'LOGS_UPDATED', logs: [] }).catch(() => {});
  });
  logStorageChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

async function loadSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  const partial = (stored[SETTINGS_STORAGE_KEY] as Partial<ExtensionSettings> | undefined) ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...partial,
    topicsIgnore: Array.isArray(partial.topicsIgnore)
      ? partial.topicsIgnore
      : [...DEFAULT_SETTINGS.topicsIgnore],
    topicsCare: Array.isArray(partial.topicsCare)
      ? partial.topicsCare
      : [...DEFAULT_SETTINGS.topicsCare],
    topicsAllow: Array.isArray(partial.topicsAllow)
      ? partial.topicsAllow
      : [...DEFAULT_SETTINGS.topicsAllow],
    kbCategories:
      Array.isArray(partial.kbCategories) && partial.kbCategories.length > 0
        ? partial.kbCategories
        : [...DEFAULT_SETTINGS.kbCategories],
    trashRetentionDays:
      typeof partial.trashRetentionDays === 'number' && partial.trashRetentionDays > 0
        ? partial.trashRetentionDays
        : DEFAULT_SETTINGS.trashRetentionDays,
    categoryRules: {
      ...DEFAULT_SETTINGS.categoryRules,
      ...(partial.categoryRules ?? {}),
    },
  };
}

async function saveSettings(partial: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const current = await loadSettings();
  const next: ExtensionSettings = {
    ...current,
    ...partial,
    categoryRules: {
      ...current.categoryRules,
      ...(partial.categoryRules ?? {}),
    },
  };
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: next });

  // Notify any open YouTube tabs and Side Panel
  chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED', settings: next }).catch(() => {});
  const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
  for (const tab of tabs) {
    if (tab.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_UPDATED', settings: next }).catch(() => {});
    }
  }
  return next;
}

async function readAllBridgeTasks(): Promise<Partial<Record<SubscriptionProvider, BridgeTask>>> {
  try {
    const res = await chrome.storage.session.get(BRIDGE_TASK_KEY);
    const raw = res[BRIDGE_TASK_KEY];
    if (raw && typeof raw === 'object' && !('id' in raw)) {
      return raw as Partial<Record<SubscriptionProvider, BridgeTask>>;
    }
    if (raw && typeof raw === 'object' && 'id' in raw) {
      const legacy = raw as BridgeTask;
      return { [legacy.provider]: legacy };
    }
  } catch {
    // storage.session fallback to memoryBridgeTasks
  }
  return { ...memoryBridgeTasks };
}

async function setBridgeTask(task: BridgeTask | null, provider?: SubscriptionProvider) {
  const next = await readAllBridgeTasks();
  if (task) {
    next[task.provider] = task;
  } else if (provider) {
    delete next[provider];
  } else {
    for (const k of Object.keys(next) as SubscriptionProvider[]) {
      delete next[k];
    }
  }
  memoryBridgeTasks = next;
  try {
    if (Object.keys(next).length > 0) {
      await chrome.storage.session.set({ [BRIDGE_TASK_KEY]: next });
    } else {
      await chrome.storage.session.remove(BRIDGE_TASK_KEY);
    }
  } catch {
    // storage.session fallback to memoryBridgeTasks
  }
}

async function getBridgeTask(
  provider?: SubscriptionProvider,
  taskId?: string
): Promise<BridgeTask | null> {
  const all = await readAllBridgeTasks();
  const tasks = Object.values(all).filter((t): t is BridgeTask => Boolean(t));
  if (taskId) {
    return tasks.find((t) => t.id === taskId) ?? null;
  }
  if (provider) {
    return all[provider] ?? null;
  }
  tasks.sort((a, b) => b.createdAt - a.createdAt);
  return tasks[0] ?? null;
}

function buildKnowledgeEntryFromAnalysis(
  meta: VideoMetadata,
  cleanedTranscript: TranscriptCue[],
  sponsorBlockCount: number,
  sponsorTimeStrippedSec: number,
  rawText: string,
  aiProviderUsed: string
): KnowledgeEntry {
  const parsed = parseAiAnalysisResponse(rawText, meta.durationSec);
  const now = Date.now();

  const chapters: Chapter[] = parsed.chapters.map((c, idx) => ({
    id: `ai-${meta.videoId}-${idx}-${c.startSec}`,
    title: c.title,
    startTime: c.startSec,
    endTime: c.endSec,
    source: 'ai' as const,
    summary: c.summary,
    relevance: c.relevance,
    relevanceReason: c.relevanceReason,
    topicTags: c.topicTags,
  }));

  const aiSponsors: SponsorSegment[] = parsed.detectedSponsors.map((s, idx) => ({
    uuid: `ai-sp-${meta.videoId}-${idx}-${s.startSec}`,
    category: s.category,
    actionType: 'skip',
    startTime: s.startSec,
    endTime: s.endSec,
    description: s.reason,
    source: 'ai' as const,
  }));

  return {
    videoId: meta.videoId,
    url: meta.url,
    title: meta.title,
    channelName: meta.channelName,
    channelUrl: meta.channelUrl,
    durationSec: meta.durationSec,
    savedAt: now,
    updatedAt: now,
    aiProviderUsed,
    tldr: parsed.tldr,
    chapters,
    aiSponsors,
    sponsorBlockCount,
    sponsorTimeStrippedSec,
    keyTakeaways: parsed.keyTakeaways,
    entities: parsed.entities,
    tags: parsed.tags,
    cleanedTranscript,
  };
}

function getSubscriptionUrl(provider: SubscriptionProvider): { url: string; matchPattern: string } {
  if (provider === 'chatgpt') {
    return { url: 'https://chatgpt.com/', matchPattern: 'https://chatgpt.com/*' };
  }
  if (provider === 'claude') {
    return { url: 'https://claude.ai/new', matchPattern: 'https://claude.ai/*' };
  }
  return { url: 'https://gemini.google.com/app', matchPattern: 'https://gemini.google.com/*' };
}

async function openOrFocusSubscriptionTab(provider: SubscriptionProvider): Promise<void> {
  const target = getSubscriptionUrl(provider);
  const existing = await chrome.tabs.query({ url: target.matchPattern });
  if (existing[0]?.id) {
    await chrome.tabs.update(existing[0].id, { active: true });
    if (existing[0].windowId) {
      await chrome.windows.update(existing[0].windowId, { focused: true });
    }
    return;
  }
  await chrome.tabs.create({ url: target.url, active: true });
}

async function pushAnalysisToYouTubeTabs(entry: KnowledgeEntry, preferredTabId?: number) {
  if (preferredTabId) {
    chrome.tabs.sendMessage(preferredTabId, { type: 'APPLY_ANALYSIS', entry }).catch(() => {});
  }
  const ytTabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
  for (const t of ytTabs) {
    if (t.id && t.id !== preferredTabId) {
      chrome.tabs.sendMessage(t.id, { type: 'APPLY_ANALYSIS', entry }).catch(() => {});
    }
  }
}

let githubPushChain: Promise<void> = Promise.resolve();
let autoPushQueued = false;

function enqueueGithubTask<T>(fn: () => Promise<T>): Promise<T> {
  const next = githubPushChain.then(fn, fn);
  githubPushChain = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

async function maybeAutoPushGithub(settings: ExtensionSettings): Promise<void> {
  if (!settings.githubAutoPush || !settings.githubRepo.trim() || !settings.githubToken.trim()) {
    return;
  }
  if (autoPushQueued) return;
  autoPushQueued = true;
  try {
    await enqueueGithubTask(async () => {
      autoPushQueued = false;
      const latestSettings = await loadSettings();
      if (
        !latestSettings.githubAutoPush ||
        !latestSettings.githubRepo.trim() ||
        !latestSettings.githubToken.trim()
      ) {
        return;
      }
      const allEntries = await getAllEntries();
      addActivityLog('github', 'info', `Auto-pushing KB (${allEntries.filter((e) => !e.trashedAt).length} active)...`);
      const res = await pushKnowledgeBaseToGithub(latestSettings, allEntries);
      addActivityLog(
        'github',
        'success',
        `Auto-push done: ${res.pushedFiles} pushed, ${res.skippedFiles} unchanged`
      );
    });
  } finally {
    autoPushQueued = false;
  }
}

async function purgeExpiredTrash(retentionDays = 30): Promise<void> {
  const entries = await getAllEntries();
  const expiredIds = getExpiredTrashIds(entries, retentionDays);
  for (const id of expiredIds) {
    await deleteEntry(id);
  }
}

async function handleMessage(
  msg: RuntimeMessage,
  sender: chrome.runtime.MessageSender
): Promise<unknown> {
  switch (msg.type) {
    case 'SETTINGS_GET': {
      const settings = await loadSettings();
      return { settings };
    }

    case 'SETTINGS_SAVE': {
      const settings = await saveSettings(msg.settings);
      return { settings };
    }

    case 'FETCH_SPONSORBLOCK': {
      const settings = await loadSettings();
      if (!settings.sponsorBlockEnabled) {
        return { segments: [] };
      }
      const cached = sponsorCache.get(msg.videoId);
      if (!msg.forceRefresh && cached && Date.now() - cached.fetchedAt < 10 * 60 * 1000) {
        return { segments: cached.segments };
      }
      const segments = await fetchSponsorBlockSegments(msg.videoId, settings.usePrivacyPrefix);
      sponsorCache.set(msg.videoId, { fetchedAt: Date.now(), segments });
      return { segments };
    }

    case 'KB_GET': {
      const entry = await getEntry(msg.videoId);
      return { entry };
    }

    case 'KB_LIST': {
      const settings = await loadSettings();
      await purgeExpiredTrash(settings.trashRetentionDays);
      const entries = await getAllEntries();
      return { entries };
    }

    case 'KB_SAVE': {
      await putEntry(msg.entry);
      return { ok: true };
    }

    case 'KB_DELETE': {
      await deleteEntry(msg.videoId);
      await broadcastQueueUpdated();
      return { ok: true };
    }

    case 'KB_SET_CATEGORY': {
      const entry = await getEntry(msg.videoId);
      if (!entry) return { ok: false, error: 'Library entry not found.' };
      const category = msg.category.trim();
      const updated: KnowledgeEntry = {
        ...entry,
        category: category || undefined,
        updatedAt: Date.now(),
      };
      await putEntry(updated);
      return { ok: true, entry: updated };
    }

    case 'KB_TRASH': {
      const entry = await getEntry(msg.videoId);
      if (!entry) return { ok: false, error: 'Library entry not found.' };
      const updated: KnowledgeEntry = {
        ...entry,
        trashedAt: Date.now(),
        updatedAt: Date.now(),
      };
      await putEntry(updated);
      await broadcastQueueUpdated();
      return { ok: true, entry: updated };
    }

    case 'KB_RESTORE': {
      const entry = await getEntry(msg.videoId);
      if (!entry) return { ok: false, error: 'Library entry not found.' };
      const updated: KnowledgeEntry = { ...entry, updatedAt: Date.now() };
      delete updated.trashedAt;
      await putEntry(updated);
      await broadcastQueueUpdated();
      return { ok: true, entry: updated };
    }

    case 'KB_EMPTY_TRASH': {
      const trashed = getTrashedEntries(await getAllEntries());
      for (const item of trashed) {
        await deleteEntry(item.videoId);
      }
      await broadcastQueueUpdated();
      return { ok: true, deletedCount: trashed.length };
    }

    case 'LOGS_GET': {
      const logs = await loadActivityLogs();
      return { logs };
    }

    case 'LOGS_CLEAR': {
      await clearActivityLogs();
      return { ok: true, logs: [] };
    }

    case 'KB_IMPORT_BULK': {
      for (const entry of msg.entries) {
        if (entry?.videoId) {
          await putEntry(entry);
        }
      }
      return { ok: true, count: msg.entries.length };
    }

    case 'ANALYZE_VIDEO_API': {
      const startedAt = Date.now();
      const settings = await loadSettings();
      const stripped = settings.stripSponsorsFromAi
        ? stripSponsorSegmentsFromTranscript(msg.transcript, msg.sponsorSegments)
        : { cleanedCues: msg.transcript, removedCueCount: 0, removedDurationSec: 0 };

      const formatted = formatTranscriptForPrompt(stripped.cleanedCues);
      if (!formatted.text) {
        addActivityLog('ai', 'error', 'Transcript empty — aborted analyze', msg.meta.videoId);
        throw new Error('Transcript is empty — cannot analyze video.');
      }

      const sbCount = msg.sponsorSegments.filter((s) => s.category !== 'chapter').length;
      const prompt = buildVideoAnalysisPrompt(msg.meta, formatted.text, msg.youtubeChapters, sbCount, {
        topicsCare: settings.topicsCare,
        topicsIgnore: settings.topicsIgnore,
      });
      const providerLabel = `${settings.apiProvider}:${settings.apiModel || 'default'}`;
      addActivityLog(
        'ai',
        'info',
        `Analyze via ${providerLabel} (${stripped.cleanedCues.length} cues, ${prompt.length} chars)`,
        msg.meta.videoId
      );
      try {
        const rawReply = await callAiProvider(settings, prompt, settings.apiProvider === 'gemini');

        const entry = buildKnowledgeEntryFromAnalysis(
          msg.meta,
          stripped.cleanedCues,
          sbCount,
          stripped.removedDurationSec,
          rawReply,
          providerLabel
        );
        if (!settings.aiFallbackSponsorDetection) {
          entry.aiSponsors = [];
        }

        await putEntry(entry);
        await pushAnalysisToYouTubeTabs(entry);
        chrome.runtime.sendMessage({ type: 'ANALYSIS_COMPLETED', entry }).catch(() => {});
        const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
        addActivityLog(
          'ai',
          'success',
          `Saved ${entry.chapters.length} ch, ${entry.entities.length} ent in ${elapsedSec}s`,
          msg.meta.videoId
        );
        void maybeAutoPushGithub(settings).catch((err) => {
          addActivityLog('github', 'warn', err instanceof Error ? err.message : String(err));
        });
        return { ok: true, entry };
      } catch (err) {
        addActivityLog('ai', 'error', err instanceof Error ? err.message : String(err), msg.meta.videoId);
        throw err;
      }
    }

    case 'PARSE_MANUAL_ANALYSIS': {
      const settings = await loadSettings();
      const stripped = settings.stripSponsorsFromAi
        ? stripSponsorSegmentsFromTranscript(msg.transcript, msg.sponsorSegments)
        : { cleanedCues: msg.transcript, removedCueCount: 0, removedDurationSec: 0 };
      const sbCount = msg.sponsorSegments.filter((s) => s.category !== 'chapter').length;

      const entry = buildKnowledgeEntryFromAnalysis(
        msg.meta,
        stripped.cleanedCues,
        sbCount,
        stripped.removedDurationSec,
        msg.rawText,
        msg.providerLabel || 'subscription-manual'
      );
      await putEntry(entry);
      await pushAnalysisToYouTubeTabs(entry);
      chrome.runtime.sendMessage({ type: 'ANALYSIS_COMPLETED', entry }).catch(() => {});
      void maybeAutoPushGithub(settings).catch(() => {});
      return { ok: true, entry };
    }

    case 'START_SUBSCRIPTION_BRIDGE': {
      const settings = await loadSettings();
      let prompt = '';
      let task: BridgeTask;

      if (msg.kind === 'analyze_video') {
        if (!msg.meta || !msg.transcript) {
          throw new Error('Missing video metadata or transcript for analysis.');
        }
        const segments = msg.sponsorSegments ?? [];
        const stripped = settings.stripSponsorsFromAi
          ? stripSponsorSegmentsFromTranscript(msg.transcript, segments)
          : { cleanedCues: msg.transcript, removedCueCount: 0, removedDurationSec: 0 };
        const formatted = formatTranscriptForPrompt(stripped.cleanedCues);
        if (!formatted.text) {
          throw new Error('Transcript is empty — cannot build prompt.');
        }
        const sbCount = segments.filter((s) => s.category !== 'chapter').length;
        prompt = buildVideoAnalysisPrompt(
          msg.meta,
          formatted.text,
          msg.youtubeChapters ?? [],
          sbCount,
          {
            topicsCare: settings.topicsCare,
            topicsIgnore: settings.topicsIgnore,
          }
        );
        task = {
          id: `bridge-${Date.now()}`,
          kind: 'analyze_video',
          provider: msg.provider,
          prompt,
          createdAt: Date.now(),
          videoId: msg.meta.videoId,
          tabId: msg.tabId,
          meta: msg.meta,
          cleanedTranscript: stripped.cleanedCues,
          sponsorBlockCount: sbCount,
          sponsorTimeStrippedSec: stripped.removedDurationSec,
        };
      } else {
        const question = (msg.question ?? '').trim();
        if (!question) throw new Error('Enter a question first.');
        const allEntries = getActiveEntries(await getAllEntries());
        if (allEntries.length === 0) {
          throw new Error('Your Knowledge Base is empty. Analyze at least one video first.');
        }
        const matched = searchKnowledgeBase(allEntries, question).slice(0, 6);
        const targetEntries =
          matched.length > 0 ? matched.map((m) => m.entry) : allEntries.slice(0, 5);
        prompt = buildKbQuestionPrompt(question, targetEntries);
        task = {
          id: `bridge-${Date.now()}`,
          kind: 'ask_kb',
          provider: msg.provider,
          prompt,
          createdAt: Date.now(),
          question,
          matchedVideoIds: targetEntries.map((e) => e.videoId),
        };
      }

      await setBridgeTask(task);
      await openOrFocusSubscriptionTab(msg.provider);
      return { ok: true, prompt, taskId: task.id };
    }

    case 'GET_BRIDGE_TASK': {
      const [task, settings] = await Promise.all([
        getBridgeTask(msg.provider),
        loadSettings(),
      ]);
      return { task, bridgePillEnabled: settings.bridgePillEnabled };
    }

    case 'CLEAR_BRIDGE_TASK': {
      await setBridgeTask(null, msg.provider);
      return { ok: true };
    }

    case 'IMPORT_BRIDGE_RESPONSE': {
      const task = await getBridgeTask(undefined, msg.taskId);
      if (!task || task.id !== msg.taskId) {
        return { ok: false, error: 'Bridge task expired or not found.' };
      }

      if (task.kind === 'analyze_video' && task.meta) {
        const settings = await loadSettings();
        const entry = buildKnowledgeEntryFromAnalysis(
          task.meta,
          task.cleanedTranscript ?? [],
          task.sponsorBlockCount ?? 0,
          task.sponsorTimeStrippedSec ?? 0,
          msg.rawText,
          `subscription:${task.provider}`
        );
        await putEntry(entry);
        await pushAnalysisToYouTubeTabs(entry, task.tabId);
        await setBridgeTask(null, task.provider);
        chrome.runtime.sendMessage({ type: 'BRIDGE_ANALYSIS_READY', entry }).catch(() => {});
        void maybeAutoPushGithub(settings).catch(() => {});
        if (settings.autoReturnAfterBridgeCapture && task.tabId) {
          chrome.tabs.update(task.tabId, { active: true }).catch(() => {});
        }
        return { ok: true, entry };
      }

      if (task.kind === 'ask_kb') {
        const allEntries = getActiveEntries(await getAllEntries());
        const usedEntries = task.matchedVideoIds?.length
          ? allEntries.filter((e) => task.matchedVideoIds?.includes(e.videoId))
          : allEntries.slice(0, 5);
        await setBridgeTask(null, task.provider);
        chrome.runtime
          .sendMessage({
            type: 'BRIDGE_KB_ANSWER_READY',
            question: task.question ?? '',
            answer: msg.rawText,
            entries: usedEntries,
          })
          .catch(() => {});
        return { ok: true };
      }

      return { ok: false, error: 'Unsupported bridge task.' };
    }

    case 'ASK_KB_API': {
      const settings = await loadSettings();
      const allEntries = getActiveEntries(await getAllEntries());
      if (allEntries.length === 0) {
        throw new Error('Your Knowledge Base is empty. Save at least one video first.');
      }
      const ranked = searchKnowledgeBase(allEntries, msg.question).slice(0, 6);
      const entries = ranked.length > 0 ? ranked.map((r) => r.entry) : allEntries.slice(0, 5);
      const prompt = buildKbQuestionPrompt(msg.question, entries);
      const answer = await callAiProvider(settings, prompt, false);
      return { ok: true, answer, entries };
    }

    case 'TEST_API_CONNECTION': {
      const settings = msg.settings ?? (await loadSettings());
      const reply = await callAiProvider(settings, 'Reply with exactly: OK', false);
      return { ok: true, reply: reply.trim().slice(0, 80) };
    }

    case 'GITHUB_TEST_CONNECTION': {
      const settings = msg.settings ?? (await loadSettings());
      const info = await testGithubConnection(settings);
      return { ok: true, info };
    }

    case 'GITHUB_PUSH_ALL': {
      const result = await enqueueGithubTask(async () => {
        const settings = await loadSettings();
        const entries = await getAllEntries();
        addActivityLog('github', 'info', 'Manual Push All started...');
        try {
          const res = await pushKnowledgeBaseToGithub(settings, entries);
          addActivityLog(
            'github',
            'success',
            `Manual Push done: ${res.pushedFiles} pushed, ${res.skippedFiles} skipped`
          );
          return res;
        } catch (err) {
          addActivityLog('github', 'error', err instanceof Error ? err.message : String(err));
          throw err;
        }
      });
      return { ok: true, ...result };
    }

    case 'GITHUB_FETCH_ALL': {
      const settings = await loadSettings();
      const localEntries = await getAllEntries();
      addActivityLog('github', 'info', 'Fetching KB updates from GitHub...');
      try {
        const result = await fetchKnowledgeBaseFromGithub(settings, localEntries);
        for (const entry of result.entriesToSave) {
          await putEntry(entry);
        }
        if (result.remoteInterests) {
          const mergedIgnore = Array.from(
            new Set([...settings.topicsIgnore, ...(result.remoteInterests.topicsIgnore ?? [])])
          );
          const mergedCare = Array.from(
            new Set([...settings.topicsCare, ...(result.remoteInterests.topicsCare ?? [])])
          );
          await saveSettings({ topicsIgnore: mergedIgnore, topicsCare: mergedCare });
        }
        addActivityLog(
          'github',
          'success',
          `Fetched ${result.fetchedCount} new/updated (${result.totalRemote} remote)`
        );
        return {
          ok: true,
          fetchedCount: result.fetchedCount,
          totalRemote: result.totalRemote,
        };
      } catch (err) {
        addActivityLog('github', 'error', err instanceof Error ? err.message : String(err));
        throw err;
      }
    }

    case 'OPEN_SIDEPANEL': {
      if (sender.tab?.windowId && chrome.sidePanel?.open) {
        await chrome.sidePanel.open({ windowId: sender.tab.windowId });
      }
      return { ok: true };
    }

    case 'KB_IDS_GET': {
      const entries = getActiveEntries(await getAllEntries());
      return { ids: entries.map((e) => e.videoId) };
    }

    case 'QUEUE_LIST': {
      const jobs = await recoverStaleQueueJobs();
      if (jobs.some((j) => j.status === 'queued')) {
        void processHeadlessQueue();
      }
      return { jobs };
    }

    case 'QUEUE_ADD': {
      const job = await enqueueHeadlessJob(msg.urlOrId, msg.title, msg.channelName);
      const jobs = await loadQueueJobs();
      return { ok: Boolean(job), job, jobs };
    }

    case 'QUEUE_ADD_BATCH': {
      const added = await enqueueHeadlessBatch(msg.items);
      const jobs = await loadQueueJobs();
      return { ok: added.length > 0, addedCount: added.length, jobs };
    }

    case 'QUEUE_ADD_OPEN_TABS': {
      const ytTabs = await chrome.tabs.query({
        url: ['https://www.youtube.com/watch*', 'https://www.youtube.com/shorts/*'],
      });
      const existingEntries = msg.onlyUnsaved !== false ? getActiveEntries(await getAllEntries()) : [];
      const savedIds = new Set(existingEntries.map((e) => e.videoId));
      const seenVid = new Set<string>();
      const batchItems: Array<{ urlOrId: string; title?: string; channelName?: string }> = [];
      let skippedSavedCount = 0;

      for (const tab of ytTabs) {
        if (!tab.url || tab.url.includes('cm_headless=1')) continue;
        const vid = extractYouTubeVideoId(tab.url);
        if (!vid || seenVid.has(vid)) continue;
        seenVid.add(vid);
        if (savedIds.has(vid)) {
          skippedSavedCount += 1;
          continue;
        }
        batchItems.push({
          urlOrId: vid,
          title: tab.title?.replace(/\s*-\s*YouTube$/, '').trim() || undefined,
        });
      }

      const added = await enqueueHeadlessBatch(batchItems);
      const jobs = await loadQueueJobs();
      return {
        ok: true,
        queuedCount: added.length,
        skippedSavedCount,
        jobs,
      };
    }

    case 'QUEUE_REMOVE': {
      const pending = pendingHeadlessCaptures.get(msg.videoId);
      if (pending) {
        pendingHeadlessCaptures.delete(msg.videoId);
        clearTimeout(pending.timer);
        chrome.tabs.remove(pending.tabId).catch(() => {});
        pending.reject(new Error('Cancelled by user.'));
      }
      inFlightQueueVideoIds.delete(msg.videoId);
      syncQueueKeepalive();
      addActivityLog('queue', 'warn', 'Cancelled / removed from queue', msg.videoId);
      const { next: jobs } = await mutateQueueJobs((curr) => ({
        next: curr.filter((j) => j.videoId !== msg.videoId),
        changed: true,
      }));
      void processHeadlessQueue();
      return { ok: true, jobs };
    }

    case 'QUEUE_CLEAR_DONE': {
      const { next: jobs } = await mutateQueueJobs((curr) => ({
        next: curr.filter(
          (j) =>
            j.status === 'queued' ||
            j.status === 'fetching_transcript' ||
            j.status === 'analyzing'
        ),
        changed: true,
      }));
      return { ok: true, jobs };
    }

    case 'HEADLESS_TRANSCRIPT_CAPTURED': {
      resolvePendingHeadlessCapture(msg.videoId, {
        meta: msg.meta,
        transcript: msg.transcript,
        youtubeChapters: msg.youtubeChapters,
        error: msg.error,
      });
      return { ok: true };
    }

    default:
      return { ok: false };
  }
}

const CONTEXT_MENU_QUEUE_ID = 'chaptermind-queue-video';
const QUEUE_JOBS_KEY = 'chaptermind_queue_jobs_v1';

interface HeadlessCaptureResult {
  meta: VideoMetadata | null;
  transcript: TranscriptCue[];
  youtubeChapters: Chapter[];
  error?: string;
}

const pendingHeadlessCaptures = new Map<
  string,
  {
    tabId: number;
    resolve: (result: HeadlessCaptureResult) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

const MAX_CONCURRENT_QUEUE_JOBS = 2;
const inFlightQueueVideoIds = new Set<string>();
let queueStorageChain: Promise<void> = Promise.resolve();
let queueKeepaliveTimer: ReturnType<typeof setInterval> | null = null;

function syncQueueKeepalive() {
  if (inFlightQueueVideoIds.size > 0) {
    if (queueKeepaliveTimer === null) {
      queueKeepaliveTimer = setInterval(() => {
        chrome.runtime?.getPlatformInfo?.(() => {
          void chrome.runtime.lastError;
        });
      }, 20_000);
    }
  } else if (queueKeepaliveTimer !== null) {
    clearInterval(queueKeepaliveTimer);
    queueKeepaliveTimer = null;
  }
}

async function loadQueueJobs(): Promise<QueueJob[]> {
  try {
    const res = await chrome.storage.local.get(QUEUE_JOBS_KEY);
    const jobs = res[QUEUE_JOBS_KEY];
    return Array.isArray(jobs) ? (jobs as QueueJob[]) : [];
  } catch {
    return [];
  }
}

async function saveQueueJobs(jobs: QueueJob[]): Promise<void> {
  await chrome.storage.local.set({ [QUEUE_JOBS_KEY]: jobs });
}

function mutateQueueJobs<T = undefined>(
  mutator: (jobs: QueueJob[]) => { next: QueueJob[]; changed?: boolean; result?: T }
): Promise<{ next: QueueJob[]; result: T | undefined }> {
  const run = queueStorageChain.then(async () => {
    const current = await loadQueueJobs();
    const { next, changed = true, result } = mutator(current);
    if (changed) {
      await saveQueueJobs(next);
      await broadcastQueueUpdated(next);
    }
    return { next, result };
  });
  queueStorageChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function broadcastQueueUpdated(jobs?: QueueJob[]): Promise<void> {
  const nextJobs = jobs ?? (await loadQueueJobs());
  const kbVideoIds = getActiveEntries(await getAllEntries()).map((e) => e.videoId);
  chrome.runtime
    .sendMessage({ type: 'QUEUE_UPDATED', jobs: nextJobs, kbVideoIds })
    .catch(() => {});
  const ytTabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' }).catch(() => []);
  for (const t of ytTabs) {
    if (t.id) {
      chrome.tabs
        .sendMessage(t.id, { type: 'QUEUE_UPDATED', jobs: nextJobs, kbVideoIds })
        .catch(() => {});
    }
  }
}

function extractBalancedJsonAfter(text: string, marker: string): unknown | null {
  const idx = text.indexOf(marker);
  if (idx === -1) return null;
  const start = text.indexOf('{', idx + marker.length);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

async function fetchWatchPageDataHeadless(videoId: string): Promise<HeadlessCaptureResult> {
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en`);
    if (!res.ok) {
      return { meta: null, transcript: [], youtubeChapters: [] };
    }
    const html = await res.text();
    const playerResp = extractBalancedJsonAfter(html, 'ytInitialPlayerResponse =') as {
      videoDetails?: {
        videoId?: string;
        title?: string;
        author?: string;
        channelId?: string;
        lengthSeconds?: string;
        shortDescription?: string;
      };
      captions?: {
        playerCaptionsTracklistRenderer?: {
          captionTracks?: Array<{
            baseUrl?: string;
            languageCode?: string;
            kind?: string;
          }>;
        };
      };
    } | null;

    if (!playerResp?.videoDetails) {
      return { meta: null, transcript: [], youtubeChapters: [] };
    }

    const vd = playerResp.videoDetails;
    const durationSec = Math.max(0, Number(vd.lengthSeconds ?? 0) || 0);
    const meta: VideoMetadata = {
      videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      title: vd.title?.trim() || `YouTube Video (${videoId})`,
      channelName: vd.author?.trim() || 'Unknown channel',
      channelUrl: vd.channelId ? `https://www.youtube.com/channel/${vd.channelId}` : '',
      durationSec,
      description: vd.shortDescription ?? '',
    };

    const tracks = playerResp.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    const preferred =
      tracks.find((t) => t.languageCode?.startsWith('en') && t.kind !== 'asr') ??
      tracks.find((t) => t.languageCode?.startsWith('en')) ??
      tracks[0];

    let transcript: TranscriptCue[] = [];
    if (preferred?.baseUrl) {
      const json3Url = `${preferred.baseUrl}${preferred.baseUrl.includes('?') ? '&' : '?'}fmt=json3`;
      const capRes = await fetch(json3Url).catch(() => null);
      if (capRes?.ok) {
        const body = await capRes.text();
        if (body.trim()) {
          try {
            transcript = parseJson3Transcript(JSON.parse(body));
          } catch {
            transcript = parseXmlTranscript(body);
          }
        }
      }
    }

    return { meta, transcript, youtubeChapters: [] };
  } catch {
    return { meta: null, transcript: [], youtubeChapters: [] };
  }
}

function resolvePendingHeadlessCapture(videoId: string, result: HeadlessCaptureResult) {
  const pending = pendingHeadlessCaptures.get(videoId);
  if (!pending) return;
  pendingHeadlessCaptures.delete(videoId);
  clearTimeout(pending.timer);
  chrome.tabs.remove(pending.tabId).catch(() => {});
  pending.resolve(result);
}

async function captureViaHeadlessTab(videoId: string): Promise<HeadlessCaptureResult> {
  const existing = pendingHeadlessCaptures.get(videoId);
  if (existing) {
    clearTimeout(existing.timer);
    pendingHeadlessCaptures.delete(videoId);
    chrome.tabs.remove(existing.tabId).catch(() => {});
  }

  const tab = await chrome.tabs.create({
    url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&cm_headless=1`,
    active: false,
  });

  if (!tab.id) {
    throw new Error('Could not open background capture tab.');
  }
  const tabId = tab.id;
  await chrome.tabs.update(tabId, { muted: true }).catch(() => {});

  return await new Promise<HeadlessCaptureResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingHeadlessCaptures.delete(videoId);
      chrome.tabs.remove(tabId).catch(() => {});
      reject(new Error('Timed out waiting for headless YouTube transcript extraction.'));
    }, 45_000);

    pendingHeadlessCaptures.set(videoId, { tabId, resolve, reject, timer });
  });
}

async function recoverStaleQueueJobs(): Promise<QueueJob[]> {
  const now = Date.now();
  const { next } = await mutateQueueJobs((jobs) => {
    let changed = false;
    const updated = jobs.map((job) => {
      const isRunning = job.status === 'fetching_transcript' || job.status === 'analyzing';
      if (!isRunning) return job;
      const notRunningInWorker = !inFlightQueueVideoIds.has(job.videoId);
      const staleTimeout = now - (job.updatedAt || job.addedAt) > 90_000;
      if (notRunningInWorker || staleTimeout) {
        changed = true;
        addActivityLog('queue', 'warn', 'Recovered stale job -> queued', job.videoId);
        return { ...job, status: 'queued' as const, error: undefined, updatedAt: now };
      }
      return job;
    });
    return { next: updated, changed };
  });
  return next;
}

async function updateQueueJob(
  videoId: string,
  patch: Partial<QueueJob>
): Promise<QueueJob[]> {
  const { next } = await mutateQueueJobs((jobs) => ({
    next: jobs.map((j) =>
      j.videoId === videoId ? { ...j, ...patch, updatedAt: Date.now() } : j
    ),
    changed: true,
  }));
  return next;
}

async function tryCaptureFromExistingYouTubeTab(
  videoId: string
): Promise<HeadlessCaptureResult | null> {
  const ytTabs = await chrome.tabs
    .query({ url: ['https://www.youtube.com/watch*', 'https://www.youtube.com/shorts/*'] })
    .catch(() => []);
  for (const tab of ytTabs) {
    if (!tab.id || !tab.url || tab.url.includes('cm_headless=1')) continue;
    if (extractYouTubeVideoId(tab.url) !== videoId) continue;
    try {
      const res = (await chrome.tabs.sendMessage(tab.id, {
        type: 'GET_ACTIVE_VIDEO_STATE',
      })) as
        | { state?: { meta?: VideoMetadata | null; transcript?: TranscriptCue[]; youtubeChapters?: Chapter[] } }
        | undefined;
      const st = res?.state;
      if (st?.meta?.videoId === videoId && Array.isArray(st.transcript) && st.transcript.length > 0) {
        return {
          meta: st.meta,
          transcript: st.transcript,
          youtubeChapters: st.youtubeChapters ?? [],
        };
      }
    } catch {
      // ignore unresponsive tab
    }
  }
  return null;
}

async function enqueueHeadlessBatch(
  items: Array<{ urlOrId: string; title?: string; channelName?: string }>
): Promise<QueueJob[]> {
  if (items.length === 0) return [];
  const { result: addedOrActive } = await mutateQueueJobs<QueueJob[]>((jobs) => {
    let working = [...jobs];
    const added: QueueJob[] = [];

    for (const item of items) {
      const clean = item.urlOrId.trim();
      const videoId = /^[A-Za-z0-9_-]{11}$/.test(clean) ? clean : extractYouTubeVideoId(clean);
      if (!videoId) continue;

      const activeExisting = working.find(
        (j) =>
          j.videoId === videoId &&
          (j.status === 'queued' || j.status === 'fetching_transcript' || j.status === 'analyzing')
      );
      if (activeExisting) {
        added.push(activeExisting);
        continue;
      }

      const now = Date.now();
      const job: QueueJob = {
        videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        title: item.title?.trim() || `YouTube Video (${videoId})`,
        channelName: item.channelName,
        status: 'queued',
        addedAt: now,
        updatedAt: now,
      };
      working = [job, ...working.filter((j) => j.videoId !== videoId)].slice(0, 30);
      added.push(job);
    }

    return { next: working, changed: added.length > 0, result: added };
  });

  if ((addedOrActive?.length ?? 0) > 0) {
    addActivityLog(
      'queue',
      'info',
      `Queued ${addedOrActive!.length} video(s)`,
      addedOrActive!.length === 1 ? addedOrActive![0]?.videoId : undefined
    );
    void processHeadlessQueue();
  }
  return addedOrActive ?? [];
}

async function enqueueHeadlessJob(
  urlOrId: string,
  title?: string,
  channelName?: string
): Promise<QueueJob | null> {
  const res = await enqueueHeadlessBatch([{ urlOrId, title, channelName }]);
  return res[0] ?? null;
}

async function runSingleHeadlessJob(videoId: string): Promise<void> {
  const startedAt = Date.now();
  try {
    await updateQueueJob(videoId, { status: 'fetching_transcript', error: undefined });
    const settings = await loadSettings();

    const fromOpenTab = await tryCaptureFromExistingYouTubeTab(videoId);
    let capture = fromOpenTab ?? (await fetchWatchPageDataHeadless(videoId));
    if (fromOpenTab) {
      addActivityLog(
        'transcript',
        'info',
        `Captured ${fromOpenTab.transcript.length} cues from open tab`,
        videoId
      );
    } else if (capture.transcript.length > 0) {
      addActivityLog(
        'transcript',
        'info',
        `Watch-HTML fast path extracted ${capture.transcript.length} cues`,
        videoId
      );
    }
    if (capture.meta?.title) {
      await updateQueueJob(videoId, {
        title: capture.meta.title,
        channelName: capture.meta.channelName,
      });
    }

    if (!capture.meta || capture.transcript.length === 0) {
      addActivityLog('transcript', 'info', 'Opening silent &cm_headless=1 tab...', videoId);
      const tabCapture = await captureViaHeadlessTab(videoId);
      capture = {
        meta: tabCapture.meta ?? capture.meta,
        transcript:
          tabCapture.transcript.length > 0 ? tabCapture.transcript : capture.transcript,
        youtubeChapters:
          tabCapture.youtubeChapters.length > 0
            ? tabCapture.youtubeChapters
            : capture.youtubeChapters,
        error: tabCapture.error ?? capture.error,
      };
      if (capture.transcript.length > 0) {
        addActivityLog(
          'transcript',
          'info',
          `Headless tab captured ${capture.transcript.length} cues`,
          videoId
        );
      }
    }

    if (!capture.meta || capture.transcript.length === 0) {
      throw new Error(capture.error || 'No captions/transcript available for this video.');
    }

    await updateQueueJob(videoId, {
      status: 'analyzing',
      title: capture.meta.title,
      channelName: capture.meta.channelName,
    });

    const sponsorSegments = settings.sponsorBlockEnabled
      ? await fetchSponsorBlockSegments(videoId, settings.usePrivacyPrefix)
      : [];
    const stripped = stripSponsorSegmentsFromTranscript(capture.transcript, sponsorSegments);
    const formatted = formatTranscriptForPrompt(stripped.cleanedCues);
    const prompt = buildVideoAnalysisPrompt(
      capture.meta,
      formatted.text,
      capture.youtubeChapters,
      sponsorSegments.filter((s) => s.category !== 'chapter').length,
      {
        topicsCare: settings.topicsCare,
        topicsIgnore: settings.topicsIgnore,
      }
    );

    const providerLabel = `${settings.apiProvider}:${settings.apiModel || 'default'}`;
    addActivityLog(
      'ai',
      'info',
      `Analyzing via ${providerLabel} (${stripped.cleanedCues.length} cues, ${prompt.length} chars)`,
      videoId
    );
    const rawResponse = await callAiProvider(settings, prompt, true);
    const entry = buildKnowledgeEntryFromAnalysis(
      capture.meta,
      stripped.cleanedCues,
      sponsorSegments.filter((s) => s.category !== 'chapter').length,
      stripped.removedDurationSec,
      rawResponse,
      providerLabel
    );

    await putEntry(entry);
    await pushAnalysisToYouTubeTabs(entry);
    chrome.runtime.sendMessage({ type: 'ANALYSIS_COMPLETED', entry }).catch(() => {});

    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    addActivityLog(
      'queue',
      'success',
      `Completed ${entry.chapters.length} ch, ${entry.entities.length} ent in ${elapsedSec}s`,
      videoId
    );

    await updateQueueJob(videoId, {
      status: 'done',
      title: entry.title,
      channelName: entry.channelName,
      chapterCount: entry.chapters.length,
      entityCount: entry.entities.length,
      error: undefined,
    });

    void maybeAutoPushGithub(settings).catch((err) => {
      console.warn('ChapterMind auto-push skipped:', err);
      addActivityLog('github', 'warn', err instanceof Error ? err.message : String(err), videoId);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    addActivityLog('queue', 'error', message, videoId);
    await updateQueueJob(videoId, { status: 'error', error: message });
  }
}

async function processHeadlessQueue(): Promise<void> {
  if (inFlightQueueVideoIds.size >= MAX_CONCURRENT_QUEUE_JOBS) return;

  const jobs = await recoverStaleQueueJobs();
  const candidates = [...jobs]
    .reverse()
    .filter((j) => j.status === 'queued' && !inFlightQueueVideoIds.has(j.videoId));

  for (const job of candidates) {
    if (inFlightQueueVideoIds.size >= MAX_CONCURRENT_QUEUE_JOBS) break;
    inFlightQueueVideoIds.add(job.videoId);
    syncQueueKeepalive();
    void runSingleHeadlessJob(job.videoId).finally(() => {
      inFlightQueueVideoIds.delete(job.videoId);
      syncQueueKeepalive();
      void processHeadlessQueue();
    });
  }
}

function ensureContextMenus() {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    chrome.contextMenus.create(
      {
        id: CONTEXT_MENU_QUEUE_ID,
        title: 'ChapterMind: Queue & Analyze (Headless)',
        contexts: ['link', 'image', 'page', 'video'],
        documentUrlPatterns: ['https://www.youtube.com/*'],
      },
      () => {
        void chrome.runtime.lastError;
      }
    );
  });
}

if (chrome.contextMenus) {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== CONTEXT_MENU_QUEUE_ID) return;
    const rawUrl = info.linkUrl || info.pageUrl || tab?.url || '';
    const videoId = extractYouTubeVideoId(rawUrl);
    if (!videoId) return;
    const fallbackTitle = !info.linkUrl && tab?.title ? tab.title.replace(/\s*-\s*YouTube$/, '') : undefined;
    void enqueueHeadlessJob(videoId, fallbackTitle);
  });
}

if (chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener((closedTabId) => {
    for (const [videoId, pending] of pendingHeadlessCaptures.entries()) {
      if (pending.tabId === closedTabId) {
        pendingHeadlessCaptures.delete(videoId);
        clearTimeout(pending.timer);
        pending.reject(new Error('Background capture tab was closed before transcript finished.'));
      }
    }
  });
}

chrome.runtime.onInstalled?.addListener(() => {
  ensureContextMenus();
});

chrome.runtime.onStartup?.addListener(() => {
  ensureContextMenus();
  void recoverStaleQueueJobs().then((jobs) => {
    if (jobs.some((j) => j.status === 'queued')) {
      void processHeadlessQueue();
    }
  });
});

ensureContextMenus();
void recoverStaleQueueJobs().then((jobs) => {
  if (jobs.some((j) => j.status === 'queued')) {
    void processHeadlessQueue();
  }
});

chrome.runtime.onMessage.addListener((msg: RuntimeMessage, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then((result) => sendResponse(result))
    .catch((err) => {
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  return true;
});
