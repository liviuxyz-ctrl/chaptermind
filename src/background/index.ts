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
import { formatTranscriptForPrompt } from '../shared/transcript';
import {
  buildKbQuestionPrompt,
  buildVideoAnalysisPrompt,
  parseAiAnalysisResponse,
} from '../shared/prompts';
import { callAiProvider } from '../shared/ai-client';
import {
  deleteEntry,
  getAllEntries,
  getEntry,
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

const sponsorCache = new Map<string, { fetchedAt: number; segments: SponsorSegment[] }>();
let memoryBridgeTask: BridgeTask | null = null;

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

  // Notify any open YouTube tabs
  const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
  for (const tab of tabs) {
    if (tab.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_UPDATED', settings: next }).catch(() => {});
    }
  }
  return next;
}

async function setBridgeTask(task: BridgeTask | null) {
  memoryBridgeTask = task;
  try {
    if (task) {
      await chrome.storage.session.set({ [BRIDGE_TASK_KEY]: task });
    } else {
      await chrome.storage.session.remove(BRIDGE_TASK_KEY);
    }
  } catch {
    // storage.session fallback to memoryBridgeTask
  }
}

async function getBridgeTask(): Promise<BridgeTask | null> {
  try {
    const res = await chrome.storage.session.get(BRIDGE_TASK_KEY);
    if (res[BRIDGE_TASK_KEY]) {
      return res[BRIDGE_TASK_KEY] as BridgeTask;
    }
  } catch {
    // fallback
  }
  return memoryBridgeTask;
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

async function maybeAutoPushGithub(settings: ExtensionSettings) {
  if (!settings.githubAutoPush || !settings.githubRepo.trim() || !settings.githubToken.trim()) {
    return;
  }
  const allEntries = await getAllEntries();
  await pushKnowledgeBaseToGithub(settings, allEntries);
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
      const entries = await getAllEntries();
      return { entries };
    }

    case 'KB_SAVE': {
      await putEntry(msg.entry);
      return { ok: true };
    }

    case 'KB_DELETE': {
      await deleteEntry(msg.videoId);
      return { ok: true };
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
      const settings = await loadSettings();
      const stripped = settings.stripSponsorsFromAi
        ? stripSponsorSegmentsFromTranscript(msg.transcript, msg.sponsorSegments)
        : { cleanedCues: msg.transcript, removedCueCount: 0, removedDurationSec: 0 };

      const formatted = formatTranscriptForPrompt(stripped.cleanedCues);
      if (!formatted.text) {
        throw new Error('Transcript is empty — cannot analyze video.');
      }

      const sbCount = msg.sponsorSegments.filter((s) => s.category !== 'chapter').length;
      const prompt = buildVideoAnalysisPrompt(msg.meta, formatted.text, msg.youtubeChapters, sbCount, {
        topicsCare: settings.topicsCare,
        topicsIgnore: settings.topicsIgnore,
      });
      const rawReply = await callAiProvider(settings, prompt, settings.apiProvider === 'gemini');

      const entry = buildKnowledgeEntryFromAnalysis(
        msg.meta,
        stripped.cleanedCues,
        sbCount,
        stripped.removedDurationSec,
        rawReply,
        `${settings.apiProvider}:${settings.apiModel || 'default'}`
      );
      if (!settings.aiFallbackSponsorDetection) {
        entry.aiSponsors = [];
      }

      await putEntry(entry);
      await pushAnalysisToYouTubeTabs(entry);
      void maybeAutoPushGithub(settings).catch(() => {});
      return { ok: true, entry };
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
        const allEntries = await getAllEntries();
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
      const [task, settings] = await Promise.all([getBridgeTask(), loadSettings()]);
      return { task, bridgePillEnabled: settings.bridgePillEnabled };
    }

    case 'CLEAR_BRIDGE_TASK': {
      await setBridgeTask(null);
      return { ok: true };
    }

    case 'IMPORT_BRIDGE_RESPONSE': {
      const task = await getBridgeTask();
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
        await setBridgeTask(null);
        chrome.runtime.sendMessage({ type: 'BRIDGE_ANALYSIS_READY', entry }).catch(() => {});
        void maybeAutoPushGithub(settings).catch(() => {});
        if (settings.autoReturnAfterBridgeCapture && task.tabId) {
          chrome.tabs.update(task.tabId, { active: true }).catch(() => {});
        }
        return { ok: true, entry };
      }

      if (task.kind === 'ask_kb') {
        const allEntries = await getAllEntries();
        const usedEntries = task.matchedVideoIds?.length
          ? allEntries.filter((e) => task.matchedVideoIds?.includes(e.videoId))
          : allEntries.slice(0, 5);
        await setBridgeTask(null);
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
      const allEntries = await getAllEntries();
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
      const settings = await loadSettings();
      const entries = await getAllEntries();
      const result = await pushKnowledgeBaseToGithub(settings, entries);
      return { ok: true, ...result };
    }

    case 'GITHUB_FETCH_ALL': {
      const settings = await loadSettings();
      const localEntries = await getAllEntries();
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
      return {
        ok: true,
        fetchedCount: result.fetchedCount,
        totalRemote: result.totalRemote,
      };
    }

    case 'OPEN_SIDEPANEL': {
      if (sender.tab?.windowId && chrome.sidePanel?.open) {
        await chrome.sidePanel.open({ windowId: sender.tab.windowId });
      }
      return { ok: true };
    }

    default:
      return { ok: false };
  }
}

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
