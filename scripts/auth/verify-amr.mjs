#!/usr/bin/env node
/**
 * Verify, against a DISPOSABLE Supabase project, that real access tokens carry a
 * stable, timestamped AMR entry (V0.1.54). Cartoona's 30-day session policy takes
 * "session start" = the earliest amr[].timestamp of the provider-verified token;
 * this is the check that proves (or disproves) that assumption on a real project.
 *
 *   CARTOONA_AMR_PROJECT_URL=https://<disposable-ref>.supabase.co \
 *   CARTOONA_AMR_ANON_KEY=<publishable key> \
 *   CARTOONA_AMR_EMAIL=<test user> CARTOONA_AMR_PASSWORD=<test password> \
 *   node scripts/auth/verify-amr.mjs
 *
 * Phone OTP (optional; the operator supplies a fresh code - nothing is sent by
 * this script unless --send-otp is passed):
 *   CARTOONA_AMR_PHONE=<test number> CARTOONA_AMR_OTP=<code> node scripts/auth/verify-amr.mjs --phone
 *   CARTOONA_AMR_PHONE=<test number> node scripts/auth/verify-amr.mjs --phone --send-otp
 *
 * Output: sanitized JSON only (methods, booleans, second deltas). It never prints
 * a token, refresh token, subject/user id, phone, e-mail or session id, and it
 * refuses production: the known production project ref, and anything that is not
 * a *.supabase.co / localhost URL named explicitly in this environment.
 * Exit 0 stable, 4 unstable/missing, 2 refused, 3 sign-in failed.
 */
import { createClient } from "@supabase/supabase-js"
import { analyzeAmr, decodeClaims } from "./amr-analysis.mjs"

const PRODUCTION_REFS = ["oucyhmrnzahlhqjfqcge"]
const out = (o) => process.stdout.write(JSON.stringify(o, null, 2) + "\n")
const refuse = (reason) => (out({ result: "refused", reason }), process.exit(2))

const url = process.env.CARTOONA_AMR_PROJECT_URL?.trim()
const key = process.env.CARTOONA_AMR_ANON_KEY?.trim()
if (!url || !key) refuse("CARTOONA_AMR_PROJECT_URL and CARTOONA_AMR_ANON_KEY are required")
let host
try { host = new URL(url).hostname } catch { refuse("project url is not a URL") }
if (PRODUCTION_REFS.some((r) => host.includes(r))) refuse("production project")
if (!(/^[a-z0-9]{20}\.supabase\.co$/.test(host) || host === "localhost" || host === "127.0.0.1")) refuse("host is not a Supabase project or localhost")

const phoneMode = process.argv.includes("--phone")
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })

async function signIn() {
  if (!phoneMode) {
    const email = process.env.CARTOONA_AMR_EMAIL, password = process.env.CARTOONA_AMR_PASSWORD
    if (!email || !password) refuse("CARTOONA_AMR_EMAIL and CARTOONA_AMR_PASSWORD are required")
    return sb.auth.signInWithPassword({ email, password })
  }
  const phone = process.env.CARTOONA_AMR_PHONE
  if (!phone) refuse("CARTOONA_AMR_PHONE is required")
  if (process.argv.includes("--send-otp")) {
    const { error } = await sb.auth.signInWithOtp({ phone })
    out({ result: error ? "otp_send_failed" : "otp_sent", note: "run again with CARTOONA_AMR_OTP set" })
    process.exit(error ? 3 : 0)
  }
  const token = process.env.CARTOONA_AMR_OTP
  if (!token) refuse("CARTOONA_AMR_OTP is required (use --send-otp first)")
  return sb.auth.verifyOtp({ phone, token, type: "sms" })
}

let first
try { first = await signIn() } catch { out({ result: "sign_in_failed", reason: "network_or_provider_error" }); process.exit(3) }
if (first.error || !first.data?.session) { out({ result: "sign_in_failed", reason: "rejected" }); process.exit(3) }
const before = decodeClaims(first.data.session.access_token)

// A refresh must change iat but leave the earliest AMR timestamp alone.
await new Promise((r) => setTimeout(r, 1500))
const refreshed = await sb.auth.refreshSession({ refresh_token: first.data.session.refresh_token })
if (refreshed.error || !refreshed.data?.session) { out({ result: "refresh_failed" }); process.exit(3) }
const after = decodeClaims(refreshed.data.session.access_token)

const analysis = analyzeAmr(before, after)
out({ result: analysis.stable ? "stable" : "unstable", mode: phoneMode ? "phone_otp" : "password", ...analysis })
process.exit(analysis.stable ? 0 : 4)
