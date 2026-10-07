/**
 * 应用状态（zustand）：启动时从 IndexedDB 载入内存，变更后写回。
 */
import { create } from 'zustand';
import type { ReminderItem, TagItem } from '../types/reminder';
import {
  DEFAULT_SETTINGS,
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
  updateSettings: (partial: Partial<AppSettings>) => Promise<void>;
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

    updateSettings: async (partial) => {
      set({ settings: { ...get().settings, ...partial } });
      await persist();
    },
  };
});
