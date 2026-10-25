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

async function listAllAuthUsers(admin: ReturnType<typeof createSupabaseAdmin>) {
  const users = [];
  const perPage = 1000;
  let page = 1;

  while (true) {
    const result = await admin.auth.admin.listUsers({ page, perPage });
    if (result.error) throw result.error;

    const batch = result.data.users ?? [];
    users.push(...batch);

    if (batch.length < perPage) break;
    page += 1;
  }

  return users;
}

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";

    if (!token) {
      return NextResponse.json({ error: "Missing access token." }, { status: 401 });
    }

    let admin: ReturnType<typeof createSupabaseAdmin>;

    try {
      admin = createSupabaseAdmin();
    } catch (error) {
      console.error("Owner monitoring configuration error", error);
      return NextResponse.json(
        {
          error:
            "Owner monitoring is not configured on this deployment. Add SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) to the server environment and redeploy.",
        },
        { status: 503 }
      );
    }

    const { data: authData, error: authError } = await admin.auth.getUser(token);
    const requestingUser = authData.user;

    if (authError || !requestingUser) {
      return NextResponse.json({ error: "Invalid session." }, { status: 401 });
    }

    if (!allowedAdminIds().has(requestingUser.id)) {
      return NextResponse.json({ error: "Admin access required." }, { status: 403 });
    }

    const [mediaResult, requestsResult, friendsResult, authUsers] = await Promise.all([
      admin.from("media_items").select("user_id,data"),
      admin
        .from("friend_requests")
        .select("id,requester_id,requested_id,status,created_at"),
      admin.from("friends").select("user_id,friend_id"),
      listAllAuthUsers(admin),
    ]);

    if (mediaResult.error) throw mediaResult.error;

    if (requestsResult.error) {
      console.warn("Owner monitoring: friend_requests unavailable", requestsResult.error);
    }

    if (friendsResult.error) {
      console.warn("Owner monitoring: friends unavailable", friendsResult.error);
    }

    let profileRows: Array<{
      id: string;
      username?: string | null;
      display_name?: string | null;
    }> = [];

    const profilesResult = await admin.from("profiles").select("*");
    if (profilesResult.error) {
      console.warn("Owner monitoring: profiles unavailable", profilesResult.error);
    } else {
      profileRows = (profilesResult.data ?? []).map((row: Record<string, unknown>) => ({
        id: String(row.id ?? ""),
        username: typeof row.username === "string" ? row.username : null,
        display_name: typeof row.display_name === "string" ? row.display_name : null,
      }));
    }

    const mediaRows = mediaResult.data ?? [];
    const requestRows = requestsResult.error ? [] : requestsResult.data ?? [];
    const friendRows = friendsResult.error ? [] : friendsResult.data ?? [];

    const profileById = new Map(profileRows.filter((row) => row.id).map((row) => [row.id, row]));
    const mediaById = new Map(mediaRows.map((row) => [row.user_id, row]));
    const authById = new Map(authUsers.map((user) => [user.id, user]));

    const ids = new Set<string>();
    authUsers.forEach((user) => ids.add(user.id));
    mediaRows.forEach((row) => ids.add(row.user_id));
    profileRows.forEach((row) => {
      if (row.id) ids.add(row.id);
    });

    const members = Array.from(ids).map((id) => {
      const authUser = authById.get(id);
      const profile = profileById.get(id);
      const rawData = mediaById.get(id)?.data;

      const legacyItems = Array.isArray(rawData)
        ? safeArray<Record<string, unknown>>(rawData)
        : null;

      const data =
        rawData && typeof rawData === "object" && !Array.isArray(rawData)
          ? (rawData as Record<string, unknown>)
          : {};

      const items = legacyItems ?? safeArray<Record<string, unknown>>(data.items);
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
    return NextResponse.json(
      { error: "Could not load admin overview. Check the server logs for details." },
      { status: 500 }
    );
  }
}
