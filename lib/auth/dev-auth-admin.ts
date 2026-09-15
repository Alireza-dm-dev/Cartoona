import "server-only"

function getAdminHeaders(): Record<string, string> {
  const secret = process.env.SUPABASE_SECRET_KEY
  if (!secret) throw new Error("Missing SUPABASE_SECRET_KEY")
  return {
    "Content-Type": "application/json",
    apikey: secret,
    Authorization: `Bearer ${secret}`,
  }
}

export function getSupabaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!url) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL")
  return url
}

async function adminFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const url = `${getSupabaseUrl()}/auth/v1${path}`
  const headers = {
    ...getAdminHeaders(),
    ...(options.headers as Record<string, string> || {}),
  }
  const resp = await fetch(url, { ...options, headers })
  return resp
}

export interface GoTrueUser {
  id: string
  email: string
  phone?: string
  email_confirmed_at?: string
  user_metadata?: Record<string, unknown>
}

const USERS_PER_PAGE = 200
const MAX_USER_PAGES = 50

/**
 * Lists every auth user, following GoTrue's pagination.
 *
 * The admin endpoint returns only the first page (50 users by default), so an
 * unpaginated call silently stops finding accounts once a project grows past
 * that — which surfaces as a parent being told their credentials are wrong.
 */
export async function listUsers(): Promise<GoTrueUser[]> {
  const all: GoTrueUser[] = []

  for (let page = 1; page <= MAX_USER_PAGES; page++) {
    const resp = await adminFetch(`/admin/users?page=${page}&per_page=${USERS_PER_PAGE}`)
    if (!resp.ok) {
      const body = await resp.text()
      throw new Error(`listUsers failed: ${resp.status} ${body}`)
    }
    const data = await resp.json()
    const users: GoTrueUser[] = data.users || []
    all.push(...users)
    if (users.length < USERS_PER_PAGE) break
  }

  return all
}

export async function createUser(params: {
  email: string
  password: string
  email_confirm: boolean
  user_metadata?: Record<string, unknown>
}): Promise<GoTrueUser> {
  const resp = await adminFetch("/admin/users", {
    method: "POST",
    body: JSON.stringify(params),
  })
  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`createUser failed: ${resp.status} ${body}`)
  }
  return resp.json()
}

export async function deleteUser(userId: string): Promise<void> {
  await adminFetch(`/admin/users/${userId}`, { method: "DELETE" })
}

export async function getUserById(userId: string): Promise<GoTrueUser | null> {
  const resp = await adminFetch(`/admin/users/${userId}`)
  if (!resp.ok) return null
  return resp.json()
}

export async function generateMagicLinkToken(email: string): Promise<{ hashedToken: string; verificationType: string }> {
  const resp = await adminFetch("/admin/generate_link", {
    method: "POST",
    body: JSON.stringify({
      type: "magiclink",
      email,
    }),
  })
  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`generateLink failed: ${resp.status} ${body}`)
  }
  const data = await resp.json()
  if (!data.hashed_token) {
    throw new Error("generateLink: no hashed_token in response")
  }
  return { hashedToken: data.hashed_token, verificationType: data.verification_type || "magiclink" }
}
