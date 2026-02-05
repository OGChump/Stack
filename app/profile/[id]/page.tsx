"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

type Profile = {
  id: string;
  username: string | null;
  display_name: string | null;
};

type StackItem = {
  id: string;
  title: string;

  // status/category
  category?: string | null; // "completed" | "in_progress" | "planned" | "dropped" | ...
  type?: string | null; // "movie" | "tv" | "anime" | ...

  rating?: number | null; // score
  created_at?: string | null;

  // extras to match your main cards
  note?: string | null;

  posterUrl?: string | null; // full URL
  posterPath?: string | null; // TMDB-style path (needs base URL)

  progress?: number | null;
  progressTotal?: number | null;

  totalHours?: number | null;

  genres?: string[] | null;
};

type MediaItemsRow = {
  data: unknown;
};

const CATEGORY_ORDER = ["in_progress", "planned", "completed", "dropped"];
const CATEGORY_LABEL: Record<string, string> = {
  in_progress: "In Progress",
  planned: "Planned",
  completed: "Completed",
  dropped: "Dropped",
};

function getInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const first = parts[0]?.[0] ?? "?";
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
  return (first + last).toUpperCase();
}

function safeString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function safeNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function safeStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.filter((x) => typeof x === "string") as string[];
  return out.length ? out : null;
}

function parseItemsFromData(data: unknown): StackItem[] {
  // Expecting: { items: [...] }
  if (!data || typeof data !== "object") return [];
  const itemsUnknown = (data as Record<string, unknown>)["items"];
  if (!Array.isArray(itemsUnknown)) return [];

  const out: StackItem[] = [];

  for (const raw of itemsUnknown) {
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;

    const id = safeString(obj["id"]) ?? crypto.randomUUID();
    const title = safeString(obj["title"]) ?? "(untitled)";

    // category/status fallbacks
    const category =
      safeString(obj["category"]) ??
      safeString(obj["status"]) ??
      safeString(obj["state"]) ??
      null;

    // type fallbacks
    const type =
      safeString(obj["type"]) ??
      safeString(obj["mediaType"]) ??
      safeString(obj["kind"]) ??
      null;

    // rating/score fallbacks
    const rating =
      safeNumber(obj["rating"]) ??
      safeNumber(obj["score"]) ??
      safeNumber(obj["stars"]) ??
      null;

    // created_at fallbacks
    const created_at =
      safeString(obj["created_at"]) ??
      safeString(obj["createdAt"]) ??
      safeString(obj["date"]) ??
      null;

    // notes fallbacks
    const note =
      safeString(obj["note"]) ??
      safeString(obj["notes"]) ??
      safeString(obj["review"]) ??
      null;

    // poster fallbacks
    const posterUrl =
      safeString(obj["posterUrl"]) ??
      safeString(obj["poster_url"]) ??
      safeString(obj["imageUrl"]) ??
      safeString(obj["image_url"]) ??
      safeString(obj["coverUrl"]) ??
      safeString(obj["cover_url"]) ??
      null;

    const posterPath =
      safeString(obj["posterPath"]) ??
      safeString(obj["poster_path"]) ??
      safeString(obj["tmdbPosterPath"]) ??
      null;

    // progress fallbacks
    const progress =
      safeNumber(obj["progress"]) ??
      safeNumber(obj["current"]) ??
      safeNumber(obj["currentProgress"]) ??
      null;

    const progressTotal =
      safeNumber(obj["progressTotal"]) ??
      safeNumber(obj["total"]) ??
      safeNumber(obj["totalProgress"]) ??
      null;

    const totalHours =
      safeNumber(obj["totalHours"]) ??
      safeNumber(obj["hours"]) ??
      safeNumber(obj["time"]) ??
      null;

    const genres =
      safeStringArray(obj["genres"]) ??
      (safeString(obj["genres"])
        ? safeString(obj["genres"])!
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : null);

    out.push({
      id,
      title,
      category,
      type,
      rating,
      created_at,
      note,
      posterUrl,
      posterPath,
      progress,
      progressTotal,
      totalHours,
      genres,
    });
  }

  return out;
}

function formatCategory(cat: string | null | undefined) {
  if (!cat) return "Uncategorized";
  return CATEGORY_LABEL[cat] ?? cat;
}

function sortByTitle(a: StackItem, b: StackItem) {
  return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
}

function formatDateShort(iso: string | null | undefined) {
  if (!iso) return null;
  // safe: often stored like "2026-02-05..." or "2026-02-05"
  return iso.slice(0, 10);
}

function getPosterUrl(m: StackItem) {
  if (m.posterUrl) return m.posterUrl;
  if (m.posterPath) return `https://image.tmdb.org/t/p/w342${m.posterPath}`;
  return null;
}

function previewNote(note: string | null | undefined, max = 140) {
  const t = (note ?? "").trim();
  if (!t) return "";
  return t.length > max ? t.slice(0, max) + "…" : t;
}

export default function ProfilePage() {
  const params = useParams();
  const id = (params?.id as string | undefined) ?? undefined;

  const [profile, setProfile] = useState<Profile | null>(null);
  const [items, setItems] = useState<StackItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string>("");

  // UI state
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");

  // simple note modal
  const [openNote, setOpenNote] = useState<{ title: string; note: string } | null>(
    null
  );

  useEffect(() => {
    if (!id) return;

    let cancelled = false;

    async function load() {
      setLoading(true);
      setErrorMsg("");

      // 1) Profile header
      const { data: prof, error: profErr } = await supabase
        .from("profiles")
        .select("id, username, display_name")
        .eq("id", id)
        .maybeSingle();

      if (cancelled) return;

      if (profErr) {
        console.error("profile fetch error:", profErr);
        setErrorMsg(profErr.message);
        setLoading(false);
        return;
      }

      if (!prof) {
        setErrorMsg("Profile not found or not permitted.");
        setLoading(false);
        return;
      }

      setProfile(prof as Profile);

      // 2) Media items (JSON blob row per user)
      const { data: row, error: rowErr } = await supabase
        .from("media_items")
        .select("data")
        .eq("user_id", id)
        .maybeSingle();

      if (cancelled) return;

      if (rowErr) {
        console.error("media_items fetch error:", rowErr);
        setErrorMsg(rowErr.message);
        setItems([]);
        setLoading(false);
        return;
      }

      const parsed = row ? parseItemsFromData((row as MediaItemsRow).data) : [];
      setItems(parsed);
      setLoading(false);
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [id]);

  const displayName = useMemo(() => {
    if (!profile) return "";
    return profile.display_name || profile.username || profile.id;
  }, [profile]);

  const initials = useMemo(() => getInitials(displayName || "User"), [displayName]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();

    return items.filter((it) => {
      const okCat = categoryFilter === "all" ? true : (it.category ?? "") === categoryFilter;
      const okQuery = !q ? true : it.title.toLowerCase().includes(q);
      return okCat && okQuery;
    });
  }, [items, query, categoryFilter]);

  const grouped = useMemo(() => {
    const map = new Map<string, StackItem[]>();

    for (const it of filtered) {
      const key = it.category ?? "uncategorized";
      const arr = map.get(key) ?? [];
      arr.push(it);
      map.set(key, arr);
    }

    // sort each group by title (stable + clean)
    for (const [k, arr] of map) {
      map.set(k, [...arr].sort(sortByTitle));
    }

    // build ordered groups: in_progress, planned, completed, dropped, then the rest
    const keys = Array.from(map.keys());
    const ordered: string[] = [];

    for (const k of CATEGORY_ORDER) if (map.has(k)) ordered.push(k);
    if (map.has("uncategorized")) ordered.push("uncategorized");

    for (const k of keys) {
      if (!ordered.includes(k) && !CATEGORY_ORDER.includes(k) && k !== "uncategorized")
        ordered.push(k);
    }

    return ordered.map((k) => ({ key: k, items: map.get(k) ?? [] }));
  }, [filtered]);

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="mx-auto w-full max-w-6xl px-6 py-6 space-y-6">
        <Link href="/friends" className="text-sm text-neutral-400 hover:text-white">
          ← Back to Friends
        </Link>

        {errorMsg && (
          <div className="rounded-xl border border-red-900 bg-red-950/30 p-3 text-sm text-red-200">
            {errorMsg}
          </div>
        )}

        {/* Header card */}
        <div className="rounded-2xl border border-neutral-800 bg-neutral-950/40 p-5">
          <div className="flex items-center gap-4">
            <div className="h-12 w-12 rounded-full border border-neutral-700 bg-neutral-900 flex items-center justify-center font-semibold">
              {initials}
            </div>

            <div className="min-w-0">
              <div className="text-2xl font-semibold truncate">{displayName || "Profile"}</div>
              <div className="text-xs text-neutral-500 truncate">{profile?.id}</div>
            </div>

            <div className="ml-auto text-sm text-neutral-400">
              {items.length} item{items.length === 1 ? "" : "s"}
            </div>
          </div>

          {/* Controls row */}
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              className="w-full sm:flex-1 rounded-lg bg-neutral-900 border border-neutral-700 px-3 py-2 text-sm outline-none focus:border-neutral-500"
              placeholder="Search titles…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />

            <select
              className="w-full sm:w-56 rounded-lg bg-neutral-900 border border-neutral-700 px-3 py-2 text-sm outline-none focus:border-neutral-500"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
            >
              <option value="all">All statuses</option>
              <option value="in_progress">In Progress</option>
              <option value="planned">Planned</option>
              <option value="completed">Completed</option>
              <option value="dropped">Dropped</option>
            </select>
          </div>
        </div>

        {/* Content */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium">Media</h2>
            {loading ? (
              <div className="text-sm text-neutral-500">Loading…</div>
            ) : (
              <div className="text-sm text-neutral-500">{filtered.length} shown</div>
            )}
          </div>

          {!loading && filtered.length === 0 ? (
            <div className="rounded-2xl border border-neutral-800 bg-neutral-950/40 p-6 text-sm text-neutral-500">
              No media found.
            </div>
          ) : (
            <div className="space-y-8">
              {grouped.map((g) => (
                <div key={g.key} className="space-y-3">
                  {/* Group header */}
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-medium text-neutral-200">
                      {formatCategory(g.key)}
                    </div>
                    <div className="text-xs text-neutral-500">{g.items.length}</div>
                  </div>

                  {/* Column header row (like your screenshot) */}
                  <div className="rounded-full border border-neutral-800 bg-neutral-950/40 px-6 py-3 text-sm text-neutral-300">
                    <div className="grid grid-cols-[1fr_140px_140px_220px] gap-4 items-center">
                      <div className="pl-16">Title</div>
                      <div className="text-center">Score</div>
                      <div className="text-center">Type</div>
                      <div className="text-center">Progress / Hours</div>
                    </div>
                  </div>

                  {/* Cards */}
                  <div className="space-y-3">
                    {g.items.map((m) => {
                      const img = getPosterUrl(m);
                      const date = formatDateShort(m.created_at);
                      const notePrev = previewNote(m.note);

                      const progressText =
                        m.progressTotal != null
                          ? `${m.progress ?? 0} / ${m.progressTotal}`
                          : m.progress != null
                          ? `${m.progress}`
                          : "—";

                      const hoursText = m.totalHours != null ? `${m.totalHours}` : "—";

                      return (
                        <div
                          key={m.id}
                          className="rounded-2xl border border-neutral-800 bg-neutral-950/40 p-6"
                        >
                          <div className="grid grid-cols-[1fr_140px_140px_220px] gap-4 items-center">
                            {/* Left block */}
                            <div className="flex gap-4 min-w-0">
                              <div className="h-20 w-14 rounded-lg border border-neutral-800 bg-neutral-900 overflow-hidden shrink-0">
                                {img ? (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img src={img} alt="" className="h-full w-full object-cover" />
                                ) : (
                                  <div className="h-full w-full flex items-center justify-center text-xs text-neutral-500">
                                    No image
                                  </div>
                                )}
                              </div>

                              <div className="min-w-0 flex-1">
                                <div className="text-xl font-semibold truncate">
                                  {m.title || "(untitled)"}
                                </div>

                                <div className="mt-1 text-sm text-neutral-400">
                                  Status:{" "}
                                  <span className="text-neutral-200">
                                    {formatCategory(m.category)}
                                  </span>
                                  {date ? (
                                    <span className="text-neutral-600"> • {date}</span>
                                  ) : null}
                                </div>

                                {notePrev ? (
                                  <div className="mt-3 text-sm text-neutral-300">
                                    {notePrev}
                                    <div className="mt-2">
                                      <button
                                        onClick={() =>
                                          setOpenNote({
                                            title: m.title || "(untitled)",
                                            note: (m.note ?? "").trim(),
                                          })
                                        }
                                        className="text-sm text-neutral-300 border border-neutral-800 bg-neutral-900/30 rounded-md px-3 py-1.5 hover:bg-neutral-900/50"
                                      >
                                        Read full note
                                      </button>
                                    </div>
                                  </div>
                                ) : null}

                                {m.genres?.length ? (
                                  <div className="mt-3 text-xs text-neutral-500">
                                    {m.genres.join(" • ")}
                                  </div>
                                ) : null}
                              </div>
                            </div>

                            {/* Score */}
                            <div className="text-center text-lg text-neutral-200">
                              {m.rating != null ? m.rating : "—"}
                            </div>

                            {/* Type */}
                            <div className="text-center text-lg text-neutral-200">
                              {m.type ?? "—"}
                            </div>

                            {/* Progress / Hours */}
                            <div className="text-center">
                              <div className="text-lg text-neutral-200">{progressText}</div>
                              <div className="text-xs text-neutral-500 mt-1">Total</div>
                              <div className="text-sm text-neutral-200">{hoursText}</div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Note modal */}
      {openNote && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/70"
            onClick={() => setOpenNote(null)}
          />
          <div className="relative w-full max-w-xl rounded-2xl border border-neutral-800 bg-neutral-950 p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-lg font-semibold truncate">{openNote.title}</div>
                <div className="text-xs text-neutral-500 mt-1">Full note</div>
              </div>
              <button
                onClick={() => setOpenNote(null)}
                className="px-3 py-1.5 rounded-md border border-neutral-800 bg-neutral-900/30 hover:bg-neutral-900/50 text-sm"
              >
                Close
              </button>
            </div>

            <div className="mt-4 whitespace-pre-wrap text-sm text-neutral-200 leading-relaxed">
              {openNote.note || "(No note)"}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
