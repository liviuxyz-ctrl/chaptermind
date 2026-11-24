import type { BridgeTask, KnowledgeEntry, RuntimeMessage } from '../shared/types';

let pillHost: HTMLElement | null = null;
let currentTask: BridgeTask | null = null;

function sendRuntimeMessage<T = unknown>(message: RuntimeMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (res) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(res as T);
    });
  });
}

function findComposerElement(): HTMLElement | HTMLTextAreaElement | null {
  const selectors = [
    '#prompt-textarea',
    'div.ProseMirror[contenteditable="true"]',
    'rich-textarea div[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'textarea[placeholder]',
    'textarea',
  ];

  for (const sel of selectors) {
    const el = document.querySelector(sel) as HTMLElement | HTMLTextAreaElement | null;
    if (el && el.offsetParent !== null) {
      return el;
    }
  }
  return null;
}

function insertPromptIntoComposer(promptText: string): boolean {
  const el = findComposerElement();
  if (!el) return false;

  el.focus();
  if (el instanceof HTMLTextAreaElement) {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    )?.set;
    if (nativeSetter) {
      nativeSetter.call(el, promptText);
    } else {
      el.value = promptText;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  // Contenteditable (Gemini / Claude / ChatGPT ProseMirror)
  try {
    const dt = new DataTransfer();
    dt.setData('text/plain', promptText);
    const pasteEvent = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dt,
    });
    el.dispatchEvent(pasteEvent);
    if ((el.textContent?.trim().length ?? 0) > 0) {
      return true;
    }
  } catch {
    // fallback below
  }

  try {
    if (document.execCommand('insertText', false, promptText) && (el.textContent?.trim().length ?? 0) > 0) {
      return true;
    }
  } catch {
    // fallback below
  }

  el.textContent = promptText;
  el.dispatchEvent(
    new InputEvent('input', { bubbles: true, data: promptText, inputType: 'insertText' })
  );
  return true;
}

function captureLatestAssistantResponse(kind: BridgeTask['kind']): string | null {
  if (kind === 'analyze_video') {
    // Prefer newest fenced/code block containing JSON ("chapters" / "tldr")
    const codeBlocks = Array.from(document.querySelectorAll('pre code, code, pre'));
    for (let i = codeBlocks.length - 1; i >= 0; i--) {
      const text = codeBlocks[i]?.textContent?.trim() ?? '';
      if (text.includes('{') && (text.includes('"chapters"') || text.includes('"tldr"'))) {
        return text;
      }
    }
  }

  // Fallback: newest assistant turn container
  const assistantSelectors = [
    '[data-message-author-role="assistant"]',
    'model-response .markdown, message-content',
    '.font-claude-response, [data-testid="chat-message-text"]',
    'article',
  ];

  for (const sel of assistantSelectors) {
    const nodes = Array.from(document.querySelectorAll(sel));
    for (let i = nodes.length - 1; i >= 0; i--) {
      const text = nodes[i]?.textContent?.trim() ?? '';
      if (text.length > 40) {
        return text;
      }
    }
  }
  return null;
}

function mountBridgePill(task: BridgeTask) {
  if (pillHost && document.contains(pillHost)) {
    if (currentTask?.id === task.id) return;
    pillHost.remove();
    pillHost = null;
  }
  currentTask = task;

  pillHost = document.createElement('div');
  pillHost.id = 'chaptermind-ai-bridge-pill';
  Object.assign(pillHost.style, {
    position: 'fixed',
    top: '14px',
    right: '14px',
    zIndex: '2147483647',
  });

  const shadow = pillHost.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    .box {
      font-family: system-ui, -apple-system, sans-serif;
      background: #10141d;
      color: #f3f4f6;
      border: 1px solid #2c3548;
      border-radius: 12px;
      padding: 10px 12px;
      box-shadow: 0 10px 28px rgba(0,0,0,0.45);
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: 280px;
    }
    .head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 12px;
      font-weight: 700;
      color: #34d399;
    }
    .sub {
      font-size: 11px;
      color: #cbd5e1;
      line-height: 1.35;
    }
    .row {
      display: flex;
      gap: 6px;
    }
    button {
      flex: 1;
      border: 1px solid #334155;
      background: #1e293b;
      color: #f8fafc;
      border-radius: 8px;
      padding: 6px 8px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover { background: #334155; }
    .primary { background: #059669; border-color: #10b981; }
    .primary:hover { background: #047857; }
    .close {
      flex: 0 0 auto;
      background: transparent;
      border: none;
      color: #94a3b8;
      padding: 2px 6px;
    }
    .status {
      font-size: 11px;
      color: #7dd3fc;
      min-height: 14px;
    }
  `;

  const box = document.createElement('div');
  box.className = 'box';

  const head = document.createElement('div');
  head.className = 'head';
  const title = document.createElement('span');
  title.textContent = 'ChapterMind AI Bridge';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'close';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => {
    void sendRuntimeMessage({ type: 'CLEAR_BRIDGE_TASK' });
    pillHost?.remove();
    pillHost = null;
  });
  head.append(title, closeBtn);

  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent =
    task.kind === 'analyze_video'
      ? `Task: Analyze "${task.meta?.title?.slice(0, 48) ?? 'YouTube video'}"`
      : `Task: Ask Knowledge Base`;

  const status = document.createElement('div');
  status.className = 'status';
  status.textContent = '1) Paste prompt & send  2) Click Capture Reply';

  const row = document.createElement('div');
  row.className = 'row';

  const pasteBtn = document.createElement('button');
  pasteBtn.type = 'button';
  pasteBtn.textContent = '1. Paste Prompt';
  pasteBtn.addEventListener('click', async () => {
    if (!currentTask) return;
    const inserted = insertPromptIntoComposer(currentTask.prompt);
    try {
      await navigator.clipboard.writeText(currentTask.prompt);
    } catch {
      // ignore clipboard permission issues
    }
    status.textContent = inserted
      ? 'Prompt pasted! Press Send in chat, then click Capture Reply.'
      : 'Copied prompt to clipboard — press Ctrl+V in the chat box.';
  });

  const captureBtn = document.createElement('button');
  captureBtn.type = 'button';
  captureBtn.className = 'primary';
  captureBtn.textContent = '2. Capture Reply';
  captureBtn.addEventListener('click', async () => {
    if (!currentTask) return;
    const rawText = captureLatestAssistantResponse(currentTask.kind);
    if (!rawText) {
      status.textContent = 'No assistant reply found yet. Wait for AI to finish.';
      return;
    }
    status.textContent = 'Importing into ChapterMind...';
    try {
      const res = await sendRuntimeMessage<{ ok: boolean; error?: string; entry?: KnowledgeEntry }>({
        type: 'IMPORT_BRIDGE_RESPONSE',
        taskId: currentTask.id,
        rawText,
      });
      if (!res.ok) {
        status.textContent = res.error || 'Could not parse reply yet.';
        return;
      }
      status.textContent = res.entry
        ? `Saved ${res.entry.chapters.length} chapters to Knowledge Base!`
        : 'Answer sent back to ChapterMind Side Panel!';
      window.setTimeout(() => {
        pillHost?.remove();
        pillHost = null;
      }, 2500);
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : 'Import failed';
    }
  });

  row.append(pasteBtn, captureBtn);
  box.append(head, sub, row, status);
  shadow.append(style, box);
  document.documentElement.appendChild(pillHost);
}

async function checkPendingBridgeTask() {
  try {
    const res = await sendRuntimeMessage<{ task: BridgeTask | null; bridgePillEnabled?: boolean }>({
      type: 'GET_BRIDGE_TASK',
    });
    if (res.bridgePillEnabled === false) return;
    if (res.task && Date.now() - res.task.createdAt < 15 * 60 * 1000) {
      mountBridgePill(res.task);
    }
  } catch {
    // ignore when service worker wakes
  }
}

void checkPendingBridgeTask();
window.addEventListener('focus', () => {
  void checkPendingBridgeTask();
});
