import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronLeft,
  Clipboard,
  Clock,
  Copy,
  CornerDownLeft,
  Database,
  Eye,
  FolderOpen,
  HardDrive,
  Image as ImageIcon,
  Info,
  Keyboard,
  Monitor,
  Moon,
  Pause,
  Pin,
  PinOff,
  Play,
  Power,
  Search,
  Settings as SettingsIcon,
  Shield,
  Sparkles,
  Sun,
  Trash2,
  Type,
  X,
  Zap,
} from 'lucide-react';
import './styles.css';

const DEFAULT_SETTINGS = {
  theme: 'system',
  hotkey: 'Alt+V',
  maxItems: 500,
  retentionDays: 0,
  autoStart: false,
  pasteOnSelect: false,
  richText: true,
  captureImages: true,
};

const DEFAULT_META = {
  version: '',
  dataDir: '',
  storageBytes: 0,
  canAutoStart: false,
  hotkey: 'Alt+V',
  activeHotkey: 'Alt+V',
  hotkeyActive: true,
  paused: false,
};

const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'text', label: '文字' },
  { id: 'image', label: '图片' },
  { id: 'pinned', label: '已固定' },
];

const THEME_OPTIONS = [
  { id: 'system', label: '跟随系统', Icon: Monitor },
  { id: 'light', label: '浅色', Icon: Sun },
  { id: 'dark', label: '深色', Icon: Moon },
];

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph']);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function searchTerms(query) {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function itemHaystack(item) {
  if (item.type === 'image') {
    return `图片 图像 截图 image screenshot ${item.width} ${item.height} ${item.width}×${item.height}`.toLowerCase();
  }
  return `${item.text || ''} ${item.rich ? '富文本 html rich text' : ''}`.toLowerCase();
}

function itemMatches(item, terms) {
  if (!terms.length) return true;
  const haystack = itemHaystack(item);
  return terms.every((term) => haystack.includes(term));
}

function getSnippet(text, query, maxLength = 520) {
  const source = String(text || '').replace(/\r\n/g, '\n');
  const terms = searchTerms(query);
  let index = -1;
  if (terms.length) {
    for (const term of terms) {
      const found = source.toLowerCase().indexOf(term);
      if (found >= 0 && (index < 0 || found < index)) index = found;
    }
  }
  let start = index > 90 ? index - 90 : 0;
  let end = Math.min(source.length, start + maxLength);
  if (end - start < maxLength && start > 0) {
    start = Math.max(0, end - maxLength);
  }
  let snippet = source.slice(start, end);
  if (start > 0) snippet = `…${snippet}`;
  if (end < source.length) snippet = `${snippet}…`;
  return snippet;
}

function Highlight({ text, query }) {
  const terms = searchTerms(query);
  if (!terms.length) return text;
  const regex = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi');
  const pieces = String(text).split(regex);
  return pieces.map((piece, index) =>
    index % 2 === 1 ? <mark key={`${piece}-${index}`}>{piece}</mark> : piece,
  );
}

function relativeTime(timestamp, now) {
  const diff = Math.max(0, now - timestamp);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;

  const date = new Date(timestamp);
  const current = new Date(now);
  const sameDay =
    date.getFullYear() === current.getFullYear() &&
    date.getMonth() === current.getMonth() &&
    date.getDate() === current.getDate();
  const time = date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  if (sameDay) return time;

  const yesterday = new Date(current);
  yesterday.setDate(current.getDate() - 1);
  if (
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()
  ) {
    return `昨天 ${time}`;
  }

  const datePart =
    date.getFullYear() === current.getFullYear()
      ? date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
      : date.toLocaleDateString('zh-CN', {
          year: 'numeric',
          month: 'numeric',
          day: 'numeric',
        });
  return `${datePart} ${time}`;
}

function formatBytes(bytes) {
  if (!bytes || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function prettyHotkey(accelerator) {
  if (!accelerator) return '未设置';
  return accelerator
    .replace(/CommandOrControl|CmdOrCtrl/gi, 'Ctrl')
    .replace(/\bControl\b/gi, 'Ctrl')
    .replace(/\bCommand\b/gi, 'Cmd')
    .replace(/\bOption\b/gi, 'Alt')
    .replace(/\bReturn\b/gi, 'Enter')
    .replace(/\bEsc\b/gi, 'Esc')
    .split('+')
    .join(' + ');
}

function acceleratorFromEvent(event) {
  if (MODIFIER_KEYS.has(event.key) || event.isComposing) return null;
  if (!event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) return null;

  const modifiers = [];
  if (event.ctrlKey) modifiers.push('Ctrl');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  if (event.metaKey) modifiers.push('Super');

  let key = '';
  if (/^[a-z]$/i.test(event.key)) {
    key = event.key.toUpperCase();
  } else if (/^[0-9]$/.test(event.key)) {
    key = event.key;
  } else if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(event.key)) {
    key = event.key.toUpperCase();
  } else {
    const map = {
      ' ': 'Space',
      ArrowUp: 'Up',
      ArrowDown: 'Down',
      ArrowLeft: 'Left',
      ArrowRight: 'Right',
      Escape: 'Esc',
      Enter: 'Return',
      Backspace: 'Backspace',
      Tab: 'Tab',
      Delete: 'Delete',
      Insert: 'Insert',
      Home: 'Home',
      End: 'End',
      PageUp: 'PageUp',
      PageDown: 'PageDown',
      '`': '`',
      '-': '-',
      '=': '=',
      '[': '[',
      ']': ']',
      '\\': '\\',
      ';': ';',
      "'": "'",
      ',': ',',
      '.': '.',
      '/': '/',
    };
    key = map[event.key] || '';
  }

  if (!key) return null;
  if (!modifiers.length) return null;
  return [...modifiers, key].join('+');
}

function describeKeyEvent(event) {
  const parts = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Win');
  if (!MODIFIER_KEYS.has(event.key)) {
    const label = event.key === ' ' ? 'Space' : event.key;
    parts.push(label.length === 1 ? label.toUpperCase() : label);
  }
  return parts.join(' + ');
}

function Logo() {
  return (
    <div className="brand-logo" aria-hidden="true">
      <svg viewBox="0 0 32 32" fill="none">
        <rect x="9.5" y="5.5" width="15" height="19" rx="4" fill="white" opacity="0.42" />
        <rect x="6.5" y="9.5" width="16" height="18" rx="4.5" fill="white" opacity="0.96" />
        <path
          d="M12 14.5H17.2M12 18.2H19.5M12 21.9H16.2"
          stroke="#6D63E8"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}

function Toggle({ checked, onChange, disabled = false, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`toggle ${checked ? 'is-on' : ''}`}
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
    >
      <span className="toggle-thumb" />
    </button>
  );
}

function SettingRow({ Icon, title, description, children, stacked = false }) {
  return (
    <div className={`setting-row ${stacked ? 'is-stacked' : ''}`}>
      <div className="setting-label">
        <span className="setting-icon">
          <Icon size={15} strokeWidth={2} />
        </span>
        <span className="setting-copy">
          <span className="setting-title">{title}</span>
          {description ? <span className="setting-desc">{description}</span> : null}
        </span>
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function HistoryItem({
  item,
  selected,
  query,
  now,
  onActivate,
  onPin,
  onDelete,
  onPreview,
  onContextMenu,
}) {
  const isImage = item.type === 'image';
  return (
    <article
      className={`history-item ${selected ? 'is-selected' : ''} ${
        item.pinned ? 'is-pinned' : ''
      } ${isImage ? 'is-image' : 'is-text'}`}
      data-item-id={item.id}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      onClick={() => onActivate(item)}
      onMouseEnter={() => onPreview.hover(item.id)}
      onContextMenu={(event) => onContextMenu(event, item)}
    >
      {isImage ? (
        <button
          type="button"
          className="image-thumb"
          onClick={(event) => {
            event.stopPropagation();
            onPreview.open(item);
          }}
          title="预览图片"
          aria-label="预览图片"
        >
          <img src={item.preview} alt="" draggable="false" loading="lazy" decoding="async" />
          <span className="image-eye">
            <Eye size={13} />
          </span>
        </button>
      ) : (
        <span className="type-marker" aria-hidden="true">
          <Type size={12} strokeWidth={2.2} />
        </span>
      )}

      <div className="item-content">
        {isImage ? (
          <>
            <div className="image-heading">
              <span>图片</span>
              <span className="image-size">
                {item.width} × {item.height}
              </span>
            </div>
            <div className="item-meta">
              <span>{relativeTime(item.createdAt, now)}</span>
              <span className="meta-dot">·</span>
              <span>{formatBytes(item.bytes)}</span>
            </div>
          </>
        ) : (
          <>
            <p className="snippet">
              <Highlight text={getSnippet(item.text, query)} query={query} />
            </p>
            <div className="item-meta">
              <span>{relativeTime(item.createdAt, now)}</span>
              <span className="meta-dot">·</span>
              <span>{item.textLength.toLocaleString('zh-CN')} 字符</span>
              {item.rich ? <span className="meta-badge">富文本</span> : null}
              {item.pinned ? (
                <span className="pinned-badge">
                  <Pin size={10} />
                  已固定
                </span>
              ) : null}
            </div>
          </>
        )}
      </div>

      <div className="item-actions">
        {isImage ? (
          <button
            type="button"
            className="mini-button"
            title="预览图片"
            aria-label="预览图片"
            onClick={(event) => {
              event.stopPropagation();
              onPreview.open(item);
            }}
          >
            <Eye size={14} />
          </button>
        ) : null}
        <button
          type="button"
          className={`mini-button pin-button ${item.pinned ? 'is-active' : ''}`}
          title={item.pinned ? '取消固定' : '固定'}
          aria-label={item.pinned ? '取消固定' : '固定'}
          onClick={(event) => {
            event.stopPropagation();
            onPin(item);
          }}
        >
          {item.pinned ? <PinOff size={14} /> : <Pin size={14} />}
        </button>
        <button
          type="button"
          className="mini-button danger-button"
          title="删除"
          aria-label="删除"
          onClick={(event) => {
            event.stopPropagation();
            onDelete(item);
          }}
        >
          <Trash2 size={14} />
        </button>
      </div>
    </article>
  );
}

function App() {
  const [items, setItems] = useState([]);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [meta, setMeta] = useState(DEFAULT_META);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('history');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [selectedId, setSelectedId] = useState(null);
  const [toast, setToast] = useState(null);
  const [previewId, setPreviewId] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [recording, setRecording] = useState(false);
  const [recordDisplay, setRecordDisplay] = useState('');
  const [recordHint, setRecordHint] = useState('');
  const [clearArmed, setClearArmed] = useState(false);
  const [panelEpoch, setPanelEpoch] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [systemDark, setSystemDark] = useState(() =>
    window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)').matches : true,
  );

  const appRef = useRef(null);
  const searchRef = useRef(null);
  const listRef = useRef(null);
  const settingsScrollRef = useRef(null);
  const toastTimerRef = useRef(null);
  const clearTimerRef = useRef(null);
  const savingHotkeyRef = useRef(false);

  const showToast = useCallback((message, type = 'info') => {
    if (!message) return;
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ message, type, id: `${Date.now()}-${Math.random()}` });
    toastTimerRef.current = setTimeout(() => setToast(null), 2800);
  }, []);

  const applyState = useCallback((state) => {
    const nextItems = Array.isArray(state?.items) ? state.items : [];
    setItems(nextItems);
    setSettings({ ...DEFAULT_SETTINGS, ...(state?.settings || {}) });
    setMeta({ ...DEFAULT_META, ...(state?.meta || {}) });
    setPaused(Boolean(state?.meta?.paused));
    setSelectedId((current) =>
      nextItems.some((item) => item.id === current) ? current : nextItems[0]?.id || null,
    );
  }, []);

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const state = await window.clipnest.getState();
        if (!disposed) applyState(state);
      } catch (error) {
        if (!disposed) {
          showToast('无法读取剪贴板数据', 'error');
          console.error(error);
        }
      } finally {
        if (!disposed) setLoading(false);
      }
    };
    refresh();

    const unsubscribers = [
      window.clipnest.onHistoryChanged((nextItems) => {
        if (disposed) return;
        setLoading(false);
        setItems(nextItems);
        setSelectedId((current) =>
          nextItems.some((item) => item.id === current)
            ? current
            : nextItems[0]?.id || null,
        );
      }),
      window.clipnest.onSettingsChanged((nextSettings) => {
        if (!disposed) setSettings({ ...DEFAULT_SETTINGS, ...nextSettings });
      }),
      window.clipnest.onMetaChanged((nextMeta) => {
        if (disposed) return;
        setMeta((current) => ({ ...current, ...nextMeta }));
        if (typeof nextMeta.paused === 'boolean') setPaused(nextMeta.paused);
      }),
      window.clipnest.onPausedChanged((value) => {
        if (!disposed) setPaused(Boolean(value));
      }),
      window.clipnest.onPanelShown(() => {
        if (disposed) return;
        setPanelEpoch((value) => value + 1);
        setView('history');
        setQuery('');
        setFilter('all');
        setPreviewId(null);
        setContextMenu(null);
        setClearArmed(false);
        setRecording(false);
        setRecordDisplay('');
        setRecordHint('');
        setSelectedId(null);
        refresh();
        requestAnimationFrame(() => searchRef.current?.focus());
      }),
      window.clipnest.onOpenSettings(() => {
        if (disposed) return;
        setView('settings');
      }),
    ];

    return () => {
      disposed = true;
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [applyState, showToast]);

  useEffect(() => {
    document.documentElement.dataset.theme =
      settings.theme === 'system' ? (systemDark ? 'dark' : 'light') : settings.theme;
  }, [settings.theme, systemDark]);

  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = (event) => setSystemDark(event.matches);
    media.addEventListener?.('change', listener);
    return () => media.removeEventListener?.('change', listener);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const app = appRef.current;
    if (!app) return undefined;
    app.classList.remove('is-entering');
    void app.offsetWidth;
    app.classList.add('is-entering');
    const timer = setTimeout(() => app.classList.remove('is-entering'), 260);
    return () => clearTimeout(timer);
  }, [panelEpoch]);

  useEffect(() => {
    if (view !== 'settings') return;
    settingsScrollRef.current?.scrollTo({ top: 0 });
    setClearArmed(false);
  }, [view]);

  useEffect(() => {
    if (view !== 'history') return undefined;
    const timer = setTimeout(() => searchRef.current?.focus(), 40);
    return () => clearTimeout(timer);
  }, [view, panelEpoch]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    };
  }, []);

  const terms = useMemo(() => searchTerms(query), [query]);

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      if (filter === 'text' && item.type !== 'text') return false;
      if (filter === 'image' && item.type !== 'image') return false;
      if (filter === 'pinned' && !item.pinned) return false;
      return itemMatches(item, terms);
    });
  }, [items, filter, terms]);

  const selectedItem =
    filteredItems.find((item) => item.id === selectedId) || filteredItems[0] || null;
  const previewItem = items.find((item) => item.id === previewId) || null;
  const pinnedCount = items.filter((item) => item.pinned).length;
  const counts = {
    all: items.length,
    text: items.filter((item) => item.type === 'text').length,
    image: items.filter((item) => item.type === 'image').length,
    pinned: pinnedCount,
  };

  useEffect(() => {
    if (view !== 'history') return;
    setSelectedId((current) =>
      filteredItems.some((item) => item.id === current)
        ? current
        : filteredItems[0]?.id || null,
    );
  }, [filteredItems, view]);

  useEffect(() => {
    if (!selectedId || !listRef.current) return;
    const node = listRef.current.querySelector(`[data-item-id="${selectedId}"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }, [selectedId, view, filter, query]);

  useEffect(() => {
    if (!contextMenu) return undefined;
    const close = () => setContextMenu(null);
    window.addEventListener('mousedown', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('resize', close);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!clearArmed) return undefined;
    clearTimerRef.current = setTimeout(() => setClearArmed(false), 4200);
    return () => clearTimeout(clearTimerRef.current);
  }, [clearArmed]);

  const activateItem = useCallback(
    async (item) => {
      if (!item) return;
      try {
        const result = await window.clipnest.copyItem(item.id);
        if (!result?.ok) showToast(result?.error || '复制失败', 'error');
      } catch {
        showToast('复制失败', 'error');
      }
    },
    [showToast],
  );

  const copyAsPlainText = useCallback(
    async (item) => {
      if (!item) return;
      try {
        const result = await window.clipnest.copyItem(item.id, { plain: true });
        if (!result?.ok) showToast(result?.error || '复制失败', 'error');
      } catch {
        showToast('复制失败', 'error');
      }
    },
    [showToast],
  );

  const togglePin = useCallback(
    async (item) => {
      if (!item) return;
      const result = await window.clipnest.pinItem(item.id);
      if (!result?.ok) showToast(result?.error || '操作失败', 'error');
    },
    [showToast],
  );

  const deleteItem = useCallback(
    async (item) => {
      if (!item) return;
      const result = await window.clipnest.deleteItem(item.id);
      if (result?.ok) {
        showToast('已删除', 'success');
        if (previewId === item.id) setPreviewId(null);
      } else {
        showToast(result?.error || '删除失败', 'error');
      }
    },
    [previewId, showToast],
  );

  const patchSettings = useCallback(
    async (patch) => {
      try {
        const result = await window.clipnest.updateSettings(patch);
        if (!result?.ok) {
          showToast(result?.error || '设置保存失败', 'error');
          return false;
        }
        setSettings(result.settings);
        if (result.meta) setMeta((current) => ({ ...current, ...result.meta }));
        return true;
      } catch {
        showToast('设置保存失败', 'error');
        return false;
      }
    },
    [showToast],
  );

  const togglePause = useCallback(async () => {
    const result = await window.clipnest.togglePause();
    if (result?.ok) {
      setPaused(Boolean(result.paused));
      showToast(result.paused ? '记录已暂停' : '已恢复记录', 'info');
    }
  }, [showToast]);

  const cancelRecording = useCallback(async () => {
    setRecording(false);
    setRecordDisplay('');
    setRecordHint('');
    await window.clipnest.resumeHotkey();
  }, []);

  const commitHotkey = useCallback(
    async (accelerator) => {
      if (savingHotkeyRef.current) return;
      savingHotkeyRef.current = true;
      try {
        const result = await window.clipnest.setHotkey(accelerator);
        if (result?.ok) {
          setSettings((current) => ({ ...current, hotkey: accelerator }));
          if (result.meta) setMeta((current) => ({ ...current, ...result.meta }));
          setRecording(false);
          setRecordDisplay('');
          setRecordHint('');
          showToast('快捷键已更新', 'success');
        } else {
          setRecordHint(result?.error || '快捷键不可用');
          setRecordDisplay('');
        }
      } catch {
        setRecordHint('快捷键保存失败');
      } finally {
        savingHotkeyRef.current = false;
      }
    },
    [showToast],
  );

  const beginRecording = useCallback(async () => {
    const result = await window.clipnest.suspendHotkey();
    if (result?.ok) {
      setRecording(true);
      setRecordDisplay('');
      setRecordHint('请按下包含 Ctrl、Alt 或 Shift 的组合键');
    }
  }, []);

  const goBack = useCallback(() => {
    if (recording) {
      cancelRecording();
    }
    setView('history');
    setClearArmed(false);
    setContextMenu(null);
    setPreviewId(null);
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [cancelRecording, recording]);

  const clearHistory = useCallback(async () => {
    if (!clearArmed) {
      setClearArmed(true);
      return;
    }
    const result = await window.clipnest.clearHistory();
    if (result?.ok) {
      setItems([]);
      setSelectedId(null);
      setClearArmed(false);
      showToast('历史已清空', 'success');
    } else {
      showToast('清空失败', 'error');
    }
  }, [clearArmed, showToast]);

  const focusSearch = useCallback(() => {
    if (view !== 'history') setView('history');
    setContextMenu(null);
    setTimeout(() => {
      searchRef.current?.focus();
      searchRef.current?.select();
    }, 20);
  }, [view]);

  const moveSelection = useCallback(
    (delta) => {
      if (!filteredItems.length) return;
      const currentIndex = filteredItems.findIndex((item) => item.id === selectedId);
      const startIndex = currentIndex < 0 ? 0 : currentIndex;
      const nextIndex = Math.max(
        0,
        Math.min(filteredItems.length - 1, startIndex + delta),
      );
      setSelectedId(filteredItems[nextIndex].id);
    },
    [filteredItems, selectedId],
  );

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.isComposing) return;

      if (recording) {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'Escape') {
          cancelRecording();
          return;
        }
        const display = describeKeyEvent(event);
        const accelerator = acceleratorFromEvent(event);
        setRecordDisplay(display);
        if (accelerator) {
          setRecordHint('');
          commitHotkey(accelerator);
        } else if (!MODIFIER_KEYS.has(event.key)) {
          setRecordHint('组合键需要包含 Ctrl、Alt 或 Shift');
        }
        return;
      }

      if (event.key === 'Escape') {
        if (contextMenu) {
          setContextMenu(null);
          return;
        }
        if (previewId) {
          setPreviewId(null);
          return;
        }
        if (view === 'settings') {
          goBack();
          return;
        }
        if (query) {
          setQuery('');
          return;
        }
        window.clipnest.hidePanel();
        return;
      }

      if (previewId) {
        if (event.key === 'Enter') {
          const item = items.find((entry) => entry.id === previewId);
          if (item) {
            event.preventDefault();
            setPreviewId(null);
            activateItem(item);
          }
        }
        return;
      }
      if (contextMenu) return;
      if (view === 'settings') return;

      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        focusSearch();
        return;
      }
      if (modifier && event.key.toLowerCase() === 'p' && selectedItem) {
        event.preventDefault();
        togglePin(selectedItem);
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveSelection(1);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveSelection(-1);
        return;
      }
      if (event.key === 'Home') {
        event.preventDefault();
        if (filteredItems[0]) setSelectedId(filteredItems[0].id);
        return;
      }
      if (event.key === 'End') {
        event.preventDefault();
        if (filteredItems.length) {
          setSelectedId(filteredItems[filteredItems.length - 1].id);
        }
        return;
      }
      if (event.key === 'Enter' && selectedItem) {
        const target = event.target;
        if (
          target instanceof HTMLElement &&
          (target.closest('button') || target.tagName === 'SELECT')
        ) {
          return;
        }
        event.preventDefault();
        activateItem(selectedItem);
        return;
      }
      if (event.key === 'Delete' && (event.shiftKey || event.ctrlKey) && selectedItem) {
        event.preventDefault();
        deleteItem(selectedItem);
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [
    activateItem,
    cancelRecording,
    commitHotkey,
    contextMenu,
    deleteItem,
    filteredItems,
    focusSearch,
    goBack,
    items,
    moveSelection,
    previewId,
    query,
    recording,
    selectedItem,
    togglePin,
    view,
  ]);

  const openContextMenu = useCallback((event, item) => {
    event.preventDefault();
    event.stopPropagation();
    setSelectedId(item.id);
    const width = 190;
    const estimatedHeight = item.type === 'image' ? 224 : 190;
    setContextMenu({
      item,
      x: Math.min(event.clientX, window.innerWidth - width - 14),
      y: Math.min(event.clientY, window.innerHeight - estimatedHeight - 14),
    });
  }, []);

  const previewActions = useMemo(
    () => ({
      open: (item) => {
        setPreviewId(item.id);
        setContextMenu(null);
      },
      hover: (id) => setSelectedId(id),
    }),
    [],
  );

  const itemActions = useMemo(
    () => ({
      onActivate: activateItem,
      onPin: togglePin,
      onDelete: deleteItem,
      onPreview: previewActions,
      onContextMenu: openContextMenu,
    }),
    [activateItem, deleteItem, openContextMenu, previewActions, togglePin],
  );

  const resetFilters = () => {
    setQuery('');
    setFilter('all');
    requestAnimationFrame(() => searchRef.current?.focus());
  };

  const canClear = items.length > 0;

  return (
    <div className="shell" ref={appRef}>
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <header className="titlebar">
        <div className="brand">
          <Logo />
          <div className="brand-copy">
            <span className="brand-name">ClipNest</span>
            <span className="brand-sub">
              {view === 'settings' ? '设置' : paused ? '记录已暂停' : '剪贴板历史'}
            </span>
          </div>
        </div>
        <div className="titlebar-actions">
          {view === 'history' ? (
            <>
              <button
                type="button"
                className={`icon-button ${paused ? 'is-accent' : ''}`}
                title={paused ? '恢复记录' : '暂停记录'}
                aria-label={paused ? '恢复记录' : '暂停记录'}
                onClick={togglePause}
              >
                {paused ? <Play size={16} /> : <Pause size={16} />}
              </button>
              <button
                type="button"
                className="icon-button"
                title="设置"
                aria-label="设置"
                onClick={() => {
                  setView('settings');
                  setContextMenu(null);
                }}
              >
                <SettingsIcon size={16} />
              </button>
            </>
          ) : (
            <button type="button" className="back-button" onClick={goBack}>
              <ChevronLeft size={16} />
              返回
            </button>
          )}
        </div>
      </header>

      {view === 'history' ? (
        <>
          <div className="search-area">
            <div className="search-box">
              <Search size={16} className="search-icon" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索剪贴板…"
                spellCheck={false}
                autoComplete="off"
                aria-label="搜索剪贴板"
              />
              {query ? (
                <button
                  type="button"
                  className="clear-search"
                  onClick={() => {
                    setQuery('');
                    searchRef.current?.focus();
                  }}
                  aria-label="清除搜索"
                >
                  <X size={14} />
                </button>
              ) : (
                <span className="search-hint">Ctrl F</span>
              )}
            </div>

            <div className="filter-row" role="tablist" aria-label="筛选剪贴板">
              {FILTERS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={filter === entry.id}
                  className={`filter-chip ${filter === entry.id ? 'is-active' : ''}`}
                  onClick={() => setFilter(entry.id)}
                >
                  {entry.label}
                  <span className="filter-count">{counts[entry.id]}</span>
                </button>
              ))}
            </div>
          </div>

          {paused ? (
            <div className="pause-banner">
              <span className="pause-pulse" />
              <span>暂停记录中，新的复制内容不会保存</span>
              <button type="button" onClick={togglePause}>
                恢复
              </button>
            </div>
          ) : null}

          <main className="list-area" ref={listRef} role="listbox" aria-label="剪贴板历史">
            {loading ? (
              <div className="skeleton-list" aria-label="正在加载">
                {[0, 1, 2, 3, 4].map((index) => (
                  <div className="skeleton-item" key={index}>
                    <span className="skeleton-line wide" />
                    <span className="skeleton-line short" />
                  </div>
                ))}
              </div>
            ) : filteredItems.length ? (
              filteredItems.map((item) => (
                <HistoryItem
                  key={item.id}
                  item={item}
                  selected={selectedItem?.id === item.id}
                  query={query}
                  now={now}
                  onActivate={itemActions.onActivate}
                  onPin={itemActions.onPin}
                  onDelete={itemActions.onDelete}
                  onPreview={itemActions.onPreview}
                  onContextMenu={itemActions.onContextMenu}
                />
              ))
            ) : (
              <div className="empty-state">
                <div className="empty-art">
                  <span className="empty-sheet sheet-back" />
                  <span className="empty-sheet sheet-middle" />
                  <span className="empty-sheet sheet-front">
                    <Clipboard size={27} strokeWidth={1.7} />
                  </span>
                  <Sparkles size={15} className="empty-spark" />
                </div>
                <h2>
                  {query || filter !== 'all'
                    ? '没有找到匹配内容'
                    : paused
                      ? '记录已暂停'
                      : '复制点什么吧'}
                </h2>
                <p>
                  {query || filter !== 'all'
                    ? '换个关键词，或者清除筛选条件再试试。'
                    : paused
                      ? '恢复记录后，新复制的文字和图片会出现在这里。'
                      : '文字、截图和图片会自动保存在本机。'}
                </p>
                {query || filter !== 'all' ? (
                  <button type="button" className="empty-action" onClick={resetFilters}>
                    清除筛选
                  </button>
                ) : (
                  <div className="empty-hotkey">
                    <kbd>{prettyHotkey(meta.activeHotkey || settings.hotkey)}</kbd>
                    <span>随时唤起</span>
                  </div>
                )}
              </div>
            )}
          </main>

          <footer className="footer">
            <div className="footer-count">
              <span>{filteredItems.length}</span> 条
              {pinnedCount > 0 ? <span className="footer-pin">· {pinnedCount} 固定</span> : null}
            </div>
            <div className="footer-hints">
              <span>
                <kbd>
                  <ArrowUp size={9} />
                  <ArrowDown size={9} />
                </kbd>
                选择
              </span>
              <span>
                <kbd>
                  <CornerDownLeft size={9} />
                </kbd>
                复制
              </span>
              <span>
                <kbd>Esc</kbd>
                关闭
              </span>
            </div>
          </footer>
        </>
      ) : (
        <main className="settings-view">
          <div className="settings-scroll" ref={settingsScrollRef}>
            <section className="settings-section">
              <div className="section-heading">
                <span>通用</span>
              </div>

              <SettingRow
                Icon={Power}
                title="开机启动"
                description={
                  meta.canAutoStart
                    ? '登录 Windows 后在托盘中静默运行'
                    : '安装版可用，开发模式下不可用'
                }
              >
                <Toggle
                  label="开机启动"
                  checked={settings.autoStart}
                  disabled={!meta.canAutoStart}
                  onChange={(value) => patchSettings({ autoStart: value })}
                />
              </SettingRow>

              <SettingRow
                Icon={Keyboard}
                title="全局快捷键"
                description={recording ? '按下组合键以替换，Esc 取消' : '在任何应用中快速唤起'}
                stacked
              >
                <button
                  type="button"
                  className={`hotkey-button ${recording ? 'is-recording' : ''}`}
                  onClick={recording ? cancelRecording : beginRecording}
                >
                  {recording ? (
                    recordDisplay || '请按组合键…'
                  ) : (
                    <kbd>{prettyHotkey(settings.hotkey)}</kbd>
                  )}
                  {recording ? <X size={13} /> : <Keyboard size={13} />}
                </button>
              </SettingRow>
              {recording ? <div className="inline-hint">{recordHint}</div> : null}
              {!recording && !meta.hotkeyActive ? (
                <div className="inline-warning">
                  <AlertCircle size={13} />
                  快捷键未生效，可能已被其他程序占用，请重新设置。
                </div>
              ) : null}

              <SettingRow Icon={Sun} title="外观" stacked>
                <div className="segmented">
                  {THEME_OPTIONS.map(({ id, label, Icon }) => (
                    <button
                      key={id}
                      type="button"
                      className={settings.theme === id ? 'is-active' : ''}
                      onClick={() => patchSettings({ theme: id })}
                    >
                      <Icon size={13} />
                      {label}
                    </button>
                  ))}
                </div>
              </SettingRow>
            </section>

            <section className="settings-section">
              <div className="section-heading">
                <span>记录与复制</span>
              </div>

              <SettingRow
                Icon={ImageIcon}
                title="记录图片"
                description="保存截图和复制的图片，并生成缩略图"
              >
                <Toggle
                  label="记录图片"
                  checked={settings.captureImages}
                  onChange={(value) => patchSettings({ captureImages: value })}
                />
              </SettingRow>

              <SettingRow
                Icon={Type}
                title="保留富文本格式"
                description="粘贴到支持格式的应用时保留样式"
              >
                <Toggle
                  label="保留富文本格式"
                  checked={settings.richText}
                  onChange={(value) => patchSettings({ richText: value })}
                />
              </SettingRow>

              <SettingRow
                Icon={Zap}
                title="选中后自动粘贴"
                description="模拟 Ctrl+V 粘贴到上一个窗口（实验性）"
              >
                <Toggle
                  label="选中后自动粘贴"
                  checked={settings.pasteOnSelect}
                  onChange={(value) => patchSettings({ pasteOnSelect: value })}
                />
              </SettingRow>

              <SettingRow
                Icon={Database}
                title="最多保留"
                description="已固定的项目不占用条数限制"
              >
                <select
                  className="select-control"
                  value={settings.maxItems}
                  onChange={(event) =>
                    patchSettings({ maxItems: Number(event.target.value) })
                  }
                >
                  <option value={100}>100 条</option>
                  <option value={300}>300 条</option>
                  <option value={500}>500 条</option>
                  <option value={1000}>1000 条</option>
                  <option value={2000}>2000 条</option>
                </select>
              </SettingRow>

              <SettingRow Icon={Clock} title="自动清理" description="到期后删除未固定的记录">
                <select
                  className="select-control"
                  value={settings.retentionDays}
                  onChange={(event) =>
                    patchSettings({ retentionDays: Number(event.target.value) })
                  }
                >
                  <option value={0}>永久保留</option>
                  <option value={1}>1 天后</option>
                  <option value={7}>7 天后</option>
                  <option value={30}>30 天后</option>
                  <option value={90}>90 天后</option>
                </select>
              </SettingRow>
            </section>

            <section className="settings-section">
              <div className="section-heading">
                <span>隐私与存储</span>
              </div>

              <SettingRow
                Icon={Pause}
                title="记录状态"
                description={paused ? '新的复制内容不会被保存' : '正在后台记录剪贴板'}
              >
                <button
                  type="button"
                  className={`secondary-button ${paused ? 'is-accent' : ''}`}
                  onClick={togglePause}
                >
                  {paused ? (
                    <>
                      <Play size={13} /> 恢复
                    </>
                  ) : (
                    <>
                      <Pause size={13} /> 暂停
                    </>
                  )}
                </button>
              </SettingRow>

              <SettingRow
                Icon={Shield}
                title="只保存在本机"
                description="不上传云端，不访问网络"
              >
                <span className="local-badge">
                  <Check size={11} /> 本地
                </span>
              </SettingRow>

              <SettingRow
                Icon={HardDrive}
                title="占用空间"
                description={`${items.length} 条记录 · ${formatBytes(meta.storageBytes)}`}
              >
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => window.clipnest.openDataFolder()}
                >
                  <FolderOpen size={13} /> 文件夹
                </button>
              </SettingRow>

              <div className="danger-row">
                <div>
                  <div className="danger-title">清空剪贴板历史</div>
                  <div className="danger-desc">删除所有文字、图片和固定项目</div>
                </div>
                <button
                  type="button"
                  className={`danger-action ${clearArmed ? 'is-armed' : ''}`}
                  disabled={!canClear}
                  onClick={clearHistory}
                >
                  <Trash2 size={13} />
                  {clearArmed ? '确认清空' : '清空'}
                </button>
              </div>
            </section>

            <section className="settings-section about-section">
              <div className="section-heading">
                <span>关于</span>
              </div>
              <div className="about-card">
                <div className="about-logo">
                  <Logo />
                </div>
                <div className="about-copy">
                  <div className="about-title">
                    ClipNest
                    <span className="version-badge">v{meta.version || '1.0.0'}</span>
                  </div>
                  <p>一个轻巧、漂亮的本地剪贴板历史工具。</p>
                </div>
              </div>
              <div className="about-links">
                <button type="button" onClick={() => window.clipnest.openDataFolder()}>
                  <FolderOpen size={12} /> 数据目录
                </button>
                <button type="button" onClick={() => window.clipnest.quit()}>
                  <Power size={12} /> 退出 ClipNest
                </button>
              </div>
              <div className="about-note">
                <Info size={12} />
                © 2026 wth · 所有剪贴板内容仅存储在你的电脑上。
              </div>
            </section>
          </div>
        </main>
      )}

      {contextMenu ? (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
          role="menu"
        >
          <button
            type="button"
            onClick={() => {
              setContextMenu(null);
              activateItem(contextMenu.item);
            }}
          >
            <Copy size={14} />
            复制
          </button>
          {contextMenu.item.type === 'text' ? (
            <button
              type="button"
              onClick={() => {
                setContextMenu(null);
                copyAsPlainText(contextMenu.item);
              }}
            >
              <Type size={14} />
              以纯文本复制
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setPreviewId(contextMenu.item.id);
                setContextMenu(null);
              }}
            >
              <Eye size={14} />
              预览图片
            </button>
          )}
          <div className="menu-separator" />
          <button
            type="button"
            onClick={() => {
              setContextMenu(null);
              togglePin(contextMenu.item);
            }}
          >
            {contextMenu.item.pinned ? <PinOff size={14} /> : <Pin size={14} />}
            {contextMenu.item.pinned ? '取消固定' : '固定'}
          </button>
          <button
            type="button"
            className="is-danger"
            onClick={() => {
              setContextMenu(null);
              deleteItem(contextMenu.item);
            }}
          >
            <Trash2 size={14} />
            删除
          </button>
        </div>
      ) : null}

      {previewItem ? (
        <div className="preview-overlay" onClick={() => setPreviewId(null)}>
          <div className="preview-card" onClick={(event) => event.stopPropagation()}>
            <header className="preview-header">
              <div>
                <strong>图片预览</strong>
                <span>
                  {previewItem.width} × {previewItem.height} · {formatBytes(previewItem.bytes)}
                </span>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setPreviewId(null)}
                aria-label="关闭预览"
              >
                <X size={16} />
              </button>
            </header>
            <div className="preview-stage">
              <img src={previewItem.image} alt="剪贴板图片预览" draggable="false" />
            </div>
            <footer className="preview-footer">
              <span>{relativeTime(previewItem.createdAt, now)}</span>
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  setPreviewId(null);
                  activateItem(previewItem);
                }}
              >
                <Copy size={14} />
                复制图片
              </button>
            </footer>
          </div>
        </div>
      ) : null}

      {toast ? (
        <div className={`toast ${toast.type}`} role="status" aria-live="polite">
          {toast.type === 'error' ? (
            <AlertCircle size={14} />
          ) : toast.type === 'success' ? (
            <Check size={14} />
          ) : (
            <Info size={14} />
          )}
          {toast.message}
        </div>
      ) : null}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
