/**
 * 应用状态（zustand）：启动时从 IndexedDB 载入内存，变更后写回。
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

const DEFAULT_TAG_COLORS = ['#2196F3', '#E91E63', '#4CAF50', '#FF9800', '#9C27B0', '#009688'];

interface ReminderStore {
  reminders: ReminderItem[];
  tags: TagItem[];
  settings: AppSettings;
  loaded: boolean;
  hydrate: () => Promise<void>;
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

export const useReminderStore = create<ReminderStore>((set, get) => {
  async function persist(): Promise<void> {
    const { reminders, tags, settings } = get();
    await savePersistedData({ reminders, tags, settings });
  }

  return {
    reminders: [],
    tags: [],
    settings: { ...DEFAULT_SETTINGS },
    loaded: false,

    hydrate: async () => {
      const data = await loadPersistedData();
      set({ reminders: data.reminders, tags: data.tags, settings: data.settings, loaded: true });
    },

    addReminder: async (item) => {
      const id = item.id > 0 ? item.id : nextNumericId(get().reminders);
      const created: ReminderItem = { ...item, id };
      set({ reminders: [...get().reminders, created] });
      await persist();
      return id;
    },

    updateReminder: async (item) => {
      set({ reminders: get().reminders.map((existing) => (existing.id === item.id ? item : existing)) });
      await persist();
    },

    deleteReminder: async (id) => {
      set({ reminders: get().reminders.filter((item) => item.id !== id) });
      await persist();
    },

    togglePin: async (id) => {
      set({
        reminders: get().reminders.map((item) =>
          item.id === id ? { ...item, isPinned: !item.isPinned } : item,
        ),
      });
      await persist();
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
      const chosenColor = color ?? DEFAULT_TAG_COLORS[(tags.length) % DEFAULT_TAG_COLORS.length] ?? '#2196F3';
      const created: TagItem = { id: nextNumericId(tags), name: trimmed, color: chosenColor, sortOrder };
      set({ tags: [...tags, created] });
      await persist();
      return created;
    },

    updateTag: async (id, name, color) => {
      const trimmed = name.trim();
      if (trimmed === '') return;
      const current = get().tags.find((tag) => tag.id === id);
      if (current === undefined) return;
      const oldKey = current.name.trim().toLowerCase();
      const tags = get()
        .tags.map((tag) => (tag.id === id ? { ...tag, name: trimmed, color } : tag))
        .sort((a, b) => a.sortOrder - b.sortOrder);
      // 改名时同步事件里的标签名，避免出现指向已不存在标签的悬空引用。
      const reminders = get().reminders.map((item) =>
        item.tag.trim().toLowerCase() === oldKey ? { ...item, tag: trimmed } : item,
      );
      set({ tags, reminders });
      await persist();
    },

    deleteTag: async (id) => {
      const current = get().tags.find((tag) => tag.id === id);
      if (current === undefined) return;
      const key = current.name.trim().toLowerCase();
      set({
        tags: get().tags.filter((tag) => tag.id !== id),
        reminders: get().reminders.map((item) =>
          item.tag.trim().toLowerCase() === key ? { ...item, tag: '' } : item,
        ),
      });
      await persist();
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
      const tags = reordered.map((tag, position) => ({ ...tag, sortOrder: position + 1 }));
      set({ tags });
      await persist();
    },

    updateSettings: async (partial) => {
      set({ settings: { ...get().settings, ...partial } });
      await persist();
    },

    importData: async (data) => {
      set({
        reminders: data.reminders,
        tags: data.tags,
        settings: { ...get().settings, ...(data.settings ?? {}) },
      });
      await persist();
    },

    resetAll: async () => {
      await clearAllData();
      set({ reminders: [], tags: [], settings: { ...DEFAULT_SETTINGS } });
      await persist();
    },
  };
});