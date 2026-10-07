/**
 * 应用状态（zustand）：启动时载入数据，变更后持久化。
 *
 * 双驱动（需求 §7 / M10 §1）：
 * - 客户端模式（纯前端）：与历史行为一致，纯 IndexedDB（键 `reminderweb:data`），不发任何 /api 请求；
 * - 服务器模式：以服务器为准，IndexedDB 仅作只读缓存（键 `reminderweb:cache`），
 *   写操作走 `PUT /api/data`，成功后采纳服务器返回的权威数据。
 *
 * 判据：运行模式由 `lib/app-mode` 按 config.json > VITE_APP_MODE > 探测 `/api/health` 决定。
 */
import { create } from 'zustand';
import type { ReminderItem, TagItem } from '../types/reminder';
import {
  DEFAULT_SETTINGS,
  clearAllData,
  loadPersistedData,
  savePersistedData,
  type AppSettings,
} from '../lib/storage';
import {
  fetchData,
  fetchVersion,
  isUnauthorized,
  login as apiLogin,
  logout as apiLogout,
  probeHealth,
  pushData,
  ssoLoginUrl,
  type AuthMode,
  type PushPayload,
  type ServerSnapshot,
  type SyncReminder,
  type SyncSettings,
  type SyncTag,
  type SyncTombstone,
} from '../lib/api';
import { detectAppMode } from '../lib/app-mode';
import {
  LOCAL_ONLY_SETTING_KEYS,
  loadServerCache,
  mergeServerSettings,
  normalizeSnapshot,
  saveServerCache,
  syncedSettings,
} from '../lib/server-storage';

const DEFAULT_TAG_COLORS = ['#2196F3', '#E91E63', '#4CAF50', '#FF9800', '#9C27B0', '#009688'];

export type StorageMode = 'unknown' | 'client' | 'server';

export interface ServerInfo {
  revision: number | null;
  version: string | null;
  schemaVersion: number | null;
  username: string | null;
  authMode: AuthMode | null;
}

interface ReminderStore {
  reminders: ReminderItem[];
  tags: TagItem[];
  settings: AppSettings;
  loaded: boolean;

  mode: StorageMode;
  authMode: AuthMode | null;
  serverUser: string | null;
  revision: number | null;
  serverVersion: string | null;
  syncing: boolean;
  /** 有尚未成功推送到服务器的本机改动。 */
  dirty: boolean;
  syncError: string | null;
  /** builtin 模式下需要登录（会话失效或尚未登录）。 */
  authRequired: boolean;
  /** 首次连接：服务器为空而本机有旧数据，可一键上传。 */
  canUploadLocal: boolean;
  /** 一次性提示（如「已按服务器数据更新」）。 */
  serverNotice: string | null;
  dismissServerNotice: () => void;

  /** 内部：提醒与标签的墓碑，用于把删除同步给服务器。 */
  tombstones: SyncTombstone[];
  /** 内部：可同步设置的更新时间。 */
  settingsUpdatedAt: number;

  hydrate: () => Promise<void>;
  refresh: (force?: boolean) => Promise<void>;
  syncNow: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  uploadLocalData: () => Promise<void>;

  addReminder: (item: ReminderItem) => Promise<number>;
  updateReminder: (item: ReminderItem) => Promise<void>;
  deleteReminder: (id: number) => Promise<void>;
  togglePin: (id: number) => Promise<void>;
  findTag: (name: string) => TagItem | undefined;
  addTag: (name: string, color?: string) => Promise<TagItem | undefined>;
  updateTag: (id: number, name: string, color: string) => Promise<void>;
  deleteTag: (id: number) => Promise<void>;
  moveTag: (id: number, direction: 'up' | 'down') => Promise<void>;
  updateSettings: (partial: Partial<AppSettings>) => Promise<void>;
  importData: (data: { reminders: ReminderItem[]; tags: TagItem[]; settings?: Partial<AppSettings> }) => Promise<void>;
  resetAll: () => Promise<void>;
}

function nextNumericId(items: Array<{ id: number }>): number {
  return items.reduce((max, item) => Math.max(max, item.id), 0) + 1;
}

function withUpdatedAt<T extends { updatedAt?: number }>(item: T, at: number): T {
  return { ...item, updatedAt: at };
}

function toSyncReminder(item: ReminderItem): SyncReminder {
  const updatedAt = typeof item.updatedAt === 'number' ? item.updatedAt : 0;
  return { ...item, updatedAt };
}

function toSyncTag(item: TagItem): SyncTag {
  const updatedAt = typeof item.updatedAt === 'number' ? item.updatedAt : 0;
  return { ...item, updatedAt };
}

function isLocalMode(mode: StorageMode): boolean {
  return mode !== 'server';
}

export const useReminderStore = create<ReminderStore>((set, get) => {
  let pushing = false;
  let pushAgain = false;

  function localSnapshot(): void {
    void savePersistedData({ reminders: get().reminders, tags: get().tags, settings: get().settings });
  }

  function handleUnauthorized(): void {
    const authMode = get().authMode;
    if (authMode === 'sso') {
      const next = `${window.location.pathname}${window.location.search}`;
      window.location.assign(ssoLoginUrl(next));
      return;
    }
    set({ authRequired: true });
  }

  function adoptSnapshot(snapshot: ServerSnapshot, extra: Partial<ReminderStore> = {}): void {
    set({
      reminders: snapshot.reminders,
      tags: snapshot.tags,
      settings: mergeServerSettings(get().settings, snapshot.settings.value),
      revision: snapshot.revision,
      settingsUpdatedAt: snapshot.settings.updatedAt,
      tombstones: snapshot.tombstones,
      dirty: false,
      syncError: null,
      ...extra,
    });
    void saveServerCache(snapshot);
    localSnapshot();
  }

  function buildPayload(): PushPayload {
    const { reminders, tags, settings, revision, tombstones, settingsUpdatedAt } = get();
    const settingsEnvelope: SyncSettings = { value: syncedSettings(settings), updatedAt: settingsUpdatedAt };
    return {
      baseRevision: revision ?? 0,
      reminders: reminders.map(toSyncReminder),
      tags: tags.map(toSyncTag),
      settings: settingsEnvelope,
      tombstones,
    };
  }

  async function doPush(): Promise<void> {
    set({ syncing: true });
    try {
      const result = await pushData(buildPayload());
      const snapshot = normalizeSnapshot(result);
      adoptSnapshot(snapshot, { canUploadLocal: false });
    } catch (error) {
      if (isUnauthorized(error)) {
        set({ dirty: true, syncError: '登录状态已过期' });
        handleUnauthorized();
      } else {
        set({ dirty: true, syncError: error instanceof Error ? error.message : '同步失败，请稍后重试' });
      }
    } finally {
      set({ syncing: false });
    }
  }

  async function pushToServer(): Promise<void> {
    if (pushing) {
      pushAgain = true;
      return;
    }
    pushing = true;
    try {
      do {
        pushAgain = false;
        await doPush();
      } while (pushAgain);
    } finally {
      pushing = false;
    }
  }

  /** 数据写入统一出口：本地模式写 IndexedDB，服务器模式推送到服务器。 */
  async function persist(options: { synced: boolean }): Promise<void> {
    const mode = get().mode;
    if (isLocalMode(mode)) {
      localSnapshot();
      return;
    }
    localSnapshot();
    if (options.synced) await pushToServer();
  }

  function isSyncedSettingsChange(partial: Partial<AppSettings>): boolean {
    for (const key of Object.keys(partial)) {
      if (!LOCAL_ONLY_SETTING_KEYS.has(key as keyof AppSettings)) return true;
    }
    return false;
  }

  return {
    reminders: [],
    tags: [],
    settings: { ...DEFAULT_SETTINGS },
    loaded: false,

    mode: 'unknown',
    authMode: null,
    serverUser: null,
    revision: null,
    serverVersion: null,
    syncing: false,
    dirty: false,
    syncError: null,
    authRequired: false,
    canUploadLocal: false,
    serverNotice: null,
    dismissServerNotice: () => set({ serverNotice: null }),

    tombstones: [],
    settingsUpdatedAt: 0,

    hydrate: async () => {
      const local = await loadPersistedData();
      set({
        reminders: local.reminders,
        tags: local.tags,
        settings: local.settings,
        loaded: true,
      });

      const detection = await detectAppMode();
      if (detection.mode === 'client') {
        // 纯前端：数据存 IndexedDB，不发任何 /api 请求。
        set({ mode: 'client', authRequired: false });
        return;
      }
      set({ mode: 'server' });

      const health = detection.health ?? (await probeHealth());
      if (health === null) {
        // 显式服务器模式但后端不可达：保留服务器模式与本地数据，提示错误。
        set({ syncError: '连不上服务器，请检查网络或后端地址' });
        const fallback = await loadServerCache().catch(() => null);
        if (fallback !== null) {
          set({
            reminders: fallback.reminders,
            tags: fallback.tags,
            settings: mergeServerSettings(local.settings, fallback.settings.value),
            revision: fallback.revision,
            settingsUpdatedAt: fallback.settings.updatedAt,
            tombstones: fallback.tombstones,
          });
        }
        return;
      }
      set({ authMode: health.authMode, revision: health.revision });

      const cache = await loadServerCache().catch(() => null);
      try {
        const snapshot = normalizeSnapshot(await fetchData());
        const localHasData = local.reminders.length > 0 || local.tags.length > 0;
        const serverEmpty =
          snapshot.revision === 0 &&
          snapshot.reminders.length === 0 &&
          snapshot.tags.length === 0 &&
          Object.keys(snapshot.settings.value).length === 0;
        if (serverEmpty && localHasData) {
          // 服务器为空而本机有旧数据：保留本机显示，提示一键上传。
          set({
            settings: mergeServerSettings(local.settings, snapshot.settings.value),
            canUploadLocal: true,
            revision: snapshot.revision,
            settingsUpdatedAt: snapshot.settings.updatedAt,
            tombstones: snapshot.tombstones,
          });
        } else {
          const staleCache = cache !== null && cache.revision !== snapshot.revision;
          adoptSnapshot(snapshot, {
            canUploadLocal: false,
            ...(staleCache ? { serverNotice: '已按服务器数据更新' } : {}),
          });
        }
        void refreshVersion();
      } catch (error) {
        if (isUnauthorized(error)) {
          handleUnauthorized();
        } else {
          set({ syncError: error instanceof Error ? error.message : '读取服务器数据失败' });
        }
        if (cache !== null) {
          set({
            reminders: cache.reminders,
            tags: cache.tags,
            settings: mergeServerSettings(local.settings, cache.settings.value),
            revision: cache.revision,
            settingsUpdatedAt: cache.settings.updatedAt,
            tombstones: cache.tombstones,
          });
        }
      }
    },

    refresh: async (force = false) => {
      if (get().mode !== 'server') return;
      // 本机有未同步改动时不动，避免覆盖用户编辑。
      if (get().dirty && !force) return;
      try {
        const snapshot = normalizeSnapshot(await fetchData());
        if (!force && get().revision === snapshot.revision) return;
        adoptSnapshot(snapshot);
        void refreshVersion();
      } catch (error) {
        if (isUnauthorized(error)) {
          handleUnauthorized();
          return;
        }
        set({ syncError: error instanceof Error ? error.message : '同步失败，请稍后重试' });
      }
    },

    syncNow: async () => {
      if (get().mode !== 'server') return;
      if (get().canUploadLocal) {
        await get().uploadLocalData();
        return;
      }
      await pushToServer();
    },

    login: async (username, password) => {
      await apiLogin(username, password);
      set({ authRequired: false, serverUser: username, syncError: null });
      await get().refresh(true);
    },

    logout: async () => {
      try {
        await apiLogout();
      } catch (error) {
        if (!isUnauthorized(error)) throw error;
      }
      set({ authRequired: true, serverUser: null });
    },

    uploadLocalData: async () => {
      const now = Date.now();
      set({
        reminders: get().reminders.map((item) => withUpdatedAt(item, now)),
        tags: get().tags.map((item) => withUpdatedAt(item, now)),
        settingsUpdatedAt: now,
        canUploadLocal: false,
      });
      await pushToServer();
    },

    addReminder: async (item) => {
      const mode = get().mode;
      const id = item.id > 0 ? item.id : nextNumericId(get().reminders);
      const created: ReminderItem = mode === 'server'
        ? withUpdatedAt({ ...item, id }, Date.now())
        : { ...item, id };
      set({ reminders: [...get().reminders, created] });
      await persist({ synced: true });
      return id;
    },

    updateReminder: async (item) => {
      const next = get().mode === 'server' ? withUpdatedAt(item, Date.now()) : item;
      set({ reminders: get().reminders.map((existing) => (existing.id === item.id ? next : existing)) });
      await persist({ synced: true });
    },

    deleteReminder: async (id) => {
      if (get().mode === 'server') {
        const tombstone: SyncTombstone = { id, updatedAt: Date.now(), kind: 'reminder' };
        set({
          reminders: get().reminders.filter((item) => item.id !== id),
          tombstones: [...get().tombstones.filter((t) => !(t.kind === 'reminder' && t.id === id)), tombstone],
        });
      } else {
        set({ reminders: get().reminders.filter((item) => item.id !== id) });
      }
      await persist({ synced: true });
    },

    togglePin: async (id) => {
      const at = Date.now();
      set({
        reminders: get().reminders.map((item) =>
          item.id === id
            ? get().mode === 'server'
              ? withUpdatedAt({ ...item, isPinned: !item.isPinned }, at)
              : { ...item, isPinned: !item.isPinned }
            : item,
        ),
      });
      await persist({ synced: true });
    },

    findTag: (name) => {
      const key = name.trim().toLowerCase();
      return get().tags.find((tag) => tag.name.trim().toLowerCase() === key);
    },

    addTag: async (name, color) => {
      const trimmed = name.trim();
      if (trimmed === '') return undefined;
      const existing = get().findTag(trimmed);
      if (existing !== undefined) return existing;
      const tags = get().tags;
      const sortOrder = tags.reduce((max, tag) => Math.max(max, tag.sortOrder), 0) + 1;
      const chosenColor = color ?? DEFAULT_TAG_COLORS[tags.length % DEFAULT_TAG_COLORS.length] ?? '#2196F3';
      const base: TagItem = { id: nextNumericId(tags), name: trimmed, color: chosenColor, sortOrder };
      const created: TagItem = get().mode === 'server' ? withUpdatedAt(base, Date.now()) : base;
      set({ tags: [...tags, created] });
      await persist({ synced: true });
      return created;
    },

    updateTag: async (id, name, color) => {
      const trimmed = name.trim();
      if (trimmed === '') return;
      const current = get().tags.find((tag) => tag.id === id);
      if (current === undefined) return;
      const oldKey = current.name.trim().toLowerCase();
      const at = Date.now();
      const server = get().mode === 'server';
      const tags = get()
        .tags.map((tag) => (tag.id === id ? (server ? withUpdatedAt({ ...tag, name: trimmed, color }, at) : { ...tag, name: trimmed, color }) : tag))
        .sort((a, b) => a.sortOrder - b.sortOrder);
      const reminders = get().reminders.map((item) =>
        item.tag.trim().toLowerCase() === oldKey
          ? server
            ? withUpdatedAt({ ...item, tag: trimmed }, at)
            : { ...item, tag: trimmed }
          : item,
      );
      set({ tags, reminders });
      await persist({ synced: true });
    },

    deleteTag: async (id) => {
      const current = get().tags.find((tag) => tag.id === id);
      if (current === undefined) return;
      const key = current.name.trim().toLowerCase();
      const at = Date.now();
      const server = get().mode === 'server';
      const reminders = get().reminders.map((item) =>
        item.tag.trim().toLowerCase() === key
          ? server
            ? withUpdatedAt({ ...item, tag: '' }, at)
            : { ...item, tag: '' }
          : item,
      );
      if (server) {
        const tombstone: SyncTombstone = { id, updatedAt: at, kind: 'tag' };
        set({
          tags: get().tags.filter((tag) => tag.id !== id),
          reminders,
          tombstones: [...get().tombstones.filter((t) => !(t.kind === 'tag' && t.id === id)), tombstone],
        });
      } else {
        set({ tags: get().tags.filter((tag) => tag.id !== id), reminders });
      }
      await persist({ synced: true });
    },

    moveTag: async (id, direction) => {
      const ordered = [...get().tags].sort((a, b) => a.sortOrder - b.sortOrder);
      const index = ordered.findIndex((tag) => tag.id === id);
      if (index < 0) return;
      const target = direction === 'up' ? index - 1 : index + 1;
      if (target < 0 || target >= ordered.length) return;
      const reordered = [...ordered];
      const [moved] = reordered.splice(index, 1);
      if (moved === undefined) return;
      reordered.splice(target, 0, moved);
      const at = Date.now();
      const server = get().mode === 'server';
      const tags = reordered.map((tag, position) =>
        server ? withUpdatedAt({ ...tag, sortOrder: position + 1 }, at) : { ...tag, sortOrder: position + 1 },
      );
      set({ tags });
      await persist({ synced: true });
    },

    updateSettings: async (partial) => {
      const synced = isSyncedSettingsChange(partial);
      set({
        settings: { ...get().settings, ...partial },
        ...(synced && get().mode === 'server' ? { settingsUpdatedAt: Date.now() } : {}),
      });
      await persist({ synced });
    },

    importData: async (data) => {
      const server = get().mode === 'server';
      const at = Date.now();
      const previousReminderIds = new Set(get().reminders.map((item) => item.id));
      const previousTagIds = new Set(get().tags.map((item) => item.id));
      const reminders = server
        ? data.reminders.map((item) => withUpdatedAt(item, at))
        : data.reminders;
      const tags = server ? data.tags.map((item) => withUpdatedAt(item, at)) : data.tags;
      const tombstones = server
        ? [
            ...get().tombstones.filter(
              (t) =>
                !(t.kind === 'reminder' && reminders.some((item) => item.id === t.id)) &&
                !(t.kind === 'tag' && tags.some((item) => item.id === t.id)),
            ),
            ...[...previousReminderIds]
              .filter((id) => !reminders.some((item) => item.id === id))
              .map((id) => ({ id, updatedAt: at, kind: 'reminder' as const })),
            ...[...previousTagIds]
              .filter((id) => !tags.some((item) => item.id === id))
              .map((id) => ({ id, updatedAt: at, kind: 'tag' as const })),
          ]
        : get().tombstones;
      set({
        reminders,
        tags,
        settings: { ...get().settings, ...(data.settings ?? {}) },
        tombstones,
        ...(server ? { settingsUpdatedAt: at } : {}),
      });
      await persist({ synced: true });
    },

    resetAll: async () => {
      if (get().mode === 'server') {
        const at = Date.now();
        const tombstones: SyncTombstone[] = [
          ...get().reminders.map((item) => ({ id: item.id, updatedAt: at, kind: 'reminder' as const })),
          ...get().tags.map((item) => ({ id: item.id, updatedAt: at, kind: 'tag' as const })),
        ];
        await clearAllData();
        set({
          reminders: [],
          tags: [],
          settings: { ...DEFAULT_SETTINGS },
          tombstones,
          settingsUpdatedAt: at,
          canUploadLocal: false,
        });
        await persist({ synced: true });
        return;
      }
      await clearAllData();
      set({ reminders: [], tags: [], settings: { ...DEFAULT_SETTINGS } });
      await persist({ synced: false });
    },
  };
});

/** 服务器模式下刷新版本信息（best-effort，失败忽略）。 */
async function refreshVersion(): Promise<void> {
  try {
    const info = await fetchVersion();
    useReminderStore.setState({ serverVersion: info.version ?? info.server ?? null });
  } catch {
    // 忽略：版本信息仅用于展示。
  }
}
