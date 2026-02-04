/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable react-hooks/exhaustive-deps */
"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";

type Profile = {
  id: string;
  username: string | null;
  display_name: string | null;
};

type IncomingRequestRow = {
  id: string;
  requester_id: string;
};

type IncomingRequest = {
  id: string;
  requester_id: string;
  user?: Profile;
};

export default function FriendsPage() {
  const [me, setMe] = useState<string | null>(null);
  const [friends, setFriends] = useState<Profile[]>([]);
  const [incoming, setIncoming] = useState<IncomingRequest[]>([]);
  const [inviteUsername, setInviteUsername] = useState("");
  const [inviteStatus, setInviteStatus] = useState("");
  const [busy, setBusy] = useState(false);

  // Keep session/user in sync
  useEffect(() => {
    let mounted = true;

    supabase.auth.getUser().then(({ data, error }) => {
      if (!mounted) return;
      if (error) {
        console.error("auth.getUser error:", error);
        return;
      }
      setMe(data.user?.id ?? null);
    });

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
    refresh();
  }, [me]);

  async function refresh() {
    if (!me) return;

    setInviteStatus("");

    // 1) Friends list (directional rows where user_id = me)
    const { data: friendRows, error: friendsErr } = await supabase
      .from("friends")
      .select("friend_id")
      .eq("user_id", me);

    if (friendsErr) console.error("friends select error:", friendsErr);

    // Deduplicate friend ids (just in case)
    const ids = Array.from(
      new Set(
        (friendRows ?? [])
          .map((r: any) => r.friend_id as string | null | undefined)
          .filter(Boolean) as string[]
      )
    );

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

    const requesterIds = Array.from(
      new Set((reqs as IncomingRequestRow[]).map((r) => r.requester_id))
    );

    const { data: reqProfiles, error: reqProfErr } = await supabase
      .from("profiles")
      .select("id, username, display_name")
      .in("id", requesterIds);

    if (reqProfErr) console.error("profiles (incoming) select error:", reqProfErr);

    const map = new Map((reqProfiles ?? []).map((p: any) => [p.id, p as Profile]));
    setIncoming(
      (reqs as IncomingRequestRow[]).map((r) => ({
        id: r.id,
        requester_id: r.requester_id,
        user: map.get(r.requester_id),
      }))
    );
  }

  async function sendInvite() {
    setInviteStatus("");

    const username = inviteUsername.trim().toLowerCase();
    if (!username) return;

    if (!me) {
      setInviteStatus("Not logged in.");
      return;
    }

    setBusy(true);
    try {
      // Find target user by username
      const { data: target, error: findErr } = await supabase
        .from("profiles")
        .select("id")
        .eq("username", username)
        .maybeSingle();

      if (findErr) {
        console.error("find user error:", findErr);
        setInviteStatus("Error finding user.");
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

      // Check if already friends (directional row me -> them OR them -> me)
      const { data: existingFriend, error: friendCheckErr } = await supabase
        .from("friends")
        .select("id")
        .or(`and(user_id.eq.${me},friend_id.eq.${target.id}),and(user_id.eq.${target.id},friend_id.eq.${me})`)
        .limit(1);

      if (!friendCheckErr && existingFriend && existingFriend.length > 0) {
        setInviteStatus("You are already friends.");
        return;
      }

      // Check if a pending request exists either direction
      // NOTE: PostgREST .or() supports "and(...),and(...)" at the top-level
      const { data: existingReq, error: existsErr } = await supabase
        .from("friend_requests")
        .select("id")
        .or(
          `and(requester_id.eq.${me},requested_id.eq.${target.id},status.eq.pending),and(requester_id.eq.${target.id},requested_id.eq.${me},status.eq.pending)`
        )
        .limit(1);

      if (!existsErr && existingReq && existingReq.length > 0) {
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
          setInviteStatus(msg);
        }
        return;
      }

      setInviteUsername("");
      setInviteStatus("Invite sent.");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function acceptRequest(requestId: string) {
    setInviteStatus("");
    setBusy(true);

    try {
      // MUST use RPC so it inserts into friends table (both directions)
      const { error } = await supabase.rpc("accept_friend_request", {
        p_request_id: requestId,
      });

      if (error) {
        console.error("accept_friend_request RPC error:", error);
        setInviteStatus(error.message);
        return;
      }

      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function declineRequest(requestId: string) {
    setInviteStatus("");
    setBusy(true);

    try {
      // DB uses 'rejected' (NOT 'declined')
      const { error } = await supabase
        .from("friend_requests")
        .update({ status: "rejected" })
        .eq("id", requestId);

      if (error) {
        console.error("decline request update error:", error);
        setInviteStatus(error.message);
        return;
      }

      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const canSend = useMemo(() => {
    return !!me && inviteUsername.trim().length > 0 && !busy;
  }, [me, inviteUsername, busy]);

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        <Link href="/" className="text-sm text-neutral-400 hover:text-white">
          ← Back
        </Link>

        <h1 className="text-3xl font-semibold">Friends</h1>

        {/* Add friend */}
        <div className="rounded-xl border border-neutral-800 p-4 space-y-2">
          <div className="font-medium">Add friend</div>
          <div className="flex gap-2">
            <input
              className="flex-1 rounded-md bg-neutral-900 border border-neutral-700 px-3 py-2"
              placeholder="username"
              value={inviteUsername}
              onChange={(e) => setInviteUsername(e.target.value)}
              disabled={busy}
            />
            <button
              onClick={sendInvite}
              disabled={!canSend}
              className="px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Send
            </button>
          </div>
          {inviteStatus && <div className="text-sm text-neutral-400">{inviteStatus}</div>}
        </div>

        {/* Incoming */}
        {incoming.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-lg font-medium">Incoming</h2>
            {incoming.map((r) => (
              <div
                key={r.id}
                className="flex justify-between border border-neutral-800 p-3 rounded-md"
              >
                <div>{r.user?.display_name || r.user?.username || r.requester_id}</div>
                <div className="flex gap-2">
                  <button
                    onClick={() => acceptRequest(r.id)}
                    disabled={busy}
                    className="px-3 py-1 bg-emerald-600 rounded disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Accept
                  </button>
                  <button
                    onClick={() => declineRequest(r.id)}
                    disabled={busy}
                    className="px-3 py-1 bg-neutral-700 rounded disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Decline
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Friends */}
        <div className="space-y-2">
          <h2 className="text-lg font-medium">Friends</h2>

          {friends.length === 0 ? (
            <div className="text-neutral-500 text-sm">No friends yet</div>
          ) : (
            friends.map((f) => (
              <Link
                key={f.id}
                href={`/profile/${f.id}`}
                className="block border border-neutral-800 p-3 rounded-md hover:bg-neutral-900"
              >
                <div className="font-medium">{f.display_name || f.username || f.id}</div>
                <div className="text-xs text-neutral-500">Tap to view profile</div>
              </Link>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
