/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
"use client";

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";
import {
  DndContext,
  DragEndEvent,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";

/* ================= TYPES ================= */

type MediaType = "movie" | "tv" | "anime" | "manga" | "book" | "game";
type GroupMode = "none" | "day" | "month" | "year";
type SortMode = "newest" | "oldest" | "title" | "rating_high" | "rating_low" | "updated" | "favorites";
type RatingFormat = "ten" | "five" | "stars" | "percent";
type StackColorTheme = "midnight" | "ocean" | "emerald" | "violet" | "rose" | "amber";

export type StackView =
  | "all"
  | "completed"
  | "in_progress"
  | "planned"
  | "dropped"
  | "stats"
  | "add"
  | "friends"
  | "feed"
  | "discover"
  | "feedback"
  | "settings";

const STATUSES = [
  { id: "completed", label: "Completed" },
  { id: "in_progress", label: "In Progress" },
  { id: "planned", label: "Planned" },
  { id: "dropped", label: "Dropped" },
] as const;

type Status = (typeof STATUSES)[number]["id"];
type FriendLibraryStatusFilter = "all" | Status;

type MediaItem = {
  id: string;
  title: string;
  type: MediaType;

  rating?: number; // 0-10
  posterUrl?: string; // autofill/base
  posterOverrideUrl?: string; // user override (keeps db info intact)

  // TMDB fields (movie/tv only)
  tmdbId?: number;
  tmdbType?: "movie" | "tv";

  // IGDB fields (game only)
  igdbId?: number;

  // AniList fields (anime/manga)
  anilistId?: number;
  anilistType?: "ANIME" | "MANGA";

  inTheaters?: boolean;
  dateFinished?: string; // YYYY-MM-DD
  notes?: string;
  rewatchCount?: number;
  runtime?: number; // minutes (movie=full runtime; tv/anime=per-episode approx)
  status: Status;
  tags: string[];
  createdAt: string; // ISO
  updatedAt?: string; // ISO
  favorite?: boolean;
  isPrivate?: boolean;
  withFriendIds?: string[];

  // Optional progress
  progressCur?: number;
  progressTotal?: number;

  // optional manual override
  progressCurOverride?: number;
  progressTotalOverride?: number;

  // games
  hoursPlayed?: number; // manual hours played
};


type TmdbSearchResult = {
  results?: Array<{ id: number; title?: string; name?: string; release_date?: string; first_air_date?: string }>;
};

type TmdbGenre = { name: string };

type TmdbDetailsResult = {
  poster_path?: string | null;
  runtime?: number | null;
  episode_run_time?: number[] | null;
  genres?: TmdbGenre[] | null;
  number_of_episodes?: number | null;
};

type TmdbRecommendationsResult = {
  results?: Array<{ id: number; title?: string; name?: string }>;
};

type IgdbSearchResponse = {
  results: Array<{ id: number; name: string; coverUrl?: string; genres?: string[] }>;
  error?: string;
};

type AnilistSearchResponse = {
  results: Array<{ id: number; title: string; coverUrl?: string; genres?: string[] }>;
  error?: string;
};

type MediaPick =
  | {
      provider: "tmdb";
      title: string;
      posterUrl?: string;
      tmdbId: number;
      tmdbType: "movie" | "tv";
    }
  | {
      provider: "anilist";
      title: string;
      posterUrl?: string;
      anilistId: number;
      anilistType: "ANIME" | "MANGA";
    }
  | {
      provider: "igdb";
      title: string;
      posterUrl?: string;
      igdbId: number;
    };


type Suggestion = {
  key: string; // unique key for list rendering
  provider: "tmdb" | "igdb" | "anilist";
  title: string;
  subtitle?: string;
  posterUrl?: string;
  tags?: string[];
  runtime?: number;
  progressTotal?: number;
  // ids
  tmdbId?: number;
  tmdbType?: "movie" | "tv";
  igdbId?: number;
  anilistId?: number;
  anilistType?: "ANIME" | "MANGA";
};

type StackSettings = {
  displayName?: string;
  usernameTag?: string;
  profileBio?: string;
  soundEffects?: boolean;
  soundVolume?: number;
  ratingFormat?: RatingFormat;
  colorTheme?: StackColorTheme;
  friendNicknames?: Record<string, string>;

  // Friend/public profile privacy controls. These stay inside the existing settings JSON.
  showRatingsToFriends?: boolean;
  showNotesToFriends?: boolean;
  showTagsToFriends?: boolean;
  showProfileBioToFriends?: boolean;

  // Display preferences saved with the existing settings JSON.
  compactMode?: boolean;
  defaultBoardView?: "board" | "list";
  defaultAddStatus?: Status;
};

type FeedbackEntry = {
  id: string;
  type: "suggestion" | "problem";
  message: string;
  createdAt: string;
  status?: "new" | "reviewed" | "done";
};

type DiscoverCard = {
  id: number;
  title: string;
  type: "movie" | "tv";
  posterUrl?: string;
  year?: string;
  overview?: string;
  tags?: string[];
};

type ActivityEntry = {
  id: string;
  actorId: string;
  actorName: string;
  itemTitle: string;
  itemType: MediaType;
  status: Status;
  date: string;
  favorite?: boolean;
};

type AdminFeedbackEntry = FeedbackEntry & {
  userId: string;
  userLabel: string;
};

const LOCAL_BACKUP_KEY = "stack-items-backup-v1";
const LOCAL_LAST_GOOD_KEY = "stack-items-backup-v1-last-good";
const LOCAL_BOARD_VIEW_KEY = "stack-board-view-v1";
const LOCAL_COLOR_THEME_KEY = "stack-color-theme-v1";
const STACK_ADMIN_USER_IDS = ["a990813e-af9d-4e1c-a15d-2e9281128c71"];


function backupKeyForUser(uid?: string | null) {
  return uid ? `${LOCAL_BACKUP_KEY}:${uid}` : LOCAL_BACKUP_KEY;
}

function lastGoodKeyForUser(uid?: string | null) {
  return uid ? `${LOCAL_LAST_GOOD_KEY}:${uid}` : LOCAL_LAST_GOOD_KEY;
}

function parseBackupItems(raw: string | null): MediaItem[] | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;

    const cleaned = parsed
      .filter((x) => x && typeof x.id === "string" && typeof x.title === "string")
      .map((x) => x as MediaItem);

    return cleaned;
  } catch {
    return null;
  }
}

const TYPE_LABEL: Record<MediaType, string> = {
  movie: "Movie",
  tv: "TV",
  anime: "Anime",
  manga: "Manga",
  book: "Book",
  game: "Game",
};

const PIE_COLORS = [
  "#22d3ee", // bright cyan
  "#f97316", // orange
  "#a78bfa", // violet
  "#84cc16", // lime
  "#f43f5e", // rose
  "#facc15", // yellow
  "#38bdf8", // sky
  "#e879f9", // fuchsia
  "#10b981", // emerald
  "#ef4444", // red
];

const STACK_COLOR_THEME_OPTIONS: Array<{ value: StackColorTheme; label: string; description: string }> = [
  { value: "midnight", label: "Midnight", description: "Original blue-gray dark theme" },
  { value: "ocean", label: "Ocean", description: "Blue and cyan glow" },
  { value: "emerald", label: "Emerald", description: "Green glow" },
  { value: "violet", label: "Violet", description: "Purple glow" },
  { value: "rose", label: "Rose", description: "Pink-red glow" },
  { value: "amber", label: "Amber", description: "Gold glow" },
];

const STACK_COLOR_THEME_VALUES = STACK_COLOR_THEME_OPTIONS.map((t) => t.value);

function isStackColorTheme(value: unknown): value is StackColorTheme {
  return typeof value === "string" && STACK_COLOR_THEME_VALUES.includes(value as StackColorTheme);
}

function loadLocalColorTheme(): StackColorTheme {
  if (typeof window === "undefined") return "midnight";

  try {
    const stored = localStorage.getItem(LOCAL_COLOR_THEME_KEY);
    if (isStackColorTheme(stored)) return stored;

    const cookieTheme = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("stack_color_theme="))
      ?.split("=")[1];

    return isStackColorTheme(cookieTheme) ? cookieTheme : "midnight";
  } catch {
    return "midnight";
  }
}

function saveLocalColorTheme(theme: StackColorTheme) {
  if (typeof window === "undefined") return;

  try {
    localStorage.setItem(LOCAL_COLOR_THEME_KEY, theme);
  } catch {}

  try {
    document.cookie = `stack_color_theme=${theme}; Max-Age=31536000; Path=/; SameSite=Lax`;
  } catch {}
}

const STACK_COLOR_THEMES: Record<
  StackColorTheme,
  {
    bg: string;
    fg: string;
    surface: string;
    accent: string;
    good: string;
    goodBorder: string;
    bad: string;
    badBorder: string;
    focus: string;
    ring: string;
  }
> = {
  midnight: {
    bg: "radial-gradient(circle at top left, rgba(59,130,246,0.18), transparent 32%), radial-gradient(circle at top right, rgba(148,163,184,0.10), transparent 30%), #05070d",
    fg: "#e5e7eb",
    surface: "rgba(12, 18, 32, 0.78)",
    accent: "linear-gradient(135deg, rgba(37,99,235,0.28), rgba(17,24,39,0.78))",
    good: "rgba(16,185,129,0.22)",
    goodBorder: "rgba(16,185,129,0.35)",
    bad: "rgba(239,68,68,0.18)",
    badBorder: "rgba(239,68,68,0.32)",
    focus: "#64748b",
    ring: "rgba(255,255,255,0.10)",
  },
  ocean: {
    bg: "radial-gradient(circle at top left, rgba(34,211,238,0.20), transparent 34%), radial-gradient(circle at bottom right, rgba(59,130,246,0.18), transparent 30%), #031018",
    fg: "#e6fbff",
    surface: "rgba(6, 25, 38, 0.78)",
    accent: "linear-gradient(135deg, rgba(14,165,233,0.32), rgba(8,47,73,0.76))",
    good: "rgba(34,211,238,0.18)",
    goodBorder: "rgba(34,211,238,0.35)",
    bad: "rgba(244,63,94,0.18)",
    badBorder: "rgba(244,63,94,0.32)",
    focus: "#22d3ee",
    ring: "rgba(34,211,238,0.12)",
  },
  emerald: {
    bg: "radial-gradient(circle at top left, rgba(16,185,129,0.20), transparent 34%), radial-gradient(circle at bottom right, rgba(20,184,166,0.14), transparent 32%), #04120d",
    fg: "#ecfdf5",
    surface: "rgba(5, 30, 22, 0.78)",
    accent: "linear-gradient(135deg, rgba(16,185,129,0.30), rgba(6,78,59,0.75))",
    good: "rgba(16,185,129,0.24)",
    goodBorder: "rgba(16,185,129,0.40)",
    bad: "rgba(248,113,113,0.18)",
    badBorder: "rgba(248,113,113,0.32)",
    focus: "#10b981",
    ring: "rgba(16,185,129,0.12)",
  },
  violet: {
    bg: "radial-gradient(circle at top left, rgba(167,139,250,0.22), transparent 34%), radial-gradient(circle at bottom right, rgba(236,72,153,0.12), transparent 32%), #0b0714",
    fg: "#f5f3ff",
    surface: "rgba(27, 15, 49, 0.78)",
    accent: "linear-gradient(135deg, rgba(124,58,237,0.34), rgba(49,46,129,0.72))",
    good: "rgba(168,85,247,0.22)",
    goodBorder: "rgba(168,85,247,0.38)",
    bad: "rgba(244,63,94,0.18)",
    badBorder: "rgba(244,63,94,0.32)",
    focus: "#a78bfa",
    ring: "rgba(167,139,250,0.14)",
  },
  rose: {
    bg: "radial-gradient(circle at top left, rgba(244,63,94,0.20), transparent 34%), radial-gradient(circle at bottom right, rgba(251,113,133,0.14), transparent 32%), #14070b",
    fg: "#fff1f2",
    surface: "rgba(42, 13, 22, 0.78)",
    accent: "linear-gradient(135deg, rgba(225,29,72,0.32), rgba(76,5,25,0.74))",
    good: "rgba(244,63,94,0.20)",
    goodBorder: "rgba(244,63,94,0.36)",
    bad: "rgba(239,68,68,0.20)",
    badBorder: "rgba(239,68,68,0.34)",
    focus: "#fb7185",
    ring: "rgba(244,63,94,0.13)",
  },
  amber: {
    bg: "radial-gradient(circle at top left, rgba(245,158,11,0.20), transparent 34%), radial-gradient(circle at bottom right, rgba(217,119,6,0.14), transparent 32%), #120b03",
    fg: "#fffbeb",
    surface: "rgba(37, 24, 8, 0.78)",
    accent: "linear-gradient(135deg, rgba(217,119,6,0.30), rgba(69,26,3,0.74))",
    good: "rgba(245,158,11,0.22)",
    goodBorder: "rgba(245,158,11,0.38)",
    bad: "rgba(239,68,68,0.18)",
    badBorder: "rgba(239,68,68,0.32)",
    focus: "#f59e0b",
    ring: "rgba(245,158,11,0.13)",
  },
};

function stackThemeToCssVars(theme: (typeof STACK_COLOR_THEMES)[StackColorTheme]) {
  return {
    "--stack-theme-bg": theme.bg,
    "--stack-theme-fg": theme.fg,
    "--stack-theme-surface": theme.surface,
    "--stack-theme-accent": theme.accent,
    "--stack-theme-good": theme.good,
    "--stack-theme-good-border": theme.goodBorder,
    "--stack-theme-bad": theme.bad,
    "--stack-theme-bad-border": theme.badBorder,
    "--stack-theme-focus": theme.focus,
    "--stack-theme-ring": theme.ring,
  };
}

const STACK_COLOR_THEME_CSS_VARS: Record<StackColorTheme, Record<string, string>> = {
  midnight: stackThemeToCssVars(STACK_COLOR_THEMES.midnight),
  ocean: stackThemeToCssVars(STACK_COLOR_THEMES.ocean),
  emerald: stackThemeToCssVars(STACK_COLOR_THEMES.emerald),
  violet: stackThemeToCssVars(STACK_COLOR_THEMES.violet),
  rose: stackThemeToCssVars(STACK_COLOR_THEMES.rose),
  amber: stackThemeToCssVars(STACK_COLOR_THEMES.amber),
};

const STACK_THEME_BOOT_SCRIPT = `(function(){try{var key=${JSON.stringify(LOCAL_COLOR_THEME_KEY)};var themes=${JSON.stringify(STACK_COLOR_THEME_CSS_VARS).replace(/</g, "\u003c")};var theme=localStorage.getItem(key);if(!themes[theme]){var match=document.cookie.match(/(?:^|; )stack_color_theme=([^;]+)/);theme=match?decodeURIComponent(match[1]):"midnight";}if(!themes[theme])theme="midnight";var root=document.documentElement;var vars=themes[theme];Object.keys(vars).forEach(function(k){root.style.setProperty(k,vars[k]);});root.dataset.stackTheme=theme;root.style.colorScheme="dark";}catch(e){}})();`;

function applyStackThemeToDocument(themeValue: unknown) {
  if (typeof document === "undefined") return;

  const theme = isStackColorTheme(themeValue) ? themeValue : "midnight";
  const vars = STACK_COLOR_THEME_CSS_VARS[theme];

  for (const [key, value] of Object.entries(vars)) {
    document.documentElement.style.setProperty(key, value);
  }

  document.documentElement.dataset.stackTheme = theme;
  document.documentElement.style.colorScheme = "dark";
}

const DEFAULT_SETTINGS: Required<
  Pick<
    StackSettings,
    | "soundEffects"
    | "soundVolume"
    | "ratingFormat"
    | "colorTheme"
    | "showRatingsToFriends"
    | "showNotesToFriends"
    | "showTagsToFriends"
    | "showProfileBioToFriends"
    | "compactMode"
    | "defaultBoardView"
    | "defaultAddStatus"
  >
> &
  Omit<
    StackSettings,
    | "soundEffects"
    | "soundVolume"
    | "ratingFormat"
    | "colorTheme"
    | "showRatingsToFriends"
    | "showNotesToFriends"
    | "showTagsToFriends"
    | "showProfileBioToFriends"
    | "compactMode"
    | "defaultBoardView"
    | "defaultAddStatus"
  > = {
  displayName: "",
  usernameTag: "",
  profileBio: "",
  soundEffects: false,
  soundVolume: 1,
  ratingFormat: "ten",
  colorTheme: "midnight",
  friendNicknames: {},
  showRatingsToFriends: true,
  showNotesToFriends: true,
  showTagsToFriends: true,
  showProfileBioToFriends: true,
  compactMode: false,
  defaultBoardView: "board",
  defaultAddStatus: "planned",
};

function uid() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  // Browser fallback for older Safari/WebView versions.
  return `stack_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeSettings(raw: unknown): StackSettings {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, any>) : {};
  const ratingFormat = ["ten", "five", "stars", "percent"].includes(obj.ratingFormat)
    ? (obj.ratingFormat as RatingFormat)
    : DEFAULT_SETTINGS.ratingFormat;
  const colorTheme = isStackColorTheme(obj.colorTheme)
    ? obj.colorTheme
    : loadLocalColorTheme();

  return {
    ...DEFAULT_SETTINGS,
    displayName: typeof obj.displayName === "string" ? obj.displayName : "",
    usernameTag: typeof obj.usernameTag === "string" ? obj.usernameTag : "",
    profileBio: typeof obj.profileBio === "string" ? obj.profileBio : "",
    soundEffects: typeof obj.soundEffects === "boolean" ? obj.soundEffects : DEFAULT_SETTINGS.soundEffects,
    soundVolume:
      typeof obj.soundVolume === "number" && Number.isFinite(obj.soundVolume)
        ? clamp(obj.soundVolume, 0.25, 3)
        : DEFAULT_SETTINGS.soundVolume,
    ratingFormat,
    colorTheme,
    showRatingsToFriends:
      typeof obj.showRatingsToFriends === "boolean" ? obj.showRatingsToFriends : DEFAULT_SETTINGS.showRatingsToFriends,
    showNotesToFriends:
      typeof obj.showNotesToFriends === "boolean" ? obj.showNotesToFriends : DEFAULT_SETTINGS.showNotesToFriends,
    showTagsToFriends:
      typeof obj.showTagsToFriends === "boolean" ? obj.showTagsToFriends : DEFAULT_SETTINGS.showTagsToFriends,
    showProfileBioToFriends:
      typeof obj.showProfileBioToFriends === "boolean"
        ? obj.showProfileBioToFriends
        : DEFAULT_SETTINGS.showProfileBioToFriends,
    compactMode: typeof obj.compactMode === "boolean" ? obj.compactMode : DEFAULT_SETTINGS.compactMode,
    defaultBoardView: obj.defaultBoardView === "list" || obj.defaultBoardView === "board" ? obj.defaultBoardView : DEFAULT_SETTINGS.defaultBoardView,
    defaultAddStatus: STATUSES.some((s) => s.id === obj.defaultAddStatus)
      ? (obj.defaultAddStatus as Status)
      : DEFAULT_SETTINGS.defaultAddStatus,
    friendNicknames:
      obj.friendNicknames && typeof obj.friendNicknames === "object" && !Array.isArray(obj.friendNicknames)
        ? (Object.fromEntries(
            Object.entries(obj.friendNicknames).filter(
              ([k, v]) => typeof k === "string" && typeof v === "string"
            )
          ) as Record<string, string>)
        : {},
  };
}

function formatRatingValue(rating: number | undefined, format: RatingFormat = "ten") {
  if (typeof rating !== "number" || !Number.isFinite(rating)) return "—";
  const r = clamp(rating, 0, 10);

  if (format === "five") return `${(r / 2).toFixed(1)} / 5`;
  if (format === "percent") return `${Math.round(r * 10)}%`;
  if (format === "stars") {
    const filled = Math.round(r / 2);
    return `${"★".repeat(filled)}${"☆".repeat(Math.max(0, 5 - filled))}`;
  }

  return `${r.toFixed(1)} / 10`;
}

function ratingFormatLabel(format: RatingFormat = "ten") {
  if (format === "five") return "5-point scale";
  if (format === "stars") return "Stars";
  if (format === "percent") return "Percent";
  return "10-point scale";
}

function sortMediaItems<T extends MediaItem>(list: T[], sortMode: SortMode): T[] {
  const out = list.slice();

  out.sort((a, b) => {
    if (sortMode === "title") return a.title.localeCompare(b.title);
    if (sortMode === "rating_high") return (b.rating ?? -1) - (a.rating ?? -1);
    if (sortMode === "rating_low") return (a.rating ?? 999) - (b.rating ?? 999);

    const createdA = new Date((a.dateFinished ?? a.createdAt) as string).getTime();
    const createdB = new Date((b.dateFinished ?? b.createdAt) as string).getTime();
    const updatedA = new Date((a.updatedAt ?? a.createdAt) as string).getTime();
    const updatedB = new Date((b.updatedAt ?? b.createdAt) as string).getTime();

    if (sortMode === "updated") return updatedB - updatedA;
    if (sortMode === "favorites") {
      const favDiff = Number(!!b.favorite) - Number(!!a.favorite);
      return favDiff || updatedB - updatedA;
    }

    return sortMode === "oldest" ? createdA - createdB : createdB - createdA;
  });

  return out;
}

type ProfilePrivacyOptions = {
  showRatings: boolean;
  showNotes: boolean;
  showTags: boolean;
};

function profilePrivacyFromSettings(settings?: StackSettings): ProfilePrivacyOptions {
  return {
    showRatings: settings?.showRatingsToFriends !== false,
    showNotes: settings?.showNotesToFriends !== false,
    showTags: settings?.showTagsToFriends !== false,
  };
}

function computeVisibleProfileStats(items: MediaItem[]) {
  const total = items.length;
  const completed = items.filter((i) => i.status === "completed").length;
  const planned = items.filter((i) => i.status === "planned").length;
  const inProgress = items.filter((i) => i.status === "in_progress").length;
  const dropped = items.filter((i) => i.status === "dropped").length;
  const ratings = items
    .map((i) => i.rating)
    .filter((r): r is number => typeof r === "number" && Number.isFinite(r));
  const avgRating = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : undefined;

  const tagCounts = new Map<string, number>();
  for (const item of items) {
    for (const tag of item.tags ?? []) {
      const key = String(tag || "").trim();
      if (!key) continue;
      tagCounts.set(key, (tagCounts.get(key) ?? 0) + 1);
    }
  }

  const topGenre = Array.from(tagCounts.entries()).sort((a, b) => b[1] - a[1])[0];

  return {
    total,
    completed,
    planned,
    inProgress,
    dropped,
    avgRating,
    topGenre: topGenre?.[0] ?? "—",
    topGenreCount: topGenre?.[1] ?? 0,
  };
}

function safeDateLabel(value?: string) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleDateString();
  } catch {
    return value;
  }
}

function playStackSoundEffect(kind: "hover" | "click" = "click", volume = 1) {
  if (typeof window === "undefined") return;

  try {
    const AudioCtor = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtor) return;

    const ctx = new AudioCtor();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const safeVolume = clamp(Number.isFinite(volume) ? volume : 1, 0.25, 3);

    osc.type = "sine";
    osc.frequency.value = kind === "click" ? 620 : 430;
    gain.gain.value = (kind === "click" ? 0.075 : 0.03) * safeVolume;

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + (kind === "click" ? 0.075 : 0.045));
    osc.stop(ctx.currentTime + (kind === "click" ? 0.08 : 0.05));

    window.setTimeout(() => {
      try {
        ctx.close();
      } catch {}
    }, 140);
  } catch {}
}

function omitKnownDataKeys(raw: unknown) {
  const obj = raw && typeof raw === "object" && raw !== null && !Array.isArray(raw) ? { ...(raw as Record<string, any>) } : {};
  delete obj.items;
  delete obj.settings;
  delete obj.feedback;
  return obj;
}

async function anilistRandomManga(): Promise<{ title: string; anilistId: number; posterUrl?: string }> {
  const page = 1 + Math.floor(Math.random() * 200);
  const perPage = 25;

  const query = `
    query ($page: Int, $perPage: Int) {
      Page(page: $page, perPage: $perPage) {
        media(type: MANGA, sort: POPULARITY_DESC) {
          id
          title { romaji english native }
          coverImage { extraLarge large medium }
        }
      }
    }
  `;

  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables: { page, perPage } }),
  });

  if (!res.ok) throw new Error(`AniList random manga failed (${res.status}).`);

  const json = (await res.json()) as any;
  const list = (json?.data?.Page?.media ?? []).filter(Boolean);
  if (!list.length) throw new Error("AniList random manga returned no results.");

  const picked = list[Math.floor(Math.random() * list.length)];
  const title =
    (picked?.title?.english || picked?.title?.romaji || picked?.title?.native || "").trim() || "Unknown";
  const posterUrl =
    picked?.coverImage?.extraLarge || picked?.coverImage?.large || picked?.coverImage?.medium || undefined;

  return { title, anilistId: picked.id, posterUrl };
}


function todayYMD() {
  return new Date().toISOString().slice(0, 10);
}

function toGroupKey(mode: GroupMode, dateStr?: string) {
  if (!dateStr) return "Undated";
  if (mode === "day") return dateStr.slice(0, 10);
  if (mode === "month") return dateStr.slice(0, 7);
  if (mode === "year") return dateStr.slice(0, 4);
  return "All";
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function uniqTags(tags: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const k = String(t || "").trim();
    if (!k) continue;
    const key = k.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k);
  }
  return out;
}

function normTitle(s: string) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\u2019']/g, "'")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Levenshtein distance */
function levenshtein(a: string, b: string) {
  const s = a;
  const t = b;
  const m = s.length;
  const n = t.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;

  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = temp;
    }
  }
  return dp[n];
}

/** Similarity score 0..1 (1 = identical) */
function similarityScore(aRaw: string, bRaw: string) {
  const a = normTitle(aRaw);
  const b = normTitle(bRaw);
  if (!a || !b) return 0;
  if (a === b) return 1;

  // prefix boost for tab-to-complete
  if (b.startsWith(a)) {
    const prefixBoost = 0.15 * Math.min(1, a.length / Math.max(1, b.length));
    return Math.min(1, 0.85 + prefixBoost);
  }

  const dist = levenshtein(a, b);
  const denom = Math.max(a.length, b.length);
  return denom ? 1 - dist / denom : 0;
}

function getMovieProgressDefaults(item: MediaItem) {
  const total = typeof item.progressTotalOverride === "number" ? item.progressTotalOverride : item.progressTotal;
  const cur = typeof item.progressCurOverride === "number" ? item.progressCurOverride : item.progressCur;

  if (item.type !== "movie") return { cur, total };

  const finalTotal = typeof total === "number" ? total : 1;
  const finalCur = typeof cur === "number" ? cur : item.status === "completed" ? 1 : 0;

  return { cur: finalCur, total: finalTotal };
}

/* ================= TMDB ================= */

async function tmdbSearch(title: string, type: "movie" | "tv"): Promise<TmdbSearchResult> {
  const key = process.env.NEXT_PUBLIC_TMDB_KEY;
  if (!key) throw new Error("Missing TMDB key (NEXT_PUBLIC_TMDB_KEY).");

  const url = new URL(`https://api.themoviedb.org/3/search/${type}`);
  url.searchParams.set("api_key", key);
  url.searchParams.set("query", title);
  url.searchParams.set("include_adult", "false");

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`TMDB search failed (${res.status}).`);
  return (await res.json()) as TmdbSearchResult;
}

async function tmdbDetails(id: number, type: "movie" | "tv"): Promise<TmdbDetailsResult> {
  const key = process.env.NEXT_PUBLIC_TMDB_KEY;
  if (!key) throw new Error("Missing TMDB key (NEXT_PUBLIC_TMDB_KEY).");

  const url = new URL(`https://api.themoviedb.org/3/${type}/${id}`);
  url.searchParams.set("api_key", key);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`TMDB details failed (${res.status}).`);
  return (await res.json()) as TmdbDetailsResult;
}

async function tmdbRecommendations(id: number, type: "movie" | "tv"): Promise<TmdbRecommendationsResult> {
  const key = process.env.NEXT_PUBLIC_TMDB_KEY;
  if (!key) throw new Error("Missing TMDB key (NEXT_PUBLIC_TMDB_KEY).");

  const url = new URL(`https://api.themoviedb.org/3/${type}/${id}/recommendations`);
  url.searchParams.set("api_key", key);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`TMDB recommendations failed (${res.status}).`);
  return (await res.json()) as TmdbRecommendationsResult;
}

/* ================= ANILIST GRAPHQL (for progress totals) ================= */

async function anilistDetails(
  id: number,
  type: "ANIME" | "MANGA"
): Promise<{
  coverUrl?: string;
  genres?: string[];
  episodes?: number | null;
  duration?: number | null;
  chapters?: number | null;
  volumes?: number | null;
}> {
  const query = `
    query ($id: Int, $type: MediaType) {
      Media(id: $id, type: $type) {
        coverImage { extraLarge large medium }
        genres
        episodes
        duration
        chapters
        volumes
      }
    }
  `;
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables: { id, type } }),
  });

  if (!res.ok) throw new Error(`AniList details failed (${res.status}).`);
  type AniListDetailsResponse = {
    data?: {
      Media?: {
        coverImage?: { extraLarge?: string; large?: string; medium?: string };
        genres?: string[];
        episodes?: number | null;
        duration?: number | null;
        chapters?: number | null;
        volumes?: number | null;
      };
    };
    errors?: Array<{ message: string }>;
  };

  const json: AniListDetailsResponse = await res.json();
  const m = json?.data?.Media;
  const coverUrl = m?.coverImage?.extraLarge || m?.coverImage?.large || m?.coverImage?.medium || undefined;
  const genres = Array.isArray(m?.genres) ? (m.genres as string[]) : undefined;

  return {
    coverUrl,
    genres,
    episodes: typeof m?.episodes === "number" ? m.episodes : null,
    duration: typeof m?.duration === "number" ? m.duration : null,
    chapters: typeof m?.chapters === "number" ? m.chapters : null,
    volumes: typeof m?.volumes === "number" ? m.volumes : null,
  };
}

// ================= RECOMMENDER HELPERS (TMDB) =================

type TmdbDiscoverResult = {
  results?: Array<{
    id: number;
    title?: string;
    name?: string;
    poster_path?: string | null;
    overview?: string;
    release_date?: string;
    first_air_date?: string;
    genre_ids?: number[];
  }>;
  total_pages?: number;
};

async function tmdbDiscoverRandom(type: "movie" | "tv") {
  const key = process.env.NEXT_PUBLIC_TMDB_KEY;
  if (!key) throw new Error("Missing TMDB key (NEXT_PUBLIC_TMDB_KEY).");

  // TMDB caps discover pages; 1..500 is the typical safe range
  const page = 1 + Math.floor(Math.random() * 500);

  const url = new URL(`https://api.themoviedb.org/3/discover/${type}`);
  url.searchParams.set("api_key", key);
  url.searchParams.set("include_adult", "false");
  url.searchParams.set("page", String(page));
  url.searchParams.set("sort_by", "popularity.desc");

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`TMDB discover failed (${res.status}).`);
  const json = (await res.json()) as TmdbDiscoverResult;

  const list = (json.results ?? []).filter((x) => x && x.id);
  if (!list.length) throw new Error("TMDB discover returned no results.");

  const picked = list[Math.floor(Math.random() * list.length)];
  const title = (picked.title || picked.name || "").trim();
  const posterUrl = picked.poster_path ? `https://image.tmdb.org/t/p/w500${picked.poster_path}` : undefined;

  return { title, tmdbId: picked.id, tmdbType: type, posterUrl };
}

async function anilistRandomAnime(): Promise<{ title: string; anilistId: number; posterUrl?: string }> {
  // Random page of popular anime, then random entry in that page
  const page = 1 + Math.floor(Math.random() * 200); // wide enough to feel random
  const perPage = 25;

  const query = `
    query ($page: Int, $perPage: Int) {
      Page(page: $page, perPage: $perPage) {
        media(type: ANIME, sort: POPULARITY_DESC) {
          id
          title { romaji english native }
          coverImage { extraLarge large medium }
        }
      }
    }
  `;

  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables: { page, perPage } }),
  });

  if (!res.ok) throw new Error(`AniList random failed (${res.status}).`);

  const json = (await res.json()) as any;
  const list = (json?.data?.Page?.media ?? []).filter(Boolean);
  if (!list.length) throw new Error("AniList random returned no results.");

  const picked = list[Math.floor(Math.random() * list.length)];
  const title =
    (picked?.title?.english || picked?.title?.romaji || picked?.title?.native || "").trim() || "Unknown";
  const posterUrl = picked?.coverImage?.extraLarge || picked?.coverImage?.large || picked?.coverImage?.medium || undefined;

  return { title, anilistId: picked.id, posterUrl };
}


type TmdbTrendingResult = {
  results?: Array<{ id: number; title?: string; name?: string }>;
};

function normTag(s: string) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function uniq<T>(arr: T[]) {
  return Array.from(new Set(arr));
}

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n));
}

function computeTasteProfile(items: MediaItem[]) {
  // Use completed items, prioritize highly-rated ones
  const completed = items.filter((i) => i.status === "completed");
  const rated = completed
    .filter((i) => typeof i.rating === "number")
    .sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));

  const seeds = rated.slice(0, 12);

  // Top tags (genres) weighted by rating
  const tagScore = new Map<string, number>();
  for (const i of seeds) {
    const w = (i.rating ?? 0) / 10; // 0..1
    for (const t of i.tags ?? []) {
      const k = normTag(t);
      if (!k) continue;
      tagScore.set(k, (tagScore.get(k) ?? 0) + w);
    }
  }

  const topTags = Array.from(tagScore.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([k]) => k);

  // Type preference from last ~30 items (what you’ve been consuming)
  const recent = items.slice(0, 30);
  const typeCounts = new Map<MediaType, number>();
  for (const i of recent) typeCounts.set(i.type, (typeCounts.get(i.type) ?? 0) + 1);
  const total = Math.max(1, recent.length);

  const typePref: Record<MediaType, number> = {
    movie: (typeCounts.get("movie") ?? 0) / total,
    tv: (typeCounts.get("tv") ?? 0) / total,
    anime: (typeCounts.get("anime") ?? 0) / total,
    manga: (typeCounts.get("manga") ?? 0) / total,
    book: (typeCounts.get("book") ?? 0) / total,
    game: (typeCounts.get("game") ?? 0) / total,
  };

  return { topTags, typePref };
}

async function tmdbTrending(mediaType: "movie" | "tv"): Promise<TmdbTrendingResult> {
  const key = process.env.NEXT_PUBLIC_TMDB_KEY;
  if (!key) throw new Error("Missing TMDB key (NEXT_PUBLIC_TMDB_KEY).");

  const url = new URL(`https://api.themoviedb.org/3/trending/${mediaType}/week`);
  url.searchParams.set("api_key", key);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`TMDB trending failed (${res.status}).`);
  return (await res.json()) as TmdbTrendingResult;
}

type TmdbGenreListResult = { genres?: Array<{ id: number; name: string }> };

async function tmdbGenreList(type: "movie" | "tv"): Promise<Array<{ id: number; name: string }>> {
  const key = process.env.NEXT_PUBLIC_TMDB_KEY;
  if (!key) throw new Error("Missing TMDB key (NEXT_PUBLIC_TMDB_KEY).");

  const url = new URL(`https://api.themoviedb.org/3/genre/${type}/list`);
  url.searchParams.set("api_key", key);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`TMDB genre list failed (${res.status}).`);

  const json = (await res.json()) as TmdbGenreListResult;
  return Array.isArray(json.genres) ? json.genres : [];
}

async function tmdbDiscoverByGenres(type: "movie" | "tv", genreIds: number[]) {
  const key = process.env.NEXT_PUBLIC_TMDB_KEY;
  if (!key) throw new Error("Missing TMDB key (NEXT_PUBLIC_TMDB_KEY).");

  // keep it “fresh” and varied
  const page = 1 + Math.floor(Math.random() * 50);

  const url = new URL(`https://api.themoviedb.org/3/discover/${type}`);
  url.searchParams.set("api_key", key);
  url.searchParams.set("include_adult", "false");
  url.searchParams.set("sort_by", "vote_count.desc"); // better than pure popularity for “good picks”
  url.searchParams.set("page", String(page));

  if (genreIds.length) url.searchParams.set("with_genres", genreIds.join(","));

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`TMDB discover-by-genres failed (${res.status}).`);

  const json = (await res.json()) as TmdbDiscoverResult;
  return (json.results ?? []).filter((x) => x && x.id);
}


function scoreCandidate(opts: { candidateTags: string[]; userTopTags: string[]; typeBoost: number }) {
  const cand = uniq(opts.candidateTags.map(normTag)).filter(Boolean);
  const user = uniq(opts.userTopTags.map(normTag)).filter(Boolean);

  if (!cand.length || !user.length) {
    return 0.15 + 0.35 * clamp01(opts.typeBoost);
  }

  const candSet = new Set(cand);
  let overlap = 0;
  for (const t of user) if (candSet.has(t)) overlap += 1;

  const overlapScore = overlap / Math.max(1, Math.min(user.length, 8));
  return 0.65 * clamp01(overlapScore) + 0.35 * clamp01(opts.typeBoost);
}

function diversifyPicks<T extends { score: number; tags: string[] }>(
  picks: T[],
  maxPerTopTag = 2
) {
  const out: T[] = [];
  const tagCounts = new Map<string, number>();

  for (const p of picks) {
    const primary = normTag(p.tags?.[0] ?? "");
    if (primary) {
      const c = tagCounts.get(primary) ?? 0;
      if (c >= maxPerTopTag) continue;
      tagCounts.set(primary, c + 1);
    }
    out.push(p);
    if (out.length >= 8) break;
  }

  return out.length ? out : picks.slice(0, 8);
}


/* ================= APP ================= */

export default function StackApp({ view = "all" }: { view?: StackView }) {
  // ✅ Stats month filter ("all" = no filter)
  const [statsMonth, setStatsMonth] = useState<string>("all");
  const [items, setItems] = useState<MediaItem[]>([]);
  const [userId, setUserId] = useState<string | null>(null);
  const [settings, setSettings] = useState<StackSettings>(() => ({
    ...DEFAULT_SETTINGS,
    colorTheme: loadLocalColorTheme(),
  }));
  const [feedbackEntries, setFeedbackEntries] = useState<FeedbackEntry[]>([]);
  const [cloudExtraData, setCloudExtraData] = useState<Record<string, any>>({});

  const [query, setQuery] = useState("");
  const groupMode: GroupMode = "none";
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [tagFilter, setTagFilter] = useState<string>("all");
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [friendProfileMobileTab, setFriendProfileMobileTab] = useState<"profile" | "library" | "stats">("profile");
  const [boardView, setBoardView] = useState<boolean>(true);
  const [ownFriendPreviewOpen, setOwnFriendPreviewOpen] = useState(false);
  const [adminFeedbackFilter, setAdminFeedbackFilter] = useState<"all" | "suggestion" | "problem" | "new" | "reviewed" | "done">("all");
  const [adminHideDone, setAdminHideDone] = useState(true);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LOCAL_BOARD_VIEW_KEY);
      if (raw !== null) {
        setBoardView(raw === "1" || raw === "true");
        return;
      }

      // Keep desktop the same, but make first-time mobile use default to the safer list view.
      if (typeof window !== "undefined" && window.matchMedia("(max-width: 640px)").matches) {
        setBoardView(false);
      }
    } catch {}
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LOCAL_BOARD_VIEW_KEY);
      if (raw !== null) return;
      setBoardView((settings.defaultBoardView ?? DEFAULT_SETTINGS.defaultBoardView) === "board");
    } catch {}
  }, [settings.defaultBoardView]);


  const [autofillStatus, setAutofillStatus] = useState("");
  const [autoAutofill, setAutoAutofill] = useState(true);
  const autofillTimer = useRef<number | null>(null);
  const lastAutofillKey = useRef<string>("");

  const [cloudLoaded, setCloudLoaded] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");
  // ================= FRIENDS =================
  const [inputUsername, setInputUsername] = useState("");
  const [friendStatus, setFriendStatus] = useState("");

  const [incomingRequests, setIncomingRequests] = useState<
    Array<{
      id: string;
      requester_id: string;
      requested_id: string;
      status: string;
      created_at?: string;
      requester?: { username?: string | null; display_name?: string | null } | null;
    }>
  >([]);

  const [outgoingRequests, setOutgoingRequests] = useState<
    Array<{
      id: string;
      requester_id: string;
      requested_id: string;
      status: string;
      created_at?: string;
      requested?: { username?: string | null; display_name?: string | null } | null;
    }>
  >([]);

  const [friendsList, setFriendsList] = useState<
    Array<{
      friend_id: string;
      friend?: { username?: string | null; display_name?: string | null } | null;
    }>
  >([]);

  const [selectedFriendProfileId, setSelectedFriendProfileId] = useState<string | null>(null);
  const [friendProfileView, setFriendProfileView] = useState<"all" | Status>("all");
  const [friendProfileQuery, setFriendProfileQuery] = useState("");
  const [friendProfileSortMode, setFriendProfileSortMode] = useState<SortMode>("updated");
  const [friendProfileBoardView, setFriendProfileBoardView] = useState(false);

  const isAdminUser = !!userId && STACK_ADMIN_USER_IDS.includes(userId);
  const [adminFeedbackRows, setAdminFeedbackRows] = useState<AdminFeedbackEntry[]>([]);
  const [adminFeedbackStatus, setAdminFeedbackStatus] = useState("");



  const [picks, setPicks] = useState<MediaPick[]>([]);
  const [pickStatus, setPickStatus] = useState("");
  const seenPickKeysRef = useRef<Set<string>>(new Set());


  const [excludeTypes, setExcludeTypes] = useState<Set<MediaType>>(new Set());
  const toggleExclude = useCallback((t: MediaType) => {
    setExcludeTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }, []);


  // Autofill UX improvements
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showSuggest, setShowSuggest] = useState(false);
  const [ghostTitle, setGhostTitle] = useState<string>("");
  const [activeSuggestIdx, setActiveSuggestIdx] = useState(0);

// For "delete 0 and type" UX
const [ratingText, setRatingText] = useState<string>(""); // decimal ok

// ✅ Rewatch: separate toggle + separate count text
const [isRewatch, setIsRewatch] = useState<boolean>(false);
const [rewatchText, setRewatchText] = useState<string>("0"); // integer

// ✅ remembers last valid count while toggle is ON (restores when you re-enable)
const lastRewatchOnRef = useRef<string>("1");

useEffect(() => {
  // keep ref sane if state starts as something else later
  const n = Math.floor(Number(rewatchText));
  if (Number.isFinite(n) && n > 0) lastRewatchOnRef.current = String(n);
  // run once
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);


const [progressCurText, setProgressCurText] = useState<string>(""); // integer
const [progressTotalText, setProgressTotalText] = useState<string>(""); // integer


  // Manual tags editor (keeps autofilled tags but allows extras)
  const [autoTags, setAutoTags] = useState<string[]>([]);
  const [manualTags, setManualTags] = useState<string[]>([]);

  // ✅ Undo delete
  const [undoState, setUndoState] = useState<{ item: MediaItem; index: number } | null>(null);
  const undoTimerRef = useRef<number | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(LOCAL_BOARD_VIEW_KEY, boardView ? "1" : "0");
    } catch {}
  }, [boardView]);

  // ✅ Cleanup undo timer on unmount
  useEffect(() => {
    return () => {
      if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current);
    };
  }, []);


  // Add form lives only on /add
  const [form, setForm] = useState<Partial<MediaItem>>({
    title: "",
    type: "movie",
    status: DEFAULT_SETTINGS.defaultAddStatus,
    tags: [],
    inTheaters: false,
    notes: "",
    dateFinished: "",
    rewatchCount: 0,
    rating: undefined,

    posterUrl: "",
    posterOverrideUrl: "",

    tmdbId: undefined,
    tmdbType: undefined,
    igdbId: undefined,
    anilistId: undefined,
    anilistType: undefined,

    progressCur: undefined,
    progressTotal: undefined,
  });

  // ✅ keep latest form in a ref (prevents stale status/type inside applySuggestion)
  const formRef = useRef<Partial<MediaItem>>(form);
  useEffect(() => {
    formRef.current = form;
  }, [form]);

  useEffect(() => {
    const defaultStatus = settings.defaultAddStatus ?? DEFAULT_SETTINGS.defaultAddStatus;
    const hasStartedTyping = String(form.title || "").trim().length > 0;
    if (hasStartedTyping) return;
    setForm((prev) => ({ ...prev, status: defaultStatus }));
  }, [settings.defaultAddStatus, form.title]);

  // ✅ Friends UI
  const [friendsTab, setFriendsTab] = useState<"friends" | "requests">("friends");
  const [friendsQuery, setFriendsQuery] = useState("");
  const [friendLibraryFriendId, setFriendLibraryFriendId] = useState<string>("all");
  const [friendLibraryStatus, setFriendLibraryStatus] = useState<FriendLibraryStatusFilter>("all");
  const [friendLibrarySortMode, setFriendLibrarySortMode] = useState<SortMode>("updated");
  const [selectedFriendIds, setSelectedFriendIds] = useState<string[]>([]);
  const [collapsedStatuses, setCollapsedStatuses] = useState<Set<Status>>(new Set());

  const [feedbackType, setFeedbackType] = useState<"suggestion" | "problem">("suggestion");
  const [feedbackText, setFeedbackText] = useState("");

  const [discoverType, setDiscoverType] = useState<"movie" | "tv">("movie");
  const [discoverGenres, setDiscoverGenres] = useState<Array<{ id: number; name: string }>>([]);
  const [discoverGenreId, setDiscoverGenreId] = useState<string>("all");
  const [discoverResults, setDiscoverResults] = useState<DiscoverCard[]>([]);
  const [discoverStatus, setDiscoverStatus] = useState("");

  const [friendActivityRows, setFriendActivityRows] = useState<Array<{ user_id: string; data: any }>>([]);
  const [friendActivityStatus, setFriendActivityStatus] = useState("");

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } })
  );

  const friendSettingsById = useMemo(() => {
    const map = new Map<string, StackSettings>();

    for (const row of friendActivityRows) {
      const settingsFromFriend = normalizeSettings(row?.data?.settings);
      map.set(row.user_id, settingsFromFriend);
    }

    return map;
  }, [friendActivityRows]);

  const getFriendDisplay = useCallback(
    (
      friendId: string,
      profile?: { username?: string | null; display_name?: string | null } | null
    ) => {
      const nickname = settings.friendNicknames?.[friendId]?.trim();
      const friendSettings = friendSettingsById.get(friendId);
      const settingsDisplayName = friendSettings?.displayName?.trim();
      const settingsTag = friendSettings?.usernameTag?.trim();
      const profileDisplayName = profile?.display_name?.trim();
      const username = profile?.username?.trim();

      const baseName = settingsDisplayName || profileDisplayName || username || friendId;
      const tagLabel = settingsTag || (username ? `@${username}` : "");
      const primary = nickname || baseName;

      const secondaryParts = nickname
        ? [baseName, tagLabel, friendId]
        : [tagLabel, friendId];

      const secondary = secondaryParts
        .filter((x): x is string => !!x && x !== primary)
        .filter((x, idx, arr) => arr.indexOf(x) === idx)
        .join(" • ");

      return {
        primary,
        secondary: secondary || friendId,
        baseName,
        idTag: tagLabel,
        hasCustomTag: !!nickname,
      };
    },
    [friendSettingsById, settings.friendNicknames]
  );

  const friendsNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const f of friendsList) {
      map.set(f.friend_id, getFriendDisplay(f.friend_id, f.friend).primary);
    }
    return map;
  }, [friendsList, getFriendDisplay]);

  const updateSettings = useCallback((patch: Partial<StackSettings>) => {
    if (isStackColorTheme(patch.colorTheme)) {
      saveLocalColorTheme(patch.colorTheme);
    }

    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  useEffect(() => {
    const theme = settings.colorTheme ?? DEFAULT_SETTINGS.colorTheme;
    if (isStackColorTheme(theme)) saveLocalColorTheme(theme);
  }, [settings.colorTheme]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const onStorage = (e: StorageEvent) => {
      if (e.key !== LOCAL_COLOR_THEME_KEY) return;
      if (!isStackColorTheme(e.newValue)) return;

      setSettings((prev) => ({ ...prev, colorTheme: e.newValue as StackColorTheme }));
    };

    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const updateFriendNickname = useCallback((friendId: string, nickname: string) => {
    setSettings((prev) => {
      const nextNicknames = { ...(prev.friendNicknames ?? {}) };
      const cleanNickname = nickname.trim();

      if (cleanNickname) nextNicknames[friendId] = cleanNickname;
      else delete nextNicknames[friendId];

      return {
        ...prev,
        friendNicknames: nextNicknames,
      };
    });
  }, []);

  const toggleSelectedFriend = useCallback((friendId: string) => {
    setSelectedFriendIds((prev) =>
      prev.includes(friendId) ? prev.filter((id) => id !== friendId) : [...prev, friendId]
    );
  }, []);

  const toggleCollapsedStatus = useCallback((status: Status) => {
    setCollapsedStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }, []);

  /* ================= NAV ================= */

  const navMain = useMemo(
    () => [
      { href: "/", label: "All", key: "all" as StackView },
      { href: "/completed", label: "Completed", key: "completed" as StackView },
      { href: "/in-progress", label: "In Progress", key: "in_progress" as StackView },
      { href: "/planned", label: "Planned", key: "planned" as StackView },
      { href: "/dropped", label: "Dropped", key: "dropped" as StackView },
    ],
    []
  );

  const navActions = useMemo(
    () => [
      { href: "/feed", label: "Feed", key: "feed" as StackView, icon: "feed" as const },
      { href: "/discover", label: "Discover", key: "discover" as StackView, icon: "discover" as const },
      { href: "/add", label: "Add", key: "add" as StackView, icon: "plus" as const },
      { href: "/stats", label: "Stats", key: "stats" as StackView, icon: "pie" as const },
      { href: "/friends", label: "Friends", key: "friends" as StackView, icon: "users" as const },
      { href: "/feedback", label: "Feedback", key: "feedback" as StackView, icon: "feedback" as const },
      { href: "/settings", label: "Settings", key: "settings" as StackView, icon: "settings" as const },
    ],
    []
  );


  /* ================= LOCAL BACKUP ================= */

  const loadLocalBackup = useCallback((uid?: string | null): MediaItem[] | null => {
    try {
      const keys = uid
        ? [
            backupKeyForUser(uid),
            lastGoodKeyForUser(uid),
            LOCAL_BACKUP_KEY,
            LOCAL_LAST_GOOD_KEY,
          ]
        : [LOCAL_BACKUP_KEY, LOCAL_LAST_GOOD_KEY];

      for (const key of Array.from(new Set(keys))) {
        const parsed = parseBackupItems(localStorage.getItem(key));
        if (parsed && parsed.length > 0) return parsed;
      }

      return null;
    } catch {
      return null;
    }
  }, []);

  const saveLocalBackup = useCallback((next: MediaItem[], uid?: string | null) => {
    try {
      const primaryKey = backupKeyForUser(uid);
      const lastGoodKey = lastGoodKeyForUser(uid);

      const existingPrimary = parseBackupItems(localStorage.getItem(primaryKey));
      const existingLastGood = parseBackupItems(localStorage.getItem(lastGoodKey));
      const existingGeneral = uid ? parseBackupItems(localStorage.getItem(LOCAL_BACKUP_KEY)) : null;
      const existingGeneralLastGood = uid ? parseBackupItems(localStorage.getItem(LOCAL_LAST_GOOD_KEY)) : null;

      const bestExisting = [existingPrimary, existingLastGood, existingGeneral, existingGeneralLastGood]
        .filter((x): x is MediaItem[] => Array.isArray(x) && x.length > 0)
        .sort((a, b) => b.length - a.length)[0];

      if (next.length === 0 && bestExisting && bestExisting.length > 0) {
        console.warn(
          `Blocked empty local backup overwrite. Existing backup has ${bestExisting.length} items.`
        );
        return;
      }

      localStorage.setItem(primaryKey, JSON.stringify(next));

      if (next.length > 0) {
        localStorage.setItem(lastGoodKey, JSON.stringify(next));
        localStorage.setItem(LOCAL_BACKUP_KEY, JSON.stringify(next));
        localStorage.setItem(LOCAL_LAST_GOOD_KEY, JSON.stringify(next));
      }
    } catch {}
  }, []);

/* ================= SUPABASE ================= */

type ProfileRow = { id: string; username: string | null; display_name?: string | null };

type IncomingRequestRow = {
  id: string;
  requester_id: string;
  requested_id: string;
  status: "pending" | "accepted" | "declined";
  created_at?: string;
  requester?: { username?: string | null; display_name?: string | null } | null;
};

type FriendRow = {
  friend_id: string;
  friend?: { username?: string | null; display_name?: string | null } | null;
};

const AUTO_ACCEPT_FRIEND_REQUESTS = true;

/** Prefer exact username first, then display name. Display names can repeat, so ambiguous matches ask for username. */
const findProfileByUsernameOrDisplayName = useCallback(
  async (input: string): Promise<{ profile: ProfileRow | null; ambiguous?: boolean }> => {
    const q = input.trim();
    if (!q) return { profile: null };

    const normalizeLookup = (value: unknown) =>
      String(value ?? "")
        .trim()
        .replace(/^@+/, "")
        .replace(/\s+/g, " ")
        .toLowerCase();

    const cleanQ = q.replace(/^@+/, "").trim();
    const qNorm = normalizeLookup(q);

    const dedupeMatches = (rows: ProfileRow[]) => {
      const map = new Map<string, ProfileRow>();
      for (const row of rows) {
        if (!row?.id) continue;
        if (!map.has(row.id)) map.set(row.id, row);
      }
      return Array.from(map.values());
    };

    const resolveMatches = (rows: ProfileRow[]) => {
      const matches = dedupeMatches(rows);
      if (matches.length === 1) return { profile: matches[0] };
      if (matches.length > 1) return { profile: null, ambiguous: true };
      return { profile: null };
    };

    // 1) Exact username, case-insensitive, with or without @.
    const { data: usernameMatches, error: usernameError } = await supabase
      .from("profiles")
      .select("id, username, display_name")
      .ilike("username", cleanQ)
      .limit(3);

    if (usernameError) console.error(usernameError);
    const exactUsername = resolveMatches((usernameMatches ?? []) as ProfileRow[]);
    if (exactUsername.profile || exactUsername.ambiguous) return exactUsername;

    // 2) Exact profile display_name, case-insensitive.
    const { data: exactDisplayMatches, error: exactDisplayError } = await supabase
      .from("profiles")
      .select("id, username, display_name")
      .ilike("display_name", q)
      .limit(3);

    if (exactDisplayError) {
      console.error(exactDisplayError);
      return { profile: null };
    }

    const exactProfileDisplay = resolveMatches((exactDisplayMatches ?? []) as ProfileRow[]);
    if (exactProfileDisplay.profile || exactProfileDisplay.ambiguous) return exactProfileDisplay;

    // 3) Exact Stack display name / custom ID tag from the existing media_items.data.settings JSON.
    // This is needed because the Settings page saves displayName in media_items.data.settings,
    // while friend search was only checking profiles.display_name before.
    const { data: stackRows, error: stackRowsError } = await supabase
      .from("media_items")
      .select("user_id,data")
      .limit(500);

    if (stackRowsError) console.warn(stackRowsError);

    const stackProfiles = ((stackRows ?? []) as Array<{ user_id: string; data: any }>)
      .map((row) => {
        const rowSettings = normalizeSettings(row?.data?.settings);
        const displayName = rowSettings.displayName?.trim() || "";
        const usernameTag = rowSettings.usernameTag?.trim() || "";

        return {
          profile: {
            id: row.user_id,
            username: usernameTag ? usernameTag.replace(/^@+/, "") : null,
            display_name: displayName || usernameTag || null,
          } satisfies ProfileRow,
          displayName,
          usernameTag,
        };
      })
      .filter((row) => row.profile.id);

    const exactStackMatches = stackProfiles
      .filter((row) => normalizeLookup(row.displayName) === qNorm || normalizeLookup(row.usernameTag) === qNorm)
      .map((row) => row.profile);

    const exactStackDisplay = resolveMatches(exactStackMatches);
    if (exactStackDisplay.profile || exactStackDisplay.ambiguous) return exactStackDisplay;

    // 4) Partial profile display_name match.
    const { data: partialDisplayMatches, error: partialDisplayError } = await supabase
      .from("profiles")
      .select("id, username, display_name")
      .ilike("display_name", `%${q}%`)
      .limit(3);

    if (partialDisplayError) {
      console.error(partialDisplayError);
      return { profile: null };
    }

    const partialProfileDisplay = resolveMatches((partialDisplayMatches ?? []) as ProfileRow[]);
    if (partialProfileDisplay.profile || partialProfileDisplay.ambiguous) return partialProfileDisplay;

    // 5) Partial Stack display name / custom ID tag match.
    const partialStackMatches = stackProfiles
      .filter((row) => {
        const display = normalizeLookup(row.displayName);
        const tag = normalizeLookup(row.usernameTag);
        return (display && display.includes(qNorm)) || (tag && tag.includes(qNorm));
      })
      .map((row) => row.profile);

    const partialStackDisplay = resolveMatches(partialStackMatches);
    if (partialStackDisplay.profile || partialStackDisplay.ambiguous) return partialStackDisplay;

    return { profile: null };
  },
  []
);

/** ✅ DEFINE THIS FIRST so it can be referenced safely below */
const loadFriends = useCallback(
  async (uid?: string) => {
    const me = uid ?? userId;
    if (!me) return;

    const { data, error } = await supabase
      .from("friends")
      .select("friend_id, friend:friend_id(username, display_name)")
      .eq("user_id", me);

    if (error) {
      console.error(error);
      return;
    }

    setFriendsList((data ?? []) as FriendRow[]);
  },
  [userId]
);

const loadIncomingFriendRequests = useCallback(
  async (uid?: string, opts?: { autoAccept?: boolean }) => {
    const me = uid ?? userId;
    if (!me) return;

    const { data, error } = await supabase
      .from("friend_requests")
      .select("id, requester_id, requested_id, status, created_at, requester:requester_id(username, display_name)")
      .eq("requested_id", me)
      .eq("status", "pending")
      .order("created_at", { ascending: false });

    if (error) {
      console.error(error);
      return;
    }

    const rows = (data ?? []) as IncomingRequestRow[];
    setIncomingRequests(rows);

    const shouldAutoAccept = opts?.autoAccept ?? AUTO_ACCEPT_FRIEND_REQUESTS;
    if (!shouldAutoAccept) return;

    for (const r of rows) {
      try {
        await acceptFriendRequest(r.id, r.requester_id, { skipReload: true, me });
      } catch (e) {
        console.error(e);
      }
    }

    await Promise.all([loadIncomingFriendRequests(me, { autoAccept: false }), loadFriends(me)]);
  },
  [userId, loadFriends]
);

const loadOutgoingFriendRequests = useCallback(
  async (uid?: string) => {
    const me = uid ?? userId;
    if (!me) return;

    const { data, error } = await supabase
      .from("friend_requests")
      .select("id, requester_id, requested_id, status, created_at, requested:requested_id(username, display_name)")
      .eq("requester_id", me)
      .eq("status", "pending")
      .order("created_at", { ascending: false });

    if (error) {
      console.error(error);
      return;
    }

    setOutgoingRequests((data ?? []) as any[]);
  },
  [userId]
);

async function acceptFriendRequest(
  requestId: string,
  requesterId: string,
  opts?: { skipReload?: boolean; me?: string }
) {
  const me = opts?.me ?? userId;
  if (!me) return;

  // 1) mark request accepted (idempotent-ish)
  const { data: updated, error: upErr } = await supabase
    .from("friend_requests")
    .update({ status: "accepted" })
    .eq("id", requestId)
    .eq("requested_id", me)
    .eq("status", "pending")
    .select("id,status")
    .maybeSingle();

  if (upErr) {
    console.error(upErr);
    setFriendStatus(upErr.message || "Failed to accept request.");
    return;
  }

  if (!updated) {
    if (!opts?.skipReload) setFriendStatus("Nothing to accept (already handled).");
    return;
  }

  // 2) RLS-safe friendship insert.
  // Most Supabase policies only allow a user to insert rows where friends.user_id = auth.uid().
  // So the receiver creates only their own side here. The requester creates their side when they send.
  const { error: frErr } = await supabase
    .from("friends")
    .upsert(
      [{ user_id: me, friend_id: requesterId }],
      { onConflict: "user_id,friend_id" }
    );

  if (frErr) {
    console.error(frErr);
    setFriendStatus(frErr.message || "Accepted, but failed to create your friendship row.");
  } else {
    setFriendStatus(AUTO_ACCEPT_FRIEND_REQUESTS ? "Friend added ✅ (auto-accepted)" : "Friend added ✅");
  }

  if (opts?.skipReload) return;

  await Promise.all([loadIncomingFriendRequests(me, { autoAccept: false }), loadFriends(me)]);
}

async function declineFriendRequest(requestId: string) {
  if (!userId) return;

  const { error } = await supabase
    .from("friend_requests")
    .update({ status: "declined" })
    .eq("id", requestId)
    .eq("requested_id", userId)
    .eq("status", "pending");

  if (error) {
    console.error(error);
    setFriendStatus(error.message || "Failed to decline request.");
    return;
  }

  setFriendStatus("Request declined.");
  await loadIncomingFriendRequests(userId, { autoAccept: false });
}

async function removeFriend(friendId: string) {
  if (!userId) return;

  const friendName = friendsNameById.get(friendId) ?? friendId;
  const confirmed =
    typeof window === "undefined"
      ? true
      : window.confirm(`Remove ${friendName} from your friends list?`);

  if (!confirmed) return;

  const { error } = await supabase
    .from("friends")
    .delete()
    .eq("user_id", userId)
    .eq("friend_id", friendId);

  if (error) {
    console.error(error);
    setFriendStatus(error.message || "Failed to remove friend.");
    return;
  }

  // Best-effort cleanup of the mirrored row. Some RLS setups may block this,
  // but the friend is removed from your own list either way.
  const reciprocal = await supabase
    .from("friends")
    .delete()
    .eq("user_id", friendId)
    .eq("friend_id", userId);

  if (reciprocal.error) console.warn(reciprocal.error);

  setSettings((prev) => {
    const nextNicknames = { ...(prev.friendNicknames ?? {}) };
    delete nextNicknames[friendId];
    return { ...prev, friendNicknames: nextNicknames };
  });

  setSelectedFriendIds((prev) => prev.filter((id) => id !== friendId));
  setFriendActivityRows((prev) => prev.filter((row) => row.user_id !== friendId));
  setFriendLibraryFriendId((prev) => (prev === friendId ? "all" : prev));
  setFriendStatus(`Removed ${friendName} from your friends list.`);

  await loadFriends(userId);
}

async function sendFriendRequest() {
  setFriendStatus("");

  if (!userId) {
    setFriendStatus("You must be logged in.");
    return;
  }

  const { profile, ambiguous } = await findProfileByUsernameOrDisplayName(inputUsername);

  if (ambiguous) {
    setFriendStatus("More than one person matches that display name. Ask them for their exact Stack username.");
    return;
  }

  if (!profile?.id) {
    setFriendStatus("User not found. Ask them to log into Stack once after setting their display name, or try their exact Stack username.");
    return;
  }

  const profileLabel = profile.display_name?.trim() || profile.username?.trim() || "that user";

  if (profile.id === userId) {
    setFriendStatus("You can't friend yourself 💀");
    return;
  }

  const finishFriendAdd = async (messagePrefix = "Friend request sent") => {
    // RLS-safe: only create YOUR row in friends.
    // The other person's row is created when their account loads Stack and auto-accepts the pending request.
    const { error: friendshipError } = await supabase
      .from("friends")
      .upsert(
        [{ user_id: userId, friend_id: profile.id }],
        { onConflict: "user_id,friend_id" }
      );

    if (friendshipError) {
      console.error(friendshipError);
      setFriendStatus(friendshipError.message || "Found the user, but could not create your friendship row.");
      return false;
    }

    setFriendStatus(`${messagePrefix}: ${profileLabel}. They will be added on their side when they open Stack.`);
    setInputUsername("");

    await Promise.all([
      loadFriends(userId),
      loadOutgoingFriendRequests(userId),
      loadIncomingFriendRequests(userId, { autoAccept: false }),
    ]);

    return true;
  };

  // already friends?
  const { data: existingFriend, error: friendCheckErr } = await supabase
    .from("friends")
    .select("friend_id")
    .eq("user_id", userId)
    .eq("friend_id", profile.id)
    .maybeSingle();

  if (friendCheckErr) console.error(friendCheckErr);

  if (existingFriend?.friend_id) {
    setFriendStatus(`You're already friends with ${profileLabel}.`);
    return;
  }

  // existing pending request either direction?
  const { data: existingReq, error: reqErr } = await supabase
    .from("friend_requests")
    .select("id, status, requester_id, requested_id")
    .or(
      `and(requester_id.eq.${userId},requested_id.eq.${profile.id}),and(requester_id.eq.${profile.id},requested_id.eq.${userId})`
    )
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (reqErr) console.error(reqErr);

  if (existingReq?.id && existingReq.status === "pending") {
    if (existingReq.requester_id === profile.id && existingReq.requested_id === userId) {
      setFriendStatus(`${profileLabel} already requested you — accepting…`);
      await acceptFriendRequest(existingReq.id, profile.id);
      setInputUsername("");
      return;
    }

    // You already sent the request before. Make sure YOUR side exists, but leave
    // the request pending so the other person can auto-accept and create their side.
    await finishFriendAdd("Friend request already sent");
    return;
  }

  // Keep a pending request row so the other account can auto-accept on their next load.
  const requestInsert = await supabase.from("friend_requests").insert({
    requester_id: userId,
    requested_id: profile.id,
    status: "pending",
  });

  if (requestInsert.error) {
    console.error(requestInsert.error);
    setFriendStatus(requestInsert.error.message || "Found the user, but could not send the friend request.");
    return;
  }

  await finishFriendAdd("Friend request sent");
}


const parseFeedbackEntries = (rawFeedback: unknown): FeedbackEntry[] => {
  return Array.isArray(rawFeedback)
    ? (rawFeedback as any[])
        .filter((x) => x && typeof x.id === "string" && typeof x.message === "string")
        .map((x) => ({
          id: x.id,
          type: x.type === "problem" ? "problem" : "suggestion",
          message: String(x.message),
          createdAt: typeof x.createdAt === "string" ? x.createdAt : new Date().toISOString(),
          status: x.status === "reviewed" || x.status === "done" ? x.status : "new",
        }))
    : [];
};

const loadCloud = useCallback(
  async (uidStr: string) => {
    setSaveStatus("Loading…");
    setCloudLoaded(false);

    const localBackup = loadLocalBackup(uidStr);
    const localBackupCount = localBackup?.length ?? 0;

    const { data, error } = await supabase
      .from("media_items")
      .select("data")
      .eq("user_id", uidStr)
      .maybeSingle();

    if (error) {
      console.error(error);
      if (localBackupCount > 0) {
        setItems(localBackup!);
        saveLocalBackup(localBackup!, uidStr);
      }
      setCloudLoaded(true);
      setSaveStatus(localBackupCount > 0 ? `Loaded local backup (${localBackupCount})` : "Cloud load error");
      return;
    }

    const raw = data?.data as unknown;
    const rawObj = raw && typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as any) : null;

    const parsedItems =
      rawObj &&
      "items" in rawObj &&
      Array.isArray(rawObj.items)
        ? (rawObj.items as any[])
            .filter((x) => x && typeof x.id === "string" && typeof x.title === "string")
            .map((x) => x as MediaItem)
        : Array.isArray(raw)
          ? (raw as any[])
              .filter((x) => x && typeof x.id === "string" && typeof x.title === "string")
              .map((x) => x as MediaItem)
          : null;

    if (parsedItems) {
      if (parsedItems.length === 0 && localBackupCount > 0) {
        setItems(localBackup!);
        setSettings(normalizeSettings(rawObj?.settings));
        setFeedbackEntries(parseFeedbackEntries(rawObj?.feedback));
        setCloudExtraData(omitKnownDataKeys(raw));
        saveLocalBackup(localBackup!, uidStr);
        setCloudLoaded(true);
        setSaveStatus(`Recovery mode: cloud was empty, showing backup (${localBackupCount})`);
        return;
      }

      setItems(parsedItems);
      setSettings(normalizeSettings(rawObj?.settings));
      setFeedbackEntries(parseFeedbackEntries(rawObj?.feedback));
      setCloudExtraData(omitKnownDataKeys(raw));
      saveLocalBackup(parsedItems, uidStr);
      setCloudLoaded(true);
      setSaveStatus("Loaded");
      return;
    }

    if (localBackupCount > 0) {
      setItems(localBackup!);
      setSettings(normalizeSettings(rawObj?.settings));
      setFeedbackEntries(parseFeedbackEntries(rawObj?.feedback));
      setCloudExtraData(omitKnownDataKeys(raw));
      saveLocalBackup(localBackup!, uidStr);
      setCloudLoaded(true);
      setSaveStatus(`Recovery mode: missing cloud items, showing backup (${localBackupCount})`);
      return;
    }

    const initialData = { items: [], settings: DEFAULT_SETTINGS, feedback: [] };
    const up = await supabase
      .from("media_items")
      .upsert([{ user_id: uidStr, data: initialData }], { onConflict: "user_id" });

    if (up.error) {
      console.error(up.error);
      setCloudLoaded(true);
      setSaveStatus("Cloud setup error");
      return;
    }

    setItems([]);
    setSettings(DEFAULT_SETTINGS);
    setFeedbackEntries([]);
    setCloudExtraData({});
    setCloudLoaded(true);
    setSaveStatus("Loaded");
  },
  [loadLocalBackup, saveLocalBackup]
);

const saveCloud = useCallback(
  async (uidStr: string, next: MediaItem[], nextSettings: StackSettings, nextFeedback: FeedbackEntry[]) => {
    if (next.length === 0) {
      const backup = loadLocalBackup(uidStr);

      if (backup && backup.length > 0) {
        setItems(backup);
        saveLocalBackup(backup, uidStr);
        setSaveStatus(`Blocked empty save; restored backup (${backup.length})`);
        return;
      }
    }

    saveLocalBackup(next, uidStr);
    if (!cloudLoaded) return;

    setSaveStatus("Saving…");

    const dataPayload = {
      ...cloudExtraData,
      items: next,
      settings: normalizeSettings(nextSettings),
      feedback: nextFeedback,
    };

    const { error } = await supabase
      .from("media_items")
      .upsert([{ user_id: uidStr, data: dataPayload }], { onConflict: "user_id" });

    if (error) {
      console.error(error);
      setSaveStatus("Saved locally (cloud error)");
      return;
    }

    setSaveStatus("Saved");
  },
  [cloudLoaded, saveLocalBackup, loadLocalBackup, cloudExtraData]
);

useEffect(() => {
  const backup = loadLocalBackup(null);
  if (backup) setItems(backup);
}, [loadLocalBackup]);

useEffect(() => {
  if (!userId) return;
  loadIncomingFriendRequests(userId);
  loadOutgoingFriendRequests(userId);
  loadFriends(userId);
}, [userId, loadIncomingFriendRequests, loadOutgoingFriendRequests, loadFriends]);

useEffect(() => {
  if (!userId || !cloudLoaded) return;

  const displayName = (settings.displayName ?? "").trim();
  const timer = window.setTimeout(async () => {
    try {
      const { error } = await supabase
        .from("profiles")
        .update({ display_name: displayName || null })
        .eq("id", userId);

      if (error) console.warn("Could not sync Stack display name to profiles.display_name", error);
    } catch (e) {
      console.warn("Could not sync Stack display name to profiles.display_name", e);
    }
  }, 600);

  return () => window.clearTimeout(timer);
}, [userId, cloudLoaded, settings.displayName]);

useEffect(() => {
  let mounted = true;

  supabase.auth.getUser().then(({ data }) => {
    if (!mounted) return;
    const uidStr = data.user?.id ?? null;
    setUserId(uidStr);
    if (uidStr) loadCloud(uidStr);
  });

  const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
    const uidStr = session?.user?.id ?? null;
    setUserId(uidStr);
    if (uidStr) loadCloud(uidStr);
  });

  return () => {
    mounted = false;
    sub?.subscription?.unsubscribe();
  };

}, [loadCloud]);

useEffect(() => {
  if (!userId || !cloudLoaded) return;

  const reloadFromCloud = () => {
    loadCloud(userId);
  };

  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") reloadFromCloud();
  };

  window.addEventListener("focus", reloadFromCloud);
  document.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    window.removeEventListener("focus", reloadFromCloud);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}, [userId, cloudLoaded, loadCloud]);

useEffect(() => {
  if (userId) saveCloud(userId, items, settings, feedbackEntries);
  else saveLocalBackup(items, null);
}, [items, settings, feedbackEntries, userId, saveCloud, saveLocalBackup]);



/* ================= ACTIONS ================= */

function addItem(e: React.SyntheticEvent) {
  e.preventDefault();
  if (!form.title) return;

  const status = (form.status as Status) ?? "planned";

  const manualDate = (form.dateFinished || "").trim();
  const autoDate = status === "completed" ? todayYMD() : "";
  const finalDate = manualDate || autoDate || undefined;

  const ratingNum = ratingText.trim() === "" ? undefined : Number(ratingText);
  const rating =
    typeof ratingNum === "number" && Number.isFinite(ratingNum) ? clamp(ratingNum, 0, 10) : undefined;

  const rewatchCount = isRewatch
    ? Math.max(1, Math.floor(Number(rewatchText.trim() || "1") || 1))
    : 0;


  const pc = progressCurText.trim() === "" ? undefined : Math.max(0, Number(progressCurText) || 0);
  const pt = progressTotalText.trim() === "" ? undefined : Math.max(0, Number(progressTotalText) || 0);

  // Progress defaults:
  const inferredTotal = (form.type as MediaType) === "movie" ? (typeof pt === "number" ? pt : 1) : pt;
  const inferredCur =
    typeof pc === "number"
      ? pc
      : status === "completed" && typeof inferredTotal === "number"
      ? inferredTotal
      : undefined;

  const tags = uniqTags([...(autoTags ?? []), ...(manualTags ?? [])]);

  const item: MediaItem = {
    id: uid(),
    title: String(form.title).trim(),
    type: form.type as MediaType,
    status,
    inTheaters: !!form.inTheaters,
    dateFinished: finalDate,

    posterUrl: (form.posterUrl || "").trim() || undefined,
    posterOverrideUrl: (form.posterOverrideUrl || "").trim() || undefined,

    runtime: typeof form.runtime === "number" ? form.runtime : undefined,
    notes: (form.notes || "").trim() || undefined,
    tags,
    rewatchCount,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    rating,
    favorite: false,
    isPrivate: false,
    withFriendIds: selectedFriendIds.length ? selectedFriendIds : undefined,

    tmdbId: typeof form.tmdbId === "number" ? form.tmdbId : undefined,
    tmdbType: form.tmdbType === "movie" || form.tmdbType === "tv" ? form.tmdbType : undefined,
    igdbId: typeof form.igdbId === "number" ? form.igdbId : undefined,
    anilistId: typeof form.anilistId === "number" ? form.anilistId : undefined,
    anilistType: form.anilistType === "ANIME" || form.anilistType === "MANGA" ? form.anilistType : undefined,

    progressCur: typeof inferredCur === "number" ? inferredCur : undefined,
    progressTotal: typeof inferredTotal === "number" ? inferredTotal : undefined,

    hoursPlayed: typeof form.hoursPlayed === "number" ? form.hoursPlayed : undefined,
  };

  setItems((p) => [item, ...p]);

  // reset
  setAutofillStatus("");
  setSuggestions([]);
  setShowSuggest(false);
  setGhostTitle("");
  setActiveSuggestIdx(0);

  setForm((prev) => ({
    title: "",
    type: prev.type ?? "movie",
    status: settings.defaultAddStatus ?? DEFAULT_SETTINGS.defaultAddStatus,
    tags: [],
    inTheaters: false,
    notes: "",
    dateFinished: "",
    posterUrl: "",
    posterOverrideUrl: "",
    runtime: undefined,
    rewatchCount: 0,
    rating: undefined,
    tmdbId: undefined,
    tmdbType: undefined,
    igdbId: undefined,
    anilistId: undefined,
    anilistType: undefined,
    progressCur: undefined,
    progressTotal: undefined,
    hoursPlayed: undefined,
  }));

  setAutoTags([]);
  setManualTags([]);

  setRatingText("");
  setIsRewatch(false);
  setRewatchText("0");
  setProgressCurText("");
  setProgressTotalText("");
  setSelectedFriendIds([]);

}

// ✅ Undo delete
function removeItem(id: string) {
  setItems((prev) => {
    const idx = prev.findIndex((x) => x.id === id);
    if (idx === -1) return prev;

    const deleted = prev[idx];

    if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current);

    setUndoState({ item: deleted, index: idx });

    undoTimerRef.current = window.setTimeout(() => {
      setUndoState(null);
      undoTimerRef.current = null;
    }, 7000);

    return prev.filter((x) => x.id !== id);
  });
}

// ✅ Smart status + smart date + progress auto-complete
function updateItem(id: string, patch: Partial<MediaItem>) {
  const nowIso = new Date().toISOString();

  setItems((prev) =>
    prev.map((x) => {
      if (x.id !== id) return x;

      const merged: MediaItem = { ...x, ...patch, updatedAt: nowIso };

      const hadCompleted = x.status === "completed";
      const nowCompleted = merged.status === "completed";

      // ✅ Was status explicitly changed by the user in this update?
      const statusExplicit = Object.prototype.hasOwnProperty.call(patch, "status");

      const getEffectiveProgress = (it: MediaItem) => {
        if (it.type === "movie") {
          const d = getMovieProgressDefaults(it);
          return { cur: d.cur, total: d.total };
        }

        const cur = typeof it.progressCurOverride === "number" ? it.progressCurOverride : it.progressCur;
        const total = typeof it.progressTotalOverride === "number" ? it.progressTotalOverride : it.progressTotal;
        return { cur, total };
      };

      // If status becomes completed and no date, set to today
      if (!hadCompleted && nowCompleted && !merged.dateFinished) {
        merged.dateFinished = todayYMD();
      }

      const { cur, total } = getEffectiveProgress(merged);
      const totalNum = typeof total === "number" && Number.isFinite(total) ? total : undefined;
      const curNum = typeof cur === "number" && Number.isFinite(cur) ? cur : undefined;

      // ✅ Only auto-complete from progress when status was NOT manually changed
      if (
        !statusExplicit &&
        merged.status !== "completed" &&
        typeof totalNum === "number" &&
        totalNum > 0 &&
        typeof curNum === "number" &&
        curNum >= totalNum
      ) {
        merged.status = "completed";
        if (!merged.dateFinished) merged.dateFinished = todayYMD();
      }

      // When completed, make progress "finished" where appropriate
      if (merged.status === "completed") {
        if (merged.type === "movie") {
          merged.progressTotal = 1;
          merged.progressCur = 1;
        } else if (merged.type === "tv" || merged.type === "anime" || merged.type === "manga") {
          if (typeof totalNum === "number" && totalNum > 0) {
            const currentCur =
              typeof merged.progressCurOverride === "number" ? merged.progressCurOverride : merged.progressCur;

            if (typeof currentCur !== "number" || currentCur < totalNum) {
              merged.progressCur = totalNum;
            }
          }
        }
      }

      return merged;
    })
  );
}

async function pickForMe(mode: "best" | "random" = "best") {
  try {
    setPickStatus(mode === "random" ? "Finding something random…" : "Finding picks…");
    setPicks([]);

    const existingTitles = new Set(items.map((i) => i.title.toLowerCase()));
    const taste = computeTasteProfile(items);

    const seed = items
      .filter((i) => i.tmdbId && (i.tmdbType === "movie" || i.tmdbType === "tv") && typeof i.rating === "number")
      .sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1))
      .slice(0, 10);

    const fallbackSeed = items
      .filter((i) => i.tmdbId && (i.tmdbType === "movie" || i.tmdbType === "tv"))
      .slice(0, 8);

    const seeds = seed.length ? seed : fallbackSeed;

    const pool: Array<{ title: string; tmdbId: number; tmdbType: "movie" | "tv" }> = [];

    // 1) Recommendations from your best seeds (what you already do)
    for (const i of seeds) {
      const tmdbId = i.tmdbId!;
      const tmdbType = i.tmdbType!;
      const rec = await tmdbRecommendations(tmdbId, tmdbType);

      for (const r of rec.results ?? []) {
        const t = (r.title || r.name || "").trim();
        if (!t) continue;
        if (existingTitles.has(t.toLowerCase())) continue;
        pool.push({ title: t, tmdbId: r.id, tmdbType });
      }
    }

    // 2) Trending injection (what you already do)
    const [trendMovie, trendTv] = await Promise.all([tmdbTrending("movie"), tmdbTrending("tv")]);

    for (const r of trendMovie.results ?? []) {
      const t = (r.title || r.name || "").trim();
      if (!t) continue;
      if (existingTitles.has(t.toLowerCase())) continue;
      pool.push({ title: t, tmdbId: r.id, tmdbType: "movie" });
    }

    for (const r of trendTv.results ?? []) {
      const t = (r.title || r.name || "").trim();
      if (!t) continue;
      if (existingTitles.has(t.toLowerCase())) continue;
      pool.push({ title: t, tmdbId: r.id, tmdbType: "tv" });
    }

    // 3) ✅ NEW: Discover based on your top genre tags (big “best pick” upgrade)
    const [movieGenres, tvGenres] = await Promise.all([tmdbGenreList("movie"), tmdbGenreList("tv")]);

    const toGenreIds = (type: "movie" | "tv") => {
      const list = type === "movie" ? movieGenres : tvGenres;
      const map = new Map(list.map((g) => [normTag(g.name), g.id]));
      const ids = (taste.topTags ?? [])
        .map((t) => map.get(normTag(t)))
        .filter((x): x is number => typeof x === "number");
      return Array.from(new Set(ids)).slice(0, 3); // top 3 genre IDs
    };

    const movieGenreIds = toGenreIds("movie");
    const tvGenreIds = toGenreIds("tv");

    const [discMovies, discTv] = await Promise.all([
      tmdbDiscoverByGenres("movie", movieGenreIds),
      tmdbDiscoverByGenres("tv", tvGenreIds),
    ]);

    for (const d of discMovies) {
      const t = (d.title || d.name || "").trim();
      if (!t) continue;
      if (existingTitles.has(t.toLowerCase())) continue;
      pool.push({ title: t, tmdbId: d.id, tmdbType: "movie" });
    }

    for (const d of discTv) {
      const t = (d.title || d.name || "").trim();
      if (!t) continue;
      if (existingTitles.has(t.toLowerCase())) continue;
      pool.push({ title: t, tmdbId: d.id, tmdbType: "tv" });
    }

    const seen = new Set<string>();
    const unique = pool.filter((x) => {
      const k = `${x.tmdbType}:${x.tmdbId}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    if (!unique.length) {
      setPickStatus("No new picks found (try rating more items).");
      return;
    }

    const candidates = unique.slice(0, 80);
    const enriched: Array<{
      provider: "tmdb";
      title: string;
      tmdbId: number;
      tmdbType: "movie" | "tv";
      posterUrl?: string;
      score: number;
      tags: string[];
    }> = [];

    for (const c of candidates) {
      try {
        const d = await tmdbDetails(c.tmdbId, c.tmdbType);
        const posterUrl = d.poster_path ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : undefined;
        const tags = (d.genres ?? []).map((g) => g.name);

        const typeBoost = c.tmdbType === "movie" ? taste.typePref.movie : taste.typePref.tv;

        const score = scoreCandidate({
          candidateTags: tags,
          userTopTags: taste.topTags,
          typeBoost,
        });

        enriched.push({
          provider: "tmdb",
          title: c.title,
          tmdbId: c.tmdbId,
          tmdbType: c.tmdbType,
          posterUrl,
          score,
          tags,
        });
      } catch {
        // ignore TMDB failures for individual items
      }
    }

    enriched.sort((a, b) => b.score - a.score);

    if (mode === "best") {
      const top = diversifyPicks(enriched);

      setPicks(
        top.map((p) => ({
          provider: "tmdb",
          title: p.title,
          tmdbId: p.tmdbId,
          tmdbType: p.tmdbType,
          posterUrl: p.posterUrl,
        }))
      );

      setPickStatus("Here you go.");
      return;
    }

    if (mode === "random") {
      setPickStatus("Rolling the dice…");

      // ✅ Truly random: ignore your library/taste, pull from provider catalogs
      // (Movie/TV: TMDB discover random. Anime/Manga: AniList random pages.)
      // NOTE: Games “true random” needs a new IGDB endpoint; see note below.
      const sources: Array<"tmdb_movie" | "tmdb_tv" | "anilist_anime" | "anilist_manga"> = [
        "tmdb_movie",
        "tmdb_tv",
        "anilist_anime",
        "anilist_manga",
      ];

      // try a few times in case we hit something already in your list
      for (let attempt = 0; attempt < 10; attempt++) {
        const src = sources[Math.floor(Math.random() * sources.length)];

        try {
          if (src === "tmdb_movie") {
            const r = await tmdbDiscoverRandom("movie");
            if (existingTitles.has(r.title.toLowerCase())) continue;

            setPicks([{ provider: "tmdb", title: r.title, tmdbId: r.tmdbId, tmdbType: "movie", posterUrl: r.posterUrl }]);
            setPickStatus("Here you go.");
            return;
          }

          if (src === "tmdb_tv") {
            const r = await tmdbDiscoverRandom("tv");
            if (existingTitles.has(r.title.toLowerCase())) continue;

            setPicks([{ provider: "tmdb", title: r.title, tmdbId: r.tmdbId, tmdbType: "tv", posterUrl: r.posterUrl }]);
            setPickStatus("Here you go.");
            return;
          }

          if (src === "anilist_anime") {
            const r = await anilistRandomAnime();
            if (existingTitles.has(r.title.toLowerCase())) continue;

            setPicks([{ provider: "anilist", title: r.title, anilistId: r.anilistId, anilistType: "ANIME", posterUrl: r.posterUrl }]);
            setPickStatus("Here you go.");
            return;
          }

          // anilist_manga
          const r = await anilistRandomManga();
          if (existingTitles.has(r.title.toLowerCase())) continue;

          setPicks([{ provider: "anilist", title: r.title, anilistId: r.anilistId, anilistType: "MANGA", posterUrl: r.posterUrl }]);
          setPickStatus("Here you go.");
          return;
        } catch {
          // try another source/attempt
        }
      }

      setPickStatus("Couldn’t find a new random pick (try again).");
      return;
    }

  } catch {
    setPickStatus("Something went wrong.");
  }
}

  /* ================= DRAG & DROP ================= */

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;

    const itemId = String(active.id);
    const newStatus = String(over.id) as Status;

    if (!["completed", "in_progress", "planned", "dropped"].includes(newStatus)) return;

    const item = items.find((x) => x.id === itemId);
    if (!item) return;
    if (item.status === newStatus) return;

    updateItem(itemId, { status: newStatus });
  }

  /* ================= APPLY SUGGESTION ================= */

  const applySuggestion = useCallback(async (s: Suggestion, opts?: { keepManualTags?: boolean }) => {
  const keepManual = opts?.keepManualTags ?? true;

  const getCurrent = () => {
    const { type = "movie", status = "planned" } = formRef.current ?? {};
    return { type: type as MediaType, status: status as Status };
  };


  setAutofillStatus(`Applying: ${s.title}…`);

  setForm((f) => {
    const base = {
      ...f,
      title: s.title,
      posterUrl: s.posterUrl || f.posterUrl,
      runtime: typeof s.runtime === "number" ? s.runtime : f.runtime,
    };

    if (s.provider === "tmdb") {
      return {
        ...base,
        tmdbId: s.tmdbId,
        tmdbType: s.tmdbType,
        igdbId: undefined,
        anilistId: undefined,
        anilistType: undefined,
      };
    }

    if (s.provider === "igdb") {
      return {
        ...base,
        igdbId: s.igdbId,
        tmdbId: undefined,
        tmdbType: undefined,
        anilistId: undefined,
        anilistType: undefined,
      };
    }

    return {
      ...base,
      anilistId: s.anilistId,
      anilistType: s.anilistType,
      tmdbId: undefined,
      tmdbType: undefined,
      igdbId: undefined,
    };
  });

  const newAuto = uniqTags([...(s.tags ?? [])]);
  setAutoTags(newAuto);
  if (!keepManual) setManualTags([]);

  const { type: currentType, status: currentStatus } = getCurrent();

  if (typeof s.progressTotal === "number" && s.progressTotal > 0) {
    setProgressTotalText((prev) => (prev.trim() === "" ? String(s.progressTotal) : prev));
    setProgressCurText((prev) => {
      if (prev.trim() !== "") return prev;
      if (currentStatus === "completed") return String(s.progressTotal);
      return prev;
    });
  } else if (currentType === "movie") {
    setProgressTotalText((prev) => (prev.trim() === "" ? "1" : prev));
    if (currentStatus === "completed") {
      setProgressCurText((prev) => (prev.trim() === "" ? "1" : prev));
    }
  }

  setAutofillStatus("Auto-fill complete.");
}, [setAutofillStatus, setForm, setAutoTags, setManualTags, setProgressTotalText, setProgressCurText]);



  /* ================= AUTO AUTOFILL ================= */

  useEffect(() => {
    if (!autoAutofill) return;
    const title = (form.title || "").trim();
    const type = form.type as MediaType;

    if (!title || title.length < 2) {
      setSuggestions([]);
      setGhostTitle("");
      setShowSuggest(false);
      setActiveSuggestIdx(0);
      return;
    }

    const key = `${type}:${title.toLowerCase()}`;
    lastAutofillKey.current = key;


    if (autofillTimer.current) window.clearTimeout(autofillTimer.current);

    autofillTimer.current = window.setTimeout(async () => {
      try {
        setAutofillStatus("Searching…");
        if (lastAutofillKey.current !== key) return;


        const pushSuggestions = async (list: Suggestion[]) => {
          if (lastAutofillKey.current !== key) return;
          const q = title;
          const scored = list
            .map((x) => ({ x, score: similarityScore(q, x.title) }))
            .sort((a, b) => b.score - a.score);

          const top = scored.map((sug) => sug.x).slice(0, 7);
          setSuggestions(top);
          setShowSuggest(true);
          setActiveSuggestIdx(0);

          const top1 = scored[0];
          const bestScore = top1?.score ?? 0;
          const best = top1?.x;

          const qNorm = normTitle(q);
          const bNorm = best ? normTitle(best.title) : "";
          const isCompletion = !!best && bNorm.startsWith(qNorm) && qNorm.length >= 2;
          setGhostTitle(isCompletion ? best!.title : "");

          // Do NOT auto-apply while typing.
          // Only show suggestions + ghost preview. User must select (Enter/click) or Tab-accept.
          setAutofillStatus(best ? `Suggestions ready (${Math.round(bestScore * 100)}% match).` : "No match found.");
        };

        if (type === "movie" || type === "tv") {
          const tmdbType: "movie" | "tv" = type;
          const s = await tmdbSearch(title, tmdbType);
          const results = (s?.results ?? []).slice(0, 7);

          if (!results.length) {
            setSuggestions([]);
            setGhostTitle("");
            setShowSuggest(false);
            setAutofillStatus("No match found on TMDB.");
            return;
          }

          const list: Suggestion[] = results.map((r) => {
            const t = (r.title || r.name || "").trim();

            // ✅ ADD THIS
            const posterUrl = (r as any).poster_path
              ? `https://image.tmdb.org/t/p/w185${(r as any).poster_path}`
              : undefined;

            return {
              key: `tmdb:${tmdbType}:${r.id}`,
              provider: "tmdb",
              title: t,
              subtitle:
                tmdbType === "movie"
                  ? r.release_date
                    ? r.release_date.slice(0, 4)
                    : ""
                  : r.first_air_date
                  ? r.first_air_date.slice(0, 4)
                  : "",
              posterUrl, // ✅ THIS IS THE FIX
              tmdbId: r.id,
              tmdbType,
            };
          });

          await pushSuggestions(list);
          return;
        }


        if (type === "game") {
          const res = await fetch(`/api/igdb/search?q=${encodeURIComponent(title)}&limit=7`, { method: "GET" });
          const json = (await res.json()) as IgdbSearchResponse;

          if (!res.ok) {
            setAutofillStatus(`IGDB error: ${json.error || "Search failed"}`);
            setSuggestions([]);
            setGhostTitle("");
            setShowSuggest(false);
            return;
          }

          const results = (json.results ?? []).slice(0, 7);
          if (!results.length) {
            setSuggestions([]);
            setGhostTitle("");
            setShowSuggest(false);
            setAutofillStatus("No match found on IGDB.");
            return;
          }

          const list: Suggestion[] = results.map((r) => ({
            key: `igdb:${r.id}`,
            provider: "igdb",
            title: r.name,
            posterUrl: r.coverUrl,
            tags: r.genres,
            igdbId: r.id,
          }));

          await pushSuggestions(list);
          return;
        }

        if (type === "anime" || type === "manga") {
          const anilistType = type === "manga" ? "MANGA" : "ANIME";
          const res = await fetch(`/api/anilist/search?q=${encodeURIComponent(title)}&limit=7&type=${anilistType}`, {
            method: "GET",
          });
          const json = (await res.json()) as AnilistSearchResponse;

          if (!res.ok) {
            setAutofillStatus(`AniList error: ${json.error || "Search failed"}`);
            setSuggestions([]);
            setGhostTitle("");
            setShowSuggest(false);
            return;
          }

          const results = (json.results ?? []).slice(0, 7);
          if (!results.length) {
            setSuggestions([]);
            setGhostTitle("");
            setShowSuggest(false);
            setAutofillStatus("No match found on AniList.");
            return;
          }

          const list: Suggestion[] = results.map((r) => ({
            key: `anilist:${anilistType}:${r.id}`,
            provider: "anilist",
            title: r.title,
            posterUrl: r.coverUrl,
            tags: r.genres,
            anilistId: r.id,
            anilistType,
          }));

          await pushSuggestions(list);
          return;
        }

        setAutofillStatus("");
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Unknown error";
        setAutofillStatus(`Auto-fill error: ${msg}`);
      }
    }, 450);

    return () => {
      if (autofillTimer.current) window.clearTimeout(autofillTimer.current);
    };
  }, [form.title, form.type, autoAutofill]);

  const selectSuggestion = useCallback(
    async (s: Suggestion) => {
      try {
        setShowSuggest(false);
        setGhostTitle("");
        setAutofillStatus(`Loading details for: ${s.title}…`);

        if (s.provider === "tmdb" && s.tmdbId && (s.tmdbType === "movie" || s.tmdbType === "tv")) {
          const d = await tmdbDetails(s.tmdbId, s.tmdbType);

          const posterUrl = d.poster_path ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : undefined;
          const tags = (d.genres ?? []).map((g) => g.name);

          let progressTotal: number | undefined;
          if (s.tmdbType === "movie") progressTotal = 1;
          if (s.tmdbType === "tv" && typeof d.number_of_episodes === "number" && d.number_of_episodes > 0) {
            progressTotal = d.number_of_episodes;
          }

          await applySuggestion(
            {
              ...s,
              posterUrl,
              tags: tags.length ? tags : s.tags,
              runtime: d.runtime ?? d.episode_run_time?.[0] ?? undefined,
              progressTotal,
            },
            { keepManualTags: true }
          );
          return;
        }

        if (s.provider === "anilist" && s.anilistId && (s.anilistType === "ANIME" || s.anilistType === "MANGA")) {
          const d = await anilistDetails(s.anilistId, s.anilistType);
          const tags = d.genres?.length ? d.genres : s.tags;

          let progressTotal: number | undefined;
          if (s.anilistType === "ANIME" && typeof d.episodes === "number" && d.episodes > 0) progressTotal = d.episodes;
          if (s.anilistType === "MANGA") {
            if (typeof d.chapters === "number" && d.chapters > 0) progressTotal = d.chapters;
            else if (typeof d.volumes === "number" && d.volumes > 0) progressTotal = d.volumes;
          }

          await applySuggestion(
            {
              ...s,
              posterUrl: d.coverUrl || s.posterUrl,
              tags,
              progressTotal,
              runtime: typeof d.duration === "number" ? d.duration : undefined,
            },
            { keepManualTags: true }
          );
          return;
        }

        if (s.provider === "igdb") {
          await applySuggestion(
            {
              ...s,
              tags: s.tags,
              posterUrl: s.posterUrl,
              progressTotal: undefined,
            },
            { keepManualTags: true }
          );
          return;
        }

        await applySuggestion(s, { keepManualTags: true });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Unknown error";
        setAutofillStatus(`Auto-fill error: ${msg}`);
      }
    },
    [applySuggestion]
  );

  useEffect(() => {
    if (!settings.soundEffects) return;
    if (typeof window === "undefined") return;

    let lastHover = 0;

    const isInteractive = (target: EventTarget | null) =>
      target instanceof Element && !!target.closest('button,a,[role="button"],select,input,textarea');

    const onMouseOver = (e: MouseEvent) => {
      if (!isInteractive(e.target)) return;
      const now = Date.now();
      if (now - lastHover < 120) return;
      lastHover = now;
      playStackSoundEffect("hover", settings.soundVolume ?? 1);
    };

    const onClick = (e: MouseEvent) => {
      if (!isInteractive(e.target)) return;
      playStackSoundEffect("click", settings.soundVolume ?? 1);
    };

    document.addEventListener("mouseover", onMouseOver, true);
    document.addEventListener("click", onClick, true);

    return () => {
      document.removeEventListener("mouseover", onMouseOver, true);
      document.removeEventListener("click", onClick, true);
    };
  }, [settings.soundEffects, settings.soundVolume]);

  useEffect(() => {
    if (view !== "discover") return;

    let active = true;
    setDiscoverStatus("Loading genres…");

    tmdbGenreList(discoverType)
      .then((genres) => {
        if (!active) return;
        setDiscoverGenres(genres);
        setDiscoverStatus("");
      })
      .catch((e: unknown) => {
        if (!active) return;
        const msg = e instanceof Error ? e.message : "Could not load genres.";
        setDiscoverStatus(msg);
      });

    return () => {
      active = false;
    };
  }, [view, discoverType]);

  const browseDiscover = useCallback(async () => {
    try {
      setDiscoverStatus("Finding titles…");
      setDiscoverResults([]);

      const genreIds = discoverGenreId === "all" ? [] : [Number(discoverGenreId)].filter((n) => Number.isFinite(n));
      const results = await tmdbDiscoverByGenres(discoverType, genreIds);
      const genreNameById = new Map(discoverGenres.map((g) => [g.id, g.name]));

      const cards = results.slice(0, 20).map((r) => {
        const title = (r.title || r.name || "Untitled").trim();
        return {
          id: r.id,
          title,
          type: discoverType,
          posterUrl: r.poster_path ? `https://image.tmdb.org/t/p/w500${r.poster_path}` : undefined,
          year: (discoverType === "movie" ? r.release_date : r.first_air_date)?.slice(0, 4) || undefined,
          overview: r.overview,
          tags: (r.genre_ids ?? []).map((id) => genreNameById.get(id)).filter((x): x is string => !!x),
        } satisfies DiscoverCard;
      });

      setDiscoverResults(cards);
      setDiscoverStatus(cards.length ? `Found ${cards.length} titles.` : "No results found.");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Discover failed.";
      setDiscoverStatus(msg);
    }
  }, [discoverType, discoverGenreId, discoverGenres]);

  const addDiscoverItem = useCallback((card: DiscoverCard) => {
    const now = new Date().toISOString();
    const item: MediaItem = {
      id: uid(),
      title: card.title,
      type: card.type,
      status: "planned",
      tags: card.tags ?? [],
      createdAt: now,
      updatedAt: now,
      posterUrl: card.posterUrl,
      tmdbId: card.id,
      tmdbType: card.type,
      favorite: false,
      isPrivate: false,
      rewatchCount: 0,
    };

    setItems((prev) => [item, ...prev]);
    setDiscoverStatus(`Added ${card.title} to Planned.`);
  }, []);

  const ensureFeedbackVisibleToAdmins = useCallback(async () => {
    if (!userId) return;

    const adminIds = STACK_ADMIN_USER_IDS.filter((adminId) => adminId && adminId !== userId);
    if (!adminIds.length) return;

    for (const adminId of adminIds) {
      try {
        // Best-effort: use the existing friends permissions so the admin can read this user's feedback
        // without adding a new database table or changing the schema.
        const friendship = await supabase
          .from("friends")
          .upsert(
            [{ user_id: userId, friend_id: adminId }],
            { onConflict: "user_id,friend_id" }
          );

        if (friendship.error) console.warn(friendship.error);

        // Keep a pending request/history row so the admin account can auto-accept
        // and create the admin-side friendship row without violating RLS.
        const requestInsert = await supabase.from("friend_requests").insert({
          requester_id: userId,
          requested_id: adminId,
          status: "pending",
        });

        if (requestInsert.error) console.warn(requestInsert.error);
      } catch (e) {
        console.warn(e);
      }
    }
  }, [userId]);

  const submitFeedback = useCallback((e: React.SyntheticEvent) => {
    e.preventDefault();
    const message = feedbackText.trim();
    if (!message) return;

    const entry: FeedbackEntry = {
      id: uid(),
      type: feedbackType,
      message,
      createdAt: new Date().toISOString(),
      status: "new",
    };

    const nextFeedback = [entry, ...feedbackEntries];
    setFeedbackEntries(nextFeedback);
    setFeedbackText("");

    // Save immediately instead of waiting only for the state effect.
    // This makes submitted suggestions/problems show up for the admin more reliably.
    if (userId) {
      saveCloud(userId, items, settings, nextFeedback);
      ensureFeedbackVisibleToAdmins();
    }
  }, [feedbackText, feedbackType, feedbackEntries, userId, items, settings, saveCloud, ensureFeedbackVisibleToAdmins]);

  const loadAdminFeedback = useCallback(async () => {
    if (!userId || !STACK_ADMIN_USER_IDS.includes(userId)) return;

    const rowsByKey = new Map<string, AdminFeedbackEntry>();

    const addRows = (sourceRows: Array<{ user_id: string; data: any }>, sourceLabel?: string) => {
      for (const row of sourceRows) {
        if (!row?.user_id) continue;

        const rowSettings = normalizeSettings(row?.data?.settings);
        const userLabel = rowSettings.displayName?.trim() || rowSettings.usernameTag?.trim() || row.user_id;
        const entries = parseFeedbackEntries(row?.data?.feedback);

        for (const entry of entries) {
          const key = `${row.user_id}:${entry.id}`;
          if (rowsByKey.has(key)) continue;

          rowsByKey.set(key, {
            ...entry,
            userId: row.user_id,
            userLabel: sourceLabel && userLabel === row.user_id ? `${row.user_id} (${sourceLabel})` : userLabel,
          });
        }
      }
    };

    try {
      setAdminFeedbackStatus("Loading all visible feedback…");

      // 1) Always include the admin's own saved feedback.
      addRows([{ user_id: userId, data: { settings, feedback: feedbackEntries } }]);

      // 2) Include rows already loaded through the friends system.
      addRows(friendActivityRows);

      // 3) Try a direct visible-row scan. With strict RLS this may only return your own row,
      // but with admin/friend read rules it can return more.
      const direct = await supabase
        .from("media_items")
        .select("user_id,data");

      if (direct.error) {
        console.warn(direct.error);
      } else {
        addRows((direct.data ?? []) as Array<{ user_id: string; data: any }>);
      }

      // 4) Explicitly request friend rows too. Some RLS setups work better when scoped this way.
      const friendIds = friendsList.map((f) => f.friend_id).filter(Boolean);
      if (friendIds.length) {
        const friendRows = await supabase
          .from("media_items")
          .select("user_id,data")
          .in("user_id", friendIds);

        if (friendRows.error) {
          console.warn(friendRows.error);
        } else {
          addRows((friendRows.data ?? []) as Array<{ user_id: string; data: any }>);
        }
      }

      const rows = Array.from(rowsByKey.values()).sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

      setAdminFeedbackRows(rows);
      setAdminFeedbackStatus(
        rows.length
          ? `Loaded ${rows.length} visible feedback item${rows.length === 1 ? "" : "s"}.`
          : "No visible feedback yet. If someone just submitted feedback, refresh after they reload once."
      );
    } catch (e) {
      console.warn(e);
      const rows = Array.from(rowsByKey.values()).sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      setAdminFeedbackRows(rows);
      setAdminFeedbackStatus(
        rows.length
          ? `Loaded ${rows.length} visible feedback item${rows.length === 1 ? "" : "s"}.`
          : "Admin feedback is unavailable with the current sharing rules."
      );
    }
  }, [userId, settings, feedbackEntries, friendActivityRows, friendsList]);


  const filteredAdminFeedbackRows = useMemo(() => {
    return adminFeedbackRows.filter((entry) => {
      if (adminHideDone && entry.status === "done") return false;
      if (adminFeedbackFilter === "all") return true;
      if (adminFeedbackFilter === "suggestion" || adminFeedbackFilter === "problem") return entry.type === adminFeedbackFilter;
      return (entry.status ?? "new") === adminFeedbackFilter;
    });
  }, [adminFeedbackRows, adminFeedbackFilter, adminHideDone]);

  const updateAdminFeedbackStatus = useCallback(
    async (targetUserId: string, feedbackId: string, nextStatus: "new" | "reviewed" | "done") => {
      if (!userId || !STACK_ADMIN_USER_IDS.includes(userId)) return;

      try {
        setAdminFeedbackStatus("Updating feedback…");
        const { data, error } = await supabase
          .from("media_items")
          .select("data")
          .eq("user_id", targetUserId)
          .maybeSingle();

        if (error) throw error;

        const raw = data?.data && typeof data.data === "object" ? (data.data as Record<string, any>) : {};
        const feedback = parseFeedbackEntries(raw.feedback).map((entry) =>
          entry.id === feedbackId ? { ...entry, status: nextStatus } : entry
        );

        const { error: updateError } = await supabase
          .from("media_items")
          .upsert(
            [{ user_id: targetUserId, data: { ...raw, feedback } }],
            { onConflict: "user_id" }
          );

        if (updateError) throw updateError;

        setAdminFeedbackRows((prev) =>
          prev.map((entry) =>
            entry.userId === targetUserId && entry.id === feedbackId ? { ...entry, status: nextStatus } : entry
          )
        );
        setAdminFeedbackStatus("Feedback updated.");
      } catch (e) {
        console.error(e);
        setAdminFeedbackStatus("Could not update feedback with the current sharing rules.");
      }
    },
    [userId]
  );

  useEffect(() => {
    if (view === "feedback" && isAdminUser) loadAdminFeedback();
  }, [view, isAdminUser, loadAdminFeedback]);

  const loadFriendActivity = useCallback(async () => {
    if (!friendsList.length) {
      setFriendActivityRows([]);
      setFriendActivityStatus("No friends yet.");
      return;
    }

    try {
      setFriendActivityStatus("Loading friend activity…");
      const friendIds = friendsList.map((f) => f.friend_id);
      const { data, error } = await supabase
        .from("media_items")
        .select("user_id,data")
        .in("user_id", friendIds);

      if (error) {
        console.error(error);
        setFriendActivityStatus("Friend activity is unavailable with the current sharing rules.");
        return;
      }

      setFriendActivityRows((data ?? []) as Array<{ user_id: string; data: any }>);
      setFriendActivityStatus(data?.length ? "Loaded." : "No friend activity found yet.");
    } catch {
      setFriendActivityStatus("Friend activity is unavailable right now.");
    }
  }, [friendsList]);

  useEffect(() => {
    if (view === "feed" || view === "friends") loadFriendActivity();
  }, [view, loadFriendActivity]);

  const activityFeed = useMemo(() => {
    const selfName = settings.displayName?.trim() || settings.usernameTag?.trim() || "You";
    const entries: ActivityEntry[] = [];

    for (const i of items) {
      const date = i.updatedAt ?? i.createdAt;
      entries.push({
        id: `self:${i.id}`,
        actorId: userId ?? "self",
        actorName: selfName,
        itemTitle: i.title,
        itemType: i.type,
        status: i.status,
        date,
        favorite: i.favorite,
      });
    }

    for (const row of friendActivityRows) {
      const actorName = friendsNameById.get(row.user_id) ?? row.user_id;
      const friendItems = Array.isArray(row?.data?.items) ? (row.data.items as MediaItem[]) : [];

      for (const i of friendItems) {
        if (i.isPrivate) continue;
        entries.push({
          id: `friend:${row.user_id}:${i.id}`,
          actorId: row.user_id,
          actorName,
          itemTitle: i.title,
          itemType: i.type,
          status: i.status,
          date: i.updatedAt ?? i.createdAt,
          favorite: i.favorite,
        });
      }
    }

    return entries
      .filter((e) => e.date)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, 50);
  }, [items, userId, settings.displayName, settings.usernameTag, friendActivityRows, friendsNameById]);

  const friendLibraryItems = useMemo(() => {
    const rows: Array<MediaItem & { __ownerId: string; __ownerName: string }> = [];

    for (const row of friendActivityRows) {
      if (friendLibraryFriendId !== "all" && row.user_id !== friendLibraryFriendId) continue;

      const ownerName = friendsNameById.get(row.user_id) ?? row.user_id;
      const friendItems = Array.isArray(row?.data?.items) ? (row.data.items as MediaItem[]) : [];

      for (const item of friendItems) {
        if (!item || item.isPrivate) continue;
        if (friendLibraryStatus !== "all" && item.status !== friendLibraryStatus) continue;

        rows.push({
          ...item,
          __ownerId: row.user_id,
          __ownerName: ownerName,
        });
      }
    }

    return sortMediaItems(rows, friendLibrarySortMode);
  }, [friendActivityRows, friendLibraryFriendId, friendLibraryStatus, friendLibrarySortMode, friendsNameById]);

  const selectedFriendProfile = useMemo(() => {
    if (!selectedFriendProfileId) return null;

    const friend = friendsList.find((f) => f.friend_id === selectedFriendProfileId);
    if (!friend) return null;

    const activityRow = friendActivityRows.find((row) => row.user_id === selectedFriendProfileId);
    const profileSettings = normalizeSettings(activityRow?.data?.settings);
    const display = getFriendDisplay(friend.friend_id, friend.friend);
    const visibleItems = Array.isArray(activityRow?.data?.items)
      ? (activityRow!.data.items as MediaItem[]).filter((item) => item && !item.isPrivate)
      : [];

    return {
      id: friend.friend_id,
      friend,
      display,
      settings: profileSettings,
      items: visibleItems,
    };
  }, [selectedFriendProfileId, friendsList, friendActivityRows, getFriendDisplay]);

  const friendProfileFilteredItems = useMemo(() => {
    if (!selectedFriendProfile) return [];

    let out = selectedFriendProfile.items.slice();

    if (friendProfileView !== "all") out = out.filter((item) => item.status === friendProfileView);

    const q = friendProfileQuery.trim().toLowerCase();
    if (q) {
      const privacy = profilePrivacyFromSettings(selectedFriendProfile.settings);
      out = out.filter((item) =>
        [
          item.title,
          privacy.showNotes ? item.notes : "",
          privacy.showTags ? item.tags?.join(" ") : "",
        ].some((value) => String(value || "").toLowerCase().includes(q))
      );
    }

    return sortMediaItems(out, friendProfileSortMode);
  }, [selectedFriendProfile, friendProfileView, friendProfileQuery, friendProfileSortMode]);

  const friendProfileByStatus = useMemo(() => {
    const map: Record<Status, MediaItem[]> = { completed: [], in_progress: [], planned: [], dropped: [] };
    for (const item of friendProfileFilteredItems) map[item.status].push(item);
    return map;
  }, [friendProfileFilteredItems]);

  const selectedFriendProfileStats = useMemo(() => {
    return computeVisibleProfileStats(selectedFriendProfile?.items ?? []);
  }, [selectedFriendProfile]);

  const ownFriendPreviewItems = useMemo(() => items.filter((item) => item && !item.isPrivate), [items]);
  const ownFriendPreviewStats = useMemo(
    () => computeVisibleProfileStats(ownFriendPreviewItems),
    [ownFriendPreviewItems]
  );

  const selectedFriendComparison = useMemo(() => {
    const friendItems = selectedFriendProfile?.items ?? [];
    const friendCompletedTitles = new Set(
      friendItems.filter((item) => item.status === "completed").map((item) => normTitle(item.title)).filter(Boolean)
    );
    const friendPlannedTitles = new Set(
      friendItems.filter((item) => item.status === "planned").map((item) => normTitle(item.title)).filter(Boolean)
    );
    const friendInProgressTitles = new Set(
      friendItems.filter((item) => item.status === "in_progress").map((item) => normTitle(item.title)).filter(Boolean)
    );

    const bothCompleted = items.filter((item) => item.status === "completed" && friendCompletedTitles.has(normTitle(item.title))).length;
    const bothPlanned = items.filter((item) => item.status === "planned" && friendPlannedTitles.has(normTitle(item.title))).length;
    const bothInProgress = items.filter((item) => item.status === "in_progress" && friendInProgressTitles.has(normTitle(item.title))).length;

    const myTags = new Set(items.flatMap((item) => item.tags ?? []).map(normTag).filter(Boolean));
    const sharedTagCounts = new Map<string, number>();
    for (const item of friendItems) {
      for (const tag of item.tags ?? []) {
        const normalized = normTag(tag);
        if (!normalized || !myTags.has(normalized)) continue;
        sharedTagCounts.set(tag, (sharedTagCounts.get(tag) ?? 0) + 1);
      }
    }

    const sharedTopTags = Array.from(sharedTagCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([tag]) => tag);

    const typeCounts = new Map<MediaType, number>();
    for (const item of friendItems) typeCounts.set(item.type, (typeCounts.get(item.type) ?? 0) + 1);
    const friendTopType = Array.from(typeCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];

    return {
      bothCompleted,
      bothPlanned,
      bothInProgress,
      sharedTopTags: sharedTopTags.length ? sharedTopTags.join(" • ") : "—",
      friendTopType: friendTopType ? TYPE_LABEL[friendTopType] : "—",
    };
  }, [items, selectedFriendProfile]);

  /* ================= FILTER ================= */
  const filteredFriendsList = useMemo(() => {
    const q = friendsQuery.trim().toLowerCase();

    return friendsList
      .slice()
      .sort((a, b) => {
        const aName = getFriendDisplay(a.friend_id, a.friend).primary;
        const bName = getFriendDisplay(b.friend_id, b.friend).primary;
        return aName.localeCompare(bName);
      })
      .filter((f) => {
        if (!q) return true;
        const display = getFriendDisplay(f.friend_id, f.friend);
        const searchable = [
          display.primary,
          display.secondary,
          display.baseName,
          display.idTag,
          f.friend?.username,
          f.friend?.display_name,
          f.friend_id,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return searchable.includes(q);
      });
  }, [friendsList, friendsQuery, getFriendDisplay]);

  const filteredIncomingRequests = useMemo(() => {
    const q = friendsQuery.trim().toLowerCase();
    if (!q) return incomingRequests;

    return incomingRequests.filter((r) => {
      const display = getFriendDisplay(r.requester_id, r.requester);
      const searchable = [
        display.primary,
        display.secondary,
        display.baseName,
        display.idTag,
        r.requester?.username,
        r.requester?.display_name,
        r.requester_id,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return searchable.includes(q);
    });
  }, [incomingRequests, friendsQuery, getFriendDisplay]);

  const tagFilterOptions = useMemo(() => {
    const tagSet = new Set<string>();
    for (const item of items) {
      for (const tag of item.tags ?? []) {
        const clean = String(tag || "").trim();
        if (clean) tagSet.add(clean);
      }
    }

    return [
      { value: "all", label: "All tags" },
      ...Array.from(tagSet)
        .sort((a, b) => a.localeCompare(b))
        .map((tag) => ({ value: tag, label: tag })),
    ];
  }, [items]);

  const filtered = useMemo(() => {
    let out = items.slice();

    if (view === "completed") out = out.filter((i) => i.status === "completed");
    if (view === "in_progress") out = out.filter((i) => i.status === "in_progress");
    if (view === "planned") out = out.filter((i) => i.status === "planned");
    if (view === "dropped") out = out.filter((i) => i.status === "dropped");

    if (favoriteOnly) out = out.filter((i) => !!i.favorite);

    if (tagFilter !== "all") {
      const selectedTag = tagFilter.toLowerCase();
      out = out.filter((i) => (i.tags ?? []).some((tag) => String(tag || "").toLowerCase() === selectedTag));
    }

    if (query) {
      const q = query.toLowerCase();
      out = out.filter((i) => [i.title, i.notes, i.tags.join(" ")].some((v) => String(v || "").toLowerCase().includes(q)));
    }

    return sortMediaItems(out, sortMode);
  }, [items, view, query, sortMode, favoriteOnly, tagFilter]);

  const grouped = useMemo(() => {
    if (groupMode === "none") return null;

    const map = new Map<string, MediaItem[]>();
    for (const i of filtered) {
      const baseDate = (i.dateFinished ?? i.createdAt).slice(0, 10);
      const k = toGroupKey(groupMode, baseDate);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(i);
    }
    return Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [filtered, groupMode]);

    const byStatusFiltered = useMemo(() => {
      const map: Record<Status, MediaItem[]> = { completed: [], in_progress: [], planned: [], dropped: [] };
      for (const i of filtered) map[i.status].push(i);
      return map;
    }, [filtered]);


  /* ================= STATS ================= */
  // ✅ Month options for stats filter
  const statsMonthOptions = useMemo(() => {
    // build from all items using: dateFinished if set, else createdAt
    const months = new Set<string>();
    for (const i of items) {
      const key = (i.dateFinished ?? i.createdAt ?? "").slice(0, 7);
      if (key) months.add(key);
    }

    const sorted = Array.from(months).sort((a, b) => (a < b ? 1 : -1)); // desc YYYY-MM
    return [
      { value: "all", label: "All time" },
      ...sorted.map((m) => ({ value: m, label: m })), // label "YYYY-MM" (simple + clean)
    ];
  }, [items]);

  // ✅ Stats-filtered view of items
  const statsItems = useMemo(() => {
    if (statsMonth === "all") return items;

    return items.filter((i) => {
      const key = (i.dateFinished ?? i.createdAt ?? "").slice(0, 7);
      return key === statsMonth;
    });
  }, [items, statsMonth]);

  const statusCounts = useMemo(() => {
    const base: Record<Status, number> = { completed: 0, in_progress: 0, planned: 0, dropped: 0 };
    for (const i of statsItems) base[i.status] += 1;
    return base;
  }, [statsItems]);


  const typeCounts = useMemo(() => {
    const map = new Map<MediaType, number>();
    for (const i of statsItems) map.set(i.type, (map.get(i.type) ?? 0) + 1);
    return Array.from(map.entries())
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count);
  }, [statsItems]);


  const avgByType = useMemo(() => {
    const map = new Map<MediaType, { sum: number; count: number }>();
    for (const i of statsItems) {
      if (typeof i.rating !== "number") continue;
      const cur = map.get(i.type) ?? { sum: 0, count: 0 };
      cur.sum += i.rating;
      cur.count += 1;
      map.set(i.type, cur);
    }
    return Array.from(map.entries())
      .map(([type, v]) => ({ type, avg: v.count ? v.sum / v.count : 0, count: v.count }))
      .sort((a, b) => b.avg - a.avg);
  }, [statsItems]);


  const totalCompleted = useMemo(() => {
    return statsItems.filter((i) => {
      if (excludeTypes.has(i.type)) return false;
      return i.status === "completed";
    }).length;
  }, [statsItems, excludeTypes]);


  const totalRuntimeMinutesCompleted = useMemo(() => {
    let sum = 0;

    for (const i of statsItems) {
      if (i.status !== "completed") continue;
      if (excludeTypes.has(i.type)) continue;

      if (i.type === "game") {
        const h = typeof i.hoursPlayed === "number" ? i.hoursPlayed : undefined;
        if (typeof h === "number" && Number.isFinite(h) && h > 0) sum += h * 60;
        continue;
      }

      if (i.type === "movie") {
        if (typeof i.runtime === "number" && Number.isFinite(i.runtime) && i.runtime > 0) sum += i.runtime;
        continue;
      }

      if (i.type === "tv" || i.type === "anime") {
        const perEp = typeof i.runtime === "number" && i.runtime > 0 ? i.runtime : 0;

        const cur =
          typeof i.progressCurOverride === "number"
            ? i.progressCurOverride
            : typeof i.progressCur === "number"
            ? i.progressCur
            : undefined;

        const total =
          typeof i.progressTotalOverride === "number"
            ? i.progressTotalOverride
            : typeof i.progressTotal === "number"
            ? i.progressTotal
            : undefined;

        const episodes = typeof cur === "number" ? cur : typeof total === "number" ? total : 0;

        if (perEp > 0 && episodes > 0) sum += perEp * episodes;
        continue;
      }
    }

    return Math.round(sum);
  }, [statsItems, excludeTypes]);


  const rewatchTotals = useMemo(() => {
    let rewatches = 0;
    let itemsRewatched = 0;
    for (const i of statsItems) {
      const c = Math.max(0, Number(i.rewatchCount ?? 0) || 0);
      if (c > 0) {
        itemsRewatched += 1;
        rewatches += c;
      }
    }
    return { itemsRewatched, rewatches };
  }, [statsItems]);


  const topTags = useMemo(() => {
    const map = new Map<string, number>();
    for (const i of statsItems) {
      if (i.status !== "completed") continue;
      if (excludeTypes.has(i.type)) continue;

      for (const t of i.tags ?? []) {
        const k = String(t || "").trim();
        if (!k) continue;
        map.set(k, (map.get(k) ?? 0) + 1);
      }
    }
    return Array.from(map.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);
  }, [statsItems, excludeTypes]);

  const genreCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const i of statsItems) {
      if (i.status !== "completed") continue;
      if (excludeTypes.has(i.type)) continue;

      for (const t of i.tags ?? []) {
        const k = String(t || "").trim();
        if (!k) continue;
        map.set(k, (map.get(k) ?? 0) + 1);
      }
    }
    return Array.from(map.entries())
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
  }, [statsItems, excludeTypes]);


  const monthlyCompleted = useMemo(() => {
    const now = new Date();
    const months: Array<{ key: string; label: string; count: number }> = [];

    for (let back = 11; back >= 0; back--) {
      const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const key = `${y}-${m}`;
      const label = d.toLocaleString(undefined, { month: "short" });
      months.push({ key, label, count: 0 });
    }

    const idx = new Map(months.map((x, i) => [x.key, i]));

    for (const i of items) {
      if (i.status !== "completed") continue;
      if (excludeTypes.has(i.type)) continue;

      const dateStr = (i.dateFinished ?? i.createdAt ?? "").slice(0, 7);
      if (!dateStr) continue;

      const pos = idx.get(dateStr);
      if (pos !== undefined) months[pos].count += 1;
    }

    const max = Math.max(1, ...months.map((x) => x.count));
    return { months, max };
  }, [items, excludeTypes]);

  // ✅ Fun stats
  const bestMonth = useMemo(() => {
    const best = monthlyCompleted.months.reduce(
      (acc, m) => (m.count > acc.count ? m : acc),
      { key: "—", label: "—", count: 0 }
    );
    return best;
  }, [monthlyCompleted]);

  const completionStreak = useMemo(() => {
    const daysSet = new Set<string>();

    for (const i of items) {
      if (i.status !== "completed") continue;
      if (excludeTypes.has(i.type)) continue;

      const day = (i.dateFinished ?? i.createdAt ?? "").slice(0, 10);
      if (day) daysSet.add(day);
    }

    const days = Array.from(daysSet).sort(); // ascending YYYY-MM-DD
    if (!days.length) return { longest: 0, current: 0 };

    const toDate = (s: string) => new Date(s + "T00:00:00");
    const diffDays = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));

    let longest = 1;
    let run = 1;

    for (let i = 1; i < days.length; i++) {
      const prev = toDate(days[i - 1]);
      const cur = toDate(days[i]);
      if (diffDays(prev, cur) === 1) {
        run += 1;
        longest = Math.max(longest, run);
      } else {
        run = 1;
      }
    }

    const today = todayYMD();
    let current = 0;
    const cursor = new Date(today + "T00:00:00");
    while (true) {
      const key = cursor.toISOString().slice(0, 10);
      if (!daysSet.has(key)) break;
      current += 1;
      cursor.setDate(cursor.getDate() - 1);
    }

    return { longest, current };
  }, [items, excludeTypes]);

  const gameHoursStats = useMemo(() => {
    const games = items.filter((i) => i.type === "game" && !excludeTypes.has(i.type));
    const withHours = games.filter((g) => typeof g.hoursPlayed === "number" && (g.hoursPlayed ?? 0) > 0);

    const totalHours = withHours.reduce((a, b) => a + (b.hoursPlayed ?? 0), 0);
    const avgHours = withHours.length ? totalHours / withHours.length : 0;

    const top = withHours.slice().sort((a, b) => (b.hoursPlayed ?? 0) - (a.hoursPlayed ?? 0))[0];

    return {
      totalHours,
      avgHours,
      topGameTitle: top?.title ?? "—",
      topGameHours: top?.hoursPlayed ?? 0,
    };
  }, [items, excludeTypes]);

  const mostRewatchedItem = useMemo(() => {
    const best = items
      .filter((i) => (Number(i.rewatchCount ?? 0) || 0) > 0)
      .slice()
      .sort((a, b) => (Number(b.rewatchCount ?? 0) || 0) - (Number(a.rewatchCount ?? 0) || 0))[0];

    return best ? { title: best.title, count: Number(best.rewatchCount ?? 0) || 0 } : { title: "—", count: 0 };
  }, [items]);

  const yearGenreCompare = useMemo(() => {
    const now = new Date();
    const y = now.getFullYear();
    const thisYearStart = `${y}-01-01`;
    const lastYearStart = `${y - 1}-01-01`;
    const lastYearEnd = `${y - 1}-12-31`;

    const countTags = (start: string, end?: string) => {
      const map = new Map<string, number>();
      for (const i of items) {
        if (i.status !== "completed") continue;
        if (excludeTypes.has(i.type)) continue;

        const d = (i.dateFinished ?? i.createdAt ?? "").slice(0, 10);
        if (!d) continue;
        if (d < start) continue;
        if (end && d > end) continue;

        for (const t of i.tags ?? []) {
          const k = String(t || "").trim();
          if (!k) continue;
          map.set(k, (map.get(k) ?? 0) + 1);
        }
      }
      const top = Array.from(map.entries()).sort((a, b) => b[1] - a[1])[0];
      return top ? { tag: top[0], count: top[1] } : { tag: "—", count: 0 };
    };

    const thisYearTop = countTags(thisYearStart);
    const lastYearTop = countTags(lastYearStart, lastYearEnd);

    return { thisYearTop, lastYearTop, year: y };
  }, [items, excludeTypes]);


  const clearStackFilters = useCallback(() => {
    setQuery("");
    setTagFilter("all");
    setFavoriteOnly(false);
    setMobileFiltersOpen(false);
  }, []);

  const handleLogout = useCallback(async () => {
    if (!userId) return;

    try {
      setSaveStatus("Logging out…");

      // Preserve the latest signed-in library backup before ending the session.
      if (items.length > 0) saveLocalBackup(items, userId);

      const { error } = await supabase.auth.signOut();
      if (error) throw error;

      setUserId(null);
      setItems([]);
      setFeedbackEntries([]);
      setFriendsList([]);
      setIncomingRequests([]);
      setOutgoingRequests([]);
      setFriendActivityRows([]);
      setSelectedFriendProfileId(null);
      setSelectedFriendIds([]);
      setCloudLoaded(false);
      setCloudExtraData({});
      setSaveStatus("Logged out");

      if (typeof window !== "undefined") {
        window.location.href = "/";
      }
    } catch (e) {
      console.error(e);
      setSaveStatus("Logout failed");
    }
  }, [items, userId, saveLocalBackup]);

  /* ================= UI ================= */

  const displayCombinedTags = useMemo(() => {
    return uniqTags([...(autoTags ?? []), ...(manualTags ?? [])]);
  }, [autoTags, manualTags]);

  const isWideBoard = view === "all" && boardView;

  const currentTheme = STACK_COLOR_THEMES[settings.colorTheme ?? DEFAULT_SETTINGS.colorTheme];
  const themeStyle = STACK_COLOR_THEME_CSS_VARS[settings.colorTheme ?? DEFAULT_SETTINGS.colorTheme] as React.CSSProperties;

  useLayoutEffect(() => {
    applyStackThemeToDocument(settings.colorTheme ?? DEFAULT_SETTINGS.colorTheme);
  }, [settings.colorTheme]);

  return (
    <>
    <script suppressHydrationWarning dangerouslySetInnerHTML={{ __html: STACK_THEME_BOOT_SCRIPT }} />
    <div className={["min-h-screen stack-bg", settings.compactMode ? "stack-compact" : ""].filter(Boolean).join(" ")}>
      <style>{`
        :root {
          --stack-theme-bg: ${STACK_COLOR_THEMES.midnight.bg};
          --stack-theme-fg: ${STACK_COLOR_THEMES.midnight.fg};
          --stack-theme-surface: ${STACK_COLOR_THEMES.midnight.surface};
          --stack-theme-accent: ${STACK_COLOR_THEMES.midnight.accent};
          --stack-theme-good: ${STACK_COLOR_THEMES.midnight.good};
          --stack-theme-good-border: ${STACK_COLOR_THEMES.midnight.goodBorder};
          --stack-theme-bad: ${STACK_COLOR_THEMES.midnight.bad};
          --stack-theme-bad-border: ${STACK_COLOR_THEMES.midnight.badBorder};
          --stack-theme-focus: ${STACK_COLOR_THEMES.midnight.focus};
          --stack-theme-ring: ${STACK_COLOR_THEMES.midnight.ring};
        }

        .stack-bg {
          background: var(--stack-theme-bg) !important;
          color: var(--stack-theme-fg) !important;
        }

        .stack-surface {
          background: var(--stack-theme-surface) !important;
          box-shadow: 0 24px 80px rgba(0, 0, 0, 0.28), 0 0 0 1px var(--stack-theme-ring) inset;
        }

        .stack-accent {
          background: var(--stack-theme-accent) !important;
        }

        .stack-good {
          background: var(--stack-theme-good) !important;
          border-color: var(--stack-theme-good-border) !important;
        }

        .stack-bad {
          background: var(--stack-theme-bad) !important;
          border-color: var(--stack-theme-bad-border) !important;
        }

        .stack-bg input:focus,
        .stack-bg textarea:focus,
        .stack-bg select:focus {
          border-color: var(--stack-theme-focus) !important;
          box-shadow: 0 0 0 1px color-mix(in srgb, var(--stack-theme-focus) 42%, transparent);
        }


        .stack-compact .p-5 { padding: 0.85rem !important; }
        .stack-compact .p-4 { padding: 0.75rem !important; }
        .stack-compact .p-3 { padding: 0.6rem !important; }
        .stack-compact .space-y-6 > :not([hidden]) ~ :not([hidden]) { margin-top: 1rem !important; }
        .stack-compact .space-y-4 > :not([hidden]) ~ :not([hidden]) { margin-top: 0.75rem !important; }
        .stack-compact .space-y-3 > :not([hidden]) ~ :not([hidden]) { margin-top: 0.5rem !important; }
        .stack-compact .rounded-3xl { border-radius: 1.15rem !important; }
        .stack-compact .rounded-2xl { border-radius: 0.9rem !important; }

        @media (max-width: 639px) {
          .stack-bg { min-height: 100dvh; }

          .stack-mobile-item-card {
            background: rgba(8, 12, 22, 0.86) !important;
            border-color: rgba(255,255,255,0.14) !important;
            box-shadow: 0 18px 54px rgba(0,0,0,0.28);
          }

          .stack-mobile-item-card select,
          .stack-mobile-item-card button,
          .stack-mobile-item-card input {
            min-height: 40px;
          }

          .stack-mobile-item-card [title="Open details"] {
            width: 5rem !important;
            height: 6.5rem !important;
          }

          .stack-mobile-readable-surface {
            background: rgba(8, 12, 22, 0.88) !important;
            border-color: rgba(255,255,255,0.14) !important;
          }

          .stack-mobile-scroll-panel {
            max-height: min(82dvh, 780px);
            overflow-y: auto;
            -webkit-overflow-scrolling: touch;
          }
        }
      `}</style>
      <div
        className={[
          isWideBoard ? "max-w-[104rem]" : "max-w-6xl",
          "mx-auto px-3 sm:px-6 py-5 pb-28 sm:py-6 sm:pb-6 space-y-6 min-w-0 overflow-x-hidden",
        ].join(" ")}
      >
        {/* Header */}
        <header className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2 text-center sm:text-left">
            <div>
              <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight">Stack</h1>
              <p className="text-sm text-neutral-400">Your personal media website</p>
            </div>
            <div className="flex flex-col sm:items-end gap-2">
              <div className="text-xs text-neutral-500 sm:text-right">{saveStatus}</div>
              {userId ? (
                <button
                  type="button"
                  onClick={handleLogout}
                  className="text-xs px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-neutral-300"
                >
                  Log out
                </button>
              ) : null}
            </div>
          </div>

          <nav className="space-y-2" aria-label="Stack navigation">
            <div className="flex justify-center">
              <div className="inline-flex flex-wrap justify-center gap-[clamp(0.35rem,1.5vw,0.65rem)] rounded-3xl bg-neutral-950/55 ring-1 ring-white/10 shadow-lg shadow-black/20 px-[clamp(0.45rem,1.6vw,0.8rem)] py-[clamp(0.4rem,1.2vw,0.65rem)] max-w-[96vw] backdrop-blur-xl">
                {navMain.map((n) => (
                  <Link
                    key={n.href}
                    href={n.href}
                    className={[
                      "px-[clamp(0.6rem,1.8vw,1rem)] py-[clamp(0.48rem,1.2vw,0.7rem)] rounded-2xl border text-[clamp(0.72rem,1.25vw,0.9rem)] transition whitespace-nowrap",
                      view === n.key
                        ? "bg-white/15 border-white/25 shadow-inner text-neutral-50"
                        : "bg-white/5 border-white/10 hover:bg-white/10 text-neutral-300",
                    ].join(" ")}
                  >
                    {n.label}
                  </Link>
                ))}
              </div>
            </div>

            <div className="flex justify-center">
              <div className="flex flex-wrap justify-center gap-2 max-w-[96vw]">
                {navActions.map((n) => (
                  <Link
                    key={n.href}
                    href={n.href}
                    title={n.label}
                    aria-label={n.label}
                    className={[
                      "h-[clamp(2.35rem,10vw,2.85rem)] min-w-[clamp(2.35rem,10vw,2.85rem)] px-2 grid place-items-center rounded-2xl border transition shadow-sm touch-manipulation",
                      "bg-neutral-950/50 ring-1 ring-white/5 backdrop-blur-xl",
                      view === n.key
                        ? "bg-white/15 border-white/25 text-neutral-50 shadow-inner"
                        : "bg-white/5 border-white/10 hover:bg-white/10 text-neutral-300",
                    ].join(" ")}
                  >
                    {n.icon === "plus" ? (
                      <span className="text-[clamp(1.0rem,2.4vw,1.35rem)] leading-none">+</span>
                    ) : n.icon === "pie" ? (
                      <span className="text-[clamp(0.95rem,2.2vw,1.25rem)] leading-none">◔</span>
                    ) : n.icon === "users" ? (
                      <span className="text-[clamp(0.95rem,2.2vw,1.25rem)] leading-none">👥</span>
                    ) : n.icon === "feed" ? (
                      <span className="text-[clamp(0.95rem,2.2vw,1.25rem)] leading-none">≡</span>
                    ) : n.icon === "discover" ? (
                      <span className="text-[clamp(0.95rem,2.2vw,1.25rem)] leading-none">⌕</span>
                    ) : n.icon === "feedback" ? (
                      <span className="text-[clamp(0.95rem,2.2vw,1.25rem)] leading-none">!</span>
                    ) : (
                      <span className="text-[clamp(0.95rem,2.2vw,1.25rem)] leading-none">⚙</span>
                    )}
                  </Link>
                ))}
              </div>
            </div>
          </nav>
        </header>

        {/* STATS PAGE */}
        {view === "stats" ? (
          <div className="space-y-6 max-w-6xl mx-auto">
            {/* ✅ Stats filter bar */}
            <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 text-center sm:text-left">
              <div>
                <div className="text-sm text-neutral-200 font-medium">Stats</div>
                <div className="text-xs text-neutral-500">
                  Filter:
                  <span className="text-neutral-300 ml-1">
                    {statsMonth === "all" ? "All time" : statsMonth}
                  </span>
                </div>
              </div>

              <div className="w-full sm:w-[220px]">
                <Select
                  label="Month"
                  value={statsMonth}
                  onChange={setStatsMonth}
                  options={statsMonthOptions}
                />
              </div>
            </div>
            {/* Top KPIs */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
              <StatCard title="Total items" value={items.length.toString()} sub={`${statusCounts.completed} completed`} />
              <StatCard title="Completed" value={totalCompleted.toString()} sub="(after excludes)" />
              <StatCard
                title="Time watched"
                value={`${(totalRuntimeMinutesCompleted / 60).toFixed(1)}h`}
                sub={`${totalRuntimeMinutesCompleted} min`}
              />
              <StatCard title="Rewatches" value={`${rewatchTotals.rewatches}`} sub={`${rewatchTotals.itemsRewatched} items`} />
              <StatCard
                title="Friends"
                value={friendsList.length.toString()}
                sub={`Following ${friendsList.length} • Pending ${outgoingRequests.length}`}
              />
            </div>

            {/* Highlights */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <Panel title="Highlights" right={<span className="text-xs text-neutral-500">Quick stats</span>}>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <MiniStat label="Best month" value={`${bestMonth.label}`} sub={`${bestMonth.count} completed`} />
                  <MiniStat label="Current streak" value={`${completionStreak.current} days`} sub={`Longest: ${completionStreak.longest}`} />
                  <MiniStat label="Top game" value={gameHoursStats.topGameTitle} sub={`${gameHoursStats.topGameHours.toFixed(1)}h`} />
                  <MiniStat label="Avg game hours" value={`${gameHoursStats.avgHours.toFixed(1)}h`} sub={`Total: ${gameHoursStats.totalHours.toFixed(1)}h`} />
                </div>

                <div className="mt-4 grid grid-cols-1 gap-2">
                  <MiniStat
                    label={`Top genre this year (${yearGenreCompare.year})`}
                    value={yearGenreCompare.thisYearTop.tag}
                    sub={`${yearGenreCompare.thisYearTop.count}`}
                  />
                  <MiniStat
                    label={`Top genre last year (${yearGenreCompare.year - 1})`}
                    value={yearGenreCompare.lastYearTop.tag}
                    sub={`${yearGenreCompare.lastYearTop.count}`}
                  />
                  <MiniStat label="Most rewatched" value={mostRewatchedItem.title} sub={`${mostRewatchedItem.count}`} />
                </div>
              </Panel>

              <Panel
                title="Monthly completions"
                right={<span className="text-xs text-neutral-500">Last 12 months</span>}
                className="lg:col-span-2 flex flex-col"
              >
                <div className="flex-1 flex items-end">
                  <div className="flex items-end gap-2 w-full">
                    {monthlyCompleted.months.map((m) => {
                      const h = Math.round((m.count / monthlyCompleted.max) * 96);
                      return (
                        <div key={m.key} className="flex-1 min-w-[18px] text-center">
                          <div
                            className="rounded-lg bg-white/10 border border-white/10 mx-auto"
                            style={{ height: `${Math.max(6, h)}px` }}
                            title={`${m.key}: ${m.count}`}
                          />
                          <div className="text-[10px] text-neutral-500 mt-2">{m.label}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div className="text-xs text-neutral-500 mt-3">
                  Uses <span className="text-neutral-400">date watched</span> if set; otherwise{" "}
                  <span className="text-neutral-400">created date</span>.
                </div>
              </Panel>
            </div>

            {/* Breakdown + Genres */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <Panel title="Status breakdown" right={<span className="text-xs text-neutral-500">{items.length} total</span>}>
                <div className="space-y-2 text-sm">
                  <BarRow label="Completed" value={statusCounts.completed} total={items.length || 1} />
                  <BarRow label="In Progress" value={statusCounts.in_progress} total={items.length || 1} />
                  <BarRow label="Planned" value={statusCounts.planned} total={items.length || 1} />
                  <BarRow label="Dropped" value={statusCounts.dropped} total={items.length || 1} />
                </div>

                <details className="mt-4 rounded-xl border border-neutral-800 bg-neutral-950/40 px-3 py-2">
                  <summary className="cursor-pointer select-none text-xs text-neutral-300">
                    Exclude types (affects all stats)
                    <span className="text-neutral-500"> — click to expand</span>
                  </summary>

                  <div className="text-xs text-neutral-400 mt-3">Toggle types:</div>
                  <div className="flex flex-wrap gap-2 mt-2">
                    {(["movie", "tv", "anime", "manga", "book", "game"] as MediaType[]).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => toggleExclude(t)}
                        className={`px-3 py-1 rounded-xl border text-xs ${
                          excludeTypes.has(t) ? "bg-red-500/15 border-red-500/20" : "bg-white/5 border-white/10 hover:bg-white/10"
                        }`}
                      >
                        {excludeTypes.has(t) ? `Excluded: ${TYPE_LABEL[t]}` : TYPE_LABEL[t]}
                      </button>
                    ))}
                  </div>
                </details>
              </Panel>

              <Panel title="Genres (completed)" className="lg:col-span-2">
                {genreCounts.length ? (
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-center gap-6">
                    <PieChartSimple data={genreCounts} />
                    <div className="space-y-2 text-sm w-full">
                      {genreCounts.map((g, idx) => (
                        <div key={g.label} className="flex items-center justify-between gap-6">
                          <div className="min-w-0 flex items-center gap-2">
                            <span
                              className="h-3 w-3 rounded-full shrink-0 ring-1 ring-white/10"
                              style={{ backgroundColor: PIE_COLORS[idx % PIE_COLORS.length] }}
                              aria-hidden="true"
                            />
                            <div className="text-neutral-300 truncate">{g.label}</div>
                          </div>
                          <div className="text-neutral-400 tabular-nums">{g.value}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="text-xs text-neutral-400">No genres yet.</div>
                )}

                <details className="mt-4 rounded-xl border border-neutral-800 bg-neutral-950/40 px-3 py-2">
                  <summary className="cursor-pointer select-none text-xs text-neutral-300">
                    Top tags (completed)
                    <span className="text-neutral-500"> — click to expand</span>
                  </summary>

                  <div className="mt-3">
                    {topTags.length ? (
                      <div className="flex flex-wrap gap-2">
                        {topTags.map((t) => (
                          <div
                            key={t.tag}
                            className="px-3 py-1 rounded-xl bg-neutral-950 border border-neutral-800 text-xs text-neutral-200"
                            title={`${t.count} items`}
                          >
                            {t.tag} <span className="text-neutral-500">({t.count})</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-xs text-neutral-400">No tags yet.</div>
                    )}
                  </div>
                </details>
              </Panel>
            </div>

            {/* “Deep dive” section (collapsible, removes repetition by default) */}
            <Panel title="Details" right={<span className="text-xs text-neutral-500">Less clutter by default</span>}>
              <details className="rounded-xl border border-neutral-800 bg-neutral-950/40 px-3 py-2">
                <summary className="cursor-pointer select-none text-xs text-neutral-300">
                  Type totals
                  <span className="text-neutral-500"> — click to expand</span>
                </summary>

                <div className="mt-3 space-y-2">
                  {typeCounts.length ? (
                    typeCounts.map((x) => (
                      <div
                        key={x.type}
                        className="flex items-center justify-between rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2"
                      >
                        <div className="text-sm text-neutral-200">{TYPE_LABEL[x.type]}</div>
                        <div className="text-sm text-neutral-300 tabular-nums">{x.count}</div>
                      </div>
                    ))
                  ) : (
                    <div className="text-xs text-neutral-400">No items yet.</div>
                  )}
                </div>
              </details>

              <details className="mt-3 rounded-xl border border-neutral-800 bg-neutral-950/40 px-3 py-2">
                <summary className="cursor-pointer select-none text-xs text-neutral-300">
                  Average rating (by type)
                  <span className="text-neutral-500"> — click to expand</span>
                </summary>

                <div className="mt-3 grid sm:grid-cols-2 gap-2 text-sm text-neutral-300">
                  {avgByType.length ? (
                    avgByType.map((x) => (
                      <div key={x.type} className="rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 text-center">
                        <div className="text-xs text-neutral-400">{TYPE_LABEL[x.type]}</div>
                        <div>
                          {formatRatingValue(x.avg, settings.ratingFormat)} <span className="text-xs text-neutral-500">({x.count} rated)</span>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="text-xs text-neutral-400">Rate some items to see averages.</div>
                  )}
                </div>
              </details>
            </Panel>
          </div>
        ) : null}


        {/* ADD PAGE */}
        {view === "add" ? (
          <div className="rounded-3xl stack-accent ring-1 ring-white/10">
            {/* center content */}
            <div className="px-4 sm:px-6 py-6 md:px-10 md:py-10 mx-auto max-w-3xl space-y-4">
              <div className="text-center">
                <div className="text-2xl font-semibold tracking-tight">Add to Stack</div>
                <div className="text-sm text-neutral-200/70 mt-1">
                  Auto-fill: Movie/TV (TMDB) • Game (IGDB) • Anime/Manga (AniList). Everything else manual.
                </div>
              </div>

              <form onSubmit={addItem} className="bg-neutral-950/55 backdrop-blur-sm p-5 sm:p-7 rounded-2xl ring-1 ring-neutral-800/80 shadow-lg space-y-5">
                <div className="space-y-2">
                  <div className="relative">
                    {ghostTitle && normTitle(ghostTitle).startsWith(normTitle(String(form.title || ""))) ? (
                      <div className="absolute inset-0 pointer-events-none flex items-center px-3 py-2">
                        <span className="text-transparent select-none">{String(form.title || "")}</span>
                        <span className="text-neutral-500/60 select-none">{ghostTitle.slice(String(form.title || "").length)}</span>
                      </div>
                    ) : null}

                    <input
                      value={form.title || ""}
                      onChange={(e) => {
                        const v = e.target.value;
                        setForm({ ...form, title: v });
                        setShowSuggest(true);
                      }}
                      onFocus={() => setShowSuggest(true)}
                      onBlur={() => {
                        window.setTimeout(() => setShowSuggest(false), 120);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Tab" && ghostTitle) {
                          e.preventDefault();
                          setForm((f) => ({ ...f, title: ghostTitle }));
                          setGhostTitle("");
                          setShowSuggest(false);
                          setSuggestions([]); // ✅ clear old list
                          return;
                        }


                        if (showSuggest && suggestions.length) {
                          if (e.key === "ArrowDown") {
                            e.preventDefault();
                            setActiveSuggestIdx((i) => Math.min(suggestions.length - 1, i + 1));
                            return;
                          }
                          if (e.key === "ArrowUp") {
                            e.preventDefault();
                            setActiveSuggestIdx((i) => Math.max(0, i - 1));
                            return;
                          }
                          if (e.key === "Enter") {
                            if (activeSuggestIdx >= 0 && activeSuggestIdx < suggestions.length) {
                              const s = suggestions[activeSuggestIdx];
                              if (s) {
                                e.preventDefault();
                                selectSuggestion(s);
                              }
                            }
                            return;
                          }
                          if (e.key === "Escape") {
                            setShowSuggest(false);
                            return;
                          }
                        }
                      }}

                      placeholder="Title"
                      className="w-full rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 text-base sm:text-sm outline-none focus:border-neutral-500"
                    />

                    {showSuggest && suggestions.length ? (
                      <div className="absolute z-30 mt-2 w-full rounded-2xl border border-neutral-800 bg-neutral-950 shadow-xl overflow-hidden">
                        <div className="px-3 py-2 text-[11px] text-neutral-500 border-b border-neutral-800">
                          Suggestions (↑/↓ + Enter) • Tab accepts ghost preview
                        </div>
                        <div className="max-h-64 overflow-auto">
                          {suggestions.map((s, idx) => (
                            <button
                              type="button"
                              key={s.key}
                              onMouseDown={(ev) => ev.preventDefault()}
                              onClick={() => selectSuggestion(s)}
                              className={[
                                "w-full text-left px-3 py-2 flex items-center gap-3 border-b border-neutral-900/60",
                                idx === activeSuggestIdx ? "bg-white/10" : "hover:bg-white/5",
                              ].join(" ")}
                            >
                              <div className="w-8 h-10 rounded-lg bg-neutral-900 border border-neutral-800 overflow-hidden shrink-0">
                                {s.posterUrl ? (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img src={s.posterUrl} alt="" className="w-full h-full object-cover" />
                                ) : (
                                  <div className="w-full h-full grid place-items-center text-[10px] text-neutral-600">—</div>
                                )}
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="text-sm text-neutral-200 truncate">{s.title}</div>
                                <div className="text-[11px] text-neutral-500">
                                  {s.provider.toUpperCase()}
                                  {s.subtitle ? ` • ${s.subtitle}` : ""}
                                </div>
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>

                  {autofillStatus ? <div className="text-xs text-neutral-300">{autofillStatus}</div> : null}
                  <div className="h-px bg-white/10" />
                  <div className="text-xs text-neutral-400 font-medium">Basics</div>
                </div>

                {((form.posterOverrideUrl || "").trim() || (form.posterUrl || "").trim()) ? (
                  <div className="flex items-center gap-3 rounded-2xl bg-neutral-950 border border-neutral-800 p-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={((form.posterOverrideUrl || "").trim() || (form.posterUrl || "").trim()) as string}
                      alt="Poster"
                      className="w-12 h-16 rounded-lg object-cover bg-neutral-900"
                    />
                    <div className="text-xs text-neutral-400">Cover loaded • Tags: {displayCombinedTags.slice(0, 4).join(", ") || "—"}</div>
                    <div className="flex-1" />
                    <button
                      type="button"
                      onClick={() =>
                        setForm((f) => ({
                          ...f,
                          posterUrl: "",
                          posterOverrideUrl: "",
                        }))
                      }
                      className="text-xs px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10"
                    >
                      Remove cover
                    </button>
                  </div>
                ) : null}

                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                  <Select
                    label="Type"
                    value={form.type || "movie"}
                    onChange={(v) => {
                      setSuggestions([]);
                      setGhostTitle("");
                      setActiveSuggestIdx(0);

                      setForm({
                        ...form,
                        type: v as MediaType,
                        tmdbId: undefined,
                        tmdbType: undefined,
                        igdbId: undefined,
                        anilistId: undefined,
                        anilistType: undefined,
                        posterUrl: "",
                        runtime: undefined,
                      });

                      setAutoTags([]);
                      setAutofillStatus("");

                      setProgressTotalText((prev) => {
                        const nextType = v as MediaType;
                        if (nextType === "movie") return prev.trim() === "" ? "1" : prev;
                        return prev;
                      });
                    }}
                    options={[
                      { value: "movie", label: "Movie" },
                      { value: "tv", label: "TV" },
                      { value: "anime", label: "Anime" },
                      { value: "manga", label: "Manga" },
                      { value: "book", label: "Book" },
                      { value: "game", label: "Game" },
                    ]}
                  />

                  <Select
                    label="Status"
                    value={form.status || "planned"}
                    onChange={(v) => setForm({ ...form, status: v as Status })}
                    options={[
                      { value: "completed", label: "Completed" },
                      { value: "in_progress", label: "In Progress" },
                      { value: "planned", label: "Planned" },
                      { value: "dropped", label: "Dropped" },
                    ]}
                  />

                  <TextNumberInput
                    label={`Rating (${ratingFormatLabel(settings.ratingFormat)})`}
                    value={ratingText}
                    onChange={setRatingText}
                    placeholder="—"
                    pattern={/^\d{0,2}(\.\d{0,1})?$/}
                    helper="Rate the show."
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <TextNumberInput
                    label="Progress current (optional)"
                    value={progressCurText}
                    onChange={setProgressCurText}
                    placeholder="—"
                    pattern={/^\d{0,6}$/}
                  />

                  <TextNumberInput
                    label="Progress total (optional)"
                    value={progressTotalText}
                    onChange={setProgressTotalText}
                    placeholder={form.type === "movie" ? "1" : "—"}
                    pattern={/^\d{0,6}$/}
                    helper={
                      form.type === "movie"
                        ? "Movies default to 1 total if left blank."
                        : form.type === "tv"
                        ? "Auto-fill tries to set episode count."
                        : form.type === "anime"
                        ? "Auto-fill tries to set episodes."
                        : form.type === "manga"
                        ? "Auto-fill tries chapters (or volumes)."
                        : undefined
                    }
                  />
                </div>
                
                <div className="h-px bg-white/10 mt-2" />
                <div className="text-xs text-neutral-400 font-medium">Details</div>
                <div className="h-px bg-white/10 mt-2" />
                <div className="text-xs text-neutral-400 font-medium">Progress</div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Text
                    label="Date watched (optional)"
                    type="date"
                    value={String(form.dateFinished || "")}
                    onChange={(v) => setForm({ ...form, dateFinished: v })}
                    helper="If blank: Completed auto-sets to today."
                  />

                  {String(form.title || "").trim().length > 0 ? (
                    <Text
                      label="Cover image URL (optional)"
                      value={String(form.posterOverrideUrl || "")}
                      onChange={(v) => setForm({ ...form, posterOverrideUrl: v })}
                      helper="Overrides auto-filled cover."
                    />
                  ) : null}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <TextNumberInput
                    label="Count"
                    value={rewatchText}
                    onChange={(v) => {
                      if (!isRewatch) return;

                      if (v.trim() === "") {
                        setRewatchText("");
                        return;
                      }

                      const n = Math.floor(Number(v));
                      if (!Number.isFinite(n)) return;

                      const clamped = Math.max(1, Math.min(999, n));
                      setRewatchText(String(clamped));
                      lastRewatchOnRef.current = String(clamped);
                    }}
                    placeholder="1"
                    pattern={/^\d{0,3}$/}
                    disabled={!isRewatch}
                    helper={isRewatch ? "Rewatch count (min 1)." : "Enable Rewatch to edit."}
                  />

                  <label className="block">
                    <div className="text-xs text-neutral-400 mb-1">Rewatch</div>
                    <Toggle
                      label="Rewatch"
                      checked={isRewatch}
                      onChange={(nextOn) => {
                        setIsRewatch(nextOn);

                        if (nextOn) {
                          setRewatchText((prev) => {
                            const restored = (lastRewatchOnRef.current || "1").trim();
                            if (prev.trim() === "" || Number(prev) === 0) return restored;
                            return prev;
                          });
                        } else {
                          const n = Math.floor(Number(rewatchText));
                          if (Number.isFinite(n) && n > 0) lastRewatchOnRef.current = String(n);
                          setRewatchText("0");
                        }
                      }}
                    />
                  </label>
                </div>

                <TagEditor
                  autoTags={autoTags}
                  manualTags={manualTags}
                  onChangeManual={setManualTags}
                  helper="Auto-filled genres show below; add your own tags too."
                />

                {friendsList.length ? (
                  <div className="space-y-2">
                    <div className="text-xs text-neutral-400">With friends (optional)</div>
                    <div className="flex flex-wrap gap-2">
                      {friendsList.map((f) => {
                        const selected = selectedFriendIds.includes(f.friend_id);
                        return (
                          <button
                            key={f.friend_id}
                            type="button"
                            onClick={() => toggleSelectedFriend(f.friend_id)}
                            className={[
                              "px-3 py-2 rounded-xl border text-xs transition touch-manipulation",
                              selected
                                ? "bg-emerald-500/15 border-emerald-500/25 text-neutral-100"
                                : "bg-white/5 border-white/10 hover:bg-white/10 text-neutral-300",
                            ].join(" ")}
                            aria-pressed={selected}
                          >
                            {selected ? "Added: " : "Add: "}
                            {friendsNameById.get(f.friend_id) ?? f.friend?.username ?? f.friend_id}
                          </button>
                        );
                      })}
                    </div>
                    <div className="text-[11px] text-neutral-500">This saves with the item in your existing media JSON.</div>
                  </div>
                ) : null}

                <TextArea
                  label="Notes"
                  value={String(form.notes || "")}
                  onChange={(v) => setForm({ ...form, notes: v })}
                  placeholder="Anything you want to remember"
                />

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <button
                    type="submit"
                    className="px-4 py-2 rounded-xl stack-good hover:opacity-95"
                  >
                    Add to Stack
                  </button>

                  <div className="flex gap-3 flex-wrap">
                    <Toggle label="Auto-fill as you type" checked={autoAutofill} onChange={setAutoAutofill} />
                  </div>
                </div>
              </form>

              {/* PICK SECTION */}
              <div className="bg-neutral-950/40 p-4 sm:p-6 rounded-2xl ring-1 ring-neutral-800/80 shadow-sm space-y-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => pickForMe("best")}
                      className="px-4 py-2 rounded-xl bg-white/10 border border-white/10 hover:bg-white/15"
                    >
                      Pick something for me
                    </button>

                    <button
                      type="button"
                      onClick={() => pickForMe("random")}
                      title="Random"
                      aria-label="Random"
                      className="px-3 py-2 rounded-xl bg-white/10 border border-white/10 hover:bg-white/15"
                    >
                      🎲
                    </button>
                  </div>

                  <div className="text-xs text-neutral-400">{pickStatus}</div>
                </div>

                {picks.length ? (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {picks.map((p) => (
                      <div
                        key={
                          p.provider === "tmdb"
                            ? `tmdb:${p.tmdbType}:${p.tmdbId}`
                            : p.provider === "anilist"
                            ? `anilist:${p.anilistType}:${p.anilistId}`
                            : `igdb:${p.igdbId}`
                        }
                      >
                        <div className="aspect-[2/3] rounded-xl overflow-hidden bg-neutral-950 border border-neutral-800">
                          {p.posterUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={p.posterUrl} alt={p.title} className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full grid place-items-center text-[10px] text-neutral-600">No cover</div>
                          )}
                        </div>
                        <div className="text-xs text-neutral-200 line-clamp-2">{p.title}</div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {/* FRIENDS PAGE */}
        {view === "friends" ? (
          <div className="space-y-4 max-w-5xl mx-auto">
            {/* Top bar (matches main pages vibe) */}
            <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 text-center sm:text-left">
              <div>
                <div className="text-lg font-semibold text-neutral-200">Friends</div>
                <div className="text-sm text-neutral-500">
                  Add friends, customize their names, and browse what they are watching.
                </div>
              </div>

              <button
                type="button"
                onClick={() => {
                  loadIncomingFriendRequests(undefined, { autoAccept: true });
                  loadFriends();
                  loadFriendActivity();
                }}
                className="text-xs px-3 py-2 rounded-xl bg-white/10 border border-white/10 hover:bg-white/15"
              >
                Refresh
              </button>
            </div>

            {/* Search + Tabs (same control style as main) */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
              <input
                value={friendsQuery}
                onChange={(e) => setFriendsQuery(e.target.value)}
                placeholder="Search friends, display names, tags, or requests..."
                className="w-full rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 text-base sm:text-sm outline-none focus:border-neutral-500"
              />

              <div className="flex items-center gap-2 justify-center sm:justify-end">
                <button
                  type="button"
                  onClick={() => setFriendsTab("friends")}
                  className={[
                    "px-3 py-2 rounded-xl border text-sm transition",
                    friendsTab === "friends"
                      ? "bg-white/15 border-white/20"
                      : "bg-white/5 border-white/10 hover:bg-white/10",
                  ].join(" ")}
                >
                  Friends <span className="text-xs text-neutral-500 ml-1">({friendsList.length})</span>
                </button>

                <button
                  type="button"
                  onClick={() => setFriendsTab("requests")}
                  className={[
                    "px-3 py-2 rounded-xl border text-sm transition",
                    friendsTab === "requests"
                      ? "bg-white/15 border-white/20"
                      : "bg-white/5 border-white/10 hover:bg-white/10",
                  ].join(" ")}
                >
                  Requests <span className="text-xs text-neutral-500 ml-1">({incomingRequests.length})</span>
                </button>
              </div>
            </div>

            {/* Send request panel (same surface look) */}
            <div className="rounded-3xl bg-neutral-950/68 ring-1 ring-white/10 shadow-xl shadow-black/10 backdrop-blur-xl p-4 sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-neutral-200">Add a friend</div>
                  <div className="text-xs text-neutral-500">Enter their Stack username or display name</div>
                </div>
              </div>

              <div className="mt-3 flex flex-col sm:flex-row gap-2">
                <input
                  value={inputUsername}
                  onChange={(e) => setInputUsername(e.target.value)}
                  placeholder="Enter username or display name (e.g., OGChump or Norey)"
                  className="flex-1 rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 text-base sm:text-sm outline-none focus:border-neutral-500"
                />
                <button
                  type="button"
                  onClick={sendFriendRequest}
                  className="px-4 py-2 rounded-xl bg-white/10 border border-white/10 hover:bg-white/15"
                >
                  Send request
                </button>
              </div>

              {friendStatus ? <div className="mt-3 text-sm text-neutral-300">{friendStatus}</div> : null}
            </div>

            {/* List panel (table header row like main pages) */}
            <div className="rounded-3xl bg-neutral-950/68 ring-1 ring-white/10 shadow-xl shadow-black/10 backdrop-blur-xl p-4 sm:p-6">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium text-neutral-200">
                  {friendsTab === "friends" ? "Your friends" : "Incoming requests"}
                </div>
                <div className="text-xs text-neutral-500">
                  {friendsTab === "friends" ? filteredFriendsList.length : filteredIncomingRequests.length}
                </div>
              </div>

              <div className="mt-3 hidden sm:grid grid-cols-[minmax(0,1fr)_minmax(180px,240px)] gap-3 px-3 py-2 rounded-xl bg-neutral-950/40 ring-1 ring-neutral-800/70 text-xs text-neutral-300">
                <div>{friendsTab === "friends" ? "Friend" : "Requester"}</div>
                <div className="text-right">Actions</div>
              </div>

              <div className="mt-2 space-y-2">
                {friendsTab === "friends" ? (
                  filteredFriendsList.length ? (
                    filteredFriendsList.map((f) => {
                      const display = getFriendDisplay(f.friend_id, f.friend);

                      return (
                        <div
                          key={f.friend_id}
                          className="rounded-2xl bg-neutral-950/80 border border-white/10 px-3 py-3 shadow-sm"
                        >
                          <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(220px,280px)] gap-3 items-center">
                            <div className="min-w-0">
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedFriendProfileId(f.friend_id);
                                  setFriendProfileView("all");
                                  setFriendProfileQuery("");
                                  setFriendProfileMobileTab("profile");
                                }}
                                className="text-sm text-neutral-200 hover:text-neutral-50 truncate text-left max-w-full"
                              >
                                {display.primary}
                              </button>
                              <div className="text-[11px] text-neutral-600 truncate">{display.secondary}</div>
                              {display.hasCustomTag ? (
                                <div className="text-[11px] text-emerald-300/80 mt-1">Showing your nickname first</div>
                              ) : null}
                            </div>

                            <div className="sm:justify-self-end w-full sm:w-[260px] space-y-2">
                              <label className="block">
                                <div className="text-[11px] text-neutral-500 mb-1">Custom friend tag</div>
                                <input
                                  value={settings.friendNicknames?.[f.friend_id] ?? ""}
                                  onChange={(e) => updateFriendNickname(f.friend_id, e.target.value)}
                                  placeholder="Nickname / ID tag"
                                  className="w-full rounded-lg bg-neutral-900 border border-neutral-800 px-2 py-1 text-xs outline-none focus:border-neutral-500"
                                />
                              </label>
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedFriendProfileId(f.friend_id);
                                  setFriendProfileView("all");
                                  setFriendProfileQuery("");
                                  setFriendProfileMobileTab("profile");
                                }}
                                className="w-full text-xs px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-neutral-200"
                              >
                                View profile
                              </button>
                              <button
                                type="button"
                                onClick={() => removeFriend(f.friend_id)}
                                className="w-full text-xs px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20 hover:bg-red-500/20 text-neutral-200"
                              >
                                Remove friend
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div className="text-xs text-neutral-500 mt-2">No friends yet.</div>
                  )
                ) : filteredIncomingRequests.length ? (
                  filteredIncomingRequests.map((r) => (
                    <div
                      key={r.id}
                      className="rounded-2xl bg-neutral-950/80 border border-white/10 px-3 py-3 shadow-sm"
                    >
                      <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(180px,240px)] gap-3 items-center">
                        <div className="min-w-0">
                          <div className="text-sm text-neutral-200 truncate">
                            {r.requester?.username ?? r.requester_id}
                          </div>
                          <div className="text-[11px] text-neutral-600 truncate">{r.requester_id}</div>
                        </div>

                        <div className="flex items-center gap-2 sm:justify-end">
                          <button
                            type="button"
                            onClick={() => acceptFriendRequest(r.id, r.requester_id)}
                            className="text-xs px-3 py-2 rounded-xl bg-emerald-500/20 border border-emerald-500/30 hover:bg-emerald-500/25"
                          >
                            Accept
                          </button>
                          <button
                            type="button"
                            onClick={() => declineFriendRequest(r.id)}
                            className="text-xs px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10"
                          >
                            Decline
                          </button>
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="text-xs text-neutral-500 mt-2">No incoming requests.</div>
                )}
              </div>
            </div>

            {selectedFriendProfile ? (
              <Panel
                title={`${selectedFriendProfile.display.primary}'s profile`}
                right={
                  <button
                    type="button"
                    onClick={() => setSelectedFriendProfileId(null)}
                    className="text-xs px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10"
                  >
                    Close profile
                  </button>
                }
              >
                <div className="sm:hidden grid grid-cols-3 gap-2 mb-4 rounded-2xl stack-mobile-readable-surface border border-white/10 p-2">
                  {(["profile", "library", "stats"] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => setFriendProfileMobileTab(tab)}
                      className={[
                        "px-3 py-2 rounded-xl border text-xs capitalize transition",
                        friendProfileMobileTab === tab
                          ? "bg-white/15 border-white/25 text-neutral-50"
                          : "bg-white/5 border-white/10 text-neutral-300",
                      ].join(" ")}
                    >
                      {tab}
                    </button>
                  ))}
                </div>

                <div className={["rounded-2xl bg-neutral-950/60 border border-white/10 p-4 mb-4", friendProfileMobileTab === "library" ? "hidden sm:block" : ""].join(" ")}>
                  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xl font-semibold text-neutral-100 truncate">
                        {selectedFriendProfile.settings.displayName?.trim() || selectedFriendProfile.display.baseName}
                      </div>
                      <div className="text-xs text-neutral-500 mt-1 truncate">
                        {selectedFriendProfile.display.idTag || selectedFriendProfile.friend.friend?.username || selectedFriendProfile.id}
                      </div>
                    </div>
                    <div className="text-xs text-neutral-500 sm:text-right">
                      {selectedFriendProfile.items.length} visible item{selectedFriendProfile.items.length === 1 ? "" : "s"}
                    </div>
                  </div>

                  <div className="mt-3 text-sm text-neutral-300 whitespace-pre-wrap">
                    {selectedFriendProfile.settings.showProfileBioToFriends === false
                      ? "Profile description hidden by this user."
                      : selectedFriendProfile.settings.profileBio?.trim() || "No profile description yet."}
                  </div>

                  <div className="grid grid-cols-2 lg:grid-cols-5 gap-2 mt-4">
                    <MiniStat label="Visible" value={String(selectedFriendProfileStats.total)} sub="items" />
                    <MiniStat label="Completed" value={String(selectedFriendProfileStats.completed)} sub="finished" />
                    <MiniStat label="In progress" value={String(selectedFriendProfileStats.inProgress)} sub="active" />
                    <MiniStat
                      label="Average"
                      value={selectedFriendProfile.settings.showRatingsToFriends === false ? "Hidden" : formatRatingValue(selectedFriendProfileStats.avgRating, settings.ratingFormat)}
                      sub="rating"
                    />
                    <MiniStat
                      label="Top genre"
                      value={selectedFriendProfile.settings.showTagsToFriends === false ? "Hidden" : selectedFriendProfileStats.topGenre}
                      sub={selectedFriendProfile.settings.showTagsToFriends === false ? "tags" : `${selectedFriendProfileStats.topGenreCount}`}
                    />
                  </div>
                </div>

                <div className={["rounded-2xl bg-neutral-950/60 border border-white/10 p-4 mb-4", friendProfileMobileTab === "stats" ? "" : "hidden sm:block"].join(" ")}>
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <div>
                      <div className="text-sm font-medium text-neutral-200">Comparison with your Stack</div>
                      <div className="text-xs text-neutral-500">Based only on visible public titles and tags.</div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
                    <MiniStat label="Both completed" value={String(selectedFriendComparison.bothCompleted)} sub="same titles" />
                    <MiniStat label="Both planned" value={String(selectedFriendComparison.bothPlanned)} sub="same titles" />
                    <MiniStat label="Both active" value={String(selectedFriendComparison.bothInProgress)} sub="in progress" />
                    <MiniStat label="Shared genres" value={selectedFriendComparison.sharedTopTags} sub="top overlap" />
                    <MiniStat label="Friend top type" value={selectedFriendComparison.friendTopType} sub="visible library" />
                  </div>
                </div>

                <div className={["space-y-4", friendProfileMobileTab === "library" ? "" : "hidden sm:block"].join(" ")}>
                <div className="flex flex-wrap gap-2 mb-4">
                  <button
                    type="button"
                    onClick={() => setFriendProfileView("all")}
                    className={[
                      "px-3 py-2 rounded-xl border text-xs transition",
                      friendProfileView === "all" ? "bg-white/15 border-white/25" : "bg-white/5 border-white/10 hover:bg-white/10",
                    ].join(" ")}
                  >
                    All
                  </button>
                  {STATUSES.map((status) => (
                    <button
                      key={status.id}
                      type="button"
                      onClick={() => setFriendProfileView(status.id)}
                      className={[
                        "px-3 py-2 rounded-xl border text-xs transition",
                        friendProfileView === status.id ? "bg-white/15 border-white/25" : "bg-white/5 border-white/10 hover:bg-white/10",
                      ].join(" ")}
                    >
                      {status.label}
                    </button>
                  ))}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(180px,240px)_auto] gap-3 items-end mb-4">
                  <label className="block">
                    <div className="text-xs text-neutral-400 mb-1">Search</div>
                    <input
                      value={friendProfileQuery}
                      onChange={(e) => setFriendProfileQuery(e.target.value)}
                      placeholder="Search this friend's titles, notes, or tags..."
                      className="w-full h-[42px] rounded-xl bg-neutral-950 border border-neutral-800 px-3 text-base sm:text-sm outline-none focus:border-neutral-500"
                    />
                  </label>

                  <Select
                    label="Sort"
                    value={friendProfileSortMode}
                    onChange={(v) => setFriendProfileSortMode(v as SortMode)}
                    options={[
                      { value: "newest", label: "Newest first" },
                      { value: "oldest", label: "Oldest first" },
                      { value: "title", label: "Title (A–Z)" },
                      { value: "rating_high", label: "Rating (high → low)" },
                      { value: "rating_low", label: "Rating (low → high)" },
                      { value: "updated", label: "Last updated" },
                      { value: "favorites", label: "Favorites first" },
                    ]}
                  />

                  <div className="sm:pb-0">
                    <Toggle label="Board view" checked={friendProfileBoardView} onChange={setFriendProfileBoardView} />
                  </div>
                </div>

                {friendProfileFilteredItems.length ? (
                  friendProfileBoardView && friendProfileView === "all" ? (
                    <FriendReadOnlyBoardView
                      items={friendProfileFilteredItems}
                      ratingFormat={settings.ratingFormat ?? "ten"}
                      privacy={profilePrivacyFromSettings(selectedFriendProfile.settings)}
                    />
                  ) : (
                    <div className="space-y-5">
                      {(friendProfileView === "all"
                        ? STATUSES.map((status) => ({ ...status, items: friendProfileByStatus[status.id] }))
                        : [
                            {
                              id: friendProfileView,
                              label: STATUSES.find((status) => status.id === friendProfileView)?.label ?? "Items",
                              items: friendProfileFilteredItems,
                            },
                          ]
                      ).map((section) =>
                        section.items.length ? (
                          <section key={section.id} className="space-y-2">
                            <div className="text-sm text-neutral-300">{section.label}</div>
                            <div className="space-y-3">
                              {section.items.map((item) => (
                                <FriendReadOnlyRow
                                  key={item.id}
                                  item={item}
                                  ratingFormat={settings.ratingFormat ?? "ten"}
                                  privacy={profilePrivacyFromSettings(selectedFriendProfile.settings)}
                                />
                              ))}
                            </div>
                          </section>
                        ) : null
                      )}
                    </div>
                  )
                ) : (
                  <div className="text-sm text-neutral-500">No visible items match this profile filter. Private items stay hidden.</div>
                )}
                </div>
              </Panel>
            ) : null}

            <Panel
              title="Friend media library"
              right={<span className="text-xs text-neutral-500">{friendActivityStatus}</span>}
            >
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Select
                  label="Friend"
                  value={friendLibraryFriendId}
                  onChange={setFriendLibraryFriendId}
                  options={[
                    { value: "all", label: "All friends" },
                    ...friendsList.map((f) => {
                      const display = getFriendDisplay(f.friend_id, f.friend);
                      return { value: f.friend_id, label: display.primary };
                    }),
                  ]}
                />

                <Select
                  label="Status"
                  value={friendLibraryStatus}
                  onChange={(v) => setFriendLibraryStatus(v as FriendLibraryStatusFilter)}
                  options={[
                    { value: "all", label: "All statuses" },
                    { value: "completed", label: "Completed" },
                    { value: "in_progress", label: "In Progress" },
                    { value: "planned", label: "Planned" },
                    { value: "dropped", label: "Dropped" },
                  ]}
                />

                <Select
                  label="Sort"
                  value={friendLibrarySortMode}
                  onChange={(v) => setFriendLibrarySortMode(v as SortMode)}
                  options={[
                    { value: "newest", label: "Newest first" },
                    { value: "oldest", label: "Oldest first" },
                    { value: "title", label: "Title (A–Z)" },
                    { value: "rating_high", label: "Rating (high → low)" },
                    { value: "rating_low", label: "Rating (low → high)" },
                    { value: "updated", label: "Last updated" },
                    { value: "favorites", label: "Favorites first" },
                  ]}
                />
              </div>

              <div className="mt-4 space-y-2">
                {friendLibraryItems.length ? (
                  friendLibraryItems.map((item) => (
                    <div
                      key={`${item.__ownerId}:${item.id}`}
                      className="rounded-2xl bg-neutral-950/80 border border-white/10 px-3 py-3 shadow-sm"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="text-sm text-neutral-200 truncate">
                            <span className="font-medium">{item.title}</span>
                          </div>
                          <div className="text-[11px] text-neutral-500 mt-1">
                            {item.__ownerName} • {TYPE_LABEL[item.type]} • {item.status.replace("_", " ")}
                            {friendSettingsById.get(item.__ownerId)?.showRatingsToFriends === false
                              ? ""
                              : item.rating !== undefined
                              ? ` • ${formatRatingValue(item.rating, settings.ratingFormat)}`
                              : ""}
                            {item.favorite ? " • Favorite" : ""}
                          </div>
                          {friendSettingsById.get(item.__ownerId)?.showTagsToFriends !== false && item.tags?.length ? (
                            <div className="text-[11px] text-neutral-600 mt-1 truncate">{item.tags.join(" • ")}</div>
                          ) : null}
                        </div>

                        <div className="text-[11px] text-neutral-600 whitespace-nowrap">
                          Updated {new Date(item.updatedAt ?? item.createdAt).toLocaleDateString()}
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="text-sm text-neutral-500">
                    No visible friend items match this filter yet. Private items stay hidden.
                  </div>
                )}
              </div>
            </Panel>
          </div>
        ) : null}

        {/* FEED PAGE */}
        {view === "feed" ? (
          <div className="space-y-4 max-w-5xl mx-auto">
            <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 text-center sm:text-left">
              <div>
                <div className="text-lg font-semibold text-neutral-200">Activity Feed</div>
                <div className="text-sm text-neutral-500">Latest activity from you and any friends your current RLS rules allow you to view.</div>
              </div>

              <button
                type="button"
                onClick={loadFriendActivity}
                className="text-xs px-3 py-2 rounded-xl bg-white/10 border border-white/10 hover:bg-white/15"
              >
                Refresh feed
              </button>
            </div>

            <Panel title="Latest activity" right={<span className="text-xs text-neutral-500">{friendActivityStatus}</span>}>
              <div className="space-y-2">
                {activityFeed.length ? (
                  activityFeed.map((a) => (
                    <div key={a.id} className="rounded-2xl bg-neutral-950/80 border border-white/10 px-3 py-3 shadow-sm">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm text-neutral-200 truncate">
                            <span className="font-medium">{a.actorName}</span> {a.status === "completed" ? "completed" : a.status === "in_progress" ? "started / updated" : a.status === "planned" ? "planned" : "dropped"} <span className="font-medium">{a.itemTitle}</span>
                          </div>
                          <div className="text-[11px] text-neutral-500 mt-1">
                            {TYPE_LABEL[a.itemType]} • {new Date(a.date).toLocaleString()}
                            {a.favorite ? " • Favorite" : ""}
                          </div>
                        </div>
                        <div className="text-xs text-neutral-500 capitalize">{a.status.replace("_", " ")}</div>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="text-sm text-neutral-500">No activity yet.</div>
                )}
              </div>
            </Panel>
          </div>
        ) : null}

        {/* DISCOVER PAGE */}
        {view === "discover" ? (
          <div className="space-y-4 max-w-5xl mx-auto">
            <div className="text-center sm:text-left">
              <div className="text-lg font-semibold text-neutral-200">Discover</div>
              <div className="text-sm text-neutral-500">Browse movies and TV by genre, then add anything directly to Planned.</div>
            </div>

            <Panel title="Browse TMDB">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Select
                  label="Type"
                  value={discoverType}
                  onChange={(v) => {
                    setDiscoverType(v as "movie" | "tv");
                    setDiscoverGenreId("all");
                    setDiscoverResults([]);
                  }}
                  options={[
                    { value: "movie", label: "Movies" },
                    { value: "tv", label: "TV" },
                  ]}
                />

                <Select
                  label="Genre"
                  value={discoverGenreId}
                  onChange={setDiscoverGenreId}
                  options={[
                    { value: "all", label: "All genres" },
                    ...discoverGenres.map((g) => ({ value: String(g.id), label: g.name })),
                  ]}
                />

                <label className="block">
                  <div className="text-xs text-neutral-400 mb-1">Search</div>
                  <button
                    type="button"
                    onClick={browseDiscover}
                    className="w-full h-[42px] px-4 rounded-xl bg-white/10 border border-white/10 hover:bg-white/15 text-sm"
                  >
                    Browse
                  </button>
                </label>
              </div>

              {discoverStatus ? <div className="text-xs text-neutral-400 mt-3">{discoverStatus}</div> : null}

              {discoverResults.length ? (
                <div className="mt-5 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
                  {discoverResults.map((card) => (
                    <div key={`${card.type}:${card.id}`} className="rounded-2xl bg-neutral-950 border border-neutral-800 overflow-hidden">
                      <div className="aspect-[2/3] bg-neutral-900">
                        {card.posterUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={card.posterUrl} alt={card.title} className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full grid place-items-center text-xs text-neutral-600">No cover</div>
                        )}
                      </div>
                      <div className="p-3 space-y-2">
                        <div className="text-sm font-medium text-neutral-200 line-clamp-2">{card.title}</div>
                        <div className="text-[11px] text-neutral-500">{TYPE_LABEL[card.type]}{card.year ? ` • ${card.year}` : ""}</div>
                        {card.tags?.length ? <div className="text-[11px] text-neutral-500 line-clamp-1">{card.tags.join(" • ")}</div> : null}
                        <button
                          type="button"
                          onClick={() => addDiscoverItem(card)}
                          className="w-full text-xs px-3 py-2 rounded-xl bg-emerald-500/15 border border-emerald-500/25 hover:bg-emerald-500/20"
                        >
                          Add planned
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </Panel>
          </div>
        ) : null}

        {/* FEEDBACK PAGE */}
        {view === "feedback" ? (
          <div className="space-y-4 max-w-5xl mx-auto">
            <div className="text-center sm:text-left">
              <div className="text-lg font-semibold text-neutral-200">Suggestions / Problems</div>
              <div className="text-sm text-neutral-500">Save feedback the moment you notice it. This uses your existing media_items.data JSON.</div>
            </div>

            <Panel title="Submit feedback">
              <form onSubmit={submitFeedback} className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-[180px_minmax(0,1fr)] gap-3">
                  <Select
                    label="Type"
                    value={feedbackType}
                    onChange={(v) => setFeedbackType(v as "suggestion" | "problem")}
                    options={[
                      { value: "suggestion", label: "Suggestion" },
                      { value: "problem", label: "Problem" },
                    ]}
                  />
                  <TextArea
                    label="What did you notice?"
                    value={feedbackText}
                    onChange={setFeedbackText}
                    placeholder="Write the idea, bug, or problem here..."
                  />
                </div>

                <button type="submit" className="px-4 py-2 rounded-xl stack-good hover:opacity-95">
                  Save feedback
                </button>
              </form>
            </Panel>

            <Panel title="Saved feedback" right={<span className="text-xs text-neutral-500">{feedbackEntries.length}</span>}>
              <div className="space-y-2">
                {feedbackEntries.length ? (
                  feedbackEntries.map((f) => (
                    <div key={f.id} className="rounded-2xl bg-neutral-950/80 border border-white/10 px-3 py-3 shadow-sm">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="text-xs text-neutral-500 mb-1">
                            {f.type === "problem" ? "Problem" : "Suggestion"} • {new Date(f.createdAt).toLocaleString()}
                          </div>
                          <div className="text-sm text-neutral-200 whitespace-pre-wrap">{f.message}</div>
                        </div>
                        <button
                          type="button"
                          onClick={() => setFeedbackEntries((prev) => prev.filter((x) => x.id !== f.id))}
                          className="text-xs px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="text-sm text-neutral-500">No feedback saved yet.</div>
                )}
              </div>
            </Panel>
            {isAdminUser ? (
              <Panel
                title="Admin feedback inbox"
                right={
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-neutral-500">{adminFeedbackStatus}</span>
                    <button
                      type="button"
                      onClick={loadAdminFeedback}
                      className="text-xs px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10"
                    >
                      Refresh
                    </button>
                  </div>
                }
              >
                <div className="text-xs text-neutral-500 mb-3">
                  Only the admin account shows this section. It gathers saved Suggestions / Problems from visible Stack data.
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,220px)_auto] gap-3 items-end mb-4">
                  <Select
                    label="Admin filter"
                    value={adminFeedbackFilter}
                    onChange={(v) => setAdminFeedbackFilter(v as typeof adminFeedbackFilter)}
                    options={[
                      { value: "all", label: "All feedback" },
                      { value: "suggestion", label: "Suggestions only" },
                      { value: "problem", label: "Problems only" },
                      { value: "new", label: "New" },
                      { value: "reviewed", label: "Reviewed" },
                      { value: "done", label: "Done" },
                    ]}
                  />
                  <Toggle label="Hide done" checked={adminHideDone} onChange={setAdminHideDone} />
                </div>

                <div className="space-y-2">
                  {filteredAdminFeedbackRows.length ? (
                    filteredAdminFeedbackRows.map((f) => (
                      <div key={`${f.userId}:${f.id}`} className="rounded-2xl bg-neutral-950/80 border border-white/10 px-3 py-3 shadow-sm">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="text-xs text-neutral-500 mb-1">
                              {f.type === "problem" ? "Problem" : "Suggestion"} • {(f.status ?? "new").toUpperCase()} • {new Date(f.createdAt).toLocaleString()}
                            </div>
                            <div className="text-[11px] text-neutral-600 mb-2 truncate">
                              From: {f.userLabel} • {f.userId}
                            </div>
                            <div className="text-sm text-neutral-200 whitespace-pre-wrap">{f.message}</div>
                          </div>
                          <div className="flex flex-wrap gap-2 sm:justify-end">
                            <button
                              type="button"
                              onClick={() => updateAdminFeedbackStatus(f.userId, f.id, "new")}
                              className="text-xs px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10"
                            >
                              New
                            </button>
                            <button
                              type="button"
                              onClick={() => updateAdminFeedbackStatus(f.userId, f.id, "reviewed")}
                              className="text-xs px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10"
                            >
                              Reviewed
                            </button>
                            <button
                              type="button"
                              onClick={() => updateAdminFeedbackStatus(f.userId, f.id, "done")}
                              className="text-xs px-3 py-2 rounded-xl stack-good hover:opacity-95"
                            >
                              Done
                            </button>
                          </div>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="text-sm text-neutral-500">No submitted feedback matches this filter yet.</div>
                  )}
                </div>
              </Panel>
            ) : null}
          </div>
        ) : null}

        {/* SETTINGS PAGE */}
        {view === "settings" ? (
          <div className="space-y-4 max-w-5xl mx-auto">
            <div className="text-center sm:text-left">
              <div className="text-lg font-semibold text-neutral-200">Settings</div>
              <div className="text-sm text-neutral-500">Personalize your Stack without changing the production database schema.</div>
            </div>

            <Panel title="Profile / personal info">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Text
                  label="Display name"
                  value={settings.displayName ?? ""}
                  onChange={(v) => updateSettings({ displayName: v })}
                  helper="Used in your local activity feed display."
                />
                <Text
                  label="Custom ID tag"
                  value={settings.usernameTag ?? ""}
                  onChange={(v) => updateSettings({ usernameTag: v })}
                  helper="This is a Stack display tag. It does not rename profiles.username in Supabase."
                />
              </div>

              <div className="mt-3">
                <TextArea
                  label="Profile bio"
                  value={settings.profileBio ?? ""}
                  onChange={(v) => updateSettings({ profileBio: v })}
                  placeholder="Anything you want shown on your Stack profile later..."
                />
              </div>
            </Panel>

            <Panel title="Friend profile privacy">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <Toggle
                  label="Show bio to friends"
                  checked={settings.showProfileBioToFriends !== false}
                  onChange={(v) => updateSettings({ showProfileBioToFriends: v })}
                />
                <Toggle
                  label="Show ratings to friends"
                  checked={settings.showRatingsToFriends !== false}
                  onChange={(v) => updateSettings({ showRatingsToFriends: v })}
                />
                <Toggle
                  label="Show notes to friends"
                  checked={settings.showNotesToFriends !== false}
                  onChange={(v) => updateSettings({ showNotesToFriends: v })}
                />
                <Toggle
                  label="Show tags to friends"
                  checked={settings.showTagsToFriends !== false}
                  onChange={(v) => updateSettings({ showTagsToFriends: v })}
                />
              </div>
              <div className="text-[11px] text-neutral-500 mt-3">
                Private items are always hidden. These controls decide what details friends see on public items.
              </div>
            </Panel>

            <Panel
              title="Preview what friends can see"
              right={
                <button
                  type="button"
                  onClick={() => setOwnFriendPreviewOpen((prev) => !prev)}
                  className="text-xs px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10"
                >
                  {ownFriendPreviewOpen ? "Hide preview" : "Show preview"}
                </button>
              }
            >
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
                <MiniStat label="Visible" value={String(ownFriendPreviewStats.total)} sub="items" />
                <MiniStat label="Completed" value={String(ownFriendPreviewStats.completed)} sub="finished" />
                <MiniStat label="In progress" value={String(ownFriendPreviewStats.inProgress)} sub="active" />
                <MiniStat
                  label="Average"
                  value={settings.showRatingsToFriends === false ? "Hidden" : formatRatingValue(ownFriendPreviewStats.avgRating, settings.ratingFormat)}
                  sub="rating"
                />
                <MiniStat
                  label="Top genre"
                  value={settings.showTagsToFriends === false ? "Hidden" : ownFriendPreviewStats.topGenre}
                  sub={settings.showTagsToFriends === false ? "tags" : `${ownFriendPreviewStats.topGenreCount}`}
                />
              </div>

              {ownFriendPreviewOpen ? (
                <div className="mt-4 space-y-3">
                  {(settings.showProfileBioToFriends === false ? "Profile description hidden." : settings.profileBio?.trim() || "No profile description yet.") ? (
                    <div className="rounded-2xl bg-neutral-950/70 border border-white/10 px-3 py-3 text-sm text-neutral-300 whitespace-pre-wrap">
                      {settings.showProfileBioToFriends === false
                        ? "Profile description hidden."
                        : settings.profileBio?.trim() || "No profile description yet."}
                    </div>
                  ) : null}
                  {ownFriendPreviewItems.length ? (
                    ownFriendPreviewItems.slice(0, 5).map((item) => (
                      <FriendReadOnlyRow
                        key={`preview:${item.id}`}
                        item={item}
                        ratingFormat={settings.ratingFormat ?? "ten"}
                        privacy={profilePrivacyFromSettings(settings)}
                      />
                    ))
                  ) : (
                    <div className="text-sm text-neutral-500">Friends would not see any items yet because your items are private or your Stack is empty.</div>
                  )}
                  {ownFriendPreviewItems.length > 5 ? (
                    <div className="text-xs text-neutral-500">Showing the first 5 visible items.</div>
                  ) : null}
                </div>
              ) : (
                <div className="text-xs text-neutral-500 mt-3">Open this to see your Stack the way a friend would see it.</div>
              )}
            </Panel>

            <Panel title="Site preferences">
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-stretch">
                <div className="rounded-2xl bg-neutral-950/72 border border-white/10 p-4 flex flex-col justify-between min-h-[152px]">
                  <Select
                    label="Rating display"
                    value={settings.ratingFormat ?? "ten"}
                    onChange={(v) => updateSettings({ ratingFormat: v as RatingFormat })}
                    options={[
                      { value: "ten", label: "10-point scale" },
                      { value: "five", label: "5-point scale" },
                      { value: "stars", label: "Stars" },
                      { value: "percent", label: "Percent" },
                    ]}
                  />
                  <div className="text-[11px] text-neutral-500 mt-3">
                    Ratings are still saved as 0–10 internally. Current display: {ratingFormatLabel(settings.ratingFormat)}.
                  </div>
                </div>

                <div className="rounded-2xl bg-neutral-950/72 border border-white/10 p-4 flex flex-col justify-between min-h-[152px]">
                  <Select
                    label="Color theme"
                    value={settings.colorTheme ?? DEFAULT_SETTINGS.colorTheme}
                    onChange={(v) => updateSettings({ colorTheme: v as StackColorTheme })}
                    options={STACK_COLOR_THEME_OPTIONS.map((t) => ({ value: t.value, label: t.label }))}
                  />

                  <div className="mt-3 grid grid-cols-6 gap-1.5">
                    {STACK_COLOR_THEME_OPTIONS.map((t) => {
                      const theme = STACK_COLOR_THEMES[t.value];
                      return (
                        <button
                          key={t.value}
                          type="button"
                          onClick={() => updateSettings({ colorTheme: t.value })}
                          className={[
                            "h-7 rounded-lg border transition",
                            (settings.colorTheme ?? DEFAULT_SETTINGS.colorTheme) === t.value
                              ? "border-white/50 ring-2 ring-white/20"
                              : "border-white/10 hover:border-white/25",
                          ].join(" ")}
                          style={{ background: theme.accent }}
                          title={t.label}
                        />
                      );
                    })}
                  </div>

                  <div className="text-[11px] text-neutral-500 mt-3">
                    Current theme: {STACK_COLOR_THEME_OPTIONS.find((t) => t.value === (settings.colorTheme ?? DEFAULT_SETTINGS.colorTheme))?.description}.
                  </div>
                </div>

                <div className="rounded-2xl bg-neutral-950/72 border border-white/10 p-4 min-h-[152px] space-y-3">
                  <Select
                    label="Default add status"
                    value={settings.defaultAddStatus ?? DEFAULT_SETTINGS.defaultAddStatus}
                    onChange={(v) => {
                      const nextStatus = v as Status;
                      updateSettings({ defaultAddStatus: nextStatus });
                      if (!String(form.title || "").trim()) setForm((prev) => ({ ...prev, status: nextStatus }));
                    }}
                    options={[
                      { value: "completed", label: "Completed" },
                      { value: "in_progress", label: "In Progress" },
                      { value: "planned", label: "Planned" },
                      { value: "dropped", label: "Dropped" },
                    ]}
                  />
                  <div className="text-[11px] text-neutral-500">
                    New items on the Add page start with this status unless you change it.
                  </div>
                </div>

                <div className="rounded-2xl bg-neutral-950/72 border border-white/10 p-4 min-h-[152px] space-y-3">
                  <Select
                    label="Default All page view"
                    value={settings.defaultBoardView ?? DEFAULT_SETTINGS.defaultBoardView}
                    onChange={(v) => {
                      const nextView = v as "board" | "list";
                      updateSettings({ defaultBoardView: nextView });
                      setBoardView(nextView === "board");
                    }}
                    options={[
                      { value: "board", label: "Board view" },
                      { value: "list", label: "List view" },
                    ]}
                  />
                  <div className="text-[11px] text-neutral-500">
                    This also switches the current All page layout.
                  </div>
                  <Toggle
                    label="Compact mode"
                    checked={!!settings.compactMode}
                    onChange={(v) => updateSettings({ compactMode: v })}
                  />
                </div>

                <div className="rounded-2xl bg-neutral-950/72 border border-white/10 p-4 min-h-[152px] space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto] gap-3 items-end">
                    <div>
                      <div className="text-xs text-neutral-400 mb-1">Sound effects</div>
                      <Toggle
                        label="Hover/click sounds"
                        checked={!!settings.soundEffects}
                        onChange={(v) => updateSettings({ soundEffects: v })}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => playStackSoundEffect("click", settings.soundVolume ?? 1)}
                      className="h-[42px] px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-sm"
                    >
                      Test sound
                    </button>
                  </div>

                  <label className="block">
                    <div className="flex items-center justify-between gap-3 text-xs text-neutral-400 mb-1">
                      <span>Sound volume</span>
                      <span className="text-neutral-500">{Math.round((settings.soundVolume ?? 1) * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min="0.25"
                      max="3"
                      step="0.05"
                      value={settings.soundVolume ?? 1}
                      onChange={(e) => updateSettings({ soundVolume: Number(e.target.value) })}
                      className="w-full accent-emerald-500"
                    />
                  </label>

                  <div className="text-[11px] text-neutral-500">
                    Turn sounds on, then click once or press Test sound to unlock audio. Volume can go up to 300%.
                  </div>
                </div>
              </div>
            </Panel>
          </div>
        ) : null}

        {/* LIST PAGES */}
        {view !== "stats" && view !== "add" && view !== "friends" && view !== "feed" && view !== "discover" && view !== "feedback" && view !== "settings" ? (
          <div className={view === "all" && boardView ? "space-y-4" : "space-y-4 max-w-5xl mx-auto"}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
              <label className="block">
                <div className="text-xs text-neutral-400 mb-1">Search</div>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search title, notes, tags..."
                  className="w-full h-[42px] rounded-xl bg-neutral-950 border border-neutral-800 px-3 text-base sm:text-sm outline-none focus:border-neutral-500"
                />
              </label>

              <Select
                label="Sort"
                value={sortMode}
                onChange={(v) => setSortMode(v as SortMode)}
                options={[
                  { value: "newest", label: "Newest first" },
                  { value: "oldest", label: "Oldest first" },
                  { value: "title", label: "Title (A–Z)" },
                  { value: "rating_high", label: "Rating (high → low)" },
                  { value: "rating_low", label: "Rating (low → high)" },
                  { value: "updated", label: "Last updated" },
                  { value: "favorites", label: "Favorites first" },
                ]}
              />
            </div>

            <div className="sm:hidden flex items-center justify-between gap-3 rounded-2xl stack-mobile-readable-surface border border-white/10 px-3 py-3">
              <button
                type="button"
                onClick={() => setMobileFiltersOpen(true)}
                className="flex-1 text-sm px-3 py-2 rounded-xl bg-white/10 border border-white/10 hover:bg-white/15 text-neutral-100"
              >
                Filters
              </button>
              <button
                type="button"
                onClick={clearStackFilters}
                className="text-xs px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-neutral-300"
              >
                Clear
              </button>
            </div>

            <div className="hidden sm:flex sm:flex-row sm:items-end sm:justify-between gap-3 rounded-2xl bg-neutral-950/55 border border-white/10 px-3 py-3">
              <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,220px)_auto] gap-3 items-end w-full sm:w-auto">
                <Select
                  label="Tag filter"
                  value={tagFilter}
                  onChange={setTagFilter}
                  options={tagFilterOptions}
                />
                <Toggle label="Favorites only" checked={favoriteOnly} onChange={setFavoriteOnly} />
              </div>
              <button
                type="button"
                onClick={clearStackFilters}
                className="text-xs px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-neutral-300"
              >
                Clear filters
              </button>
            </div>

            {view === "all" ? (
              <div className="flex items-center justify-between">
                <div className="text-xs text-neutral-500">Board view lets you drag cards between statuses.</div>
                <Toggle label="Board view" checked={boardView} onChange={setBoardView} />
              </div>
            ) : null}

            {filtered.length === 0 ? (
              <EmptyState
                title="No items match this view"
                message="Try clearing search, tag, or favorite filters, or add something new to your Stack."
              />
            ) : null}

            <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
              {view === "all" && boardView ? (
                <BoardView items={filtered} onDelete={removeItem} onUpdate={updateItem} friendsById={friendsNameById} ratingFormat={settings.ratingFormat ?? "ten"} />
              ) : groupMode !== "none" && grouped ? (
                <div className="space-y-6">
                  {grouped.map(([k, list]) => (
                    <section key={k} className="space-y-2">
                      <h3 className="text-sm text-neutral-400">{k}</h3>
                      <div className="space-y-3">
                        {list.map((i) => (
                          <MALRow key={i.id} item={i} onDelete={() => removeItem(i.id)} onUpdate={(patch) => updateItem(i.id, patch)} friendsById={friendsNameById} ratingFormat={settings.ratingFormat ?? "ten"} />
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              ) : (
                <div className="space-y-6">
                  {STATUSES.map((s) => {
                    const list = byStatusFiltered[s.id];
                    if (!list.length) return null;

                    const collapsed = collapsedStatuses.has(s.id);

                    return (
                      <section key={s.id} className="space-y-3">
                        <button
                          type="button"
                          onClick={() => toggleCollapsedStatus(s.id)}
                          className="w-full flex items-center justify-between rounded-xl bg-neutral-900/40 ring-1 ring-neutral-800/70 px-3 py-2 text-left touch-manipulation"
                          aria-expanded={!collapsed}
                        >
                          <h3 className="text-sm text-neutral-300">{s.label}</h3>
                          <div className="text-xs text-neutral-500">
                            {collapsed ? "Show" : "Hide"} • {list.length}
                          </div>
                        </button>

                        {!collapsed ? (
                        <div className="space-y-3">
                          <div className="hidden sm:grid grid-cols-[72px_minmax(0,1fr)_minmax(72px,12%)_minmax(72px,12%)_minmax(140px,20%)] gap-3 px-3 py-2 rounded-xl bg-neutral-900/40 ring-1 ring-neutral-800/70 text-xs text-neutral-300">
                            <div />
                            <div>Title</div>
                            <div className="text-center">Score</div>
                            <div className="text-center">Type</div>
                            <div className="text-center">Progress / Hours</div>
                          </div>

                          {list.map((i) => (
                            <MALRow
                              key={i.id}
                              item={i}
                              onDelete={() => removeItem(i.id)}
                              onUpdate={(patch) => updateItem(i.id, patch)}
                              friendsById={friendsNameById}
                              ratingFormat={settings.ratingFormat ?? "ten"}
                            />
                          ))}
                        </div>
                        ) : null}
                      </section>
                    );
                  })}
                </div>
              )}
            </DndContext>
          </div>
        ) : null}

        <footer className="pt-6 text-xs text-neutral-500">Stack • Saves to Supabase + local backup</footer>
      </div>

      {view !== "stats" && view !== "add" && view !== "friends" && view !== "feed" && view !== "discover" && view !== "feedback" && view !== "settings" && mobileFiltersOpen ? (
        <div className="sm:hidden fixed inset-0 z-50 bg-black/70" onMouseDown={() => setMobileFiltersOpen(false)}>
          <div
            className="absolute inset-x-0 bottom-0 rounded-t-3xl stack-mobile-readable-surface border-t border-white/10 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 mb-4">
              <div>
                <div className="text-base font-semibold text-neutral-100">Filters</div>
                <div className="text-xs text-neutral-500">Search, sort, tags, favorites, and view.</div>
              </div>
              <button type="button" onClick={() => setMobileFiltersOpen(false)} className="text-xs px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10">
                Close
              </button>
            </div>

            <div className="space-y-3">
              <label className="block">
                <div className="text-xs text-neutral-400 mb-1">Search</div>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search title, notes, tags..."
                  className="w-full h-[42px] rounded-xl bg-neutral-950 border border-neutral-800 px-3 text-base outline-none focus:border-neutral-500"
                />
              </label>

              <Select
                label="Sort"
                value={sortMode}
                onChange={(v) => setSortMode(v as SortMode)}
                options={[
                  { value: "newest", label: "Newest first" },
                  { value: "oldest", label: "Oldest first" },
                  { value: "title", label: "Title (A–Z)" },
                  { value: "rating_high", label: "Rating (high → low)" },
                  { value: "rating_low", label: "Rating (low → high)" },
                  { value: "updated", label: "Last updated" },
                  { value: "favorites", label: "Favorites first" },
                ]}
              />

              <Select label="Tag filter" value={tagFilter} onChange={setTagFilter} options={tagFilterOptions} />
              <Toggle label="Favorites only" checked={favoriteOnly} onChange={setFavoriteOnly} />
              {view === "all" ? <Toggle label="Board view" checked={boardView} onChange={setBoardView} /> : null}

              <div className="grid grid-cols-2 gap-2 pt-2">
                <button type="button" onClick={clearStackFilters} className="text-sm px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10">
                  Clear filters
                </button>
                <button type="button" onClick={() => setMobileFiltersOpen(false)} className="text-sm px-3 py-2 rounded-xl stack-good hover:opacity-95">
                  Apply
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {view !== "add" ? (
        <Link href="/add" className="sm:hidden fixed right-4 bottom-[5.35rem] z-40 px-4 py-3 rounded-2xl stack-good border border-white/10 shadow-2xl text-sm font-medium text-neutral-50" aria-label="Add to Stack">
          + Add
        </Link>
      ) : null}

      <nav className="sm:hidden fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-neutral-950/90 backdrop-blur-xl px-2 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]" aria-label="Mobile Stack navigation">
        <div className="grid grid-cols-5 gap-1 max-w-md mx-auto">
          {[
            { href: "/", label: "All", key: "all" as StackView },
            { href: "/add", label: "Add", key: "add" as StackView },
            { href: "/friends", label: "Friends", key: "friends" as StackView },
            { href: "/stats", label: "Stats", key: "stats" as StackView },
            { href: "/settings", label: "Settings", key: "settings" as StackView },
          ].map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={[
                "min-h-[46px] rounded-2xl grid place-items-center px-1 text-[11px] border transition",
                view === n.key ? "bg-white/15 border-white/25 text-neutral-50" : "bg-white/5 border-white/10 text-neutral-300",
              ].join(" ")}
            >
              {n.label}
            </Link>
          ))}
        </div>
      </nav>

      {/* ✅ UNDO TOAST */}
      {undoState ? (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50">
          <div className="flex items-center gap-3 rounded-2xl bg-neutral-950 border border-neutral-800 shadow-2xl px-4 py-3">
            <div className="text-sm text-neutral-200">
              Deleted <span className="font-semibold">{undoState.item.title}</span>
            </div>
            <button
              type="button"
              onClick={() => {
                setItems((prev) => {
                  const next = prev.slice();
                  next.splice(undoState.index, 0, undoState.item);
                  return next;
                });
                setUndoState(null);
                if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current);
                undoTimerRef.current = null;
              }}
              className="text-xs px-3 py-2 rounded-xl bg-white/10 border border-white/10 hover:bg-white/15"
            >
              Undo
            </button>
            <button
              type="button"
              onClick={() => {
                setUndoState(null);
                if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current);
                undoTimerRef.current = null;
              }}
              className="text-xs px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10"
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}
    </div>
    </>
  );
}

/* ================= BOARD VIEW ================= */

function BoardView({
  items,
  onDelete,
  onUpdate,
  friendsById,
  ratingFormat,
}: {
  items: MediaItem[];
  onDelete: (id: string) => void;
  onUpdate: (id: string, patch: Partial<MediaItem>) => void;
  friendsById: Map<string, string>;
  ratingFormat: RatingFormat;
}) {
  const byStatus = useMemo(() => {
    const map: Record<Status, MediaItem[]> = { completed: [], in_progress: [], planned: [], dropped: [] };
    for (const i of items) map[i.status].push(i);
    return map;
  }, [items]);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 2xl:grid-cols-4 gap-6">
      {STATUSES.map((s) => (
        <StatusColumn key={s.id} status={s.id} title={s.label}>
          <div className="space-y-3">
            {byStatus[s.id].map((i) => (
              <CardDraggable key={i.id} item={i} onDelete={() => onDelete(i.id)} onUpdate={(p) => onUpdate(i.id, p)} friendsById={friendsById} ratingFormat={ratingFormat} />
            ))}
            {!byStatus[s.id].length ? <div className="text-xs text-neutral-600 text-center py-8">Drop here</div> : null}
          </div>
        </StatusColumn>
      ))}
    </div>
  );
}

function StatusColumn({ status, title, children }: { status: Status; title: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: status });

  return (
    <section
      ref={setNodeRef}
      className={[
        "rounded-2xl ring-1 shadow-sm p-5 min-h-[340px]",
        isOver ? "ring-emerald-500/40 bg-emerald-500/5" : "ring-neutral-800/80 bg-neutral-900/40",
      ].join(" ")}
    >
      <div className="text-sm font-medium mb-3 text-neutral-200">{title}</div>
      {children}
    </section>
  );
}

/* ================= MAL ROW ================= */

function MALRow({
  item,
  onDelete,
  onUpdate,
  friendsById,
  ratingFormat = "ten",
}: {
  item: MediaItem;
  onDelete: () => void;
  onUpdate: (patch: Partial<MediaItem>) => void;
  friendsById?: Map<string, string>;
  ratingFormat?: RatingFormat;
}) {
  const displayPoster = item.posterOverrideUrl || item.posterUrl;
  const withFriends = (item.withFriendIds ?? [])
    .map((id) => friendsById?.get(id) ?? id)
    .filter(Boolean);

  // ---------------- EDITING ----------------
  const [isEditing, setIsEditing] = React.useState(false);
  const [draftTitle, setDraftTitle] = React.useState(item.title);
  const [draftDate, setDraftDate] = React.useState(item.dateFinished ?? "");
  const [draftRating, setDraftRating] = React.useState(typeof item.rating === "number" ? String(item.rating) : "");
  const [draftNotes, setDraftNotes] = React.useState(item.notes ?? "");

  // full detail / note modals
  const [showFullNote, setShowFullNote] = React.useState(false);
  const [showDetail, setShowDetail] = React.useState(false);

  // keep drafts in sync if item changes while not editing
  useEffect(() => {
    if (isEditing) return;
    setDraftTitle(item.title);
    setDraftDate(item.dateFinished ?? "");
    setDraftRating(typeof item.rating === "number" ? String(item.rating) : "");
    setDraftNotes(item.notes ?? "");
  }, [item.id, item.title, item.dateFinished, item.rating, item.notes, isEditing]);

  const cancelEdit = () => {
    setIsEditing(false);
    setDraftTitle(item.title);
    setDraftDate(item.dateFinished ?? "");
    setDraftRating(typeof item.rating === "number" ? String(item.rating) : "");
    setDraftNotes(item.notes ?? "");
  };

  const saveEdit = () => {
    const nextTitle = String(draftTitle || "").trim();
    const nextDate = String(draftDate || "").trim();

    const ratingRaw = String(draftRating || "").trim();
    const ratingNum = ratingRaw === "" ? undefined : Number(ratingRaw);
    const nextRating =
      typeof ratingNum === "number" && Number.isFinite(ratingNum) ? clamp(ratingNum, 0, 10) : undefined;

    const notesRaw = String(draftNotes || "").trim();
    const nextNotes = notesRaw ? notesRaw : undefined;

    onUpdate({
      title: nextTitle || item.title,
      dateFinished: nextDate ? nextDate : undefined,
      rating: nextRating,
      notes: nextNotes,
    });

    setIsEditing(false);
  };

  // ---------------- PROGRESS / HOURS ----------------
  const movieProg = getMovieProgressDefaults(item);

  const cur =
    item.type === "movie"
      ? movieProg.cur
      : typeof item.progressCurOverride === "number"
      ? item.progressCurOverride
      : item.progressCur;

  const total =
    item.type === "movie"
      ? movieProg.total
      : typeof item.progressTotalOverride === "number"
      ? item.progressTotalOverride
      : item.progressTotal;

  const hasCur = typeof cur === "number";
  const hasTotal = typeof total === "number";
  const progressText = hasCur || hasTotal ? (hasTotal ? `${cur ?? 0} / ${total}` : `${cur ?? 0}`) : "—";

  const effectiveCur = typeof cur === "number" ? cur : 0;

  const usingCurOverride = item.type !== "movie" && typeof item.progressCurOverride === "number";

  const incCur = () => {
    const t = typeof total === "number" ? total : undefined;
    const next = t ? Math.min(t, effectiveCur + 1) : effectiveCur + 1;

    if (item.type === "movie") return onUpdate({ progressCur: Math.min(1, next), progressTotal: 1 });

    onUpdate(usingCurOverride ? { progressCurOverride: next } : { progressCur: next });
  };

  const decCur = () => {
    const next = Math.max(0, effectiveCur - 1);

    if (item.type === "movie") return onUpdate({ progressCur: Math.min(1, next), progressTotal: 1 });

    onUpdate(usingCurOverride ? { progressCurOverride: next } : { progressCur: next });
  };



  const isGame = item.type === "game";
  const hoursText = typeof item.hoursPlayed === "number" ? `${item.hoursPlayed.toFixed(1)}h` : "—";

  const hasLongNote = !!item.notes && item.notes.length > 120;
  const mobileDateLabel = item.dateFinished ? item.dateFinished : "No date";
  const mobileRatingLabel = formatRatingValue(item.rating, ratingFormat);

  return (
    <>
      {showDetail ? (
        <MediaItemDetailModal
          item={item}
          ratingFormat={ratingFormat}
          friendsById={friendsById}
          onUpdate={onUpdate}
          onDelete={onDelete}
          onClose={() => setShowDetail(false)}
        />
      ) : null}

      {/* FULL NOTE MODAL */}
      {showFullNote ? (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"
          onMouseDown={() => setShowFullNote(false)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="w-full max-w-2xl rounded-2xl bg-neutral-950 border border-neutral-800 shadow-2xl overflow-hidden"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-neutral-800">
              <div className="text-sm text-neutral-200 font-medium truncate">{item.title}</div>
              <button
                type="button"
                onClick={() => setShowFullNote(false)}
                className="text-xs px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10"
              >
                Close
              </button>
            </div>
            <div className="p-4">
              <div className="text-xs text-neutral-500 mb-2">Full note</div>
              <div className="text-sm text-neutral-200 whitespace-pre-wrap leading-relaxed">{item.notes || "—"}</div>
            </div>
          </div>
        </div>
      ) : null}

      <div className="stack-mobile-item-card rounded-2xl bg-neutral-950/72 ring-1 ring-neutral-800/80 overflow-hidden">
        <div className="sm:hidden p-3 space-y-3">
          <div className="flex gap-3 items-start">
            <button
              type="button"
              onClick={() => setShowDetail(true)}
              className="w-20 h-28 rounded-2xl overflow-hidden bg-neutral-950 border border-neutral-800 shrink-0 shadow-lg shadow-black/20"
              title="Open details"
            >
              {displayPoster ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={displayPoster} alt={item.title} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full grid place-items-center text-[10px] text-neutral-600">No cover</div>
              )}
            </button>

            <div className="min-w-0 flex-1 space-y-2">
              {isEditing ? (
                <input
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  className="w-full rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 text-sm outline-none focus:border-neutral-500"
                  placeholder="Title"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setShowDetail(true)}
                  className="block w-full text-left text-base font-semibold leading-snug text-neutral-100 line-clamp-2"
                >
                  {item.title}
                </button>
              )}

              <div className="flex flex-wrap gap-1.5 text-[11px]">
                <span className="px-2 py-1 rounded-lg bg-white/5 border border-white/10 text-neutral-300">{TYPE_LABEL[item.type]}</span>
                <span className="px-2 py-1 rounded-lg bg-white/5 border border-white/10 text-neutral-300">{mobileRatingLabel}</span>
                {item.favorite ? (
                  <span className="px-2 py-1 rounded-lg bg-amber-400/10 border border-amber-400/20 text-neutral-200">Favorite</span>
                ) : null}
                {item.isPrivate ? (
                  <span className="px-2 py-1 rounded-lg bg-sky-400/10 border border-sky-400/20 text-neutral-200">Private</span>
                ) : null}
              </div>

              <select
                value={item.status}
                onChange={(e) => onUpdate({ status: e.target.value as Status })}
                className="w-full rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 text-xs outline-none focus:border-neutral-500"
              >
                <option value="completed">Completed</option>
                <option value="in_progress">In Progress</option>
                <option value="planned">Planned</option>
                <option value="dropped">Dropped</option>
              </select>

              <div className="text-[11px] text-neutral-500">
                {isEditing ? (
                  <input
                    type="date"
                    value={draftDate}
                    onChange={(e) => setDraftDate(e.target.value)}
                    className="w-full rounded-lg bg-neutral-950 border border-neutral-800 px-2 py-1 text-xs outline-none focus:border-neutral-500"
                    title="Date watched"
                  />
                ) : (
                  <span>{mobileDateLabel}</span>
                )}
                {(Number(item.rewatchCount ?? 0) || 0) > 0 ? (
                  <span className="text-neutral-300"> • Rewatch x{Number(item.rewatchCount ?? 0) || 0}</span>
                ) : null}
              </div>
            </div>
          </div>

          {isEditing ? (
            <div>
              <div className="text-[11px] text-neutral-500 mb-1">Note</div>
              <textarea
                value={draftNotes}
                onChange={(e) => setDraftNotes(e.target.value)}
                rows={3}
                className="w-full rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 text-base outline-none focus:border-neutral-500 resize-none"
                placeholder="Write a note…"
              />
            </div>
          ) : item.notes ? (
            <div className="rounded-2xl bg-white/[0.035] border border-white/10 px-3 py-2">
              <div className="text-xs text-neutral-300 line-clamp-3">{item.notes}</div>
              {hasLongNote ? (
                <button
                  type="button"
                  onClick={() => setShowFullNote(true)}
                  className="mt-2 text-[11px] px-2 py-1 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 text-neutral-200"
                >
                  Read full note
                </button>
              ) : null}
            </div>
          ) : null}

          {item.tags?.length || withFriends.length ? (
            <div className="space-y-1">
              {item.tags?.length ? (
                <div className="text-[11px] text-neutral-500 line-clamp-2">{item.tags.join(" • ")}</div>
              ) : null}
              {withFriends.length ? (
                <div className="text-[11px] text-neutral-500 line-clamp-1">With: {withFriends.join(" • ")}</div>
              ) : null}
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-2xl bg-white/[0.035] border border-white/10 p-3">
              <div className="text-[11px] text-neutral-500 mb-1">Score</div>
              {isEditing ? (
                <input
                  value={draftRating}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "" || /^\d{0,2}(\.\d{0,1})?$/.test(v)) setDraftRating(v);
                  }}
                  placeholder="—"
                  className="w-full text-center rounded-lg bg-neutral-950 border border-neutral-800 px-2 py-1 text-xs outline-none focus:border-neutral-500"
                  title="Rating (0–10)"
                />
              ) : (
                <div className="text-sm text-neutral-200 tabular-nums">{mobileRatingLabel}</div>
              )}
            </div>

            <div className="rounded-2xl bg-white/[0.035] border border-white/10 p-3">
              <div className="text-[11px] text-neutral-500 mb-1">{isGame ? "Hours" : "Progress"}</div>
              <div className="text-sm text-neutral-200 tabular-nums">{isGame ? hoursText : progressText}</div>
            </div>
          </div>

          <div className="rounded-2xl bg-white/[0.035] border border-white/10 p-3">
            {isGame ? (
              <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2 items-center">
                <span className="text-[11px] text-neutral-500">Hours</span>
                <input
                  type="number"
                  min={0}
                  step="0.1"
                  value={typeof item.hoursPlayed === "number" ? item.hoursPlayed : ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "") return onUpdate({ hoursPlayed: undefined });
                    const n = Math.max(0, Number(v) || 0);
                    onUpdate({ hoursPlayed: n });
                  }}
                  className="w-full text-center rounded-lg bg-neutral-950 border border-neutral-800 px-2 py-1 text-xs outline-none focus:border-neutral-500"
                  placeholder="—"
                />
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-[2.5rem_minmax(0,1fr)_2.5rem] gap-2 items-center">
                  <button
                    type="button"
                    onClick={decCur}
                    className="h-10 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-lg"
                    aria-label="Decrease progress"
                    title="Decrease progress"
                  >
                    −
                  </button>

                  <div className="text-center text-sm text-neutral-200 tabular-nums whitespace-nowrap">{progressText}</div>

                  <button
                    type="button"
                    onClick={incCur}
                    className="h-10 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-lg"
                    aria-label="Increase progress"
                    title="Increase progress"
                  >
                    +
                  </button>
                </div>

                <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2 items-center">
                  <span className="text-[11px] text-neutral-500">Total</span>
                  <input
                    type="number"
                    min={0}
                    value={
                      item.type === "movie"
                        ? 1
                        : typeof item.progressTotalOverride === "number"
                        ? item.progressTotalOverride
                        : typeof item.progressTotal === "number"
                        ? item.progressTotal
                        : ""
                    }
                    onChange={(e) => {
                      if (item.type === "movie") return;
                      const v = e.target.value;
                      if (v === "") return onUpdate({ progressTotal: undefined, progressTotalOverride: undefined });
                      const n = Math.max(0, Number(v) || 0);
                      onUpdate({
                        progressTotalOverride: n,
                        progressCurOverride: undefined,
                      });
                    }}
                    className="w-full text-center rounded-lg bg-neutral-950 border border-neutral-800 px-2 py-1 text-xs outline-none focus:border-neutral-500"
                    placeholder="—"
                  />
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            {isEditing ? (
              <>
                <button
                  type="button"
                  onClick={saveEdit}
                  className="text-xs px-3 py-2 rounded-xl bg-emerald-500/20 border border-emerald-500/30 hover:bg-emerald-500/25"
                  title="Save"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={cancelEdit}
                  className="text-xs px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10"
                  title="Cancel"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setShowDetail(true)}
                  className="text-xs px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10"
                >
                  Details
                </button>
                <button
                  type="button"
                  onClick={() => setIsEditing(true)}
                  className="text-xs px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => onUpdate({ favorite: !item.favorite })}
                  className={[
                    "text-xs px-3 py-2 rounded-xl border hover:bg-white/10",
                    item.favorite ? "bg-amber-400/15 border-amber-400/25" : "bg-white/5 border-white/10",
                  ].join(" ")}
                  aria-pressed={!!item.favorite}
                >
                  {item.favorite ? "Unfavorite" : "Favorite"}
                </button>
                <button
                  type="button"
                  onClick={() => onUpdate({ isPrivate: !item.isPrivate })}
                  className={[
                    "text-xs px-3 py-2 rounded-xl border hover:bg-white/10",
                    item.isPrivate ? "bg-sky-400/15 border-sky-400/25" : "bg-white/5 border-white/10",
                  ].join(" ")}
                  aria-pressed={!!item.isPrivate}
                >
                  {item.isPrivate ? "Private" : "Public"}
                </button>
                <button
                  type="button"
                  onClick={onDelete}
                  className="col-span-2 text-xs px-3 py-2 rounded-xl stack-bad hover:opacity-95"
                >
                  Delete
                </button>
              </>
            )}
          </div>
        </div>

        <div className="hidden sm:grid sm:grid-cols-[72px_minmax(0,1fr)_minmax(72px,12%)_minmax(72px,12%)_minmax(140px,20%)] gap-3 p-3 items-center">
          {/* Poster */}
          <button
            type="button"
            onClick={() => setShowDetail(true)}
            className="w-[72px] h-[96px] rounded-xl overflow-hidden bg-neutral-950 border border-neutral-800 block"
            title="Open details"
          >
            {displayPoster ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={displayPoster} alt={item.title} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full grid place-items-center text-[10px] text-neutral-600">No cover</div>
            )}
          </button>

          {/* Title + meta */}
          <div className="min-w-0">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                {/* TITLE */}
                {isEditing ? (
                  <input
                    value={draftTitle}
                    onChange={(e) => setDraftTitle(e.target.value)}
                    className="w-full rounded-lg bg-neutral-950 border border-neutral-800 px-2 py-1 text-sm outline-none focus:border-neutral-500"
                    placeholder="Title"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setShowDetail(true)}
                    className="font-semibold truncate text-left hover:text-neutral-50 max-w-full"
                  >
                    {item.title}
                  </button>
                )}

                {/* STATUS + DATE */}
              <div className="text-xs text-neutral-400 mt-1 flex flex-wrap items-center gap-2">
                <span>Status:</span>
                <select
                  value={item.status}
                  onChange={(e) => onUpdate({ status: e.target.value as Status })}
                  className="rounded-md bg-neutral-950 border border-neutral-800 px-2 py-[2px] text-xs outline-none focus:border-neutral-500"
                >
                  <option value="completed">Completed</option>
                  <option value="in_progress">In Progress</option>
                  <option value="planned">Planned</option>
                  <option value="dropped">Dropped</option>
                </select>

                <span className="text-neutral-600">•</span>

                {isEditing ? (
                  <input
                    type="date"
                    value={draftDate}
                    onChange={(e) => setDraftDate(e.target.value)}
                    className="rounded-md bg-neutral-950 border border-neutral-800 px-2 py-[2px] text-xs outline-none focus:border-neutral-500"
                    title="Date watched"
                  />
                ) : item.dateFinished ? (
                  <span className="text-neutral-500">{item.dateFinished}</span>
                ) : (
                  <span className="text-neutral-600">No date</span>
                )}

                {(Number(item.rewatchCount ?? 0) || 0) > 0 ? (
                  <>
                    <span className="text-neutral-600">•</span>
                    <span className="text-neutral-300">Rewatch x{Number(item.rewatchCount ?? 0) || 0}</span>
                  </>
                ) : null}
              </div>


                {/* NOTES */}
                {isEditing ? (
                  <div className="mt-2">
                    <div className="text-[11px] text-neutral-500 mb-1">Note</div>
                    <textarea
                      value={draftNotes}
                      onChange={(e) => setDraftNotes(e.target.value)}
                      rows={3}
                      className="w-full rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 text-base sm:text-sm outline-none focus:border-neutral-500 resize-none"
                      placeholder="Write a note…"
                    />
                  </div>
                ) : item.notes ? (
                  <div className="mt-2">
                    <div className="text-xs text-neutral-300 line-clamp-2">{item.notes}</div>
                    <div className="mt-1 flex items-center gap-2">
                      {hasLongNote ? (
                        <button
                          type="button"
                          onClick={() => setShowFullNote(true)}
                          className="text-[11px] px-2 py-1 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 text-neutral-200"
                        >
                          Read full note
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {/* TAGS */}
                {item.tags?.length ? (
                  <div className="text-[11px] text-neutral-500 mt-1 truncate">{item.tags.join(" • ")}</div>
                ) : null}

                {withFriends.length ? (
                  <div className="text-[11px] text-neutral-500 mt-1 truncate">With: {withFriends.join(" • ")}</div>
                ) : null}

                <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
                  {item.favorite ? (
                    <span className="px-2 py-1 rounded-lg bg-amber-400/10 border border-amber-400/20 text-neutral-200">Favorite</span>
                  ) : null}
                  {item.isPrivate ? (
                    <span className="px-2 py-1 rounded-lg bg-sky-400/10 border border-sky-400/20 text-neutral-200">Private</span>
                  ) : null}
                </div>

                {/* ACTIONS */}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {isEditing ? (
                    <>
                      <button
                        type="button"
                        onClick={saveEdit}
                        className="text-xs px-3 py-2 rounded-xl bg-emerald-500/20 border border-emerald-500/30 hover:bg-emerald-500/25"
                        title="Save"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={cancelEdit}
                        className="text-xs px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10"
                        title="Cancel"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => onUpdate({ favorite: !item.favorite })}
                        className={[
                          "text-xs px-3 py-2 rounded-xl border hover:bg-white/10",
                          item.favorite ? "bg-amber-400/15 border-amber-400/25" : "bg-white/5 border-white/10",
                        ].join(" ")}
                        title={item.favorite ? "Remove favorite" : "Mark favorite"}
                        aria-pressed={!!item.favorite}
                      >
                        {item.favorite ? "★" : "☆"}
                      </button>
                      <button
                        type="button"
                        onClick={() => onUpdate({ isPrivate: !item.isPrivate })}
                        className={[
                          "text-xs px-3 py-2 rounded-xl border hover:bg-white/10",
                          item.isPrivate ? "bg-sky-400/15 border-sky-400/25" : "bg-white/5 border-white/10",
                        ].join(" ")}
                        title={item.isPrivate ? "Make visible to friends later" : "Mark private"}
                        aria-pressed={!!item.isPrivate}
                      >
                        {item.isPrivate ? "Private" : "Public"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setIsEditing(true)}
                        className="text-xs px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10"
                        title="Edit"
                      >
                        Edit
                      </button>
                      <button
                        onClick={onDelete}
                        className="text-xs px-3 py-2 rounded-xl stack-bad hover:opacity-95"
                        title="Delete"
                        type="button"
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* SCORE */}
          <div className="text-center text-sm text-neutral-300 tabular-nums">
            {isEditing ? (
              <input
                value={draftRating}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "" || /^\d{0,2}(\.\d{0,1})?$/.test(v)) setDraftRating(v);
                }}
                placeholder="—"
                className="w-[5.5rem] text-center rounded-lg bg-neutral-950 border border-neutral-800 px-2 py-1 text-xs outline-none focus:border-neutral-500"
                title="Rating (0–10)"
              />
            ) : (
              formatRatingValue(item.rating, ratingFormat)
            )}
          </div>

          {/* TYPE */}
          <div className="text-center text-sm text-neutral-300">{TYPE_LABEL[item.type]}</div>

          {/* PROGRESS / HOURS */}
          <div className="text-center w-full">
            {isGame ? (
              <>
                <div className="text-sm text-neutral-200 tabular-nums whitespace-nowrap">{hoursText}</div>

                <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
                  <span className="text-[11px] text-neutral-500">Hours</span>
                  <input
                    type="number"
                    min={0}
                    step="0.1"
                    value={typeof item.hoursPlayed === "number" ? item.hoursPlayed : ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "") return onUpdate({ hoursPlayed: undefined });
                      const n = Math.max(0, Number(v) || 0);
                      onUpdate({ hoursPlayed: n });
                    }}
                    className="w-[min(6rem,100%)] text-center rounded-lg bg-neutral-950 border border-neutral-800 px-2 py-1 text-xs outline-none focus:border-neutral-500"
                    placeholder="—"
                  />
                </div>
              </>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={decCur}
                    className="h-[2.1rem] w-[2.1rem] rounded-lg bg-white/5 border border-white/10 hover:bg-white/10"
                    aria-label="Decrease progress"
                    title="Decrease progress"
                  >
                    −
                  </button>

                  <div className="min-w-0 px-2 text-sm text-neutral-200 tabular-nums whitespace-nowrap">{progressText}</div>

                  <button
                    type="button"
                    onClick={incCur}
                    className="h-[2.1rem] w-[2.1rem] rounded-lg bg-white/5 border border-white/10 hover:bg-white/10"
                    aria-label="Increase progress"
                    title="Increase progress"
                  >
                    +
                  </button>
                </div>

                <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
                  <span className="text-[11px] text-neutral-500">Total</span>
                  <input
                    type="number"
                    min={0}
                    value={
                      item.type === "movie"
                        ? 1
                        : typeof item.progressTotalOverride === "number"
                        ? item.progressTotalOverride
                        : typeof item.progressTotal === "number"
                        ? item.progressTotal
                        : ""
                    }
                    onChange={(e) => {
                      if (item.type === "movie") return;
                      const v = e.target.value;
                      if (v === "") return onUpdate({ progressTotal: undefined, progressTotalOverride: undefined });
                      const n = Math.max(0, Number(v) || 0);
                      onUpdate({
                        progressTotalOverride: n,
                        progressCurOverride: undefined,
                      });
                    }}
                    className="w-[min(6rem,100%)] text-center rounded-lg bg-neutral-950 border border-neutral-800 px-2 py-1 text-xs outline-none focus:border-neutral-500"
                    placeholder="—"
                  />
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/* ================= DRAGGABLE CARD (BOARD) ================= */

function CardDraggable({
  item,
  onDelete,
  onUpdate,
  friendsById,
  ratingFormat = "ten",
}: {
  item: MediaItem;
  onDelete: () => void;
  onUpdate: (patch: Partial<MediaItem>) => void;
  friendsById?: Map<string, string>;
  ratingFormat?: RatingFormat;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: item.id });

  const style: React.CSSProperties = transform
    ? {
        transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
      }
    : {};

  const displayPoster = item.posterOverrideUrl || item.posterUrl;
  const withFriends = (item.withFriendIds ?? [])
    .map((id) => friendsById?.get(id) ?? id)
    .filter(Boolean);

  const movieProg = getMovieProgressDefaults(item);
  const cur =
    item.type === "movie"
      ? movieProg.cur
      : typeof item.progressCurOverride === "number"
      ? item.progressCurOverride
      : item.progressCur;
  const total =
    item.type === "movie"
      ? movieProg.total
      : typeof item.progressTotalOverride === "number"
      ? item.progressTotalOverride
      : item.progressTotal;

  const progressText =
    typeof cur === "number" || typeof total === "number"
      ? typeof total === "number"
        ? `${cur ?? 0} / ${total}`
        : `${cur ?? 0}`
      : "—";

        // ---------------- NOTES / DETAIL (BOARD VIEW) ----------------
  const [showNote, setShowNote] = React.useState(false);
  const [showDetail, setShowDetail] = React.useState(false);
  const [draftNote, setDraftNote] = React.useState(item.notes ?? "");

  useEffect(() => {
    if (showNote) return;
    setDraftNote(item.notes ?? "");
  }, [item.notes, showNote]);

  return (
    <>
      {showDetail ? (
        <MediaItemDetailModal
          item={item}
          ratingFormat={ratingFormat}
          friendsById={friendsById}
          onUpdate={onUpdate}
          onDelete={onDelete}
          onClose={() => setShowDetail(false)}
        />
      ) : null}

      {/* NOTE MODAL */}
      {showNote ? (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"
          onMouseDown={() => setShowNote(false)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="w-full max-w-2xl rounded-2xl bg-neutral-950 border border-neutral-800 shadow-2xl overflow-hidden"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-neutral-800">
              <div className="text-sm text-neutral-200 font-medium truncate">Note — {item.title}</div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const trimmed = draftNote.trim();
                    onUpdate({ notes: trimmed ? trimmed : undefined });
                    setShowNote(false);
                  }}
                  className="text-xs px-3 py-2 rounded-xl bg-emerald-500/20 border border-emerald-500/30 hover:bg-emerald-500/25"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => setShowNote(false)}
                  className="text-xs px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10"
                >
                  Close
                </button>
              </div>
            </div>

            <div className="p-4 space-y-2">
              <div className="text-[11px] text-neutral-500">Edit note</div>
              <textarea
                value={draftNote}
                onChange={(e) => setDraftNote(e.target.value)}
                rows={8}
                className="w-full rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 text-base sm:text-sm outline-none focus:border-neutral-500 resize-none"
                placeholder="Write anything you want to remember…"
              />

              <div className="flex items-center justify-between gap-3">
                <div className="text-[11px] text-neutral-600">Leave blank + Save to remove the note.</div>
                {item.notes ? (
                  <button
                    type="button"
                    onClick={() => {
                      setDraftNote("");
                      onUpdate({ notes: undefined });
                      setShowNote(false);
                    }}
                    className="text-xs px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20 hover:bg-red-500/20"
                  >
                    Clear note
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div
        ref={setNodeRef}
        style={style}
        className={[
          "stack-mobile-item-card rounded-2xl bg-neutral-950/74 border border-neutral-800 shadow-sm overflow-hidden",
          isDragging ? "opacity-70" : "opacity-100",
        ].join(" ")}
      >
        {/* drag handle row */}
        <div
          className="flex items-center justify-between gap-2 px-3 py-2 bg-neutral-950 border-b border-neutral-800"
          {...listeners}
          {...attributes}
          style={{ cursor: "grab", touchAction: "none" }}
        >
          <div className="text-xs text-neutral-500">Drag</div>
          <div className="text-xs text-neutral-400">{TYPE_LABEL[item.type]}</div>
        </div>

        <div className="p-4 flex gap-4">
          {/* LEFT: poster + note button */}
          <div className="shrink-0 space-y-2">
            <button
              type="button"
              onClick={() => setShowDetail(true)}
              className="w-16 h-20 rounded-xl overflow-hidden bg-neutral-900 border border-neutral-800 block"
              title="Open details"
            >
              {displayPoster ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={displayPoster} alt={item.title} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full grid place-items-center text-[10px] text-neutral-600">—</div>
              )}
            </button>

            <button
              type="button"
              onClick={() => setShowNote(true)}
              className={[
                "w-16 rounded-lg px-2 py-1 text-[11px] border transition",
                item.notes
                  ? "bg-white/10 border-white/10 hover:bg-white/15 text-neutral-200"
                  : "bg-white/5 border-white/10 hover:bg-white/10 text-neutral-400",
              ].join(" ")}
              title={item.notes ? "View/Edit note" : "Add note"}
            >
              Note ≡
            </button>
          </div>

          <div className="min-w-0 flex-1">
            <button
              type="button"
              onClick={() => setShowDetail(true)}
              className="font-semibold text-base text-neutral-200 truncate text-left hover:text-neutral-50 max-w-full"
            >
              {item.title}
            </button>

            <div className="text-[11px] text-neutral-500 mt-1">
              {item.type === "game"
                ? `Hours: ${typeof item.hoursPlayed === "number" ? `${item.hoursPlayed.toFixed(1)}h` : "—"}`
                : `Progress: ${progressText}`}
              {(Number(item.rewatchCount ?? 0) || 0) > 0 ? ` • Rewatch x${Number(item.rewatchCount ?? 0) || 0}` : ""}
            </div>

            <div className="text-[11px] text-neutral-500 mt-1">Score: {formatRatingValue(item.rating, ratingFormat)}</div>

            {/* tiny note preview */}
            {item.notes ? (
              <div className="text-[11px] text-neutral-400 mt-1 line-clamp-1">{item.notes}</div>
            ) : null}

            {withFriends.length ? (
              <div className="text-[11px] text-neutral-500 mt-1 line-clamp-1">With: {withFriends.join(" • ")}</div>
            ) : null}

            <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
              {item.favorite ? (
                <span className="px-2 py-1 rounded-lg bg-amber-400/10 border border-amber-400/20 text-neutral-200">Favorite</span>
              ) : null}
              {item.isPrivate ? (
                <span className="px-2 py-1 rounded-lg bg-sky-400/10 border border-sky-400/20 text-neutral-200">Private</span>
              ) : null}
            </div>

            <div className="mt-3 pt-3 border-t border-white/10 space-y-2">
              <label className="block">
                <div className="text-[11px] text-neutral-500 mb-1">Status</div>
                <select
                  value={item.status}
                  onChange={(e) => onUpdate({ status: e.target.value as Status })}
                  className="w-full rounded-lg bg-neutral-950 border border-neutral-800 px-2 py-1.5 text-xs outline-none focus:border-neutral-500"
                >
                  <option value="completed">Completed</option>
                  <option value="in_progress">In Progress</option>
                  <option value="planned">Planned</option>
                  <option value="dropped">Dropped</option>
                </select>
              </label>

              <div className="flex flex-wrap items-center justify-start gap-2">
                <button
                  type="button"
                  onClick={() => onUpdate({ favorite: !item.favorite })}
                  className={[
                    "text-xs px-2.5 py-1.5 rounded-lg border hover:bg-white/10",
                    item.favorite ? "bg-amber-400/15 border-amber-400/25" : "bg-white/5 border-white/10",
                  ].join(" ")}
                  title={item.favorite ? "Remove favorite" : "Mark favorite"}
                  aria-pressed={!!item.favorite}
                >
                  {item.favorite ? "★" : "☆"}
                </button>
                <button
                  type="button"
                  onClick={() => onUpdate({ isPrivate: !item.isPrivate })}
                  className={[
                    "text-xs px-2.5 py-1.5 rounded-lg border hover:bg-white/10",
                    item.isPrivate ? "bg-sky-400/15 border-sky-400/25" : "bg-white/5 border-white/10",
                  ].join(" ")}
                  title={item.isPrivate ? "Make visible to friends later" : "Mark private"}
                  aria-pressed={!!item.isPrivate}
                >
                  {item.isPrivate ? "Private" : "Public"}
                </button>
                <button
                  type="button"
                  onClick={onDelete}
                  className="text-xs px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20 hover:bg-red-500/20"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );

}


/* ================= FRIEND READ-ONLY PROFILE VIEW ================= */

function readOnlyProgressLabel(item: MediaItem) {
  if (item.type === "game") {
    return typeof item.hoursPlayed === "number" ? `${item.hoursPlayed.toFixed(1)}h` : "—";
  }

  const movieProg = getMovieProgressDefaults(item);
  const cur =
    item.type === "movie"
      ? movieProg.cur
      : typeof item.progressCurOverride === "number"
      ? item.progressCurOverride
      : item.progressCur;

  const total =
    item.type === "movie"
      ? movieProg.total
      : typeof item.progressTotalOverride === "number"
      ? item.progressTotalOverride
      : item.progressTotal;

  if (typeof cur === "number" || typeof total === "number") {
    return typeof total === "number" ? `${cur ?? 0} / ${total}` : `${cur ?? 0}`;
  }

  return "—";
}

function MediaItemDetailModal({
  item,
  ratingFormat,
  privacy = profilePrivacyFromSettings(),
  friendsById,
  onClose,
  onUpdate,
  onDelete,
}: {
  item: MediaItem;
  ratingFormat: RatingFormat;
  privacy?: ProfilePrivacyOptions;
  friendsById?: Map<string, string>;
  onClose: () => void;
  onUpdate?: (patch: Partial<MediaItem>) => void;
  onDelete?: () => void;
}) {
  const displayPoster = item.posterOverrideUrl || item.posterUrl;
  const withFriends = (item.withFriendIds ?? [])
    .map((id) => friendsById?.get(id) ?? id)
    .filter(Boolean);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-end sm:place-items-center bg-black/70 p-0 sm:p-4"
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-3xl max-h-[92dvh] sm:max-h-[86vh] rounded-t-3xl sm:rounded-2xl bg-neutral-950 border border-neutral-800 shadow-2xl overflow-hidden flex flex-col"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-neutral-800">
          <div className="min-w-0">
            <div className="text-sm text-neutral-200 font-medium truncate">{item.title}</div>
            <div className="text-[11px] text-neutral-500">
              {TYPE_LABEL[item.type]} • {item.status.replace("_", " ")}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-xs px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10"
          >
            Close
          </button>
        </div>

        <div className="p-4 grid grid-cols-1 sm:grid-cols-[140px_minmax(0,1fr)] gap-4 overflow-y-auto stack-mobile-scroll-panel">
          <div className="w-32 sm:w-full max-w-[160px] mx-auto sm:mx-0 aspect-[2/3] rounded-2xl overflow-hidden bg-neutral-900 border border-neutral-800">
            {displayPoster ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={displayPoster} alt={item.title} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full grid place-items-center text-xs text-neutral-600">No cover</div>
            )}
          </div>

          <div className="min-w-0 space-y-3">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
              <MiniStat label="Status" value={item.status.replace("_", " ")} />
              <MiniStat label="Type" value={TYPE_LABEL[item.type]} />
              <MiniStat label={item.type === "game" ? "Hours" : "Progress"} value={readOnlyProgressLabel(item)} />
              <MiniStat label="Rating" value={privacy.showRatings ? formatRatingValue(item.rating, ratingFormat) : "Hidden"} />
            </div>

            <div className="rounded-2xl bg-neutral-900/40 border border-white/10 px-3 py-3 text-sm text-neutral-300">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-neutral-400">
                <div>Date watched: <span className="text-neutral-200">{item.dateFinished || "—"}</span></div>
                <div>Updated: <span className="text-neutral-200">{safeDateLabel(item.updatedAt ?? item.createdAt)}</span></div>
                <div>Rewatch count: <span className="text-neutral-200">{Number(item.rewatchCount ?? 0) || 0}</span></div>
                <div>Visibility: <span className="text-neutral-200">{item.isPrivate ? "Private" : "Public"}</span></div>
              </div>
            </div>

            {privacy.showNotes ? (
              <div className="rounded-2xl bg-neutral-900/40 border border-white/10 px-3 py-3">
                <div className="text-xs text-neutral-500 mb-1">Notes</div>
                <div className="text-sm text-neutral-200 whitespace-pre-wrap leading-relaxed">{item.notes || "No notes yet."}</div>
              </div>
            ) : null}

            {privacy.showTags ? (
              <div className="rounded-2xl bg-neutral-900/40 border border-white/10 px-3 py-3">
                <div className="text-xs text-neutral-500 mb-2">Tags</div>
                {item.tags?.length ? (
                  <div className="flex flex-wrap gap-2">
                    {item.tags.map((tag) => (
                      <span key={tag} className="px-2 py-1 rounded-lg bg-white/5 border border-white/10 text-xs text-neutral-200">
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="text-sm text-neutral-500">No tags yet.</div>
                )}
              </div>
            ) : null}

            {withFriends.length ? (
              <div className="text-xs text-neutral-500">With: {withFriends.join(" • ")}</div>
            ) : null}

            {onUpdate || onDelete ? (
              <div className="sticky bottom-0 flex flex-wrap gap-2 pt-3 pb-1 border-t border-white/10 bg-neutral-950/95 backdrop-blur">
                {onUpdate ? (
                  <>
                    <button
                      type="button"
                      onClick={() => onUpdate({ favorite: !item.favorite })}
                      className="text-xs px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10"
                    >
                      {item.favorite ? "Remove favorite" : "Favorite"}
                    </button>
                    <button
                      type="button"
                      onClick={() => onUpdate({ isPrivate: !item.isPrivate })}
                      className="text-xs px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10"
                    >
                      {item.isPrivate ? "Make public" : "Make private"}
                    </button>
                    <button
                      type="button"
                      onClick={() => onUpdate({ status: "completed" })}
                      className="text-xs px-3 py-2 rounded-xl stack-good hover:opacity-95"
                    >
                      Mark completed
                    </button>
                  </>
                ) : null}
                {onDelete ? (
                  <button
                    type="button"
                    onClick={() => {
                      onDelete();
                      onClose();
                    }}
                    className="text-xs px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20 hover:bg-red-500/20"
                  >
                    Delete
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function FriendReadOnlyBoardView({
  items,
  ratingFormat,
  privacy = profilePrivacyFromSettings(),
}: {
  items: MediaItem[];
  ratingFormat: RatingFormat;
  privacy?: ProfilePrivacyOptions;
}) {
  const byStatus = useMemo(() => {
    const map: Record<Status, MediaItem[]> = { completed: [], in_progress: [], planned: [], dropped: [] };
    for (const item of items) map[item.status].push(item);
    return map;
  }, [items]);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 2xl:grid-cols-4 gap-6">
      {STATUSES.map((status) => (
        <section
          key={status.id}
          className="rounded-2xl ring-1 ring-neutral-800/80 bg-neutral-900/40 shadow-sm p-5 min-h-[240px]"
        >
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="text-sm font-medium text-neutral-200">{status.label}</div>
            <div className="text-xs text-neutral-500">{byStatus[status.id].length}</div>
          </div>

          <div className="space-y-3">
            {byStatus[status.id].map((item) => (
              <FriendReadOnlyCard key={item.id} item={item} ratingFormat={ratingFormat} privacy={privacy} />
            ))}
            {!byStatus[status.id].length ? (
              <div className="text-xs text-neutral-600 text-center py-8">No visible items</div>
            ) : null}
          </div>
        </section>
      ))}
    </div>
  );
}

function FriendReadOnlyCard({
  item,
  ratingFormat,
  privacy = profilePrivacyFromSettings(),
}: {
  item: MediaItem;
  ratingFormat: RatingFormat;
  privacy?: ProfilePrivacyOptions;
}) {
  const [showDetail, setShowDetail] = React.useState(false);
  const displayPoster = item.posterOverrideUrl || item.posterUrl;

  return (
    <>
      {showDetail ? (
        <MediaItemDetailModal
          item={item}
          ratingFormat={ratingFormat}
          privacy={privacy}
          onClose={() => setShowDetail(false)}
        />
      ) : null}

      <div className="rounded-2xl bg-neutral-950/74 border border-neutral-800 shadow-sm overflow-hidden">
        <div className="flex items-center justify-between gap-2 px-3 py-2 bg-neutral-950 border-b border-neutral-800">
          <div className="text-xs text-neutral-500 capitalize">{item.status.replace("_", " ")}</div>
          <div className="text-xs text-neutral-400">{TYPE_LABEL[item.type]}</div>
        </div>

        <div className="p-4 flex gap-4">
          <div className="shrink-0">
            <button
              type="button"
              onClick={() => setShowDetail(true)}
              className="w-16 h-20 rounded-xl overflow-hidden bg-neutral-900 border border-neutral-800 block"
            >
              {displayPoster ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={displayPoster} alt={item.title} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full grid place-items-center text-[10px] text-neutral-600">—</div>
              )}
            </button>
          </div>

          <div className="min-w-0 flex-1">
            <button
              type="button"
              onClick={() => setShowDetail(true)}
              className="font-semibold text-base text-neutral-200 truncate text-left hover:text-neutral-50 max-w-full"
            >
              {item.title}
            </button>
            <div className="text-[11px] text-neutral-500 mt-1">
              {item.type === "game" ? "Hours" : "Progress"}: {readOnlyProgressLabel(item)}
            </div>
            {privacy.showRatings ? (
              <div className="text-[11px] text-neutral-500 mt-1">Score: {formatRatingValue(item.rating, ratingFormat)}</div>
            ) : null}
            {privacy.showNotes && item.notes ? (
              <div className="text-[11px] text-neutral-400 mt-1 line-clamp-2">{item.notes}</div>
            ) : null}
            {privacy.showTags && item.tags?.length ? (
              <div className="text-[11px] text-neutral-500 mt-1 line-clamp-1">{item.tags.join(" • ")}</div>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
              {item.favorite ? (
                <span className="px-2 py-1 rounded-lg bg-amber-400/10 border border-amber-400/20 text-neutral-200">Favorite</span>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function FriendReadOnlyRow({
  item,
  ratingFormat,
  privacy = profilePrivacyFromSettings(),
}: {
  item: MediaItem;
  ratingFormat: RatingFormat;
  privacy?: ProfilePrivacyOptions;
}) {
  const [showFullNote, setShowFullNote] = React.useState(false);
  const [showDetail, setShowDetail] = React.useState(false);
  const displayPoster = item.posterOverrideUrl || item.posterUrl;
  const visibleNote = privacy.showNotes ? item.notes : undefined;
  const hasLongNote = !!visibleNote && visibleNote.length > 120;

  return (
    <>
      {showDetail ? (
        <MediaItemDetailModal
          item={item}
          ratingFormat={ratingFormat}
          privacy={privacy}
          onClose={() => setShowDetail(false)}
        />
      ) : null}

      {showFullNote ? (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"
          onMouseDown={() => setShowFullNote(false)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="w-full max-w-2xl rounded-2xl bg-neutral-950 border border-neutral-800 shadow-2xl overflow-hidden"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-neutral-800">
              <div className="text-sm text-neutral-200 font-medium truncate">{item.title}</div>
              <button
                type="button"
                onClick={() => setShowFullNote(false)}
                className="text-xs px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10"
              >
                Close
              </button>
            </div>
            <div className="p-4">
              <div className="text-xs text-neutral-500 mb-2">Full note</div>
              <div className="text-sm text-neutral-200 whitespace-pre-wrap leading-relaxed">{visibleNote || "—"}</div>
            </div>
          </div>
        </div>
      ) : null}

      <div className="stack-mobile-item-card rounded-2xl bg-neutral-950/72 ring-1 ring-neutral-800/80 overflow-hidden">
        <div className="grid grid-cols-1 sm:grid-cols-[72px_minmax(0,1fr)_minmax(72px,12%)_minmax(72px,12%)_minmax(120px,18%)] gap-3 p-3 items-center">
          <button
            type="button"
            onClick={() => setShowDetail(true)}
            className="w-[72px] h-[96px] rounded-xl overflow-hidden bg-neutral-950 border border-neutral-800 block"
          >
            {displayPoster ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={displayPoster} alt={item.title} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full grid place-items-center text-[10px] text-neutral-600">No cover</div>
            )}
          </button>

          <div className="min-w-0">
            <button type="button" onClick={() => setShowDetail(true)} className="font-semibold truncate text-left hover:text-neutral-50 max-w-full">
              {item.title}
            </button>
            <div className="text-xs text-neutral-400 mt-1 flex flex-wrap items-center gap-2">
              <span className="capitalize">{item.status.replace("_", " ")}</span>
              {item.dateFinished ? (
                <>
                  <span className="text-neutral-600">•</span>
                  <span className="text-neutral-500">{item.dateFinished}</span>
                </>
              ) : null}
              {(Number(item.rewatchCount ?? 0) || 0) > 0 ? (
                <>
                  <span className="text-neutral-600">•</span>
                  <span className="text-neutral-300">Rewatch x{Number(item.rewatchCount ?? 0) || 0}</span>
                </>
              ) : null}
            </div>

            {visibleNote ? (
              <div className="mt-2">
                <div className="text-xs text-neutral-300 line-clamp-2">{visibleNote}</div>
                {hasLongNote ? (
                  <button
                    type="button"
                    onClick={() => setShowFullNote(true)}
                    className="mt-1 text-[11px] px-2 py-1 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 text-neutral-200"
                  >
                    Read full note
                  </button>
                ) : null}
              </div>
            ) : null}

            {privacy.showTags && item.tags?.length ? (
              <div className="text-[11px] text-neutral-500 mt-1 truncate">{item.tags.join(" • ")}</div>
            ) : null}

            <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
              {item.favorite ? (
                <span className="px-2 py-1 rounded-lg bg-amber-400/10 border border-amber-400/20 text-neutral-200">Favorite</span>
              ) : null}
            </div>
          </div>

          <div className="text-center text-sm text-neutral-300 tabular-nums">
            {privacy.showRatings ? formatRatingValue(item.rating, ratingFormat) : "Hidden"}
          </div>
          <div className="text-center text-sm text-neutral-300">{TYPE_LABEL[item.type]}</div>
          <div className="text-center text-sm text-neutral-200 tabular-nums whitespace-nowrap">{readOnlyProgressLabel(item)}</div>
        </div>
      </div>
    </>
  );
}

/* ================= SMALL UI COMPONENTS ================= */

function Panel({
  title,
  right,
  className,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={[
        "stack-surface p-4 sm:p-6 rounded-3xl border border-white/10 shadow-xl shadow-black/10 backdrop-blur-xl mx-auto w-full",
        className || "",
      ].join(" ")}
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4 text-center sm:text-left">
        <div className="text-sm font-medium text-neutral-200">{title}</div>
        {right ? <div className="shrink-0">{right}</div> : null}
      </div>
      {children}
    </div>
  );
}

function EmptyState({ title, message }: { title: string; message: string }) {
  return (
    <div className="rounded-3xl bg-neutral-950/55 border border-white/10 px-5 py-8 text-center shadow-sm">
      <div className="text-sm font-medium text-neutral-200">{title}</div>
      <div className="text-xs text-neutral-500 mt-2 max-w-md mx-auto">{message}</div>
    </div>
  );
}

function MiniStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 text-center">
      <div className="text-[11px] text-neutral-500">{label}</div>
      <div className="text-sm text-neutral-200 mt-1 truncate">{value}</div>
      {sub ? <div className="text-[11px] text-neutral-600 mt-1">{sub}</div> : null}
    </div>
  );
}


function StatCard({ title, value, sub }: { title: string; value: string; sub?: string }) {
  return (
    <div className="bg-neutral-950/72 p-4 rounded-2xl ring-1 ring-neutral-800/80 shadow-sm text-center">
      <div className="text-xs text-neutral-400">{title}</div>
      <div className="text-2xl font-semibold tracking-tight mt-1">{value}</div>
      {sub ? <div className="text-[11px] text-neutral-500 mt-1">{sub}</div> : null}
    </div>
  );
}

function BarRow({ label, value, total }: { label: string; value: number; total: number }) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <div className="text-neutral-300">{label}</div>
        <div className="text-neutral-400 tabular-nums">
          {value} <span className="text-neutral-600">({pct}%)</span>
        </div>
      </div>
      <div className="h-2 rounded-full bg-white/5 border border-white/10 overflow-hidden">
        <div className="h-full bg-white/15" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/**
 * Simple pie chart (SVG) — colored slices.
 */
function PieChartSimple({ data }: { data: Array<{ label: string; value: number }> }) {
  const total = Math.max(1, data.reduce((a, b) => a + (b.value || 0), 0));
  let acc = 0;

  const r = 38;
  const cx = 45;
  const cy = 45;

  const COLORS = PIE_COLORS;

  const slices = data.map((d, idx) => {
    const v = Math.max(0, d.value || 0);
    const start = (acc / total) * Math.PI * 2;
    acc += v;
    const end = (acc / total) * Math.PI * 2;

    const x1 = cx + r * Math.cos(start);
    const y1 = cy + r * Math.sin(start);
    const x2 = cx + r * Math.cos(end);
    const y2 = cy + r * Math.sin(end);

    const largeArc = end - start > Math.PI ? 1 : 0;

    const path = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`;
    const fill = COLORS[idx % COLORS.length];

    return <path key={d.label} d={path} fill={fill} fillOpacity={0.9} stroke="white" strokeOpacity={0.08} />;
  });

  return (
    <div className="shrink-0 mx-auto sm:mx-0">
      <svg width={90} height={90} viewBox="0 0 90 90" className="block">
        <circle cx={cx} cy={cy} r={r} fill="transparent" stroke="white" strokeOpacity={0.08} />
        {slices}
      </svg>
    </div>
  );
}


function Select({
  label,
  value,
  onChange,
  options,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="block">
      {label ? <div className="text-xs text-neutral-400 mb-1">{label}</div> : null}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-[42px] rounded-xl bg-neutral-950 border border-neutral-800 px-3 text-base sm:text-sm outline-none focus:border-neutral-500"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={[
        "w-full sm:w-auto px-3 py-2 rounded-xl border text-sm transition text-left",
        checked ? "bg-emerald-500/15 border-emerald-500/20" : "bg-white/5 border-white/10 hover:bg-white/10",
      ].join(" ")}
      aria-pressed={checked}
    >
      <span className="text-neutral-200">{label}</span>
      <span className="ml-2 text-xs text-neutral-500">{checked ? "On" : "Off"}</span>
    </button>
  );
}

function Text({
  label,
  value,
  onChange,
  helper,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  helper?: string;
  type?: React.HTMLInputTypeAttribute;
}) {
  return (
    <label className="block">
      <div className="text-xs text-neutral-400 mb-1">{label}</div>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 text-base sm:text-sm outline-none focus:border-neutral-500"
      />
      {helper ? <div className="text-[11px] text-neutral-500 mt-1">{helper}</div> : null}
    </label>
  );
}

function TextArea({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <div className="text-xs text-neutral-400 mb-1">{label}</div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={4}
        className="w-full rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 text-base sm:text-sm outline-none focus:border-neutral-500 resize-none"
      />
    </label>
  );
}

function TextNumberInput({
  label,
  value,
  onChange,
  placeholder,
  pattern,
  helper,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  pattern: RegExp;
  helper?: string;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <div className="text-xs text-neutral-400 mb-1">{label}</div>
      <input
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "" || pattern.test(v)) onChange(v);
        }}
        placeholder={placeholder}
        disabled={disabled}
        className={[
          "w-full rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 text-base sm:text-sm outline-none focus:border-neutral-500",
          disabled ? "opacity-50 cursor-not-allowed" : "",
        ].join(" ")}
      />
      {helper ? <div className="text-[11px] text-neutral-500 mt-1">{helper}</div> : null}
    </label>
  );
}

function TagEditor({
  autoTags,
  manualTags,
  onChangeManual,
  helper,
}: {
  autoTags: string[];
  manualTags: string[];
  onChangeManual: (tags: string[]) => void;
  helper?: string;
}) {
  const [text, setText] = useState("");

  const add = () => {
    const parts = text
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

    if (!parts.length) return;

    const next = uniqTags([...(manualTags ?? []), ...parts]);
    onChangeManual(next);
    setText("");
  };

  const remove = (t: string) => {
    const next = (manualTags ?? []).filter((x) => x.toLowerCase() !== t.toLowerCase());
    onChangeManual(next);
  };

  return (
    <div className="space-y-2">
      <div className="text-xs text-neutral-400">Tags</div>

      <div className="flex flex-wrap gap-2">
        {(autoTags ?? []).map((t) => (
          <span
            key={`a:${t}`}
            className="px-3 py-1 rounded-xl bg-white/5 border border-white/10 text-xs text-neutral-200"
            title="Auto-filled"
          >
            {t}
          </span>
        ))}

        {(manualTags ?? []).map((t) => (
          <button
            key={`m:${t}`}
            type="button"
            onClick={() => remove(t)}
            className="px-3 py-1 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-xs text-neutral-200 hover:bg-emerald-500/15"
            title="Click to remove"
          >
            {t} <span className="text-neutral-400">×</span>
          </button>
        ))}

        {!autoTags?.length && !manualTags?.length ? <div className="text-xs text-neutral-600">No tags yet.</div> : null}
      </div>

      <div className="flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="Add tags (comma separated)"
          className="flex-1 rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 text-sm outline-none focus:border-neutral-500"
        />
        <button
          type="button"
          onClick={add}
          className="px-3 py-2 rounded-xl bg-white/10 border border-white/10 hover:bg-white/15"
        >
          Add
        </button>
      </div>

      {helper ? <div className="text-[11px] text-neutral-500">{helper}</div> : null}
    </div>
  );
}