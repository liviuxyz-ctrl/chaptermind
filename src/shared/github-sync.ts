import type { ExtensionSettings, KnowledgeEntry } from './types';
import { exportEntryToMarkdown } from './kb-storage';

const GITHUB_API_BASE = 'https://api.github.com';

export function utf8ToBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function base64ToUtf8(b64: string): string {
  const clean = b64.replace(/\s+/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

export function parseGithubRepo(input: string): { owner: string; repo: string } {
  const trimmed = input
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');

  const parts = trimmed.split('/').filter(Boolean);
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('Enter GitHub repository as "owner/repo" (e.g. username/chaptermind-kb).');
  }
  return { owner: parts[0], repo: parts[1] };
}

function normalizeFolder(folder: string): string {
  return folder.trim().replace(/^\/+|\/+$/g, '') || 'knowledge-base';
}

function slugifyTitle(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'video'
  );
}

function encodeGithubPath(repoPath: string): string {
  return repoPath
    .split('/')
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

export function normalizeGithubToken(raw?: string): string {
  if (!raw) return '';
  let token = raw.trim().replace(/^["']+|["']+$/g, '');
  token = token.replace(/^(?:Bearer|token)\s+/i, '').trim();
  if (!token) return '';

  if (/\s/.test(token) || token.length > 140) {
    throw new Error(
      'Token looks pasted twice or contains spaces — clear the box (Ctrl+A, Backspace) and paste once.'
    );
  }
  if (!/^(?:github_pat_|ghp_|gho_|ghu_|ghs_)/.test(token)) {
    const preview = token.slice(0, 6);
    throw new Error(
      `GitHub token should start with "github_pat_" or "ghp_" (yours starts with "${preview}..."). Clear the box and paste your GitHub Fine-grained PAT.`
    );
  }
  return token;
}

function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const cleanToken = normalizeGithubToken(token);
  if (cleanToken) {
    headers.Authorization = `Bearer ${cleanToken}`;
  }
  return headers;
}

export interface GithubConnectionInfo {
  fullName: string;
  isPrivate: boolean;
  canPush: boolean;
  defaultBranch: string;
}

export async function testGithubConnection(
  settings: Pick<ExtensionSettings, 'githubRepo' | 'githubToken'>,
  fetchFn: typeof fetch = fetch
): Promise<GithubConnectionInfo> {
  const { owner, repo } = parseGithubRepo(settings.githubRepo);
  const res = await fetchFn(`${GITHUB_API_BASE}/repos/${owner}/${repo}`, {
    headers: buildHeaders(settings.githubToken),
    cache: 'no-store',
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GitHub HTTP ${res.status}: ${errText.slice(0, 220)}`);
  }
  const data = (await res.json()) as {
    full_name?: string;
    private?: boolean;
    default_branch?: string;
    permissions?: { push?: boolean };
  };
  return {
    fullName: data.full_name || `${owner}/${repo}`,
    isPrivate: Boolean(data.private),
    canPush: Boolean(data.permissions?.push),
    defaultBranch: data.default_branch || 'main',
  };
}

interface GithubContentItem {
  type?: string;
  name?: string;
  path?: string;
  sha?: string;
  content?: string;
  encoding?: string;
}

async function getRemoteFile(
  owner: string,
  repo: string,
  branch: string,
  filePath: string,
  token: string,
  fetchFn: typeof fetch
): Promise<{ sha: string; text: string } | null> {
  const encodedPath = encodeGithubPath(filePath);
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(
    branch
  )}`;
  const res = await fetchFn(url, { headers: buildHeaders(token), cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GitHub read failed (${filePath}) HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = (await res.json()) as GithubContentItem;
  const text =
    data.content && data.encoding === 'base64' ? base64ToUtf8(data.content) : '';
  return { sha: data.sha || '', text };
}

async function upsertRemoteFile(
  owner: string,
  repo: string,
  branch: string,
  filePath: string,
  textContent: string,
  commitMessage: string,
  token: string,
  fetchFn: typeof fetch
): Promise<'pushed' | 'skipped'> {
  const encodedPath = encodeGithubPath(filePath);
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${encodedPath}`;
  const maxAttempts = 3;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const existing = await getRemoteFile(owner, repo, branch, filePath, token, fetchFn);
    if (existing && existing.text === textContent) {
      return 'skipped';
    }

    const body: Record<string, unknown> = {
      message: commitMessage,
      content: utf8ToBase64(textContent),
      branch,
    };
    if (existing?.sha) {
      body.sha = existing.sha;
    }

    const res = await fetchFn(url, {
      method: 'PUT',
      headers: {
        ...buildHeaders(token),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    });

    if (res.ok) {
      return 'pushed';
    }

    const errText = await res.text();
    if (res.status === 409 && attempt < maxAttempts - 1) {
      continue;
    }
    throw new Error(`GitHub write failed (${filePath}) HTTP ${res.status}: ${errText.slice(0, 240)}`);
  }

  return 'pushed';
}

export interface GithubIndexDocument {
  version: number;
  updatedAt: number;
  topicsIgnore: string[];
  topicsCare: string[];
  videos: Array<{
    videoId: string;
    title: string;
    channelName: string;
    updatedAt: number;
  }>;
}

export interface GithubPushResult {
  pushedFiles: number;
  skippedFiles: number;
  videoCount: number;
  repoUrl: string;
}

export async function pushKnowledgeBaseToGithub(
  settings: Pick<
    ExtensionSettings,
    'githubRepo' | 'githubBranch' | 'githubFolder' | 'githubToken' | 'topicsIgnore' | 'topicsCare'
  >,
  entries: KnowledgeEntry[],
  fetchFn: typeof fetch = fetch
): Promise<GithubPushResult> {
  const token = normalizeGithubToken(settings.githubToken);
  if (!token) {
    throw new Error('GitHub token is required to push. Add a PAT in Settings → GitHub Sync.');
  }

  const { owner, repo } = parseGithubRepo(settings.githubRepo);
  const branch = settings.githubBranch.trim() || 'main';
  const folder = normalizeFolder(settings.githubFolder);
  const activeEntries = entries.filter((e) => !e.trashedAt);

  let pushedFiles = 0;
  let skippedFiles = 0;

  for (const entry of activeEntries) {
    const jsonPath = `${folder}/videos/${entry.videoId}.json`;
    const jsonRes = await upsertRemoteFile(
      owner,
      repo,
      branch,
      jsonPath,
      JSON.stringify(entry, null, 2),
      `ChapterMind sync JSON: ${entry.title.slice(0, 60)}`,
      token,
      fetchFn
    );
    if (jsonRes === 'pushed') pushedFiles += 1;
    else skippedFiles += 1;

    const mdPath = `${folder}/notes/${entry.videoId}-${slugifyTitle(entry.title)}.md`;
    const mdRes = await upsertRemoteFile(
      owner,
      repo,
      branch,
      mdPath,
      exportEntryToMarkdown(entry),
      `ChapterMind sync Markdown: ${entry.title.slice(0, 60)}`,
      token,
      fetchFn
    );
    if (mdRes === 'pushed') pushedFiles += 1;
    else skippedFiles += 1;
  }

  const indexDoc: GithubIndexDocument = {
    version: 1,
    updatedAt: Date.now(),
    topicsIgnore: settings.topicsIgnore,
    topicsCare: settings.topicsCare,
    videos: activeEntries.map((e) => ({
      videoId: e.videoId,
      title: e.title,
      channelName: e.channelName,
      updatedAt: e.updatedAt,
    })),
  };

  const indexRes = await upsertRemoteFile(
    owner,
    repo,
    branch,
    `${folder}/index.json`,
    JSON.stringify(indexDoc, null, 2),
    `ChapterMind sync index (${activeEntries.length} videos)`,
    token,
    fetchFn
  );
  if (indexRes === 'pushed') pushedFiles += 1;
  else skippedFiles += 1;

  return {
    pushedFiles,
    skippedFiles,
    videoCount: activeEntries.length,
    repoUrl: `https://github.com/${owner}/${repo}`,
  };
}

export interface GithubFetchResult {
  entriesToSave: KnowledgeEntry[];
  remoteInterests?: {
    topicsIgnore?: string[];
    topicsCare?: string[];
  };
  fetchedCount: number;
  totalRemote: number;
}

export async function fetchKnowledgeBaseFromGithub(
  settings: Pick<
    ExtensionSettings,
    'githubRepo' | 'githubBranch' | 'githubFolder' | 'githubToken'
  >,
  localEntries: KnowledgeEntry[],
  fetchFn: typeof fetch = fetch
): Promise<GithubFetchResult> {
  const { owner, repo } = parseGithubRepo(settings.githubRepo);
  const branch = settings.githubBranch.trim() || 'main';
  const folder = normalizeFolder(settings.githubFolder);
  const token = settings.githubToken.trim();

  const localById = new Map<string, KnowledgeEntry>(
    localEntries.map((e) => [e.videoId, e])
  );

  let videoIds: string[] = [];
  let remoteInterests: GithubFetchResult['remoteInterests'];

  const indexFile = await getRemoteFile(
    owner,
    repo,
    branch,
    `${folder}/index.json`,
    token,
    fetchFn
  );

  if (indexFile?.text) {
    const parsed = JSON.parse(indexFile.text) as Partial<GithubIndexDocument>;
    if (Array.isArray(parsed.videos)) {
      videoIds = parsed.videos
        .map((v) => v?.videoId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
    }
    if (Array.isArray(parsed.topicsIgnore) || Array.isArray(parsed.topicsCare)) {
      remoteInterests = {
        topicsIgnore: Array.isArray(parsed.topicsIgnore) ? parsed.topicsIgnore : undefined,
        topicsCare: Array.isArray(parsed.topicsCare) ? parsed.topicsCare : undefined,
      };
    }
  } else {
    // Fallback: list {folder}/videos directory directly
    const dirUrl = `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${encodeGithubPath(
      `${folder}/videos`
    )}?ref=${encodeURIComponent(branch)}`;
    const res = await fetchFn(dirUrl, { headers: buildHeaders(token), cache: 'no-store' });
    if (res.status === 404) {
      return { entriesToSave: [], fetchedCount: 0, totalRemote: 0 };
    }
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`GitHub list failed HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }
    const items = (await res.json()) as GithubContentItem[];
    if (Array.isArray(items)) {
      videoIds = items
        .filter((item) => item.type === 'file' && item.name?.endsWith('.json'))
        .map((item) => item.name!.replace(/\.json$/i, ''));
    }
  }

  const entriesToSave: KnowledgeEntry[] = [];
  for (const vid of videoIds) {
    const remoteFile = await getRemoteFile(
      owner,
      repo,
      branch,
      `${folder}/videos/${vid}.json`,
      token,
      fetchFn
    );
    if (!remoteFile?.text) continue;
    const remoteEntry = JSON.parse(remoteFile.text) as KnowledgeEntry;
    if (!remoteEntry?.videoId) continue;

    const local = localById.get(remoteEntry.videoId);
    if (!local || (remoteEntry.updatedAt ?? 0) > (local.updatedAt ?? 0)) {
      entriesToSave.push(remoteEntry);
    }
  }

  return {
    entriesToSave,
    remoteInterests,
    fetchedCount: entriesToSave.length,
    totalRemote: videoIds.length,
  };
}
