# CLAUDE.md — Project Map & Agent Instructions

This file is the source of truth for "what is where and what it does." **Read this first.**

> **Agent rule**: If the information you need (file purpose, where a feature lives, env var names, table schemas, etc.) is already documented below and accurate, **do not re-grep/re-read the whole codebase to rediscover it**. Only read the specific file/line range you need to edit. If you add, remove, move, or substantially change a file/feature, **update the relevant section of this file in the same turn** so it stays accurate for the next agent.

---

## 1. What this project is

Two apps live in this repo:

- **Voltz** (internally still "VexHub" — file/dir names predate the rebrand) — the active app. A React SPA for VEX Robotics students: lessons, a Code Lab (Monaco-based C++/VEXcode editor + AI assistant "Rio"), a 3D CAD builder (Three.js), a team Dashboard, Resources, and a real-time Team Chat (Supabase). **This is what `npm run dev` serves.** Brand: name **Voltz**. Mascot/AI face = **Volt**, a glossy red robot (cyan glowing eyes, lightning-bolt antenna) rendered by `VoltMascot({size})` — a module-level component in VexHub.jsx just above `Nav` (uses `React.useId()` so its gradient ids stay unique across instances). `VoltMascot` (flat inline-SVG) is used at small/tiny sizes: the `Nav` mark and the assistant message avatars. A **real 3D Volt** (`VoltModel` + `Volt3D`, react-three-fiber — glossy white shell, glowing red visor, idle rotate/bob) is used on the `FloatingChat` launcher button and the chat header avatar (dark backdrop so the white shell pops). Note: do NOT wrap `Volt3D` in a `scale:0` entrance (e.g. `popIn`) — r3f then measures the canvas at 0px and it stays tiny; that's why the launcher has no pop-in. The **AI assistant is named "Voltz"** (renamed from the old "Rio" — intro lines, system prompts in CodeLab + FloatingChat, aria-labels, header all say Voltz). `VoltzMark` (red squircle + bolt) and `VoltzBolt` (bolt glyph) still exist as the simpler flat logo; `public/favicon.svg` is the bolt (kept for tiny favicon legibility); tab `<title>` is "Voltz — Robotics, charged". The nav wordmark uses the `.brand-wordmark` class (Sora 800 display font, loaded via a Google Fonts link in index.html; defined in index.css). "VEX" appears only as descriptive/nominative copy (e.g. hero eyebrow "Learn VEX Robotics Smarter"), never as the product/assistant name.
- **AI Try-On App** — an older/legacy app (auth, clothing upload, virtual try-on via AI). Its frontend pieces (`App.jsx` + `src/components/*`) exist but are **not wired into the running app** (the entry point renders VexHub directly — see §3). The Express **backend** (`backend/index.js`) still has the try-on/auth/clothing routes live, but nothing in the current frontend calls them except the shared Groq proxy.

---

## 2. Repo layout

```
PassionPrj/
├── CLAUDE.md                  ← this file
├── SECURITY.md                ← security model, what's a real boundary vs advisory, hardening steps
├── .claude/launch.json        ← preview launch config ("vexhub" → frontend npm run dev, port 5173)
├── frontend/
│   ├── .env.local             ← VITE_* env vars (Supabase, LiveKit, owner PIN hash) — gitignored
│   ├── vite.config.js         ← dev server port 5173, proxies /api → :5000; ALSO holds vitest `test` config
│   ├── index.html             ← entry HTML, loads src/index.jsx
│   └── src/
│       ├── index.jsx          ← ReactDOM root — renders <VexLearningHub /> from VexHub.jsx (THE active entry point)
│       ├── VexHub.jsx          ← ~12,000 lines. THE entire VEX Learning Hub app (see §4 for component map)
│       ├── App.jsx             ← LEGACY AI Try-On app shell — NOT imported/used by index.jsx
│       ├── index.css / App.css
│       ├── lib/               ← extracted, unit-tested modules (see §10)
│       │   ├── logger.js          ← structured logger + ring buffer (createLogger, getLogBuffer)
│       │   ├── logger.test.js
│       │   ├── chatGuards.js      ← pure chat guard logic (automod/rate/upload limits, server join/create validation) + constants
│       │   ├── chatGuards.test.js
│       │   ├── notify.jsx         ← styled toast + async confirm dialog (notify, confirmDialog, ToastHost) — replaces ALL native alert()/window.confirm()
│       │   ├── notify.test.jsx
│       │   ├── sanitizers.js      ← per-field input sanitizers (digits-only, letters-only, VEX team number) — used by Dashboard team form
│       │   ├── sanitizers.test.js
│       │   ├── analytics.js        ← pure: visitor UUID (getVisitorId), one-visit-per-session (isNewSession), engagement-triggered sign-in decision (shouldPromptSignIn) + prompt cooldown. No PII/IP. Wired by VexHub's recordVisit()/SignInPrompt/OwnerStats
│       │   ├── analytics.test.js
│       │   ├── scrollFx.jsx       ← GSAP motion system: data-reveal reveals, data-parallax scrub, data-count-to counters, <ScrollFx/>, <ScrollProgress/> bar, animatePageEnter (page transitions), animateSwap/useSwapAnimation (tab switches), useScrollSpy (sticky chapter navs), popIn (floating UI), floatIdle (infinite idle bob — used by the draggable Voltz launcher)
│       │   ├── scrollFx.test.jsx
│       │   ├── theme.js           ← design tokens: Apple design language (APPLE ink/muted/blue + system font stack, APPLE_PILL, flat #f5f5f7 LIGHT_PAGE_BG, graphite DARK_PAGE_BG/PALETTE.dark) + PALETTE/LIGHT_CARD + legacy gradient helpers + WCAG contrast math — single source of truth for colors
│       │   ├── theme.test.js
│       │   ├── ErrorBoundary.jsx  ← app-level error boundary
│       │   └── ErrorBoundary.test.jsx
│       ├── test/setup.js      ← vitest setup (jest-dom matchers)
│       └── components/         ← LEGACY AI Try-On components (Auth, ProfileSetup, ClothingUpload, ClothingGallery)
│                                  + an accidentally-committed full Oracle JDK 25 install at
│                                  components/oracleJdk-25.jdk/ (huge, unused — flag for removal, do not touch otherwise)
├── backend/
│   ├── .env                    ← PORT, DB_*, JWT_SECRET, GROQ_API_KEY — gitignored
│   ├── index.js                ← Express server (see §5 for routes)
│   └── services/aiService.js   ← AI try-on image generation logic (used by /try-on route)
└── supabase/
    ├── migrations/
    │   ├── 20260608_ip_blacklist.sql        ← `ip_blacklist` table (automod IP bans)
    │   ├── 20260610_upload_limits.sql       ← `upload_usage` table + chat-media bucket 40MB limit
    │   ├── 20260610_security_hardening.sql  ← locks down anon writes — APPLY ONLY after deploying owner-action (see SECURITY.md)
    │   └── 20260810_analytics.sql           ← `site_visits` table (visitor UUID + user_id + path, NO IP) — anon INSERT only, no SELECT; `get_site_stats()` SECURITY DEFINER RPC returns aggregate counts only. Powers the owner Site-stats panel
    └── functions/
        ├── livekit-token/index.ts  ← Edge Function: mints LiveKit tokens (LIVEKIT_API_KEY/SECRET env)
        └── owner-action/index.ts   ← Edge Function: server-side PIN-gated IP ban / automod writes (deploy-ready, see SECURITY.md)
```

---

## 3. Frontend entry point & routing

- `src/index.jsx` renders `<VexLearningHub />` (default export of `VexHub.jsx`).
- `VexLearningHub` (line ~11174) wraps `VexLearningHubInner` in `<AuthProvider>` + `<StoreProvider>`.
- `VexLearningHubInner` (line ~11184) is the page router — a simple `currentPage` string state, switched via `<Nav>`. Pages: `home`, `lessons`, `codelab`, `cad`, `dashboard`, `resources`, `community` (= TeamChat).
- `<FloatingChat />` (the AI assistant "Voltz", `VoltMascot` launcher) is mounted on every page except `codelab` and `community`. The launcher is **drag-anywhere** (pointer drag moves the whole widget via a `pos` transform on the root, clamped on-screen; a no-move release = click to open) and has a GSAP `floatIdle` bob while closed.

---

## 4. `VexHub.jsx` component map

> Line numbers below are approximate and **shift with edits** — they were accurate at first authoring but the file has since changed. Always re-anchor with `grep -n "^function \|^const [A-Z]"` before editing rather than trusting an exact line. The top of the file now also imports from `./lib/` (logger, chatGuards, ErrorBoundary).

| Lines | Name | Purpose |
|---|---|---|
| 41–224 | `defaultStore`, `loadStore`, `saveStore`, `getStore`, `StoreProvider`/`useStore` | LocalStorage-backed app state: study time, skill %, badges, activity feed |
| 229–386 | `AuthProvider` / `useAuth` | Supabase Auth context — `user`, `signIn`/`signUp` (email+password), `signInWithGoogle` (OAuth, redirects to Google consent), `signOut`. Drives dashboard cloud sync + the sign-in nudge |
| 387–2454 | (large block of C++/VEXcode reference snippets — used as Code Lab lesson/example content, not executable app code) | |
| 2455–3375 | `CodeLab()` | Monaco-based code editor page + AI assistant chat (Rio) for coding help |
| 3376–3477 | `ChatMessage`, `AuthModal` | Shared chat bubble UI; sign-in modal |
| 3585–4161 | `Nav`, `Home`, `FeatureCard`, `RichBody`, `LessonDetail`, `Lessons` | Marketing/landing page + lessons browser. `Nav` = single consistent translucent-graphite frosted bar (`rgba(22,22,23,0.72)`) on every page. `Lessons` page (learning-track layout): a **Current Track hero** (static eyebrow "Current Track" + "Zero to Competition" title + tagline — NOT dynamic, do not re-tie to a lesson name), **category filter pills** (`LESSON_CATS`: All/Coding/Engineering/Strategy/Hardware), and **photo-header lesson cards** (3-col) — clean photo + category eyebrow + title + desc + "Start Lesson →" (the level/duration badges and Module Progress bar were intentionally removed; green ✓ shows on completed). Card photo + filter category come from the module-level `LESSON_META` map (keyed by lesson title → `{cat, img}`; images are real photos in `/public`, named per-lesson). Clicking a card → `LessonDetail`. **`LessonDetail`** = a "technical dossier" layout (Stitch-styled) with **premium/Apple-ish typography** (warm `#3a3a3c` body at relaxed leading, `#1d1d1f` semibold headings): a refined "Back to Lessons" chevron link, a **full-colour landscape hero banner** (`aspect-[16/9] sm:aspect-[21/9]`, `object-cover`, `SYS_VIEW_0X` corner tag, `L0X_LEVEL` red tag), title + desc, a **section list** (`R{track}.{n}` codes, animated chevrons) that jump-scrolls, a `Start Lesson →` red pill, then rounded white section cards (soft shadow, stacked `R#.#` code above the heading). Section bodies render `RichBody` + code blocks + **component cards** + callouts (tinted-by-type `// LABEL` cards). **Component cards** show **real VEX product photos** on a white panel (`<img object-contain>`, `c.img` = `/public/part-<key>.jpg`). Those JPGs are genuine VEX studio shots (white background) sourced from the Wayback Machine archive of vexrobotics.com (the live store + KB Cloudflare-block scraping; only archive.org's CDX index + image rehost are reachable via curl) — see the per-part set: brain/controller/battery/cables (the cables shot is the crimp-kit photo, PIL-cropped to the cable coil + connectors with the red tool recoloured to white)/c-channel/flat-plate/standoffs(spacer)/hardware(screw)/gears/wheels/omni-wheels. `High-Strength Axles` is intentionally **text-only** (no clean bare-axle photo exists in the archive — every `hs-shaft` image is a wheel-with-shaft). An earlier inline-SVG `PartIcon` approach was tried and removed — the user wants photoreal, not illustrated. Replacing a part photo: pull a fresh one via `https://web.archive.org/web/2018id_/<vexrobotics media URL>` (discover URLs with the CDX API, `filter=original:.*1800x.*<keyword>.*`). |
| 4162–6154 | `GlbModel`, `SmartPart`, `MAT`, `PartShape`, `VexPart`, `StableFloor`, `CameraReset`, `CAD()` | 3D CAD builder (react-three-fiber) — drag/drop VEX parts, snapping, GLB models |
| 6624–6680 | Dashboard config constants, `getSB()`, `timeAgo()` | `getSB()` = module-level Supabase client singleton (see §6) |
| 6659–6662 | Upload & rate-limit constants | `MAX_FILE_BYTES` (40MB), `DAILY_UPLOAD_BYTES` (40MB/day), `SEND_COOLDOWN_MS` (1.2s) — used by TeamChat |
| 6663–6680 | Env-derived config | `SUPABASE_URL`, `SUPABASE_KEY`, `OWNER_PIN_HASH`, `checkPin()`, `LIVEKIT_URL` — all from `import.meta.env.VITE_*` |
| 6719–6748 | `ShareBtn` | Reusable "share this to a chat channel" button |
| 6750–7378 | `CompetitionHub`, `SeasonGoals`, `PracticeCalendar` | Dashboard sub-panels (competition tracking, goals, practice schedule) |
| 7394–8313 | `NotebookView` | Engineering notebook / progress tracking, Supabase-backed |
| 8314–8413 | `ChatThemeCtx`, `chatColors`, `NameColorFields` | Chat theming helpers |
| 8414–8557 | `SetupScreen` | First-time chat name/color picker |
| 8558–8685 | `ShareCard`, `MediaAttachment`, `MessageRow` | Chat message rendering (shared cards, image/video attachments, message rows) |
| **8686–9971** | **`TeamChat()`** | **The Team Chat / community page.** See §6 for full breakdown — automod, IP bans, media uploads, rate limits all live here. |
| 9972–10735 | `ChapterArt`, `ChapterBody`, `Resources()` | Resources page — **"Voltz Library": bento hub + docs reader** (`openGuide` state: null → hub; chapter id → reader). **Hub**: hero (bolt chip + display title + inline `data-count-to` counters) and a **bento grid** of the five guides (featured 2×2 tile + smaller tiles, `ChapterArt` art panels, per-guide `stats` chips, hover lift), plus a graphite **Voltz strip** CTA. **Reader**: sticky left guide rail (accent-dot buttons switch guides, "Library" goes back) + ONE guide at a time — `ChapterHead` (accent chip + display title), a **`VoltzTip` explainer** (graphite card: `VoltLogo` avatar + per-guide `tip` + "Ask Voltz" button), the guide content via **`ChapterBody`** (module-level: renders a `.guide-body` wrapper — every top-level content block becomes a bordered white card via CSS in index.css, hover lift, accent top rule on the first card, blocks cascade in through a cloned `data-reveal="stagger"`), and prev/next guide cards. **Voltz integration**: "Ask Voltz" buttons dispatch a `voltz-ask` CustomEvent with a per-guide `ask` question; `FloatingChat` listens and opens with the input pre-filled. Each `CHAPTERS` entry carries `accent`, `tag`, `stats[]`, `tip`, `ask`. Hub ⇄ reader toggles re-run `initScrollFx` on the mounted view (app-level ScrollFx only re-scans on page change). `ChapterArt({id,accent})` renders a themed inline-SVG illustration per guide — no external image assets. The old scrolling-chapters + scroll-spy + collapsible-preview layout was replaced by this hub/reader design (user request, 2026-06). |
| 10736–10957 | `Dashboard()` | Main dashboard page ("Team HQ", assembles CompetitionHub/SeasonGoals/PracticeCalendar/NotebookView). **Pit-wall design (2026-07)**: graphite hero card = red license-plate team number (brand-wordmark font) + team name/region/rank chips + season W–L scoreboard + next-event countdown (derived from `store.competitions` dates) + quiet edit button. The draft/live workspace UI was REMOVED entirely (user: unnecessary) — a mount effect force-switches any stale draft mode back to prod; the store's draft plumbing still exists unused. Team setup form = number/name/region only (rank fields removed). CompetitionHub's 4 icon stat tiles are now ONE white strip (plain type, thin dividers: matches/win–loss/avg/auton% with a mini `ProgressRing`). **Data-viz (dataviz-skill specs)**: module-level `ProgressRing({pct,size,stroke,color})` (animated donut, used for auton% + SeasonGoals progress) and `ScoreTrend({matches})` (points-per-match red line+area SVG, draw-in via `.dv-draw`/`.dv-fade` keyframes in index.css, hover crosshair+tooltip, last-point direct label) — both defined just above `CompetitionHub`. Hero has a red ambient radial glow layer. Empty states use the VoltLogo mascot on a dark circle, not pastel icon chips. Do NOT reintroduce icon-chip stat tiles — user explicitly wants "not AI-looking". |
| 10958–11162 | `FloatingChat()` | "Voltz" floating AI assistant (drag-anywhere launcher, breathing-halo tap cue), available on most pages. Listens for the `voltz-ask` CustomEvent (dispatched by Resources' "Ask Voltz" buttons) → opens with the event's question pre-filled in the input |
| — | `GoogleButton`, `SignInPrompt`, `OwnerStats` | **Auth/analytics (2026-08).** `GoogleButton` = reusable "Continue with Google" (Supabase OAuth) — in AuthModal + SignInPrompt. `SignInPrompt` = engagement-triggered, dismissible sign-in nudge (mounted in app shell) — appears once the visitor passes time+scroll thresholds (`shouldPromptSignIn` in lib/analytics.js), never a hard gate, cooled-down for days, hidden for signed-in users. `OwnerStats` = PIN-gated (reuses `checkPin`) Site-stats panel in the Dashboard footer showing visits/unique-visitors/signed-in/today via the `get_site_stats()` RPC (`fetchSiteStats`); shows an "apply the migration" hint until `20260810_analytics.sql` is applied. `recordVisit()` (module-level, near getSB) inserts one `site_visits` row per browser session on app mount |
| 11163–11219 | `PageTransition`, `VexLearningHub` (default export), `VexLearningHubInner` | App shell + router (see §3). `VexLearningHubInner` mounts the single `<ToastHost/>` (lib/notify.jsx), `<SignInPrompt/>`, and calls `recordVisit(user?.id)` once on mount |

---

## 5. Backend (`backend/index.js`, Express, port 5000)

| Route | Auth | Purpose |
|---|---|---|
| `POST /register`, `POST /login` | — | Legacy AI Try-On user auth (bcrypt + JWT). Issues JWT signed with `JWT_SECRET`. |
| `GET/PUT /profile` | JWT | Legacy try-on user profile (height/weight/face data) |
| `GET /clothing`, `POST /upload/clothing` | JWT | Legacy clothing item CRUD + S3 upload (`AWS_*` env vars) |
| `POST /try-on` | JWT | Calls `services/aiService.js` → `tryOnClothing()` |
| **`POST /groq-chat`** | none (proxy) | **Active — used by VexHub's CodeLab and FloatingChat.** Proxies to `https://api.groq.com/openai/v1/chat/completions` using server-side `GROQ_API_KEY`. Frontend never sees the Groq key. Body: `{ messages, max_tokens?, temperature? }`. Model = `GROQ_MODEL` env or default `openai/gpt-oss-120b` (migrated off the deprecated `llama-3.3-70b-versatile`, decommissioned 2026-08-16). |

`vite.config.js` proxies `/api/*` → `http://localhost:5000/*` (strips `/api` prefix), so the frontend calls `/api/groq-chat`.

**Production (Vercel):** the `backend/` Express server is dev-only. In production the Groq proxy runs as a Vercel serverless function at `frontend/api/groq-chat.js` (mirrors the Express `/groq-chat`; reads `GROQ_API_KEY`/`GROQ_MODEL` from Vercel env). The frontend's `/api/groq-chat` calls hit this function — no separate backend deployed. Full launch steps in `DEPLOY.md`.

---

## 6. TeamChat (`function TeamChat()`, ~lines 8686–9971) — feature breakdown

This is the most actively-developed area. Key pieces:

- **Messaging**: generic `messages` Supabase table — `channel`, `username`, `color`, `content`, `share_type`, `share_data` (JSONB), `created_at`, `id`. `share_type` is overloaded to store config/system records too (e.g. `"channel_config"`, `"server_config"`, `"automod_config"`, `"flagged_msg"`, `"media"`, `"reaction"`) in a per-server `${serverId}_sys` channel (config types) or the message's own channel (`"reaction"`).
- **Identity is account-based (2026-08)**: the Community is **sign-in gated** (`if (!user)` → on-brand gate with `GoogleButton` + "Sign in with email"). `userDisplayName(user)` (helper right after `useAuth`) is the one canonical name (username → chat_name → Google name → email local-part), shown in Nav + used in chat. First-time signed-in users pick a name via the global `UsernameSetup` modal; a signed-in user with an identity **auto-joins** the public Community (a `autoJoinedRef`-guarded effect; a Volt veil covers the transition; "Leave server"/`disconnect` sets the guard so a manual leave isn't auto-undone). `SetupScreen` still collects a name for anyone without one.
- **Private team servers = invite links, not codes (2026-08)**: creating a server names it and generates an unguessable ~18-char token via `genServerToken()` (module-level near `PUBLIC_SERVER_ID`); the sidebar shows a copyable **invite link** (`inviteLink(id)` = `origin/?invite=TOKEN`). Opening `?invite=TOKEN` routes the app to the Community page (`hasInvite` in `VexLearningHubInner`) and the auto-join effect joins that token's server (URL cleaned via `replaceState`). `parseInvite()` extracts a token from a pasted link/token (Join field). Server name is stored in `server_config.share_data.name` so link-joiners resolve the real name; an invalid/expired invite reports plainly. Old short-code servers still resolve.
- **Reactions + emoji (2026-08)**: `EMOJI_SET`/`QUICK_EMOJI` + `EmojiPicker` (module-level, self-contained — no external lib, CSP-safe) above `MessageRow`. Compose emoji button (opens `EmojiPicker`, appends to `input`). Message reactions ride the same channel as rows with `share_type:"reaction"`, `share_data:{msgId,emoji}`; `TeamChat` aggregates them into `reactionMap` (plain derivation — past the gate returns, so NOT a hook) and filters them out of `renderedMessages`. `toggleReaction()` inserts (realtime echo appends) or deletes own reaction row (optimistic — no DELETE subscription). `MessageRow` renders reaction chips (mine = accent) + a hover toolbar (quick-react + `EmojiPicker` + delete). Reaction INSERTs skip the auto-scroll-to-bottom.
- **Presence**: Supabase Realtime Presence channel `presence:${serverId}` (ephemeral, no DB) → `members` state (online list + status dots).
- **Typing indicators**: Supabase Realtime **broadcast** channel `typing:${serverId}_${channel}` (ephemeral, no DB). Keystrokes throttle-ping (`pingTyping`, ≤1/1.4s); receivers hold `typingMap` (name→ts), pruned after 3.5s by a 1s interval; a line above the composer shows "X is typing…"/"X and Y…"/"Several people…" with the `.typing-dot` bounce (index.css). Scoped per channel; excludes self.
- **Realtime**: Supabase `postgres_changes` subscriptions for messages, automod config/flags, and IP bans.
- **Automod (text matching)**:
  - `automodRules` (regex or substring patterns + `block`/`flag` action), stored as `share_type: "automod_config"`.
  - `matchesAutomod()`, `saveAutomodRules()`, `addAutomodRule()`, `removeAutomodRule()`.
  - Flagged messages → `share_type: "flagged_msg"` with `{ content, username, ip, channel, matchedPattern, timestamp }`. `approveFlagged()` / `deleteFlagged()` manage the queue.
- **Owner-only access control**:
  - Automod panel is hidden entirely unless `ownerUnlocked === true`.
  - Unlock flow: type `/automod` in the chat input → opens a PIN prompt → `checkPin()` (SHA-256 compares against `VITE_OWNER_PIN_HASH`) → on success sets `ownerUnlocked = true` (session-only, resets on reload) and opens the Automod panel.
- **IP bans**:
  - Dedicated `ip_blacklist` table (migration `20260608_ip_blacklist.sql`), columns: `id, ip, username, banned_at, banned_by`. Realtime-synced into `bannedIps` state.
  - `userIp` fetched once via `https://api.ipify.org?format=json`.
  - `banIp()` / `unbanIp()`. `send()` checks `bannedIps.includes(userIp)` before allowing a message.
- **Media uploads** (`handleFilePick`, `sendMedia`):
  - Per-file limit: `MAX_FILE_BYTES` = 40MB (client check + Supabase Storage `chat-media` bucket `file_size_limit` set to 41943040 via migration `20260610_upload_limits.sql`).
  - Per-user daily cap: `DAILY_UPLOAD_BYTES` = 40MB/day, tracked in `upload_usage` table (`username, upload_date, bytes_used`, unique on `username+upload_date`). Checked/upserted in `sendMedia()`.
  - Uploads go to Supabase Storage bucket `chat-media`; message row gets `share_type: "media"`, `share_data: { url, mediaType, fileName }`.
- **Rate limiting**: `lastSendRef` (a ref, not state) + `SEND_COOLDOWN_MS` (1.2s) — shared cooldown across `send()` (text) and `sendMedia()` (uploads). Too-fast sends get an inline error, no server-side enforcement.
- **Guard logic is extracted & tested**: the automod match, rate-limit, IP-ban, and daily-upload checks are pure functions in `lib/chatGuards.js` (`matchAutomod`, `isRateLimited`, `isIpBanned`, `checkDailyUpload`, `isFileSizeOk`, `formatBytes`) with the limit constants (`MAX_FILE_BYTES`, `DAILY_UPLOAD_BYTES`, `SEND_COOLDOWN_MS`). `TeamChat` imports and calls them — do NOT re-inline this logic. **These are UX guards, not security boundaries** (see SECURITY.md).
- **Upload quota indicator**: `dailyUsedBytes` state (loaded from `upload_usage` on mount) drives a "X left today" readout in the pending-file preview card.
- **Logging**: `TeamChat` uses a module-scoped `chatLog = createLogger("chat")`; upload/automod/IP events are logged instead of failing silently.
- **Join/Create validation**: `handleSetup` is async — before committing, it checks whether a `server_config` record exists for the token and rejects join-of-nonexistent / create-of-existing via `validateServerChoice()` (pure, in `chatGuards.js`); it also pulls `share_data.name` from that record so a link-joiner sees the real server name. Fail-open if the lookup itself errors.
- **Realtime resilience**: the message subscription logs lifecycle status (`CHANNEL_ERROR`/`TIMED_OUT` → warn) and a `window "online"` listener refetches the channel after a network blip.

> **Server-side enforcement (the real boundary) is NOT live yet.** `supabase/functions/owner-action/index.ts` + `20260610_security_hardening.sql` are deploy-ready but require the steps in SECURITY.md. Until deployed, IP bans / automod writes go directly from the client with the anon key.

---

## 7. Secrets & env vars

**Frontend** (`frontend/.env.local`, gitignored, `VITE_` prefix = embedded in client bundle — only non-secret/public values go here):
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_KEY` — Supabase project URL + **publishable** anon key (safe to expose; access controlled via RLS policies).
- `VITE_LIVEKIT_URL` — LiveKit Cloud WebSocket URL (public).
- `VITE_OWNER_PIN_HASH` — SHA-256 hash of the Automod owner PIN. The hash is safe to expose, but note the client-side PIN check is **UI-only** (gates the panel's visibility, not the DB writes). The real server-side check uses a separate `OWNER_PIN_HASH` secret in the `owner-action` Edge Function — see SECURITY.md. Also gates the owner Site-stats panel.

**Google OAuth setup (one-time, in the Supabase dashboard — not in this repo):** Authentication → Providers → enable **Google**, paste a Google Cloud OAuth **client ID + secret**, and add the Supabase callback URL to the Google console's authorized redirect URIs. Until this is done, "Continue with Google" returns an error (handled gracefully in `GoogleButton`). No new frontend env var is needed — it uses the existing Supabase client.
**Analytics setup:** apply `supabase/migrations/20260810_analytics.sql` (creates `site_visits` + `get_site_stats()`). Until then, visit inserts 404 harmlessly and the Site-stats panel shows a "not set up yet" hint.
- (removed) `groqApiKey` in localStorage — older CodeLab builds stored a personal Groq key in plaintext localStorage. That flow is deleted; CodeLab now calls the `/api/groq-chat` proxy and a one-time effect purges any lingering key.

**Backend** (`backend/.env`, gitignored — true secrets, never sent to client):
- `JWT_SECRET`, `GROQ_API_KEY`, `DB_*`, plus (if used) `AWS_*` for S3. Optional `GROQ_MODEL` overrides the chat model (default `openai/gpt-oss-120b`).

**Supabase Edge Function** (`supabase/functions/livekit-token`):
- `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` — set via Supabase project secrets, not in this repo.

**Rule for agents**: never put a true secret (API key that grants write/spend access) behind a `VITE_` variable — it ends up in the client bundle. True secrets go through the Express backend (`/groq-chat` pattern) or Supabase Edge Functions.

---

## 8. Known issues / housekeeping notes

- `Resources()` throws a React console error on load — pre-existing, not yet diagnosed. **Now contained**: the app-level `ErrorBoundary` (§10) catches it instead of white-screening the whole SPA, so a crash there shows a recovery screen rather than killing every page.
- `frontend/src/components/oracleJdk-25.jdk/` is a full Oracle JDK 25 installation accidentally committed inside the React source tree (hundreds of files, large binaries). It is unused by the app. Safe to delete, but do so as its own cleanup task (not bundled into feature work).
- `App.jsx` and `src/components/{Auth,ProfileSetup,ClothingUpload,ClothingGallery}.jsx` are legacy AI Try-On frontend pieces, currently dead code (not imported by `index.jsx`). The matching backend routes in `backend/index.js` (`/register`, `/login`, `/profile`, `/clothing`, `/upload/clothing`, `/try-on`) are still live but unused by the current frontend.

---

## 10. Testing & logging

- **Test runner**: Vitest (jsdom). Config lives in the `test` block of `frontend/vite.config.js`; global setup in `src/test/setup.js`.
- **Run**: `cd frontend && npm test` (single run) or `npm run test:watch`.
- **Coverage today** (`src/lib/*.test.{js,jsx}`):
  - `chatGuards.test.js` — automod matching (regex + substring fallback + bad input), IP-ban fail-open, rate-limit windows, daily-upload accounting, file-size cap, server join/create validation, formatting, constant values.
  - `notify.test.jsx` — toast render/auto-dismiss/click-dismiss/stack-cap/a11y role, confirm dialog resolve-true/false, Escape + backdrop cancel, second-dialog-cancels-first.
  - `sanitizers.test.js` — digits-only (signs/decimals/exponents stripped), letters-only word fields, VEX team-number format (1–5 digits + optional uppercase letter, leading letter dropped).
  - `scrollFx.test.jsx` — variant→vars mapping, reduced-motion disable, trigger creation/cleanup, in-view-immediate fail-safe (elements are never pre-hidden awaiting a trigger), empty-stagger guard, CSS-transition suspension (jank fix), parallax scrub triggers, data-count-to counters (deferred/immediate/junk/reduced-motion), useScrollSpy (per-section triggers + cleanup + missing ids), animatePageEnter/animateSwap/popIn no-op paths, ScrollProgress mount/unmount. Note: jsdom has no layout (all rects top 0), so tests patch `getBoundingClientRect` to simulate below-fold elements; `src/test/setup.js` polyfills `matchMedia` because GSAP needs listener methods jsdom lacks.
  - `theme.test.js` — WCAG contrast math (canonical extremes, junk input) and AA assertions on the REAL token pairings used in the UI (text-on-surface, white-on-brand, light-text-on-dark, semantics-on-white) — a palette tweak below AA fails the suite.
  - `logger.test.js` — ring-buffer recording/capping, `guard()` success/throw paths, never-throws-on-broken-console, localStorage verbosity override.
  - `ErrorBoundary.test.jsx` — renders children, catches render errors, logs to the ring buffer, "Try again" recovery.
  - `analytics.test.js` — visitor-id create-once/reuse/persist/fallback, one-visit-per-session, `shouldPromptSignIn` thresholds (time+scroll+cooldown+signed-in), prompt-timestamp round-trip.
- **When you add logic to `lib/`, add/extend its `.test.js`.** Prefer extracting non-trivial logic out of `VexHub.jsx` into a pure `lib/` module so it can be tested (as was done for chat guards).
- **Logging**: use `createLogger(scope)` from `lib/logger.js` instead of empty `catch {}` or bare `console.*`. Levels: `debug`/`info` (dev only), `warn`/`error` (always). `logger.guard(label, fn, fallback)` wraps a throwing call so failures are logged, not swallowed. Recent entries are in an in-memory ring buffer (`getLogBuffer()`), surfaced by the ErrorBoundary's "Copy diagnostics" button. Override verbosity in a deployed build via `localStorage.setItem("vexhub_log", "debug")`.
- Existing module loggers: `supabase` (getSB init), `codelab`/`aiLog` (Rio AI requests), `chat` (TeamChat events), `error-boundary`.

## 11. Maintenance instructions for agents

1. Before grepping/reading `VexHub.jsx` broadly, check §4's component map for the area you need (re-anchor exact lines with grep — they drift).
2. When you add a new Supabase table/migration, add a row to the `supabase/migrations/` listing in §2 and a one-line description in the relevant feature section (§6, etc.).
3. When you add/change env vars, update §7. When you change a security boundary, update SECURITY.md.
4. When you add a new top-level component/page to `VexHub.jsx`, update §4.
5. When you add a `lib/` module or test, update §10.
6. Prefer extracting testable logic into `lib/` and logging via `createLogger` rather than inlining + swallowing errors.
6a. Never use native `alert()`/`window.confirm()` — use `notify()` / `await confirmDialog()` from `lib/notify.jsx` (ToastHost is already mounted in the app shell).
6b. For motion/animation, use the GSAP system in `lib/scrollFx.jsx` — `data-reveal` / `data-parallax` attributes for scroll effects, `useSwapAnimation` for tab switches, `animatePageEnter` for page-level entrances, `popIn` for floating UI. Do NOT write ad-hoc per-component GSAP code or CSS keyframe entrances. Content pages only; never on CodeLab/CAD/TeamChat internals (they own their scroll containers). Page transitions run through `PageTransition` (GSAP-driven, in VexHub.jsx).
6c. For colors, use `PALETTE` / `LIGHT_CARD` from `lib/theme.js` instead of hardcoding hex values. Dark tool surfaces = `PALETTE.dark` family (navy-tinted, used by CodeLab/CAD); light pages = `PALETTE.light` (tinted page + white cards). New token pairings must pass the AA assertions in `theme.test.js`.
6d. The site uses the **Apple design language** (user-requested), EXCEPT the Home page hero/features which the user explicitly wants kept in the original red/black VEX style — do not Apple-ify Home content. Rules elsewhere: pages are flat `#f5f5f7` (`LIGHT_PAGE_BG`) or graphite (`DARK_PAGE_BG`/`PALETTE.dark`); headings are `#1d1d1f` semibold tracking-tight (NOT gradient); tab bars are segmented controls (track `#e8e8ed`, active = white pill + soft shadow); CTAs are `#0071e3` pills (`APPLE_PILL`); the Nav is the thin frosted bar (12px links, blue Sign In pill); body font = system/SF stack set in `index.css`. `gradientText`/`BRAND_GRADIENT`/`GLASS_CARD` remain exported+tested in theme.js but are currently unused by the app.
7. Keep this file's tables terse — one line per item. Detailed code lives in the source; this file is a map, not documentation duplication.
