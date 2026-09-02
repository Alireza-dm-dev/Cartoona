import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const email = process.argv[2];
const password = process.argv[3];

const client = createClient(url, key);
const { data, error } = await client.auth.signInWithPassword({ email, password });
if (error) {
  console.error("SIGNIN_FAILED:", error.message);
  process.exit(1);
}
const s = data.session;
const cookie = Buffer.from(
  JSON.stringify({
    access_token: s.access_token,
    refresh_token: s.refresh_token,
    expires_in: s.expires_in,
    expires_at: Math.floor(Date.now() / 1000) + s.expires_in,
    token_type: "bearer",
  }),
).toString("base64");
console.log(cookie);
