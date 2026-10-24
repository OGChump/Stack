import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabaseAdmin";

const FALLBACK_ADMIN_IDS = ["a990813e-af9d-4e1c-a15d-2e9281128c71"];

function allowedAdminIds() {
  const fromEnv = (process.env.STACK_ADMIN_USER_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return new Set([...FALLBACK_ADMIN_IDS, ...fromEnv]);
}

function safeArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";

    if (!token) {
      return NextResponse.json({ error: "Missing access token." }, { status: 401 });
    }

    const admin = createSupabaseAdmin();
    const { data: authData, error: authError } = await admin.auth.getUser(token);
    const requestingUser = authData.user;

    if (authError || !requestingUser) {
      return NextResponse.json({ error: "Invalid session." }, { status: 401 });
    }

    if (!allowedAdminIds().has(requestingUser.id)) {
      return NextResponse.json({ error: "Admin access required." }, { status: 403 });
    }

    const [mediaResult, profilesResult, requestsResult, friendsResult, usersResult] =
      await Promise.all([
        admin.from("media_items").select("user_id,data"),
        admin.from("profiles").select("id,username,display_name"),
        admin
          .from("friend_requests")
          .select("id,requester_id,requested_id,status,created_at"),
        admin.from("friends").select("user_id,friend_id"),
        admin.auth.admin.listUsers({ page: 1, perPage: 1000 }),
      ]);

    if (mediaResult.error) throw mediaResult.error;
    if (profilesResult.error) throw profilesResult.error;
    if (requestsResult.error) throw requestsResult.error;
    if (friendsResult.error) throw friendsResult.error;
    if (usersResult.error) throw usersResult.error;

    const mediaRows = mediaResult.data ?? [];
    const profileRows = profilesResult.data ?? [];
    const requestRows = requestsResult.data ?? [];
    const friendRows = friendsResult.data ?? [];
    const authUsers = usersResult.data.users ?? [];

    const profileById = new Map(profileRows.map((row) => [row.id, row]));
    const mediaById = new Map(mediaRows.map((row) => [row.user_id, row]));
    const authById = new Map(authUsers.map((user) => [user.id, user]));

    const ids = new Set<string>();
    authUsers.forEach((user) => ids.add(user.id));
    mediaRows.forEach((row) => ids.add(row.user_id));
    profileRows.forEach((row) => ids.add(row.id));

    const members = Array.from(ids).map((id) => {
      const authUser = authById.get(id);
      const profile = profileById.get(id);
      const rawData = mediaById.get(id)?.data;
      const data = rawData && typeof rawData === "object" && !Array.isArray(rawData)
        ? (rawData as Record<string, unknown>)
        : {};

      const items = safeArray<Record<string, unknown>>(data.items);
      const feedback = safeArray<Record<string, unknown>>(data.feedback);
      const settings =
        data.settings && typeof data.settings === "object" && !Array.isArray(data.settings)
          ? data.settings
          : {};

      const friendCount = friendRows.filter((row) => row.user_id === id).length;
      const incomingPending = requestRows.filter(
        (row) => row.requested_id === id && row.status === "pending"
      ).length;
      const outgoingPending = requestRows.filter(
        (row) => row.requester_id === id && row.status === "pending"
      ).length;

      return {
        id,
        email: authUser?.email ?? null,
        createdAt: authUser?.created_at ?? null,
        lastSignInAt: authUser?.last_sign_in_at ?? null,
        emailConfirmedAt: authUser?.email_confirmed_at ?? null,
        username: profile?.username ?? null,
        profileDisplayName: profile?.display_name ?? null,
        settings,
        items,
        feedback,
        friendCount,
        incomingPending,
        outgoingPending,
      };
    });

    members.sort((a, b) => {
      const aName = String(
        (a.settings as Record<string, unknown>)?.displayName ||
          a.profileDisplayName ||
          a.username ||
          a.email ||
          a.id
      );
      const bName = String(
        (b.settings as Record<string, unknown>)?.displayName ||
          b.profileDisplayName ||
          b.username ||
          b.email ||
          b.id
      );
      return aName.localeCompare(bName);
    });

    const allItems = members.flatMap((member) => member.items);
    const privateItems = allItems.filter((item) => item?.isPrivate === true).length;
    const completedItems = allItems.filter((item) => item?.status === "completed").length;
    const feedbackItems = members.reduce((sum, member) => sum + member.feedback.length, 0);

    return NextResponse.json(
      {
        generatedAt: new Date().toISOString(),
        summary: {
          members: members.length,
          mediaItems: allItems.length,
          privateItems,
          publicItems: allItems.length - privateItems,
          completedItems,
          pendingFriendRequests: requestRows.filter((row) => row.status === "pending").length,
          friendships: friendRows.length,
          feedbackItems,
        },
        members,
      },
      {
        headers: {
          "Cache-Control": "no-store, max-age=0",
        },
      }
    );
  } catch (error) {
    console.error("Admin overview error", error);
    return NextResponse.json({ error: "Could not load admin overview." }, { status: 500 });
  }
}
