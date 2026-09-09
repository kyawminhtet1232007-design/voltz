# Deploying Voltz publicly (Vercel + custom domain)

Voltz is a Vite React SPA (`frontend/`) + Supabase (auth, chat, storage, analytics)
+ a tiny Groq chat proxy. For production the proxy runs as a **Vercel serverless
function** (`frontend/api/groq-chat.js`), so there is **no separate always-on
backend** — the old `backend/` Express server is only for local dev.

Cost: domain ~$10–15/yr is the only required cost. Vercel Hobby + Supabase free
tier = $0/month.

---

## 0. Get this code onto GitHub (required first)

This working copy is NOT currently a git repo, so GitHub doesn't have the latest
Voltz. From `/Users/kyaw/Downloads/PassionPrj`:

```bash
git init
git add .
git commit -m "Voltz: current build (auth, dashboard, lessons, analytics)"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git   # your repo URL
git push -u origin main
```

`.env.local` and `backend/.env` are gitignored — good, secrets never get pushed.

---

## 1. Create the Vercel project

1. vercel.com → **Add New → Project** → import your GitHub repo.
2. **Root Directory:** set to **`frontend`** (important — the app lives there).
3. Framework preset: **Vite** (auto-detected). Build `npm run build`, output `dist`.
4. Don't deploy yet — add env vars first (next step).

## 2. Environment variables (Vercel → Project → Settings → Environment Variables)

Public (safe — these are already `VITE_` and shipped in the bundle):
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_KEY`
- `VITE_LIVEKIT_URL`
- `VITE_OWNER_PIN_HASH`
- `VITE_GOOGLE_CLIENT_ID`

Secret (server-side only — used by the serverless function, NEVER `VITE_`):
- `GROQ_API_KEY`  ← copy from `backend/.env`
- `GROQ_MODEL` (optional; defaults to `openai/gpt-oss-120b`)

Copy the `VITE_*` values from `frontend/.env.local`. Then **Deploy**. You'll get a
`*.vercel.app` URL — verify the site loads and Voltz (the AI chat) answers, which
proves the serverless proxy works.

## 3. Add your custom domain

1. Buy a domain (Cloudflare / Namecheap / Porkbun).
2. Vercel → Project → **Settings → Domains → Add** → enter your domain.
3. Vercel shows DNS records (an A record or CNAME). Add them at your registrar.
4. Wait for DNS + the automatic HTTPS cert (minutes to a couple hours).

## 4. Point Supabase + Google at the real domain

**Supabase → Authentication → URL Configuration:**
- **Site URL:** `https://yourdomain.com`
- **Redirect URLs:** add `https://yourdomain.com/**` (and keep the vercel.app URL
  while testing). `signInWithOAuth` redirects to `window.location.origin`, so the
  live origin must be allow-listed here or sign-in bounces.

**Google Cloud → Google Auth Platform → Clients → your OAuth client:**
- **Authorized JavaScript origins:** add `https://yourdomain.com` (needed for One Tap).
- The Authorized *redirect URI* stays the Supabase callback — no change.

**Google Cloud → Google Auth Platform → Audience:** click **Publish app** so anyone
(not just test users) can sign in. Basic email/profile scopes don't need Google's
verification review.

### Email templates — use `{{ .TokenHash }}`, not `{{ .ConfirmationURL }}`

**Supabase → Authentication → Emails → Confirm signup** (and **Reset password**).
Replace the link with:

```html
<a href="{{ .SiteURL }}/?token_hash={{ .TokenHash }}&type=signup">Confirm your email</a>
```

(`type=recovery` for the reset-password template.)

Why this matters: the client runs the **PKCE** flow, whose `?code=` exchange needs
a `code_verifier` stored in the localStorage of the browser that *started* the
flow. People routinely open the confirmation mail somewhere else — the Gmail app's
in-app browser, or a desktop click after signing up on a phone — and there the
exchange cannot work, so they land signed out and have to log in manually. A
`token_hash` link has no such dependency: `AuthProvider` calls `verifyOtp()` with
it and a session is created wherever the link is opened.

### Whether sign-up signs people in immediately

**Supabase → Authentication → Sign In / Providers → Confirm email.**

- **On** (current setting): `signUp` returns **no session**. The user gets a
  "check your email" screen and is only signed in once they click the link. Best
  for keeping fake addresses out.
- **Off**: `signUp` returns a session and they're signed in on the spot, no email
  round-trip. Fewer people drop out of sign-up; unverified addresses get in.

The app handles both — `AuthModal` branches on whether a session came back, so
flipping this setting needs no code change.

## 5. Apply the Supabase migrations (SQL Editor → run each)

- `supabase/migrations/20260810_analytics.sql` — visitor counter.
- Review `supabase/migrations/20260610_security_hardening.sql` + SECURITY.md before
  applying (it locks down anon writes; deploy `owner-action` first).

## 6. Security cleanup

- **Regenerate the Google client secret** (it appeared in a screenshot during setup):
  Google → Clients → your client → **Reset secret** → paste the new one into
  Supabase → Authentication → Providers → Google.

---

## Notes
- The `backend/` Express server is no longer deployed — it's dev-only now. Local dev
  still runs it for `/api/groq-chat`; production uses the Vercel function instead.
- Redeploys are automatic on every push to `main` once the repo is connected.
