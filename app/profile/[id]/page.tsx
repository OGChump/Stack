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

type MediaItem = {
  id?: string;
  title?: string | null;

  // your app has evolved, so support both
  category?: string | null;
  status?: string | null;

  rating?: number | null;

  // optional fields your app may store
  type?: string | null;
  created_at?: string | null;
};

type MediaItemsRow = {
  data: unknown;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function safeParseItems(data: unknown): MediaItem[] {
  // Expecting: { items: [...] }
  if (!isRecord(data)) return [];
  const items = data.items;

  if (!Array.isArray(items)) return [];

  // Only keep object-ish entries
  return items
    .filter(isRecord)
    .map((x) => ({
      id: typeof x.id === "string" ? x.id : undefined,
      title: typeof x.title === "string" ? x.title : null,
      category: typeof x.category === "string" ? x.category : null,
      status: typeof x.status === "string" ? x.status : null,
      rating: typeof x.rating === "number" ? x.rating : null,
      type: typeof x.type === "string" ? x.type : null,
      created_at: typeof x.created_at === "string" ? x.created_at : null,
    }));
}

export default function ProfilePage() {
  const params = useParams();
  const id = params?.id as string | undefined;

  const [profile, setProfile] = useState<Profile | null>(null);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [errorMsg, setErrorMsg] = useState<string>("");

  const sortedMedia = useMemo(() => {
    // If created_at exists, sort newest first; otherwise keep stable order
    return [...media].sort((a, b) => {
      const ad = a.created_at ? Date.parse(a.created_at) : 0;
      const bd = b.created_at ? Date.parse(b.created_at) : 0;
      return bd - ad;
    });
  }, [media]);

  useEffect(() => {
    if (!id) return;

    async function load() {
      setErrorMsg("");

      const { data: prof, error: profErr } = await supabase
        .from("profiles")
        .select("id, username, display_name")
        .eq("id", id)
        .maybeSingle();

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

      // ✅ Correct: media_items is ONE ROW PER USER, JSON blob in data
      const { data: row, error: itemsErr } = await supabase
        .from("media_items")
        .select("data")
        .eq("user_id", id)
        .maybeSingle();

      if (itemsErr) {
        console.error("media_items fetch error:", itemsErr);
        setErrorMsg(itemsErr.message);
        return;
      }

      const parsed = safeParseItems((row as MediaItemsRow | null)?.data);
      setMedia(parsed);
    }

    load();
  }, [id]);

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        <Link href="/friends" className="text-sm text-neutral-400 hover:text-white">
          ← Back to Friends
        </Link>

        {errorMsg && (
          <div className="border border-red-900 bg-red-950/30 p-3 rounded-md text-sm text-red-200">
            {errorMsg}
          </div>
        )}

        {profile && (
          <>
            <h1 className="text-3xl font-semibold">
              {profile.display_name || profile.username || profile.id}
            </h1>

            <div className="space-y-2">
              <h2 className="text-lg font-medium">Media</h2>

              {sortedMedia.length === 0 ? (
                <div className="text-neutral-500 text-sm">No media yet</div>
              ) : (
                sortedMedia.map((m, idx) => {
                  const label =
                    m.status ||
                    m.category ||
                    (m.type ? m.type : null) ||
                    "—";

                  return (
                    <div
                      key={m.id ?? `${idx}`}
                      className="border border-neutral-800 p-3 rounded-md"
                    >
                      <div className="font-medium">{m.title || "(untitled)"}</div>
                      <div className="text-xs text-neutral-500">
                        {label}
                        {typeof m.rating === "number" ? ` • Rating: ${m.rating}` : ""}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
