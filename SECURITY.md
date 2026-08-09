# Security Model & Hardening Notes

This documents where each security control is enforced, what's currently a real
boundary vs. advisory, and the deployment steps to close the remaining gaps.

## Threat model in one line

The Supabase **anon (publishable) key is embedded in the browser bundle** — it is
public by design. Anything protected only by client-side JavaScript (a PIN check,
an `isAdmin` flag, a rate limit) can be bypassed by calling the Supabase REST API
directly with that key. Real boundaries must live in **Postgres RLS** or in a
**server-side secret** (Express backend / Supabase Edge Function).

## What is a real boundary today

| Control | Where enforced | Real boundary? |
|---|---|---|
| Groq API key | Express `/groq-chat` proxy (`backend/.env`) | ✅ Yes — key never sent to browser |
| LiveKit token minting | `supabase/functions/livekit-token` (service secret) | ✅ Yes |
| DB / JWT secrets | `backend/.env`, server-only | ✅ Yes |
| Storage per-file 40MB cap | `chat-media` bucket `file_size_limit` | ✅ Yes — enforced by Supabase Storage |

## What is advisory (client-side only) and needs hardening

| Control | Current state | Fix |
|---|---|---|
| Automod IP ban writes | anon key can write `ip_blacklist` directly | `owner-action` Edge Function + hardening migration |
| Automod rule writes | anon key can write `automod_config` rows | `owner-action` Edge Function |
| Owner PIN (`/automod`) | UI-only SHA-256 check; gates nothing server-side | Move verification into `owner-action` |
| `isAdmin` team role | trusted from `localStorage`; spoofable | Needs authenticated identities (see below) |
| Daily 40MB upload cap | client check + `upload_usage` row a user could lower | hardening migration (no-decrease) + future server accounting |
| Send rate limit (1.2s) | client cooldown only | acceptable for spam UX; not a security control |

## Client-side guards (tested, but UX-only)

The pure guard functions in `frontend/src/lib/chatGuards.js`
(`matchAutomod`, `isIpBanned`, `isRateLimited`, `checkDailyUpload`,
`isFileSizeOk`) are unit-tested (`chatGuards.test.js`). They make the client
behaviour predictable and are the first line of defence — but per the threat
model above they are **not** the authoritative boundary. Keep them; back them
with server enforcement.

## Deployment steps to close the gaps

1. **Deploy the Edge Function**
   ```bash
   supabase functions deploy owner-action
   supabase secrets set \
     OWNER_PIN_HASH=<sha256 of your owner PIN> \
     SERVICE_ROLE_KEY=<project service_role key> \
     SUPABASE_URL=<project url>
   ```
2. **Rewire the frontend** `banIp` / `unbanIp` / `saveAutomodRules` (in
   `VexHub.jsx`, `TeamChat`) to `POST` to `owner-action` with `{ pin, action,
   payload }` instead of writing to Supabase directly. (The PIN is already
   collected by the `/automod` flow.)
3. **Apply the hardening migration** once the above works:
   `supabase/migrations/20260610_security_hardening.sql` — this revokes anon
   write access to `ip_blacklist` and tightens `upload_usage`. Do NOT apply it
   before step 2 or the in-app ban/automod buttons will silently fail.

## Future: authenticated identities

The team chat currently has no real user authentication — display name + color
live in `localStorage`. To make `isAdmin`, message authorship, and per-user
quotas tamper-proof, introduce Supabase Auth (anonymous or email) and key RLS
policies off `auth.uid()`. Until then, those remain advisory.

## Sign-in (Google OAuth) & visitor analytics — privacy model

**Sign-in is optional, never a gate.** `SignInPrompt` nudges Google sign-in only
after real engagement (time + scroll), is dismissible, and stays quiet for days
after (`lib/analytics.js`). Google OAuth runs through Supabase — the consent flow
happens on Google's domain, so the app never sees the user's password. Enabling
the Google provider (client ID/secret + redirect URI) is a Supabase-dashboard
step, not in this repo.

**Analytics stores no IP and no PII.** A "visit" is identified by a random
per-browser UUID kept in `localStorage` (`voltz_visitor_id`) plus, when signed in,
the Supabase `user_id` — never an IP address. Raw IP is used **only** in the
existing moderation path (`ip_blacklist`, for bans); it is deliberately kept out
of `site_visits`. RLS on `site_visits` allows anon **INSERT only, no SELECT**, so
the raw visit log can't be scraped with the anon key. The owner Site-stats panel
reads through the `get_site_stats()` SECURITY-DEFINER RPC, which returns four
aggregate counts and nothing else. The panel is PIN-gated client-side (UX only —
same caveat as automod); if the counts themselves must be owner-only, move
`get_site_stats()` behind the `owner-action` Edge Function. If you later collect
anything that identifies a person, add an in-app privacy disclosure.
