"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";
import { useParams } from "next/navigation";

type Profile = {
  id: string;
  username: string | null;
  display_name: string | null;
};

type MediaType = "movie" | "tv" | "anime" | "manga" | "book" | "game";
type Status = "completed" | "in_progress" | "planned" | "dropped";

type MediaItem = {
  id: string;
  title: string;
  type: MediaType;
  status: Status;

  rating?: number; // 0-10
  createdAt?: string; // ISO
  dateFinished?: string; // YYYY-MM-DD
  notes?: string;
  tags?: string[];

  posterUrl?: string;
  posterOverrideUrl?: string;

  // optional extras (safe to ignore in UI)
  progressCur?: number;
  progressTotal?: number;
  progressCurOverride?: number;
  progressTotalOverride?: number;
  hoursPlayed?: number;
  rewatchCount?: number;
};

function safeParseItems(raw: unknown): MediaItem[] {
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as any;

  const items = obj?.items;
  if (!Array.isArray(items)) return [];

  // minimal validation to avoid runtime crashes
  return items
    .filter((x: any) => x && typeof x.id === "string" && typeof x.title === "string")
    .map((x: any) => x as MediaItem);
}

export default function ProfilePage() {
  const params = useParams();
  const id = params?.id as string | undefined;

  const [profile, setProfile] = useState<Profile | null>(null);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [errorMsg, setErrorMsg] = useState<string>("");

  useEffect(() => {
    if (!id) return;

    let cancelled = false;

    async function load() {
      setErrorMsg("");
      setProfile(null);
      setMedia([]);

      // 1) Profile info
      const { data: prof, error: profErr } = await supabase
        .from("profiles")
        .select("id, username, display_name")
        .eq("id", id)
        .maybeSingle();

      if (cancelled) return;

      if (profErr) {
        console.error("profile fetch error:", profErr);
        setErrorMsg(profErr.message);
        return;
      }

      if (!prof) {
        setErrorMsg("Profile not found or not permitted.");
        return;
      }

      setProfile(prof as Profile);

      // 2) Media blob for that user (ONE ROW PER USER)
      const { data: row, error: itemsErr } = await supabase
        .from("media_items")
        .select("data")
        .eq("user_id", id)
        .maybeSingle();

      if (cancelled) return;

      if (itemsErr) {
        console.error("media_items fetch error:", itemsErr);
        setErrorMsg(itemsErr.message);
        return;
      }

      const parsed = safeParseItems(row?.data);
      // sort newest first using dateFinished then createdAt (mirrors app behavior)
      parsed.sort((a, b) => {
        const ad = new Date((a.dateFinished ?? a.createdAt ?? "") as string).getTime() || 0;
        const bd = new Date((b.dateFinished ?? b.createdAt ?? "") as string).getTime() || 0;
        return bd - ad;
      });

      setMedia(parsed);
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [id]);

  const title = useMemo(() => {
    if (!profile) return "";
    return profile.display_name || profile.username || profile.id;
  }, [profile]);

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        <Link href="/friends" className="text-sm text-neutral-400 hover:text-white">
          ← Back to Friends
        </Link>

        {errorMsg ? (
          <div className="border border-red-900 bg-red-950/30 p-3 rounded-md text-sm text-red-200">
            {errorMsg}
          </div>
        ) : null}

        {profile ? (
          <>
            <h1 className="text-3xl font-semibold">{title}</h1>

            <div className="space-y-2">
              <h2 className="text-lg font-medium">Media</h2>

              {media.length === 0 ? (
                <div className="text-neutral-500 text-sm">No media yet</div>
              ) : (
                media.map((m) => (
                  <div key={m.id} className="border border-neutral-800 p-3 rounded-md">
                    <div className="font-medium">{m.title || "(untitled)"}</div>

                    <div className="text-xs text-neutral-500">
                      {m.type}
                      {m.status ? ` • ${m.status.replace("_", " ")}` : ""}
                      {typeof m.rating === "number" ? ` • Rating: ${m.rating}` : ""}
                      {m.dateFinished ? ` • ${m.dateFinished}` : m.createdAt ? ` • ${m.createdAt.slice(0, 10)}` : ""}
                    </div>

                    {m.tags?.length ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {m.tags.slice(0, 10).map((t) => (
                          <span
                            key={`${m.id}:${t}`}
                            className="text-[11px] px-2 py-1 rounded-lg bg-white/5 border border-white/10 text-neutral-200"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
