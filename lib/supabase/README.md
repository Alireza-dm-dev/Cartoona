# Supabase Client Helpers

This directory provides the foundational Supabase client infrastructure for Cartoona.

## Overview

These helpers provide:
- Browser Supabase client for frontend operations
- Server Supabase client for backend operations
- Environment variable validation
- Clean separation between demo auth and real Supabase integration

## Usage

### Browser Client

```typescript
import { createBrowserSupabaseClient } from '@/lib/supabase/client'

const supabase = createBrowserSupabaseClient()
```

### Server Client

```typescript
import { createServerSupabaseClient } from '@/lib/supabase/server'

const supabase = createServerSupabaseClient()
```

### Environment Helper

```typescript
import { getSupabaseEnv } from '@/lib/supabase/env'

const env = getSupabaseEnv()
```

## Files

- `lib/supabase/client.ts` - Browser Supabase client
- `lib/supabase/server.ts` - Server Supabase client
- `lib/supabase/env.ts` - Environment variable validation
- `lib/supabase/README.md` - Documentation
- ~~`lib/supabase/admin.ts` — removed as premature (add back when API routes need it)~~

## Setup

See [docs/SUPABASE_SETUP.md](../../docs/SUPABASE_SETUP.md) for step-by-step instructions on creating a Supabase project and configuring these clients.

## Environment Variables

| Variable | Required by | Source |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | All clients | Supabase Dashboard > Project Settings > API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Browser + Server clients | Supabase Dashboard > Project Settings > API |

## Security Notes

- Only public environment variables are used (anon key)
- No service role keys in client helpers
- Demo auth remains active for development
- Real Supabase integration is a future migration
- Admin/service-role client (`lib/supabase/admin.ts`) was removed as premature —
  add it back when API routes or seed scripts require it

## Development

These helpers are ready for use but are currently not wired into the application. The existing demo auth system continues to provide full functionality.

Run `npm run build` to verify the project compiles successfully.
