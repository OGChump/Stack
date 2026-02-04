"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";

type Profile = {
  id: string;
  username: string | null;
  display_name: string | null;
};

type FriendRow = { friend_id: string };

type IncomingRequestRow = {
  id: string;
  requester_id: string;
};

type IncomingRequest = {
  id: string;
  requester_id: string;
  user?: Profile;
};

function displayLabel(p: Profile | undefined | null) {
  if (!p) return "";
  return p.display_name || p.username || p.id;
}

function initialsFromProfile(p: Profile | undefined | null) {
  const label = (p?.display_name || p?.username || "").trim();
  if (!label) return "U";
  const parts = label.split(/\s+/).filter(Boolean);
  const a = parts[0]?.[0] ?? "U";
  const b = parts.length > 1 ? parts[1]?.[0] ?? "" : "";
  return (a + b).toUpperCase();
}

function formatHandle(p: Profile) {
  if (!p.username) return null;
  return `@${p.username}`;
}

export default function FriendsPage() {
  const [me, setMe] = useState<string | null>(null);

  const [friends, setFriends] = useState<Profile[]>([]);
  const [incoming, setIncoming] = useState<IncomingRequest[]>([]);

  const [inviteUsername, setInviteUsername] = useState("");
  const [inviteStatus, setInviteStatus] = useState("");

  const [pageLoading, setPageLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sendingInvite, setSendingInvite] = useState(false);
  const [actingRequestId, setActingRequestId] = useState<string | null>(null);

  // Keep session/user in sync
  useEffect(() => {
    let mounted = true;

    (async () => {
      const { data, error } = await supabase.auth.getUser();
      if (!mounted) return;

      if (error) {
        console.error("auth.getUser error:", error);
        setMe(null);
        setPageLoading(false);
        return;
      }

      setMe(data.user?.id ?? null);
      setPageLoading(false);
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setMe(session?.user?.id ?? null);
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!me) return;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);

  const sortedFriends = useMemo(() => {
    const copy = [...friends];
    copy.sort((a, b) => {
      const A = (a.display_name || a.username || a.id).toLowerCase();
      const B = (b.display_name || b.username || b.id).toLowerCase();
      return A.localeCompare(B);
    });
    return copy;
  }, [friends]);

  async function refresh() {
    if (!me) return;

    setInviteStatus("");
    setRefreshing(true);

    try {
      // 1) Friends list (directional rows where user_id = me)
      const { data: friendRows, error: friendsErr } = await supabase
        .from("friends")
        .select("friend_id")
        .eq("user_id", me);

      if (friendsErr) {
        console.error("friends select error:", friendsErr);
      }

      const ids = (friendRows ?? [])
        .map((r) => (r as FriendRow).friend_id)
        .filter((x): x is string => Boolean(x));

      if (!ids.length) {
        setFriends([]);
      } else {
        const { data: profs, error: profErr } = await supabase
          .from("profiles")
          .select("id, username, display_name")
          .in("id", ids);

        if (profErr) console.error("profiles (friends) select error:", profErr);
        setFriends((profs ?? []) as Profile[]);
      }

      // 2) Incoming friend requests (pending where requested_id = me)
      const { data: reqs, error: reqErr } = await supabase
        .from("friend_requests")
        .select("id, requester_id")
        .eq("requested_id", me)
        .eq("status", "pending");

      if (reqErr) console.error("friend_requests select error:", reqErr);

      if (!reqs?.length) {
        setIncoming([]);
        return;
      }

      const requesterIds = (reqs as IncomingRequestRow[]).map((r) => r.requester_id);

      const { data: reqProfiles, error: reqProfErr } = await supabase
        .from("profiles")
        .select("id, username, display_name")
        .in("id", requesterIds);

      if (reqProfErr) console.error("profiles (incoming) select error:", reqProfErr);

      const map = new Map<string, Profile>(
        (reqProfiles ?? []).map((p) => [p.id, p as Profile])
      );

      setIncoming(
        (reqs as IncomingRequestRow[]).map((r) => ({
          id: r.id,
          requester_id: r.requester_id,
          user: map.get(r.requester_id),
        }))
      );
    } finally {
      setRefreshing(false);
    }
  }

  async function sendInvite() {
    if (sendingInvite) return;

    setInviteStatus("");

    const username = inviteUsername.trim().toLowerCase();
    if (!username) {
      setInviteStatus("Enter a username.");
      return;
    }

    if (!me) {
      setInviteStatus("Not logged in.");
      return;
    }

    setSendingInvite(true);
    try {
      // Find target user by username
      const { data: target, error: findErr } = await supabase
        .from("profiles")
        .select("id")
        .eq("username", username)
        .maybeSingle();

      if (findErr) {
        console.error("find user error:", findErr);
        setInviteStatus(findErr.message || "Error finding user.");
        return;
      }

      if (!target?.id) {
        setInviteStatus("User not found.");
        return;
      }

      if (target.id === me) {
        setInviteStatus("You can’t friend yourself.");
        return;
      }

      // Optional: check if a pending request exists either direction
      const { data: existing, error: existsErr } = await supabase
        .from("friend_requests")
        .select("id")
        .or(
          `and(requester_id.eq.${me},requested_id.eq.${target.id},status.eq.pending),and(requester_id.eq.${target.id},requested_id.eq.${me},status.eq.pending)`
        )
        .limit(1);

      if (!existsErr && existing && existing.length > 0) {
        setInviteStatus("A pending request already exists between you two.");
        return;
      }

      // Insert request (status defaults to 'pending')
      const { error: insErr } = await supabase.from("friend_requests").insert({
        requester_id: me,
        requested_id: target.id,
      });

      if (insErr) {
        console.error("insert friend_request error:", insErr);
        const msg = insErr.message || "";
        if (msg.toLowerCase().includes("duplicate key value")) {
          setInviteStatus("A pending request already exists. Ask them to accept it.");
        } else {
          setInviteStatus(msg || "Failed to send invite.");
        }
        return;
      }

      setInviteUsername("");
      setInviteStatus("Invite sent.");
      await refresh();
    } finally {
      setSendingInvite(false);
    }
  }

  async function acceptRequest(requestId: string) {
    if (actingRequestId) return;

    setInviteStatus("");
    setActingRequestId(requestId);

    try {
      // MUST use RPC so it inserts into friends table (both directions)
      const { error } = await supabase.rpc("accept_friend_request", {
        p_request_id: requestId,
      });

      if (error) {
        console.error("accept_friend_request RPC error:", error);
        setInviteStatus(error.message || "Failed to accept request.");
        return;
      }

      await refresh();
    } finally {
      setActingRequestId(null);
    }
  }

  async function declineRequest(requestId: string) {
    if (actingRequestId) return;

    setInviteStatus("");
    setActingRequestId(requestId);

    try {
      // DB uses 'rejected' (NOT 'declined')
      const { error } = await supabase
        .from("friend_requests")
        .update({ status: "rejected" })
        .eq("id", requestId);

      if (error) {
        console.error("decline request update error:", error);
        setInviteStatus(error.message || "Failed to decline request.");
        return;
      }

      await refresh();
    } finally {
      setActingRequestId(null);
    }
  }

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="max-w-5xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Link href="/" className="text-sm text-neutral-400 hover:text-white">
              ← Back
            </Link>
            <div className="flex items-center gap-2">
              <h1 className="text-3xl font-semibold">Friends</h1>
              <span className="text-xs px-2 py-1 rounded-full border border-neutral-800 text-neutral-300">
                {friends.length} total
              </span>
              {incoming.length > 0 && (
                <span className="text-xs px-2 py-1 rounded-full border border-neutral-800 text-neutral-300">
                  {incoming.length} incoming
                </span>
              )}
            </div>
            <div className="text-sm text-neutral-400">
              Add friends and view their profiles & media.
            </div>
          </div>

          <button
            onClick={() => void refresh()}
            disabled={!me || refreshing}
            className="shrink-0 px-3 py-2 rounded-md border border-neutral-800 bg-neutral-950 hover:bg-neutral-900 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        {/* Not logged in */}
        {!pageLoading && !me && (
          <div className="rounded-2xl border border-neutral-800 bg-neutral-950 p-5">
            <div className="text-lg font-medium">You’re not signed in</div>
            <div className="text-sm text-neutral-400 mt-1">
              Sign in to manage friends and requests.
            </div>
            <div className="mt-4">
              <Link
                href="/login"
                className="inline-flex items-center justify-center px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 text-sm font-medium"
              >
                Go to Login
              </Link>
            </div>
          </div>
        )}

        {/* Add friend */}
        <div className="rounded-2xl border border-neutral-800 bg-neutral-950 p-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-lg font-medium">Add a friend</div>
              <div className="text-sm text-neutral-400">
                Send an invite by username (example: <span className="text-neutral-200">DenaliM</span>)
              </div>
            </div>
          </div>

          <div className="mt-4 flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500 text-sm">
                @
              </span>
              <input
                className="w-full rounded-md bg-neutral-900 border border-neutral-700 pl-7 pr-3 py-2 outline-none focus:ring-2 focus:ring-emerald-600/40 focus:border-emerald-700"
                placeholder="username"
                value={inviteUsername}
                onChange={(e) => setInviteUsername(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void sendInvite();
                }}
                disabled={!me || sendingInvite}
              />
            </div>

            <button
              onClick={() => void sendInvite()}
              disabled={!me || sendingInvite}
              className="px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
            >
              {sendingInvite ? "Sending…" : "Send invite"}
            </button>
          </div>

          {inviteStatus && (
            <div className="mt-3 text-sm text-neutral-300 border border-neutral-800 bg-neutral-900/30 rounded-md p-3">
              {inviteStatus}
            </div>
          )}
        </div>

        {/* Incoming */}
        <div className="rounded-2xl border border-neutral-800 bg-neutral-950 p-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-lg font-medium">Incoming requests</div>
              <div className="text-sm text-neutral-400">Accept to add them as a friend.</div>
            </div>
            <span className="text-xs px-2 py-1 rounded-full border border-neutral-800 text-neutral-300">
              {incoming.length}
            </span>
          </div>

          {incoming.length === 0 ? (
            <div className="mt-4 text-sm text-neutral-500">
              No incoming requests right now.
            </div>
          ) : (
            <div className="mt-4 grid grid-cols-1 gap-2">
              {incoming.map((r) => {
                const label = r.user?.display_name || r.user?.username || r.requester_id;
                const handle = r.user ? formatHandle(r.user) : null;
                const isActing = actingRequestId === r.id;

                return (
                  <div
                    key={r.id}
                    className="flex items-center justify-between gap-3 rounded-xl border border-neutral-800 bg-neutral-900/20 p-3"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="h-10 w-10 rounded-full border border-neutral-800 bg-neutral-900 flex items-center justify-center text-sm font-semibold text-neutral-200">
                        {initialsFromProfile(r.user ?? null)}
                      </div>
                      <div className="min-w-0">
                        <div className="font-medium truncate">{label}</div>
                        <div className="text-xs text-neutral-500 truncate">
                          {handle ?? r.requester_id}
                        </div>
                      </div>
                    </div>

                    <div className="flex gap-2 shrink-0">
                      <button
                        onClick={() => void acceptRequest(r.id)}
                        disabled={isActing}
                        className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded-md text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {isActing ? "Working…" : "Accept"}
                      </button>
                      <button
                        onClick={() => void declineRequest(r.id)}
                        disabled={isActing}
                        className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 rounded-md text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Decline
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Friends */}
        <div className="rounded-2xl border border-neutral-800 bg-neutral-950 p-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-lg font-medium">Your friends</div>
              <div className="text-sm text-neutral-400">Tap a friend to view their profile.</div>
            </div>
            <span className="text-xs px-2 py-1 rounded-full border border-neutral-800 text-neutral-300">
              {friends.length}
            </span>
          </div>

          {friends.length === 0 ? (
            <div className="mt-4 rounded-xl border border-neutral-800 bg-neutral-900/20 p-4">
              <div className="text-sm text-neutral-300">No friends yet.</div>
              <div className="text-xs text-neutral-500 mt-1">
                Add someone by username above, then accept requests here.
              </div>
            </div>
          ) : (
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
              {sortedFriends.map((f) => {
                const label = displayLabel(f);
                const handle = formatHandle(f);

                return (
                  <Link
                    key={f.id}
                    href={`/profile/${f.id}`}
                    className="group rounded-xl border border-neutral-800 bg-neutral-900/20 p-3 hover:bg-neutral-900/40 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-full border border-neutral-800 bg-neutral-900 flex items-center justify-center text-sm font-semibold text-neutral-200">
                        {initialsFromProfile(f)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-medium truncate">{label}</div>
                        <div className="text-xs text-neutral-500 truncate">
                          {handle ?? f.id}
                        </div>
                      </div>
                      <div className="text-xs text-neutral-500 group-hover:text-neutral-300">
                        View →
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer hint */}
        <div className="text-xs text-neutral-600">
          {pageLoading ? "Loading…" : me ? `Signed in: ${me}` : "Not signed in"}
        </div>
      </div>
    </div>
  );
}
