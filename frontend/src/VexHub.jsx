import React, { useState, useCallback, useRef, useEffect } from "react";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { LiveKitRoom, VideoConference, RoomAudioRenderer, ControlBar, PreJoin } from "@livekit/components-react";
import { VideoPresets } from "livekit-client";
import "@livekit/components-styles";
import Editor from "@monaco-editor/react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import * as THREE from "three";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { OrbitControls, Text, Environment, useGLTF, RoundedBox } from "@react-three/drei";
import ErrorBoundary from "./lib/ErrorBoundary.jsx";
import { createLogger } from "./lib/logger.js";
import {
  matchAutomod, containsBannedWord, isIpBanned, isRateLimited, checkDailyUpload, isFileSizeOk, formatBytes,
  validateServerChoice, MAX_FILE_BYTES, DAILY_UPLOAD_BYTES, SEND_COOLDOWN_MS,
} from "./lib/chatGuards.js";
// Refinement: styled toast + async confirm replacing native alert()/window.confirm()
import { ToastHost, notify, confirmDialog } from "./lib/notify.jsx";
// Visitor analytics + engagement-triggered sign-in nudge (pure logic + tests).
// shouldPromptSignIn/getLastPromptAt/markPromptShown are still exported + tested
// in lib/analytics.js, but no longer imported here — SignInPrompt is now a hard
// timed gate rather than an engagement-triggered, cooled-down nudge.
import { getVisitorId, isNewSession } from "./lib/analytics.js";
// Refinement: per-field input sanitizers (digits-only / letters-only / VEX team number)
import { sanitizeLetters, sanitizeTeamNumber } from "./lib/sanitizers.js";
// Refinement: GSAP ScrollTrigger design language — elements marked data-reveal
// get scroll-triggered entrances; <ScrollFx/> re-scans on each page switch.
import { ScrollFx, animatePageEnter, useSwapAnimation, popIn, useScrollSpy, prefersReducedMotion, initScrollFx, refreshScrollFx, floatIdle } from "./lib/scrollFx.jsx";
// Design tokens — single source of truth for the site's color system (lib/theme.js)
import { PALETTE, LIGHT_CARD, LIGHT_PAGE_BG, DARK_PAGE_BG } from "./lib/theme.js";

const ROBOT_IMAGE = "/robot.jpg";

// ─────────────────────────────────────────────────────────────────
//  PERSISTENT DATA STORE  (localStorage-backed)
//  Two databases: production ("vexhub_v1") and draft ("vexhub_v1_draft")
// ─────────────────────────────────────────────────────────────────
const STORE_KEY_PROD  = "vexhub_v1";
const STORE_KEY_DRAFT = "vexhub_v1_draft";
const MODE_KEY        = "vexhub_mode"; // "prod" | "draft"

// Mapping lesson titles → skill category
const LESSON_SKILL = {
  "VEX Basics":               "Structure & Build",
  "Autonomous Programming":   "Autonomous",
  "Robot Design":             "Structure & Build",
  "Competition Strategy":     "Competition IQ",
  "Hello, World!":            "Sensors & Code",
  "Variables & Data Types":   "Sensors & Code",
  "Operators":                "Sensors & Code",
  "If / Else Statements":     "Sensors & Code",
  "Loops — for & while":      "Sensors & Code",
  "Functions":                "Sensors & Code",
  "Arrays & Vectors":         "Sensors & Code",
  "Strings":                  "Sensors & Code",
  "Classes & Objects":        "Sensors & Code",
  "VEX C++ Basics":           "Sensors & Code",
};

function defaultStore() {
  return {
    team: { number: "", name: "", region: "" },
    completedLessons: [],
    lessonTimeMs: {},
    cadSessions: 0,
    cadPartsPlaced: 0,
    recentActivity: [],
    earnedBadges: [],
    setupDone: false,
    competitions: [],   // { id, name, date, location, type, matches[], finalRank, qualified, skills:{driver,programming} }
    goals: [],          // { id, text, category, priority, done, createdAt, completedAt }
    practices: [],      // { id, date "YYYY-MM-DD", title, type, duration, notes, done }
  };
}

// Tiny unique id
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function loadStore(key) {
  try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : null; } catch { return null; }
}
function saveStore(key, d) {
  try { localStorage.setItem(key, JSON.stringify(d)); } catch {}
}
function getStore(key) { return { ...defaultStore(), ...loadStore(key) }; }

// Derived helpers
function totalStudyMs(s) { return Object.values(s.lessonTimeMs || {}).reduce((a, b) => a + b, 0); }
function avgStudyMsPerLesson(s) {
  const keys = Object.keys(s.lessonTimeMs || {});
  if (!keys.length) return 0;
  return totalStudyMs(s) / keys.length;
}

function computeSkillPct(s) {
  const totals = {}, earned = {};
  Object.values(LESSON_SKILL).forEach(sk => { totals[sk] = (totals[sk]||0)+1; });
  (s.completedLessons||[]).forEach(t => {
    const sk = LESSON_SKILL[t];
    if (sk) earned[sk] = (earned[sk]||0)+1;
  });
  const skills = [
    { name:"Structure & Build", color:"#3b82f6" },
    { name:"Sensors & Code",    color:"#8b5cf6" },
    { name:"Autonomous",        color:"#06b6d4" },
    { name:"Drive Systems",     color:"#10b981" },
    { name:"Competition IQ",    color:"#f59e0b" },
    { name:"Pneumatics",        color:"#ef4444" },
  ];
  return skills.map(sk => ({
    ...sk,
    pct: Math.round(((earned[sk.name]||0) / Math.max(totals[sk.name]||1, 1)) * 100),
  }));
}

function checkBadges(s) {
  const badges = [...(s.earnedBadges||[])];
  const add = id => { if (!badges.includes(id)) badges.push(id); };
  if ((s.completedLessons||[]).length >= 1) add("first-lesson");
  if ((s.completedLessons||[]).length >= 5) add("five-lessons");
  if ((s.completedLessons||[]).length >= 10) add("ten-lessons");
  if ((s.cadPartsPlaced||0) >= 1)   add("first-build");
  if ((s.cadPartsPlaced||0) >= 50)  add("50-parts");
  if ((s.cadPartsPlaced||0) >= 100) add("100-parts");
  if ((s.cadSessions||0) >= 3) add("serial-builder");
  return { ...s, earnedBadges: badges };
}

function pushActivity(s, action, item, col) {
  const now = new Date();
  const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const act = { action, item, time, ts: Date.now(), col };
  return { ...s, recentActivity: [act, ...(s.recentActivity||[])].slice(0, 30) };
}

// React context — dual-database (production + draft) + Supabase cloud sync
const StoreCtx = React.createContext(null);
function StoreProvider({ children }) {
  const auth = React.useContext(AuthCtx); // may be null if AuthProvider not mounted yet
  const user = auth?.user ?? null;

  const [mode, setModeState] = React.useState(() =>
    localStorage.getItem(MODE_KEY) === "draft" ? "draft" : "prod"
  );
  const activeKey = mode === "draft" ? STORE_KEY_DRAFT : STORE_KEY_PROD;

  const [store, setStore]         = React.useState(() => getStore(activeKey));
  const [cloudSynced, setCloudSynced] = React.useState(false);
  const [syncing, setSyncing]     = React.useState(false);
  const saveTimerRef              = React.useRef(null);

  // ── Supabase helpers ──────────────────────────────────────────
  const sbLoad = React.useCallback(async (uid, m) => {
    const sb = getSB();
    if (!sb) return null;
    const { data } = await sb
      .from("dashboard_data")
      .select("data")
      .eq("user_id", uid)
      .eq("mode", m)
      .maybeSingle();
    return data?.data ?? null;
  }, []);

  const sbSave = React.useCallback(async (uid, m, d) => {
    const sb = getSB();
    if (!sb) return;
    await sb.from("dashboard_data").upsert(
      { user_id: uid, mode: m, data: d, updated_at: new Date().toISOString() },
      { onConflict: "user_id,mode" }
    );
  }, []);

  // ── On user sign-in / mode change: load from cloud ───────────
  React.useEffect(() => {
    if (!user) { setCloudSynced(false); return; }
    let cancelled = false;
    setSyncing(true);
    sbLoad(user.id, mode).then(cloudData => {
      if (cancelled) return;
      if (cloudData) {
        const merged = { ...defaultStore(), ...cloudData };
        setStore(merged);
        saveStore(activeKey, merged);
      } else {
        // First time this user+mode — push local data to cloud
        sbSave(user.id, mode, getStore(activeKey));
      }
      setCloudSynced(true);
      setSyncing(false);
    }).catch(() => { if (!cancelled) setSyncing(false); });
    return () => { cancelled = true; };
  }, [user?.id, mode]); // eslint-disable-line

  // ── Switch mode ───────────────────────────────────────────────
  const switchMode = React.useCallback((newMode) => {
    const key = newMode === "draft" ? STORE_KEY_DRAFT : STORE_KEY_PROD;
    localStorage.setItem(MODE_KEY, newMode);
    setModeState(newMode);
    setStore(getStore(key));
    setCloudSynced(false); // will re-sync via effect
  }, []);

  // ── Publish draft → production ────────────────────────────────
  const publishDraft = React.useCallback(async () => {
    const draft = getStore(STORE_KEY_DRAFT);
    saveStore(STORE_KEY_PROD, draft);
    if (user) await sbSave(user.id, "prod", draft);
  }, [user, sbSave]);

  // ── Load production → draft ───────────────────────────────────
  const loadProdIntoDraft = React.useCallback(async () => {
    let prod = getStore(STORE_KEY_PROD);
    if (user) {
      const cloud = await sbLoad(user.id, "prod");
      if (cloud) prod = { ...defaultStore(), ...cloud };
    }
    saveStore(STORE_KEY_DRAFT, prod);
    if (user) await sbSave(user.id, "draft", prod);
    if (mode === "draft") setStore(prod);
  }, [user, mode, sbLoad, sbSave]);

  // ── Update — local immediately, cloud debounced 800ms ─────────
  const update = React.useCallback((fn) => {
    setStore(prev => {
      const next = checkBadges(fn(prev));
      saveStore(activeKey, next);
      // Debounced cloud save
      if (user) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => sbSave(user.id, mode, next), 800);
      }
      return next;
    });
  }, [activeKey, user, mode, sbSave]);

  return (
    <StoreCtx.Provider value={{ store, update, mode, switchMode, publishDraft, loadProdIntoDraft, cloudSynced, syncing, user }}>
      {children}
    </StoreCtx.Provider>
  );
}
function useStore() { return React.useContext(StoreCtx); }

// ─────────────────────────────────────────────────────────────────
//  AUTH CONTEXT  (Supabase Auth)
// ─────────────────────────────────────────────────────────────────
const AuthCtx = React.createContext(null);
function AuthProvider({ children }) {
  const [user, setUser]               = React.useState(null);
  const [authLoading, setAuthLoading] = React.useState(true);
  // True for the window between someone clicking a "reset your password" email
  // link and actually setting a new one. Supabase's recovery link signs them
  // in via a short-lived token and fires this specific event so the app can
  // gate them into a "set new password" screen instead of dropping them
  // straight into the app as if they'd signed in normally.
  const [passwordRecovery, setPasswordRecovery] = React.useState(false);

  React.useEffect(() => {
    const sb = getSB();
    if (!sb) { setAuthLoading(false); return; }
    sb.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      setAuthLoading(false);
    });
    const { data: { subscription } } = sb.auth.onAuthStateChange((ev, session) => {
      setUser(session?.user ?? null);
      if (ev === "PASSWORD_RECOVERY") setPasswordRecovery(true);
    });
    return () => subscription.unsubscribe();
  }, []);

  const signIn  = (email, pw) => getSB().auth.signInWithPassword({ email, password: pw });
  const signUp  = (email, pw) => getSB().auth.signUp({ email, password: pw });
  const signOut = ()          => getSB().auth.signOut();
  // Emails a one-time reset link; clicking it brings them back here signed in
  // via a recovery session, which flips passwordRecovery above.
  const resetPasswordForEmail = (email) => {
    const sb = getSB();
    if (!sb) return Promise.resolve({ error: { message: "Auth unavailable" } });
    return sb.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
  };
  // Sets the new password during a recovery session, then signs out — the
  // recovery session is a special short-lived credential (from clicking the
  // emailed link), not a real login, so it deliberately does NOT leave them
  // signed in. They confirm the new password actually works by signing back
  // in with it themselves, same as anyone else.
  const updatePasswordAndClearRecovery = async (newPassword) => {
    const { error } = await getSB().auth.updateUser({ password: newPassword });
    if (!error) {
      await getSB().auth.signOut();
      setPasswordRecovery(false);
    }
    return { error };
  };
  // Google OAuth — redirects to Google's consent screen, then back to the app.
  // Requires the Google provider enabled in the Supabase dashboard (see SECURITY.md).
  const signInWithGoogle = () => {
    const sb = getSB();
    if (!sb) return Promise.resolve({ error: { message: "Auth unavailable" } });
    return sb.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: window.location.origin,
        // Always show Google's "Choose an account" chooser (lists the user's
        // signed-in accounts) instead of jumping straight into one.
        queryParams: { prompt: "select_account" },
      },
    });
  };

  return (
    <AuthCtx.Provider value={{ user, authLoading, signIn, signUp, signOut, signInWithGoogle, resetPasswordForEmail, passwordRecovery, updatePasswordAndClearRecovery }}>
      {children}
    </AuthCtx.Provider>
  );
}
function useAuth() { return React.useContext(AuthCtx); }

// One canonical display identity for a signed-in user: the username they chose
// (stored in user_metadata), falling back to their Google name, then the email
// local-part. Used by the Nav corner AND the Community chat so identity is one
// thing everywhere — never the raw email.
function userDisplayName(user) {
  const m = user?.user_metadata || {};
  return m.username || m.chat_name || m.full_name || m.name || (user?.email ? user.email.split("@")[0] : "");
}

// ---------- DATA ----------
const lessons = [
  {
    title: "VEX Basics",
    description: "A complete introduction to VEX Robotics — every component, competition format, and team role explained in full detail.",
    level: "Beginner",
    duration: "15 min read",
    color: "red",
    topics: ["Robot Parts", "Electronics", "Sensors", "Structure", "Competition Rules", "Team Roles"],
    sections: [
      {
        heading: "What is VEX Robotics?",
        body: "VEX Robotics is one of the largest and most prestigious competitive robotics programs in the world, with over 20,000 teams competing across 50+ countries. Students design, build, and program robots from scratch to compete in a brand-new game challenge every season.\n\nThe main programs are:\n• **VEX IQ** — for middle school students, uses snap-together plastic components.\n• **VEX V5** — for high school and college, uses metal structure and smart electronics.\n• **VEX U** — university-level competition with fewer restrictions.\n\nEach spring, the next season's game is revealed at the VEX World Championship (held every April/May). Teams then spend the entire school year building, testing, and competing at tournaments leading up to the following Worlds.",
        callout: { type: "info", text: "The VEX World Championship is held every April/May and features thousands of teams from around the globe — it is one of the largest STEM events in the world." },
      },
      {
        heading: "The V5 Brain — Your Robot's Computer",
        body: "The **V5 Brain** is the central computer of every VEX V5 robot. It runs your C++ program, communicates with all connected devices, and displays real-time information on its color touchscreen.\n\nKey specs:\n• **21 Smart Ports** — connect motors, sensors, and other smart devices via VEX Smart Cables.\n• **8 Three-Wire (ADI) Ports** (A–H) — connect legacy analog/digital devices (bumper switches, potentiometers, pneumatic solenoids).\n• **Dual-core ARM Cortex-A9 processor** — plenty of headroom for multitasking sensor loops.\n• **8 program slots** plus a microSD card slot for data logging.\n• **Full-color 480×272 touchscreen** for displaying sensor values, program selection, and debug info.\n• **Wireless downloads and field connection** via the V5 Robot Radio and controller link.\n• **USB port** for direct programming via USB cable.",
        components: [
          { emoji: "🧠", img: "/part-brain.jpg", name: "V5 Brain", color: "bg-red-50 border-red-200", badge: "bg-red-100 text-red-700", desc: "Central computer — runs your code, connects all smart devices via 21 ports, features a color touchscreen." },
          { emoji: "🔋", img: "/part-battery.jpg", name: "V5 Battery", color: "bg-orange-50 border-orange-200", badge: "bg-orange-100 text-orange-700", desc: "Rechargeable 12.8V LiFePO4 battery. Powers the entire robot for a full day of competition." },
          { emoji: "🎮", img: "/part-controller.jpg", name: "V5 Controller", color: "bg-yellow-50 border-yellow-200", badge: "bg-yellow-100 text-yellow-700", desc: "Wireless gamepad with 2 joysticks, 8 buttons, LCD screen, and 2.4 GHz radio link to the Brain." },
          { emoji: "🔌", img: "/part-cables.jpg", name: "Smart Cables", color: "bg-blue-50 border-blue-200", badge: "bg-blue-100 text-blue-700", desc: "Connect motors and sensors to Brain ports. Available in multiple lengths (6in to 4ft)." },
        ],
        callout: { type: "tip", text: "Always plug the Brain into your computer via USB before your first program download. Wireless programming requires an initial USB setup." },
      },
      {
        heading: "V5 Smart Motors",
        body: "The **V5 Smart Motor** is a self-contained motor with a built-in encoder, temperature sensor, and motor controller. Unlike older systems where you need separate components, the V5 motor reports everything back to the Brain automatically.\n\nTechnical specs:\n• **11W of continuous power** — one of the most powerful motors in student robotics.\n• **Up to 100 RPM, 200 RPM, or 600 RPM** depending on the installed cartridge.\n• **High-resolution built-in encoder** — precise position tracking with no extra wiring.\n• **Thermal protection** — automatically reduces power when overheated.\n• **Smart Cable port** — plug directly into any of the 21 Brain ports.\n\nMotor Cartridge Colors:\n• 🔴 **Red Cartridge** — 100 RPM, maximum torque. Best for lifts and mechanisms needing lots of power.\n• 🟢 **Green Cartridge** — 200 RPM, balanced speed and torque. Best for most drive bases.\n• 🔵 **Blue Cartridge** — 600 RPM, maximum speed, low torque. Best for flywheels and fast spinning mechanisms.",
        components: [
          { emoji: "⚙️", name: "Red (100 RPM)", color: "bg-red-50 border-red-200", badge: "bg-red-100 text-red-700", desc: "High torque. Best for lifts, claws, and mechanisms that need to hold heavy loads." },
          { emoji: "⚙️", name: "Green (200 RPM)", color: "bg-green-50 border-green-200", badge: "bg-green-100 text-green-700", desc: "Balanced. Standard choice for drive bases and general mechanisms." },
          { emoji: "⚙️", name: "Blue (600 RPM)", color: "bg-blue-50 border-blue-200", badge: "bg-blue-100 text-blue-700", desc: "High speed, low torque. Used for flywheels, intakes, and rapid spinning mechanisms." },
        ],
        callout: { type: "warning", text: "The rules limit total motor power to 88W per robot — that's 8× 11W motors, or a mix of 11W and 5.5W motors that stays under the cap. Plan your motor allocation carefully before building." },
      },
      {
        heading: "V5 Controller",
        body: "The **V5 Controller** is the wireless gamepad that your driver uses during matches. It connects to the Brain via a 2.4 GHz radio link with extremely low latency.\n\nLayout and features:\n• **Two joysticks** (Axis 1–4) — smooth analog control, reads values from -127 to +127.\n• **12 digital buttons** — 4 face buttons (A, B, X, Y), 4 shoulder buttons (L1, L2, R1, R2), and the Up/Down/Left/Right directional buttons.\n• **LCD screen** — shows battery %, connected status, and custom text from your code.\n• **Rumble motor** — provides haptic feedback you can trigger in code.\n• **USB charging port** — charges the internal battery.\n• **Tether port** — connect a second controller for a partner driver.",
        components: [
          { emoji: "🕹️", img: "/part-controller.jpg", name: "V5 Controller", color: "bg-purple-50 border-purple-200", badge: "bg-purple-100 text-purple-700", desc: "Two joysticks (Axis 1–4), 4 face buttons, 4 shoulder buttons, D-pad, LCD screen, and rumble motor." },
          { emoji: "🔘", name: "Left Joystick (Axis 3/4)", color: "bg-indigo-50 border-indigo-200", badge: "bg-indigo-100 text-indigo-700", desc: "Axis 3 = vertical (-127 to 127), Axis 4 = horizontal. Typically controls forward/backward drive." },
          { emoji: "🔘", name: "Right Joystick (Axis 1/2)", color: "bg-teal-50 border-teal-200", badge: "bg-teal-100 text-teal-700", desc: "Axis 2 = vertical, Axis 1 = horizontal. Typically controls turning or secondary mechanisms." },
          { emoji: "🔴", name: "Shoulder Buttons L1/L2/R1/R2", color: "bg-gray-50 border-gray-200", badge: "bg-gray-100 text-gray-700", desc: "Digital on/off buttons. Ideal for triggering lifts, intakes, claws, and pneumatic solenoids." },
        ],
      },
      {
        heading: "All VEX Sensors Explained",
        body: "Sensors give your robot the ability to perceive and react to the world. Modern V5 sensors plug into the Brain's Smart Ports; legacy sensors like the Bumper Switch and Light Sensor use the Three-Wire (ADI) ports.",
        components: [
          { emoji: "🧭", img: "/part-inertial.jpg", name: "Inertial Sensor", color: "bg-blue-50 border-blue-200", badge: "bg-blue-100 text-blue-700", desc: "Measures rotation, heading (0–360°), and acceleration on all 3 axes. Essential for accurate turns in autonomous." },
          { emoji: "📏", img: "/part-distance.jpg", name: "Distance Sensor", color: "bg-green-50 border-green-200", badge: "bg-green-100 text-green-700", desc: "Uses laser time-of-flight to measure distance (20mm–2000mm). Detects walls, goals, and game objects." },
          { emoji: "🔄", img: "/part-rotation.jpg", name: "Rotation Sensor", color: "bg-orange-50 border-orange-200", badge: "bg-orange-100 text-orange-700", desc: "Measures absolute shaft angle (0–360°) with 0.088° precision. Used for tracking lift height or arm position." },
          { emoji: "🌈", img: "/part-optical.jpg", name: "Optical Sensor", color: "bg-purple-50 border-purple-200", badge: "bg-purple-100 text-purple-700", desc: "Detects color (hue, saturation, brightness), proximity, and gesture. Used for sorting game pieces by color." },
          { emoji: "📷", img: "/part-vision.jpg", name: "Vision Sensor", color: "bg-red-50 border-red-200", badge: "bg-red-100 text-red-700", desc: "Camera that tracks color signatures and returns the X/Y position of detected objects. Useful for autonomous targeting." },
          { emoji: "👆", img: "/part-bumper.jpg", name: "Bumper Switch", color: "bg-yellow-50 border-yellow-200", badge: "bg-yellow-100 text-yellow-700", desc: "Simple contact switch that returns true/false. Used as limit switches on lifts and mechanisms." },
          { emoji: "🔆", img: "/part-light.jpg", name: "Light Sensor", color: "bg-amber-50 border-amber-200", badge: "bg-amber-100 text-amber-700", desc: "Measures ambient light or reflected light. Can detect field lines or light-colored tiles." },
          { emoji: "📡", img: "/part-gps.jpg", name: "GPS Sensor", color: "bg-cyan-50 border-cyan-200", badge: "bg-cyan-100 text-cyan-700", desc: "Reads VEX field GPS strips to give absolute X/Y position on the field. Enables odometry-free localization." },
        ],
        callout: { type: "tip", text: "The Inertial Sensor is the most commonly used sensor for autonomous. Always call InertialSensor.calibrate() before using it — calibration takes about 2 seconds." },
      },
      {
        heading: "Structure & Hardware Components",
        body: "VEX metal structure forms the skeleton of your robot. All pieces use a standardized 0.5\" hole spacing, meaning everything lines up perfectly.",
        components: [
          { emoji: "📐", img: "/part-c-channel.jpg", name: "C-Channel", color: "bg-slate-50 border-slate-200", badge: "bg-slate-100 text-slate-700", desc: "The backbone of VEX robots. Comes in 1×2, 1×3, 1×5, 2×2, 2×4 sizes. Strong in bending, used for arms and frames." },
          { emoji: "📏", img: "/part-flat-plate.jpg", name: "Angle Bar / Flat Plate", color: "bg-gray-50 border-gray-200", badge: "bg-gray-100 text-gray-700", desc: "Flat plates add broad mounting surfaces; angle bars provide rigid L-shaped bracing for corners and joints." },
          { emoji: "🔩", img: "/part-standoffs.jpg", name: "Standoff / Spacer", color: "bg-zinc-50 border-zinc-200", badge: "bg-zinc-100 text-zinc-700", desc: "Spacer used to create gaps between plates or brace structures at a fixed distance. Comes in nylon and aluminum." },
          { emoji: "🪛", img: "/part-hardware.jpg", name: "Screws & Keps Nuts", color: "bg-stone-50 border-stone-200", badge: "bg-stone-100 text-stone-700", desc: "8-32 thread screws in various lengths (0.25\" to 2\"). Keps nuts self-lock to prevent loosening from vibration." },
          { emoji: "⚙️", img: "/part-gears.jpg", name: "Gears & Sprockets", color: "bg-orange-50 border-orange-200", badge: "bg-orange-100 text-orange-700", desc: "12T to 84T gears for power transmission. Sprockets and chain are used for long-distance power transfer." },
          { emoji: "🔗", name: "High-Strength Axles", color: "bg-blue-50 border-blue-200", badge: "bg-blue-100 text-blue-700", desc: "Square-profile steel axles in 2\"–6\" lengths. Used for drivetrain wheels and high-torque applications." },
          { emoji: "🛞", img: "/part-wheels.jpg", name: "Drive Wheels", color: "bg-green-50 border-green-200", badge: "bg-green-100 text-green-700", desc: "Available in 2.75\", 3.25\", and 4\" diameters. Traction wheels grip the field surface for maximum pushing power." },
          { emoji: "🔄", img: "/part-omni-wheels.jpg", name: "Omni Wheels", color: "bg-teal-50 border-teal-200", badge: "bg-teal-100 text-teal-700", desc: "Rollers around the rim allow lateral sliding while still driving forward. Essential for holonomic (strafing) drivetrains." },
        ],
        callout: { type: "warning", text: "Always use thread-locking methods (keps nuts, nylon locknuts, or blue Loctite) on any joint that experiences vibration. Loose screws are the #1 cause of robot failures at competitions." },
      },
      {
        heading: "Pneumatics System",
        body: "VEX Pneumatics use compressed air to power linear actuators (pistons) that move at very high speed. Pneumatics are excellent for one-shot or toggle mechanisms that don't need precise positioning.\n\nSystem components:\n• **Air reservoir** — stores compressed air, typically filled to ~100 PSI before each match.\n• **Solenoids** — electrically controlled valves that direct air to extend or retract a piston. Connect to ADI ports on the Brain.\n• **Pneumatic cylinders** — linear actuators that push or pull with significant force.\n• **Tubing and fittings** — connect all pneumatic components together.\n• **Pressure gauge** — check your tank pressure before each match.\n\nUse cases: clamps on mobile goals, one-time expansion mechanisms, rapid intake toggles.",
        callout: { type: "warning", text: "Pneumatics add significant weight and complexity. Only use them when a motor solution would require too many motors or when very fast linear motion is needed." },
      },
      {
        heading: "Competition Format — Full Breakdown",
        body: "A standard VEX tournament runs over one or two days:",
        components: [
          { emoji: "🎯", name: "Skills Runs", color: "bg-yellow-50 border-yellow-200", badge: "bg-yellow-100 text-yellow-700", desc: "60-second solo runs. Driving Skills (driver controlled) and Autonomous Coding Skills (fully autonomous). Your best run of each type combine into your Skills score." },
          { emoji: "⚔️", name: "Qualification Matches", color: "bg-blue-50 border-blue-200", badge: "bg-blue-100 text-blue-700", desc: "2v2 alliance matches, ~2 minutes each. 15-sec autonomous + 1:45 driver control. Teams are randomly paired for quals." },
          { emoji: "🤝", name: "Alliance Selection", color: "bg-green-50 border-green-200", badge: "bg-green-100 text-green-700", desc: "After quals, top-ranked teams pick alliance partners for eliminations. Being a good alliance partner matters as much as ranking." },
          { emoji: "🏆", name: "Eliminations", color: "bg-red-50 border-red-200", badge: "bg-red-100 text-red-700", desc: "Best-of-3 bracket rounds. Quarter-finals → Semi-finals → Finals. Winning alliance earns the tournament champion award." },
        ],
        callout: { type: "info", text: "The autonomous bonus is awarded to the alliance that scores more points during the 15-second autonomous period. It can add a significant amount to your final score — never skip programming a reliable auto." },
      },
      {
        heading: "Team Roles & Responsibilities",
        body: "High-performing teams divide their work strategically. Here are the core roles:",
        components: [
          { emoji: "🔨", name: "Builder", color: "bg-orange-50 border-orange-200", badge: "bg-orange-100 text-orange-700", desc: "Designs and constructs the physical robot. Responsible for structural integrity, mechanism reliability, and iterating on designs based on testing feedback." },
          { emoji: "💻", name: "Programmer", color: "bg-blue-50 border-blue-200", badge: "bg-blue-100 text-blue-700", desc: "Writes all autonomous and driver-control code. Tunes motor speeds, PID controllers, and sensor thresholds. Works closely with the driver on control layout." },
          { emoji: "🕹️", name: "Driver", color: "bg-green-50 border-green-200", badge: "bg-green-100 text-green-700", desc: "Operates the robot during driver control. Practices match scenarios daily. Works with the programmer to optimize controller bindings for their play style." },
          { emoji: "📓", name: "Notebooker", color: "bg-purple-50 border-purple-200", badge: "bg-purple-100 text-purple-700", desc: "Documents every design decision, meeting, and test result in the engineering notebook. The notebook is judged for the Excellence Award — the most prestigious award in VEX." },
          { emoji: "📊", name: "Scout / Strategist", color: "bg-teal-50 border-teal-200", badge: "bg-teal-100 text-teal-700", desc: "Researches other teams at tournaments, tracks match data, and advises during alliance selection and elimination strategy." },
        ],
        callout: { type: "tip", text: "On smaller teams (3–4 people), members often hold 2 roles. The most common overlap is Builder + Notebooker, and Programmer + Driver." },
      },
    ],
  },
  {
    title: "Autonomous Programming",
    description: "Learn to write reliable autonomous routines — from timed movement to IMU-guided turns, encoder-based driving, and intro PID control.",
    level: "Intermediate",
    duration: "20 min read",
    color: "blue",
    topics: ["Competition Template", "Timed Movement", "IMU Turns", "Encoder Driving", "PID Basics", "Route Planning"],
    sections: [
      {
        heading: "Why Autonomous Matters",
        body: "The autonomous period is the first 15 seconds of every VEX match — no driver input allowed. Your robot must execute a pre-programmed routine entirely on its own.\n\nWhy it's crucial:\n• **Autonomous Bonus** — the alliance that scores more points during autonomous gets a bonus added to their final score. At high-level competitions this swing can decide the match.\n• **Autonomous Coding Skills** — a separate 60-second solo run where your robot scores entirely autonomously. Top Skills scores are tracked globally and affect your ranking.\n• **Alliance Selection** — teams with reliable autonomous routines are highly sought after as alliance partners.\n\nA robot with a strong autonomous is worth significantly more than one without. Even a simple, consistent 5-point auto beats an unreliable 15-point attempt.",
        callout: { type: "info", text: "At regional and state-level tournaments, matches are often decided entirely by the autonomous bonus. Never skip building an autonomous routine — even a basic one is better than nothing." },
      },
      {
        heading: "The Competition Template",
        body: "Every VEX program in VEXcode Pro uses the same three entry-point functions. Understanding what each one does is the foundation of all autonomous programming.",
        code: `// ── COMPETITION TEMPLATE STRUCTURE ─────────────────
// This is the skeleton every VEX program is built on.

#include "vex.h"
using namespace vex;

// ── DEVICE DECLARATIONS ──────────────────────────────
// Declare all motors and sensors here, matching your port wiring.
motor LeftFront  = motor(PORT1,  ratio18_1, false);
motor LeftBack   = motor(PORT2,  ratio18_1, false);
motor RightFront = motor(PORT10, ratio18_1, true);  // reversed!
motor RightBack  = motor(PORT9,  ratio18_1, true);  // reversed!
motor Intake     = motor(PORT5,  ratio6_1,  false);
inertial Imu     = inertial(PORT8);
competition Competition;

// ── PRE_AUTON ────────────────────────────────────────
// Runs ONCE when the program starts (before the match).
// Use for: sensor calibration, brake modes, screen messages.
void pre_auton(void) {
  Imu.calibrate();                    // start IMU calibration
  waitUntil(!Imu.isCalibrating());    // wait ~2 seconds for it to finish
  LeftFront.setBrakeType(brake);
  RightFront.setBrakeType(brake);
  LeftBack.setBrakeType(brake);
  RightBack.setBrakeType(brake);
  Brain.Screen.print("Ready!");       // show status on Brain screen
}

// ── AUTONOMOUS ───────────────────────────────────────
// Runs during the 15-second autonomous period.
// NO controller input. Every movement must be pre-programmed.
void autonomous(void) {
  // your routine goes here
}

// ── USERCONTROL ──────────────────────────────────────
// Runs during the 1:45 driver control period.
void usercontrol(void) {
  while (true) {
    // driver code here
    wait(20, msec);
  }
}

// ── MAIN ─────────────────────────────────────────────
int main() {
  Competition.autonomous(autonomous);
  Competition.drivercontrol(usercontrol);
  pre_auton();
  while (true) { wait(100, msec); }
}`,
        callout: { type: "warning", text: "Always call Imu.calibrate() in pre_auton() and wait for it to finish before the match starts. An uncalibrated IMU gives random heading values — your turns will be completely wrong." },
      },
      {
        heading: "Timed Movement — The Quickest Start",
        body: "The simplest way to make your robot move autonomously is timed movement — spin motors for a fixed number of milliseconds, then stop. It's not the most accurate method, but it's fast to write and works well for short, simple routines.",
        code: `// ── HELPER: spin all four drive motors ──────────────
void spinDrive(int leftPct, int rightPct) {
  LeftFront.spin(forward, leftPct, percent);
  LeftBack.spin(forward, leftPct, percent);
  RightFront.spin(forward, rightPct, percent);
  RightBack.spin(forward, rightPct, percent);
}

void stopDrive() {
  LeftFront.stop(brake);  LeftBack.stop(brake);
  RightFront.stop(brake); RightBack.stop(brake);
}

// ── TIMED AUTONOMOUS ─────────────────────────────────
void autonomous(void) {

  // Drive forward at 70% for 1.2 seconds
  spinDrive(70, 70);
  wait(1200, msec);    // wait 1200ms = 1.2 seconds
  stopDrive();

  // Pause briefly before next move (lets robot settle)
  wait(200, msec);

  // Turn right: left motors forward, right motors backward
  spinDrive(50, -50);
  wait(600, msec);     // tune this value until you get ~90 degrees
  stopDrive();

  wait(200, msec);

  // Drive forward again
  spinDrive(60, 60);
  wait(800, msec);
  stopDrive();

  // Score: run intake for 1.5 seconds
  Intake.spin(forward, 100, percent);
  wait(1500, msec);
  Intake.stop(coast);
}`,
        callout: { type: "tip", text: "Timed movement drifts over distance — even a 2% battery difference changes your timing. Use it for short moves (under 2 seconds) and always pair with an IMU-based turn for anything that needs accuracy." },
      },
      {
        heading: "IMU-Guided Turns — Consistent Every Time",
        body: "The Inertial Sensor (IMU) measures your robot's heading in degrees. Instead of guessing how long a turn takes, you rotate until the IMU reports the exact angle you want. This is far more accurate than timed turns and works regardless of battery level.",
        code: `// ── TURN TO AN ABSOLUTE HEADING ─────────────────────
// targetDeg: the compass heading to turn to (0–360°)
//   0° = starting direction, 90° = 90° clockwise, etc.
// speed: motor speed percent (30–60 is recommended for turns)
void turnToHeading(double targetDeg, int speed) {

  // Keep turning until we're within 1.5° of the target
  while (fabs(Imu.heading() - targetDeg) > 1.5) {

    double error = targetDeg - Imu.heading();

    // Handle wrap-around: if error > 180, take the shorter path
    if (error > 180)  error -= 360;
    if (error < -180) error += 360;

    if (error > 0) {
      spinDrive(speed, -speed);   // turn clockwise (right)
    } else {
      spinDrive(-speed, speed);   // turn counter-clockwise (left)
    }

    wait(10, msec);  // small delay to not flood the brain
  }

  stopDrive();
  wait(150, msec);  // settle pause — robot may overshoot slightly
}

// ── USAGE IN AUTONOMOUS ──────────────────────────────
void autonomous(void) {
  // Drive forward, then make a precise 90° right turn
  spinDrive(70, 70);
  wait(1000, msec);
  stopDrive();

  turnToHeading(90, 45);   // turn to face 90° (right) at 45% speed

  // Drive forward again after the turn
  spinDrive(65, 65);
  wait(800, msec);
  stopDrive();

  turnToHeading(180, 45);  // face 180° (backward from start)
}`,
        callout: { type: "tip", text: "Lower turn speed (30–50%) gives you more accuracy. At 80%, the robot overshoots before the while loop can react. Start at 45% and tune from there." },
      },
      {
        heading: "Encoder-Based Driving — Consistent Distance",
        body: "Motor encoders track exactly how many degrees the motor shaft has rotated. By converting your target distance (in inches) to motor degrees, you can drive a precise distance regardless of timing or battery level.",
        code: `// ── CONVERSION CONSTANT ─────────────────────────────
// How many motor degrees = 1 inch of robot travel?
// Formula: 360 / (wheel circumference) * gear_ratio
// For 3.25" wheels with 1:1 gearing: 360 / (3.25 * 3.14159) ≈ 35.2 deg/inch
// TUNE THIS for your specific robot — measure and adjust.
const double DEG_PER_INCH = 35.2;

// ── DRIVE STRAIGHT WITH ENCODER ──────────────────────
// inches: how far to drive (negative = reverse)
// speed:  motor percent (positive only, direction handled by sign of inches)
void driveDistance(double inches, int speed) {

  // Reset encoder positions to zero before the move
  LeftFront.resetPosition();
  RightFront.resetPosition();

  double target = fabs(inches) * DEG_PER_INCH;  // target in degrees
  int dir = (inches >= 0) ? 1 : -1;             // forward or backward

  // Keep going until BOTH left and right motors have reached the target
  while (LeftFront.position(degrees)  < target &&
         RightFront.position(degrees) < target) {

    // Use IMU heading to correct drift (keeps robot going straight)
    double drift      = Imu.heading();   // any deviation from 0° = drift
    double correction = drift * 0.8;     // correction gain — tune this

    spinDrive(dir * (speed - correction),
              dir * (speed + correction));

    wait(10, msec);
  }

  stopDrive();
  wait(150, msec);
}

// ── USAGE ────────────────────────────────────────────
void autonomous(void) {
  driveDistance(24, 70);    // drive exactly 24 inches forward at 70%
  turnToHeading(90, 45);    // turn right 90 degrees
  driveDistance(12, 60);    // drive 12 more inches
  driveDistance(-6, 50);    // back up 6 inches
}`,
        callout: { type: "warning", text: "DEG_PER_INCH varies with wheel size, gear ratio, and even how worn your wheels are. Always measure: drive your robot exactly 48 inches, read the encoder value, then divide by 48 to get your constant." },
      },
      {
        heading: "Intro to PID — Smooth & Accurate Control",
        body: "PID (Proportional-Integral-Derivative) is the gold standard for autonomous movement. Instead of running at a fixed speed, PID adjusts the motor speed based on how far away you are from the target — slowing down as you approach. This gives smooth, accurate, and repeatable movement.\n\n**P (Proportional)** — correction proportional to the error. Large error = fast movement. Small error = slow, precise movement.\n**I (Integral)** — corrects for accumulated error over time. Helps when P alone can't quite reach the target.\n**D (Derivative)** — slows down when approaching fast, preventing overshoot.",
        code: `// ── SIMPLE P-CONTROLLER FOR DRIVING ─────────────────
// This uses just the P term — a great starting point.
// Add I and D once P is tuned well.

void driveDistancePID(double inches, double kP = 0.5) {
  LeftFront.resetPosition();
  RightFront.resetPosition();

  double target = inches * DEG_PER_INCH;
  double error, motorPower;

  do {
    // Error = how many degrees are left to travel
    double leftPos  = LeftFront.position(degrees);
    double rightPos = RightFront.position(degrees);
    double avgPos   = (leftPos + rightPos) / 2.0;

    error      = target - avgPos;    // positive = not there yet
    motorPower = kP * error;         // P term: power scales with distance remaining

    // Clamp to a reasonable range (avoid stalling or overspeeding)
    if (motorPower >  80) motorPower =  80;
    if (motorPower < -80) motorPower = -80;
    if (motorPower > 0 && motorPower < 10) motorPower = 10;  // min power
    if (motorPower < 0 && motorPower > -10) motorPower = -10;

    // Heading correction (keep going straight)
    double drift = Imu.heading();
    double correction = drift * 0.8;

    spinDrive(motorPower - correction, motorPower + correction);
    wait(10, msec);

  } while (fabs(error) > 5);  // stop when within 5 degrees of target

  stopDrive();
  wait(150, msec);
}

// ── FULL PID TURN ────────────────────────────────────
void turnPID(double targetDeg, double kP = 0.6, double kD = 0.3) {
  double prevError = 0;

  for (int i = 0; i < 200; i++) {  // max 200 iterations (~2 seconds)
    double error = targetDeg - Imu.heading();
    if (error > 180)  error -= 360;   // take shorter path
    if (error < -180) error += 360;

    double derivative = error - prevError;
    double power      = kP * error + kD * derivative;

    if (power >  60) power =  60;
    if (power < -60) power = -60;

    spinDrive(power, -power);
    prevError = error;
    wait(10, msec);

    if (fabs(error) < 1.5) break;  // close enough — exit early
  }

  stopDrive();
}`,
        callout: { type: "tip", text: "Start tuning with just the P term (kP). Increase it until the robot oscillates (wobbles at target), then reduce slightly. Only add D if you still get overshoot. Most student teams never need the I term." },
      },
      {
        heading: "Route Planning & Debugging",
        body: "Writing the movement code is only half the work — figuring out WHAT to do in 15 seconds and verifying it works is the other half.\n\n**Plan your route before coding:**\n• Draw the field on paper and mark your starting position.\n• Identify every game object you want to score and the path to reach them.\n• Estimate time: driving 24 inches at 70% ≈ 1.2 seconds. 90° turn ≈ 0.5 seconds. Leave buffer — 15 seconds goes fast.\n• Score the highest-value objects first in case you run out of time.\n\n**Debugging techniques:**\n• Print sensor values to the Brain screen during the run: `Brain.Screen.print(Imu.heading())`\n• Add `Brain.Screen.printAt(5, 30, \"Step 1\");` before each movement step to see where it fails.\n• Run on a full battery every time — a half-charged battery changes timing significantly.\n• Test on the actual field tile material, not carpet or hardwood — friction affects distance.",
        components: [
          { emoji: "📋", name: "Plan First", color: "bg-blue-50 border-blue-200", badge: "bg-blue-100 text-blue-700", desc: "Draw your route on paper before touching the keyboard. Know exactly which objects you're targeting and in what order." },
          { emoji: "🔋", name: "Full Battery", color: "bg-green-50 border-green-200", badge: "bg-green-100 text-green-700", desc: "Always test on a charged battery. Voltage affects motor speed — a 20% drop can throw off timed movements by 15%." },
          { emoji: "🎯", name: "Tune Constants", color: "bg-yellow-50 border-yellow-200", badge: "bg-yellow-100 text-yellow-700", desc: "DEG_PER_INCH, turn time, and PID gains must all be measured on your actual robot. No published value will be correct for you." },
          { emoji: "🖥️", name: "Brain Screen Debug", color: "bg-purple-50 border-purple-200", badge: "bg-purple-100 text-purple-700", desc: "Print step labels and sensor values during test runs. Seeing 'Step 3 failed' instantly tells you which function has the bug." },
        ],
        callout: { type: "info", text: "The best autonomous routine is the one that runs consistently, not the one that theoretically scores the most. A simple 8-point auto that works every time beats a complex 20-point auto that fails half the time." },
      },
    ],
  },
  {
    title: "Robot Design",
    description: "Design the mechanisms that win matches — lift systems, intakes, scoring devices, and the structural principles that hold them together.",
    level: "Intermediate",
    duration: "18 min read",
    color: "green",
    icon: "🔧",
    topics: ["Lift Systems", "Intakes", "Scoring Mechanisms", "Structural Tips", "Build Quality"],
    sections: [
      {
        heading: "Start With the Drivetrain",
        body: "The drivetrain is the single most important subsystem of your robot — every mechanism, motor allocation, and chassis dimension flows from that choice. A bad drivetrain loses matches even with a perfect scoring mechanism.\n\nThis lesson focuses on everything that sits **on top of** the drive: lifts, intakes, scoring mechanisms, and the structure that holds it all together. For the full drivetrain comparison — tank vs. holonomic, gear ratios, and wheel selection — work through the dedicated **Drivetrain Design** lesson first.",
        callout: { type: "tip", text: "Recommended order: choose your drivetrain first (see the Drivetrain Design lesson), lock in your motor allocation, then design your mechanisms around the motors you have left." },
      },
      {
        heading: "Lift Systems — Full Breakdown",
        body: "Every game requires moving objects vertically. Choosing the right lift dramatically impacts your scoring ability.",
        components: [
          { emoji: "📐", name: "4-Bar Lift", color: "bg-blue-50 border-blue-200", badge: "bg-blue-100 text-blue-700", desc: "Two parallel linkages keep the end effector level as it rises. Simple to build. Limited height range (~12\"). Best for low-scoring games." },
          { emoji: "📏", name: "6-Bar Lift", color: "bg-green-50 border-green-200", badge: "bg-green-100 text-green-700", desc: "Extended 4-bar with extra links. Greater height range (~18\"). More complex but still manageable for intermediate builders." },
          { emoji: "🏗️", name: "DR4B (Double Reverse 4-Bar)", color: "bg-purple-50 border-purple-200", badge: "bg-purple-100 text-purple-700", desc: "Two 4-bars stacked in reverse. Provides very tall reach (30\"+) with minimal horizontal shift. Used by top teams in stacking games. Hard to build." },
          { emoji: "📦", name: "Linear Lift / Cascade", color: "bg-orange-50 border-orange-200", badge: "bg-orange-100 text-orange-700", desc: "Slides up a vertical rail via a chain or lead screw. Very compact footprint. Less consistent than linkage lifts but excellent for tight robots." },
          { emoji: "🔄", name: "Scissor Lift", color: "bg-red-50 border-red-200", badge: "bg-red-100 text-red-700", desc: "Crossing X-shaped links that expand vertically when pushed. Compact when collapsed. Gets unstable at extreme heights. Good for moderate height requirements." },
        ],
        callout: { type: "tip", text: "Always use rubber bands to counterbalance your lift. Attach them so they pull the lift upward — this way the motor only needs to control movement, not hold the lift's weight. This can reduce motor load by 50%+." },
      },
      {
        heading: "Intake & Scoring Mechanisms",
        body: "Your intake collects game objects; your scoring mechanism places them. Both must be fast, consistent, and reliable under match pressure.",
        components: [
          { emoji: "🔄", name: "Roller Intake", color: "bg-green-50 border-green-200", badge: "bg-green-100 text-green-700", desc: "Spinning rubber flex wheels or anti-static flaps grab balls, rings, or discs. Fast and forgiving. Most common intake type." },
          { emoji: "🦾", name: "Pneumatic Claw", color: "bg-blue-50 border-blue-200", badge: "bg-blue-100 text-blue-700", desc: "Air-powered two-finger claw grabs large objects like mobile goals. Instant actuation, reliable grip, no motor required." },
          { emoji: "🏭", name: "Conveyor / Indexer", color: "bg-orange-50 border-orange-200", badge: "bg-orange-100 text-orange-700", desc: "Belt or roller conveyor moves objects through the robot body. Used for sorting, stacking, or transferring game pieces to a scorer." },
          { emoji: "🌪️", name: "Flywheel Launcher", color: "bg-red-50 border-red-200", badge: "bg-red-100 text-red-700", desc: "High-speed spinning wheel that launches discs or balls. Requires precise RPM control for consistent shot accuracy. Used in shooting games." },
          { emoji: "🪣", name: "Bucket / Tray", color: "bg-teal-50 border-teal-200", badge: "bg-teal-100 text-teal-700", desc: "Simple container that scoops game objects. No motor required. Limited to games where pushing or containing objects scores points." },
        ],
        callout: { type: "warning", text: "Test your intake with actual game objects on the real field surface before tournaments. Mechanisms that work on a carpet at home may fail on the polished field tiles used at competitions." },
      },
      {
        heading: "Structural Design Tips",
        body: "Strong robots survive matches; well-designed robots win them. These principles apply to every subsystem you build:\n\n**Triangulate everything.** Triangles are the strongest shape in 2D. Add a diagonal brace to any rectangular frame to prevent racking (twisting).\n\n**Minimize cantilevering.** A beam supported at one end with load at the other is a cantilever — it bends and breaks. Add a second support whenever possible.\n\n**Keep the center of gravity low.** Heavy components (battery, Brain) should be as low and central as possible. A high CoG causes tipping during aggressive driving.\n\n**Use standoffs to triangulate.** A single standoff from a c-channel to a motor mount adds enormous rigidity without much weight.\n\n**Design for assembly.** Leave enough clearance that you can insert and remove screws with a screwdriver. Tight spaces cause assembly time to explode at competitions.",
        callout: { type: "tip", text: "At your first competition, you'll likely need to make emergency repairs in 5–10 minutes between matches. Design your robot so every critical component can be accessed and replaced quickly without disassembling half the robot." },
      },
    ],
  },
  {
    title: "Competition Strategy",
    description: "Advanced match strategy, scouting systems, alliance selection, driver practice methods, and engineering notebook mastery.",
    level: "Advanced",
    duration: "20 min read",
    color: "yellow",
    icon: "🏆",
    topics: ["Match Strategy", "Scouting", "Alliance Selection", "Driver Practice", "Notebook", "Awards"],
    sections: [
      {
        heading: "Strategy Starts With the Game",
        body: "Every strategic decision — robot design, match plans, alliance picks — flows from a deep understanding of the game itself. If you haven't done that groundwork yet, work through the **Game Analysis** lesson first: reading the manual, calculating maximum scores, and identifying priority actions.\n\nThis lesson covers what comes next: turning that game knowledge into tournament results through scouting, alliance selection, driver practice, and awards strategy.",
        callout: { type: "info", text: "Watch all match replays from the game reveal day and early-season tournaments posted on YouTube. You will see the meta-strategy evolve rapidly in the first 2 months of the season." },
      },
      {
        heading: "Scouting System — How to Track Every Team",
        body: "Scouting is the competitive intelligence that makes alliance selection and match strategy possible. Here is a full scouting framework:\n\n**What to record for each team:**\n• Average match score (quals and eliminations)\n• Autonomous: does it run? Is it consistent? Does it score?\n• Drive quality: smooth or jerky? Fast or slow?\n• Mechanism reliability: does it malfunction during matches?\n• Behavior: do they play offensively, defensively, or neutrally?\n• Best and worst match scores (shows consistency)\n\n**Tools:**\n• Google Sheets shared with your entire team\n• RobotEvents.com for official match results\n• VEX Via app for real-time match data at tournaments\n\n**At the tournament:** Assign 1–2 team members dedicated to scouting every single qualification match. Don't rely on memory.",
        components: [
          { emoji: "📊", name: "Score Tracking", color: "bg-blue-50 border-blue-200", badge: "bg-blue-100 text-blue-700", desc: "Record every team's match scores. Calculate average, max, and consistency (standard deviation)." },
          { emoji: "🤖", name: "Robot Assessment", color: "bg-green-50 border-green-200", badge: "bg-green-100 text-green-700", desc: "Note each robot's capabilities: can it do auton? High goal? Defend? Stack? Expand? Rate 1–5 for each." },
          { emoji: "🎥", name: "Video Review", color: "bg-purple-50 border-purple-200", badge: "bg-purple-100 text-purple-700", desc: "Film or rewatch key matches. Slow-motion review reveals details you miss in real time — mechanism failures, driving patterns." },
          { emoji: "🤝", name: "Alliance Fit", color: "bg-orange-50 border-orange-200", badge: "bg-orange-100 text-orange-700", desc: "Rank teams by how well they complement your robot. A team that does what you don't is more valuable than a copy of you." },
        ],
      },
      {
        heading: "Alliance Selection Strategy",
        body: "Alliance selection is one of the highest-stakes decisions in a VEX tournament. Here is how to approach it:\n\n**If you are picking (top 8 teams):**\n• Don't just pick the highest-ranked team available — pick the team that makes your alliance the strongest combined.\n• A robot that scores 80 points doing what you can't is better than a 100-point robot that duplicates your scoring.\n• Consider consistency over peak performance. A team that scores 80 points every match is more valuable than one that scores 120 occasionally and 30 sometimes.\n• Have a ranked list of 10 teams prepared before selection starts. Teams go fast.\n\n**If you are being picked:**\n• Be visible and approachable at the event. Top teams pick teams they have talked to.\n• Have a clear 30-second pitch: 'We score X points autonomously, our robot does Y, and we average Z points per match.'\n• Don't wait by the field passively — go introduce yourself to the top 8 teams between quals.",
        callout: { type: "warning", text: "Never decline an alliance invitation unless you have already accepted another. Declining to 'wait for a better offer' almost always backfires — teams move on immediately and you may end up with a weaker partner." },
      },
      {
        heading: "Driver Practice — Building Consistency",
        body: "A world-class robot driven poorly will lose to a decent robot driven expertly. Driver practice is non-negotiable for competitive teams.\n\n**Practice structure:**\n• Practice at least 3 times per week during competition season.\n• Always practice on a real or simulated field — living room carpet does not replicate competition conditions.\n• Record every practice session. Review the footage to identify mistakes.\n• Practice under simulated match pressure: timer running, someone calling out opponent positions.\n\n**Drills to run:**\n• Cycle drill: complete a full scoring cycle as fast as possible, 20 times in a row. Aim for sub-30 seconds.\n• Consistency drill: run the same autonomous 10 times and record success rate. Target 90%+.\n• Stress drill: practice while someone bumps your controller (simulates nerves) or creates distractions.\n• Alliance drill: practice with your likely alliance partner to develop coordination.",
        callout: { type: "tip", text: "The best drivers develop 'muscle memory' — they stop thinking about controls and focus entirely on the field. This only comes from repetition. 100+ practice matches before your first major tournament is the target for top teams." },
      },
      {
        heading: "The Notebook as a Competitive Weapon",
        body: "The Engineering Notebook is judged for multiple awards, including the Excellence Award — the most prestigious award in VEX Robotics and a direct qualifier to the World Championship. For mid-ranked teams, a strong notebook is often the most reliable path to qualifying.\n\n**Treat it as strategy, not homework:**\n• Assign a dedicated notebooker and make documentation part of every meeting — not a season-end scramble.\n• A team with an average robot and an Expert-level notebook frequently out-qualifies a team with a great robot and no documentation.\n• The notebook also powers your judge interview: pointing to specific pages proves the work is genuinely yours.\n\nFor the full section-by-section breakdown — the judging rubric, the 7-step design process, and common mistakes — open the **Notebook Guide in the Voltz Library** (Resources tab).",
        callout: { type: "tip", text: "Start your notebook on Day 1 of the season — even before you have a robot. Document your game analysis, brainstorming sessions, and initial sketches. Judges can tell when notebooks are backfilled at the end of the season." },
      },
      {
        heading: "Awards — How to Win Them",
        body: "VEX tournaments offer multiple awards beyond the tournament champion. Understanding them helps you strategize your season goals.",
        components: [
          { emoji: "🥇", name: "Excellence Award", color: "bg-yellow-50 border-yellow-200", badge: "bg-yellow-100 text-yellow-700", desc: "Most prestigious. Requires a top-ranked notebook, strong robot performance, and good sportsmanship. Qualifies to State/Worlds." },
          { emoji: "🏆", name: "Tournament Champion", color: "bg-red-50 border-red-200", badge: "bg-red-100 text-red-700", desc: "Win the elimination bracket. Awarded to the winning alliance (both teams). Qualifies to State/Worlds." },
          { emoji: "🤖", name: "Design Award", color: "bg-blue-50 border-blue-200", badge: "bg-blue-100 text-blue-700", desc: "Recognizes innovative robot design and strong notebook documentation. Judges interview the team about design decisions." },
          { emoji: "🌟", name: "Amaze Award", color: "bg-purple-50 border-purple-200", badge: "bg-purple-100 text-purple-700", desc: "Given to a team with impressive robot capabilities that wows the judges and audience — often for a breakthrough mechanism." },
          { emoji: "🤝", name: "Sportsmanship Award", color: "bg-green-50 border-green-200", badge: "bg-green-100 text-green-700", desc: "Awarded for positive attitude, helping other teams, and representing the spirit of VEX. Judges watch behaviour in the pits and at the field all day." },
        ],
        callout: { type: "info", text: "At large tournaments like Regionals and State, the Excellence Award and Design Award are the most reliable paths to Worlds qualification for mid-ranked teams. Focus heavily on your notebook if your robot is not yet top-tier." },
      },
    ],
  },
  {
    title: "Drivetrain Design",
    description: "Compare every drivetrain type — tank, holonomic, X-drive, and more — and learn how gear ratios and wheel choice affect your robot's performance.",
    level: "Intermediate",
    duration: "16 min read",
    color: "green",
    icon: "🛞",
    topics: ["Tank Drive", "Holonomic Drive", "X-Drive", "Gear Ratios", "Wheel Selection", "Motor Allocation"],
    sections: [
      {
        heading: "Why Drivetrain Choice Matters",
        body: "The drivetrain is the most important subsystem on your robot. It determines how fast you move, how much pushing power you have, and whether you can strafe. A robot with a subpar mechanism but an excellent drivetrain will outperform a robot with great mechanisms and a slow, unreliable drive in almost every match.\n\nCore trade-offs every team faces:\n• **Speed vs. Torque** — faster drivetrains are harder to push but harder to control. Slower drivetrains are stable but lose ground battles.\n• **Maneuverability vs. Simplicity** — holonomic drives strafe but are more complex to build and program.\n• **Motor Count** — most teams dedicate 4–6 motors to drive, leaving 2–4 for mechanisms.\n\nChoose your drivetrain before designing anything else. Every mechanism, motor allocation, and chassis size flows from this decision.",
        callout: { type: "info", text: "At the high school level, a well-tuned 6-motor tank drive beats a poorly-built X-drive in almost every head-to-head scenario. Don't sacrifice mechanical simplicity chasing fancy designs you haven't built before." },
      },
      {
        heading: "Tank Drive",
        body: "Tank drive is the most common drivetrain in VEX. Left joystick controls the left side, right joystick controls the right side. Turning is achieved by spinning the two sides at different speeds.\n\n**Variants:**\n• **4-wheel tank** — standard, 4 motors (2 per side). Simple and reliable.\n• **6-wheel tank** — adds a center wheel. Better traction and reduces scuffing on turns. The center wheel is often mounted 1/16\" lower to act as a pivot point.\n• **8-wheel tank** — maximum pushing power. Used by heavy bots that need to dominate defense.\n\n**Gear ratios for tank drive:**\n• 200 RPM (green cartridge) — standard balanced choice for most games.\n• 257 RPM (200 RPM + 36:28 external gear) — slight speed boost while keeping torque.\n• 333 RPM (200 RPM + 60:36) — fast, used when speed is the priority.\n• 100 RPM (red cartridge) — maximum pushing power, used for defense-heavy robots.",
        components: [
          { emoji: "🛞", name: "4-Wheel Tank", color: "bg-blue-50 border-blue-200", badge: "bg-blue-100 text-blue-700", desc: "Simplest setup. 2 wheels per side. Best for beginner teams and games with lots of open field space." },
          { emoji: "🛞", name: "6-Wheel Tank", color: "bg-green-50 border-green-200", badge: "bg-green-100 text-green-700", desc: "Drops center wheel 1/16\" lower. Eliminates turning scrub, greatly improves auton accuracy. Most popular at high levels." },
          { emoji: "🛞", name: "8-Wheel Tank", color: "bg-orange-50 border-orange-200", badge: "bg-orange-100 text-orange-700", desc: "Maximum pushing force. Used when the game rewards defense or mobile goal possession." },
        ],
        callout: { type: "tip", text: "The 6-wheel drop-center drive is the standard choice for serious VEX teams. It is reliable, easy to program, and delivers excellent autonomous accuracy." },
      },
      {
        heading: "Holonomic & X-Drive",
        body: "Holonomic drivetrains use wheels arranged at angles so the robot can move in any direction — including sideways — without rotating first.\n\n**X-Drive (also called Holonomic Drive):**\n• 4 wheels arranged in an X pattern, each at 45° to the robot's sides.\n• Can strafe (move sideways), drive diagonally, and spin simultaneously.\n• Faster diagonal movement than tank drive.\n• **Disadvantage:** mechanically complex, harder to build straight, weaker against pushing.\n• Uses omni wheels — the rollers allow lateral slip.\n\n**H-Drive:**\n• Standard 4-wheel tank drive with a 5th omni wheel in the center, pointing sideways.\n• Can strafe by spinning only the center wheel.\n• Simpler than X-Drive but strafing is slower and requires an extra motor.\n\n**Mecanum Drive:**\n• 4 mecanum wheels with angled rollers. Can strafe like X-Drive.\n• Very popular in FRC but less common in VEX due to cost and weight.",
        components: [
          { emoji: "✖️", name: "X-Drive", color: "bg-purple-50 border-purple-200", badge: "bg-purple-100 text-purple-700", desc: "Full omnidirectional movement. Best for games requiring rapid repositioning. Harder to build and weaker against pushing." },
          { emoji: "➡️", name: "H-Drive", color: "bg-teal-50 border-teal-200", badge: "bg-teal-100 text-teal-700", desc: "Tank drive + sideways center wheel. Strafing is slower but the build is much simpler. Good middle ground." },
          { emoji: "🔄", name: "Mecanum Drive", color: "bg-indigo-50 border-indigo-200", badge: "bg-indigo-100 text-indigo-700", desc: "Angled roller wheels allow strafing like X-Drive. Heavier and more expensive but intuitive to program." },
        ],
        callout: { type: "warning", text: "Holonomic drives are weaker in pushing battles because the angled wheels generate less direct lateral force. In games where pushing or defending is important, tank drive is usually better." },
      },
      {
        heading: "Gear Ratios Explained",
        body: "A gear ratio changes how fast and how powerfully a motor drives your wheels.\n\n**Formula:** Output RPM = Motor RPM × (Driver Gear Teeth / Driven Gear Teeth)\n\n**Example:** A 200 RPM motor with a 36-tooth gear driving a 48-tooth gear:\n200 × (36 / 48) = 150 RPM — slower but more torque.\n\n**Speed-up ratio:** Small gear drives large gear → faster output, less torque.\n**Torque ratio:** Large gear drives small gear → slower output, more torque.\n\n**Common external gear ratios in VEX:**\n• 36:48 — reduces to ~150 RPM (extra torque for heavy bots)\n• 36:36 — 1:1 (no change, same as direct drive)\n• 36:24 — speeds up to 300 RPM\n• 48:24 — 2:1 speedup, 400 RPM from 200 RPM motor\n\n**Compound ratios multiply together:** a 12T→60T (5:1) stage followed by a 12T→36T (3:1) stage gives 15:1 total — very high torque for heavy lifts.\n\n**Wheel diameter also matters:**\nLarger wheels = more distance per rotation = faster linear speed but less pushing force. Most teams use 3.25\" traction wheels for a balance of speed and grip.",
        callout: { type: "tip", text: "Calculate your target drive speed in inches per second: RPM × wheel circumference (π × diameter) ÷ 60. Most competitive VEX robots target 60–90 inches per second for drive speed." },
      },
      {
        heading: "Wheel Types for Drivetrain",
        body: "Choosing the right wheels for each position on your drivetrain significantly affects traction, turning, and autonomous accuracy.",
        components: [
          { emoji: "🟤", name: "Traction Wheels", color: "bg-orange-50 border-orange-200", badge: "bg-orange-100 text-orange-700", desc: "High-grip rubber treads. Grip the field mat best. Use on the drive wheels you want for pushing power. Cause turning scrub if used on all 4 corners." },
          { emoji: "⚪", name: "Omni Wheels", color: "bg-gray-50 border-gray-200", badge: "bg-gray-100 text-gray-700", desc: "Side rollers allow lateral sliding. Reduces turning scrub. Often used on front/rear of tank drives to allow smooth pivoting. Required for X-Drive." },
          { emoji: "🔵", name: "Mecanum Wheels", color: "bg-blue-50 border-blue-200", badge: "bg-blue-100 text-blue-700", desc: "Angled internal rollers allow strafing. Used for mecanum drive configurations. Less common in VEX V5 competition." },
        ],
        callout: { type: "tip", text: "The most reliable tank drive setup: traction wheels in the center (for pushing grip) and omni wheels on front and rear (to eliminate scrubbing on turns). This is what most high-level teams use." },
      },
    ],
  },
  {
    title: "Sensor Integration",
    description: "Learn how to use VEX sensors in real code — reading the inertial sensor for turns, distance sensor for detection, optical for color sorting, and more.",
    level: "Intermediate",
    duration: "18 min read",
    color: "purple",
    icon: "📡",
    topics: ["Inertial Sensor", "Distance Sensor", "Rotation Sensor", "Optical Sensor", "Vision Sensor", "Sensor Fusion"],
    sections: [
      {
        heading: "Why Sensors Matter",
        body: "Without sensors, your robot is blind. It can only execute timed commands hoping the world is exactly where expected. Sensors give your robot awareness — it can measure, react, and correct.\n\nIn autonomous routines:\n• A sensor-guided turn is accurate to ±1° vs. ±10–15° for a timed turn.\n• A distance sensor stops your robot exactly at a goal instead of running into it.\n• An optical sensor lets you sort game pieces by color automatically.\n\nIn driver control:\n• Sensors can enforce soft limits (stop a lift before it breaks itself).\n• An inertial sensor can auto-straighten your drive after releasing the joystick.\n• A bumper switch confirms a game piece is loaded before firing.\n\nEvery sensor you add makes your robot smarter and more reliable.",
        callout: { type: "info", text: "The two sensors every serious VEX team uses are the Inertial Sensor (for accurate turns) and motor encoders (built into every V5 motor). If you use nothing else, use these two." },
      },
      {
        heading: "Inertial Sensor — Accurate Turns",
        body: "The Inertial Sensor (IMU) measures your robot's rotation using a gyroscope and accelerometer. It is the most important sensor for autonomous accuracy.\n\n**Setup in VEXcode:**\n```cpp\nvex::inertial InertialSensor(PORT1);\nInertialSensor.calibrate();\nwait(2, sec); // always wait for calibration\n```\n\n**Reading heading:**\n```cpp\ndouble heading = InertialSensor.heading(); // 0–360°\ndouble rotation = InertialSensor.rotation(); // can exceed 360°\n```\n\n**Turning to a target angle:**\n```cpp\nvoid turnToAngle(double target) {\n  while (fabs(InertialSensor.rotation() - target) > 1.0) {\n    double error = target - InertialSensor.rotation();\n    LeftDrive.spin(fwd, error * 0.5, pct);\n    RightDrive.spin(reverse, error * 0.5, pct);\n    wait(10, msec);\n  }\n  LeftDrive.stop();\n  RightDrive.stop();\n}\n```\n\nThis is a basic proportional controller — the robot slows down as it approaches the target angle.",
        callout: { type: "warning", text: "Always call InertialSensor.calibrate() at the start of your program and wait 2 seconds before using it. Using it before calibration completes causes incorrect readings." },
      },
      {
        heading: "Distance Sensor — Proximity Detection",
        body: "The Distance Sensor uses a laser (time-of-flight) to measure how far away the nearest object is, from 20mm to 2000mm.\n\n**Setup:**\n```cpp\nvex::distance DistanceSensor(PORT2);\n```\n\n**Reading distance:**\n```cpp\ndouble dist = DistanceSensor.objectDistance(mm); // or inches\nbool detected = DistanceSensor.isObjectDetected(); // true if object < threshold\n```\n\n**Use cases:**\n• Stop the robot when it reaches a goal or wall.\n• Detect whether a game piece is loaded in an intake.\n• Measure distance from field elements for repositioning.\n\n**Drive until close to wall:**\n```cpp\nDrive.setVelocity(50, pct);\nDrive.spin(fwd);\nwhile (DistanceSensor.objectDistance(mm) > 100) {\n  wait(10, msec);\n}\nDrive.stop();\n```",
        callout: { type: "tip", text: "Distance sensors have a small detection cone (~15°). Mount them facing directly at the target surface for best accuracy. They can struggle with transparent or very dark objects." },
      },
      {
        heading: "Rotation Sensor — Precise Position Tracking",
        body: "The Rotation Sensor measures the absolute angle of a rotating shaft (0–360°) with 0.088° precision. Unlike motor encoders, it does not reset on power-cycle.\n\n**Setup:**\n```cpp\nvex::rotation ArmRotation(PORT3);\n```\n\n**Reading angle:**\n```cpp\ndouble angle = ArmRotation.position(degrees); // 0–360\nArmRotation.resetPosition(); // zero it out\n```\n\n**Common use cases:**\n• Track lift height and enforce soft limits.\n• Measure arm angle for PID position control.\n• Track the angle of a turret or rotating mechanism.\n\n**Soft limit example (prevent lift from over-extending):**\n```cpp\nif (ArmRotation.position(degrees) > 270 && Controller.ButtonR1.pressing()) {\n  // block the up command — at max height\n} else if (Controller.ButtonR1.pressing()) {\n  Lift.spin(fwd, 100, pct);\n} else if (Controller.ButtonR2.pressing()) {\n  Lift.spin(reverse, 100, pct);\n} else {\n  Lift.stop(hold);\n}\n```",
        callout: { type: "tip", text: "Mount the Rotation Sensor directly on the same shaft as the mechanism you're tracking — never on a separate shaft connected through gears, as gear lash introduces measurement error." },
      },
      {
        heading: "Optical Sensor — Color Detection",
        body: "The Optical Sensor detects hue, saturation, brightness, and proximity. It can reliably distinguish red and blue game objects at close range.\n\n**Setup:**\n```cpp\nvex::optical OpticalSensor(PORT4);\nOpticalSensor.setLight(ledState::on); // turn on the LED for detection\n```\n\n**Reading color:**\n```cpp\ndouble hue = OpticalSensor.hue(); // 0–360\nint brightness = OpticalSensor.brightness(); // 0–100\nbool isRed = (hue < 30 || hue > 330);\nbool isBlue = (hue > 200 && hue < 260);\n```\n\n**Proximity reading:**\n```cpp\nint proximity = OpticalSensor.proximity(); // 0–255, higher = closer\nbool objectPresent = OpticalSensor.isNearObject();\n```\n\n**Color sorting intake example:**\n```cpp\nif (OpticalSensor.isNearObject()) {\n  if (isBlue && myAllianceColor == \"red\") {\n    Intake.spin(reverse, 100, pct); // reject opponent color\n  } else {\n    Intake.spin(fwd, 100, pct); // accept our color\n  }\n}\n```",
        callout: { type: "warning", text: "Optical sensors are sensitive to ambient light changes. Calibrate hue thresholds under competition lighting — gym fluorescents and LED arena lights can shift color readings by 10–20 hue units compared to your build room." },
      },
      {
        heading: "Sensor Fusion — Combining Multiple Sensors",
        body: "The most reliable autonomous routines combine multiple sensors, cross-checking one against another.\n\n**Example: Drive to goal with IMU + Distance Sensor:**\n```cpp\nvoid driveToGoal(double targetDist_mm) {\n  double targetHeading = InertialSensor.rotation();\n  Drive.setVelocity(60, pct);\n  Drive.spin(fwd);\n  \n  while (DistanceSensor.objectDistance(mm) > targetDist_mm) {\n    // Correct heading drift while driving\n    double headingError = targetHeading - InertialSensor.rotation();\n    LeftDrive.setVelocity(60 + headingError * 2, pct);\n    RightDrive.setVelocity(60 - headingError * 2, pct);\n    wait(10, msec);\n  }\n  Drive.stop();\n}\n```\n\nThis combines:\n• **IMU** → keeps the robot driving straight\n• **Distance Sensor** → stops at the exact right distance\n\nNeither sensor alone would achieve this result as reliably.",
        callout: { type: "info", text: "At the World Championship level, almost every autonomous routine uses at least 3 sensors simultaneously — motor encoders, IMU, and either odometry wheels or GPS. Start simple and add sensors as your programming skills grow." },
      },
    ],
  },
  {
    title: "PID Control",
    description: "Master the Proportional-Integral-Derivative controller — the algorithm behind smooth, precise autonomous movement in every competitive VEX robot.",
    level: "Advanced",
    duration: "22 min read",
    color: "red",
    icon: "🎯",
    topics: ["What is PID", "Proportional", "Integral", "Derivative", "Tuning", "VEX Examples"],
    sections: [
      {
        heading: "What is a PID Controller?",
        body: "A PID controller is an algorithm that continuously adjusts a motor's output to reach and hold a target value — a position, speed, or angle.\n\nWithout PID: you tell a motor to run at 50% power for 2 seconds to drive 24 inches. If the battery is low, you undershoot. If the floor is slippery, you overshoot. Every run is different.\n\nWith PID: you tell the robot 'drive until the encoder reads 1200 ticks.' The algorithm automatically adjusts motor power every 10ms based on how far off you are. Battery level, carpet friction, and mechanical variation are all compensated.\n\n**The three terms:**\n• **P (Proportional)** — responds to how far you are from the target *right now*.\n• **I (Integral)** — responds to how long you've been off target (fixes steady-state error).\n• **D (Derivative)** — responds to how fast the error is changing (smooths out oscillation).\n\n**Output formula:**\n```\noutput = (Kp × error) + (Ki × integral) + (Kd × derivative)\n```",
        callout: { type: "info", text: "PID is used in virtually every piece of industrial automation — from CNC machines to airplane autopilots to car cruise control. Learning it in VEX gives you a skill that applies far beyond robotics." },
      },
      {
        heading: "Proportional Term (P)",
        body: "The P term produces an output proportional to the current error.\n\n```cpp\ndouble error = target - currentPosition;\ndouble output = Kp * error;\n```\n\nWhen error is large (far from target) → large output (high motor power).\nWhen error is small (near target) → small output (slow motor).\n\n**Kp too small:** robot moves very slowly toward target, takes forever.\n**Kp too large:** robot overshoots the target, oscillates back and forth.\n**Kp just right:** robot approaches quickly and stops cleanly.\n\n**P-only problem — Steady State Error:**\nWith only P, the robot often stops just short of the target. When the error is very small, the P output is also small — too small to overcome friction. The robot sits there, slightly off target, forever.\n\nThis is called **steady-state error** and it's why we need the I term.",
        callout: { type: "tip", text: "Always start tuning with P only. Gradually increase Kp until the robot oscillates around the target, then back off by about 30%. You now have your P baseline before adding I and D." },
      },
      {
        heading: "Integral Term (I)",
        body: "The I term accumulates error over time. If the robot has been slightly off target for many iterations, the integral grows until the output is large enough to push past friction.\n\n```cpp\nintegral += error * dt; // dt = time step in seconds\ndouble iOutput = Ki * integral;\n```\n\n**Ki too small:** takes too long to overcome steady-state error.\n**Ki too large:** integral winds up (accumulates too fast), causing large overshoot.\n\n**Integral Windup — The Main Problem:**\nIf the robot is blocked from reaching the target (e.g., by a wall), the integral keeps growing indefinitely. When the blockage clears, the motor gets a massive sudden burst.\n\n**Solution — Integral Clamp:**\n```cpp\nintegral += error;\nintegral = fmax(-maxIntegral, fmin(maxIntegral, integral)); // clamp\n```\n\n**Also reset integral near target:**\n```cpp\nif (fabs(error) > integralRange) integral = 0; // only integrate when close\n```\n\nFor most VEX drive PID, a small Ki (0.001–0.05) with a tight clamp is all you need.",
        callout: { type: "warning", text: "Many experienced VEX programmers use only PD control (no I term) for driving. The I term is most useful for velocity control (maintaining a set RPM) and position-holding (arm holding at height). For drives, P + D often works better." },
      },
      {
        heading: "Derivative Term (D)",
        body: "The D term responds to how fast the error is *changing*. If the robot is approaching the target quickly, the D term applies a braking force before it overshoots.\n\n```cpp\nderivative = (error - prevError) / dt;\ndouble dOutput = Kd * derivative;\nprevError = error;\n```\n\nWhen error is decreasing fast (approaching target) → D is negative → reduces output (braking).\nWhen error is increasing fast (moving away from target) → D is positive → increases output.\n\n**Kd too small:** doesn't damp oscillation much, still overshoots.\n**Kd too large:** robot freezes up, twitches, becomes unresponsive ('derivative kick').\n**Kd just right:** robot glides smoothly to the target without oscillating.\n\n**D on measurement, not error:**\nA better implementation uses the derivative of the sensor reading instead of the error, to avoid spikes when the target changes suddenly:\n```cpp\nderivative = (currentPosition - prevPosition) / dt;\ndouble dOutput = -Kd * derivative; // negative because we're fighting movement\n```",
        callout: { type: "tip", text: "Think of D as a dashpot (shock absorber). It resists rapid changes in position — smoothing out oscillation and overshooting. Start with Kd = 5–20× your Kp value as an initial guess." },
      },
      {
        heading: "Full PID Implementation for VEX",
        body: "Here is a complete, ready-to-use PID drive function for VEX:\n\n```cpp\nvoid drivePID(double targetInches) {\n  double wheelCircumference = M_PI * 3.25; // 3.25\" wheel diameter\n  double ticksPerInch = 360.0 / wheelCircumference;\n  double target = targetInches * ticksPerInch;\n\n  double Kp = 0.3, Ki = 0.001, Kd = 2.0;\n  double error = 0, prevError = 0, integral = 0;\n  double tolerance = 10; // stop within 10 encoder ticks\n\n  LeftDrive.resetPosition();\n  RightDrive.resetPosition();\n\n  while (true) {\n    double pos = (LeftDrive.position(deg) + RightDrive.position(deg)) / 2.0;\n    error = target - pos;\n\n    if (fabs(error) < tolerance) break; // within tolerance — done\n\n    integral += error;\n    integral = fmax(-300, fmin(300, integral)); // clamp integral\n\n    double derivative = error - prevError;\n    double output = (Kp*error) + (Ki*integral) + (Kd*derivative);\n    output = fmax(-100, fmin(100, output)); // clamp output to ±100%\n\n    LeftDrive.spin(fwd, output, pct);\n    RightDrive.spin(fwd, output, pct);\n\n    prevError = error;\n    wait(10, msec);\n  }\n  LeftDrive.stop(brake);\n  RightDrive.stop(brake);\n}\n```",
        callout: { type: "tip", text: "Start tuning with Kp=0.1, Ki=0, Kd=0. Double Kp until it oscillates, then back off 30%. Add Kd (start at 5×Kp) to smooth oscillation. Add Ki last if there is still steady-state error." },
      },
      {
        heading: "Turning PID",
        body: "The same PID structure applies to turning — except you use the Inertial Sensor instead of motor encoders.\n\n```cpp\nvoid turnPID(double targetDegrees) {\n  double Kp = 1.2, Ki = 0.0, Kd = 8.0;\n  double error = 0, prevError = 0, integral = 0;\n  double tolerance = 1.0; // stop within 1 degree\n\n  InertialSensor.resetRotation();\n\n  while (true) {\n    error = targetDegrees - InertialSensor.rotation();\n\n    if (fabs(error) < tolerance) break;\n\n    integral += error;\n    integral = fmax(-50, fmin(50, integral));\n\n    double derivative = error - prevError;\n    double output = (Kp*error) + (Ki*integral) + (Kd*derivative);\n    output = fmax(-100, fmin(100, output));\n\n    LeftDrive.spin(fwd, output, pct);\n    RightDrive.spin(reverse, output, pct); // opposite for turning\n\n    prevError = error;\n    wait(10, msec);\n  }\n  LeftDrive.stop(brake);\n  RightDrive.stop(brake);\n}\n```\n\nCalling `turnPID(90)` will rotate the robot exactly 90° to the right. Negative values turn left.",
        callout: { type: "info", text: "Teams that master both drivePID and turnPID unlock the ability to chain movement sequences with sub-inch accuracy — which is exactly what world-level autonomous routines are built from." },
      },
    ],
  },
  {
    title: "Game Analysis",
    description: "Learn how to read the VEX game manual, calculate maximum scores, identify the most valuable actions, and plan your robot's strategy from Day 1 of the season.",
    level: "Beginner",
    duration: "14 min read",
    color: "orange",
    icon: "🎮",
    topics: ["Game Manual", "Scoring Math", "Priority Actions", "Robot Concept", "Season Planning", "Meta Strategy"],
    sections: [
      {
        heading: "The Season Starts at Game Reveal",
        body: "Each spring at the World Championship (late April/early May), VEX reveals the next season's game. From that moment, your season begins — and the teams that analyze the game fastest gain a significant early advantage.\n\nThe game reveal gives you:\n• The official **Game Manual** (the rulebook — treat it as law)\n• An animation explaining the field setup and gameplay\n• The **field CAD files** so you can measure element sizes precisely\n• A list of all scoring elements and their point values\n\n**Your first 48 hours after reveal:**\n1. Watch the reveal animation 3–5 times.\n2. Download and read the Game Manual from start to finish.\n3. Sketch the field from memory to test your understanding.\n4. Start a spreadsheet calculating maximum possible scores.\n5. Brainstorm robot concepts with your whole team — no idea is too crazy in the first session.",
        callout: { type: "info", text: "The teams that win Worlds almost always had a clear strategy within the first week of the season. Early analysis compounds — every decision you make flows from understanding the game deeply." },
      },
      {
        heading: "Reading the Game Manual",
        body: "The Game Manual is the authoritative source for every rule. Misreading it causes disqualifications, rule violations, and wasted build effort.\n\n**Key sections to focus on:**\n• **Definitions** — every technical term (Alliance, Possession, Scored, Contact) is defined. If you disagree with a referee call, the definition is the basis for your appeal.\n• **Scoring** — exactly how points are calculated. Read the examples.\n• **Restrictions** — what your robot *cannot* do (size limits, motor limits, pneumatics rules).\n• **Violation table** — what gets you a warning vs. a Match Affecting Disqualification.\n\n**Common traps teams fall into:**\n• Building a robot that scores a lot but violates a restriction they didn't read.\n• Misunderstanding 'possession' — touching vs. carrying vs. controlling differ in most games.\n• Ignoring the autonomous rules — auton has separate restrictions in many games.",
        components: [
          { emoji: "📖", name: "Definitions Section", color: "bg-blue-50 border-blue-200", badge: "bg-blue-100 text-blue-700", desc: "Read every definition twice. Referees call violations based on definitions, not common sense. 'Possession' and 'Scored' have precise legal meanings." },
          { emoji: "🔢", name: "Scoring Section", color: "bg-green-50 border-green-200", badge: "bg-green-100 text-green-700", desc: "Build a spreadsheet. Enter every scoring element and point value. Calculate what 100% of possible points looks like. Then reality-check it." },
          { emoji: "⛔", name: "Robot Rules", color: "bg-red-50 border-red-200", badge: "bg-red-100 text-red-700", desc: "Size, weight, motor count, pneumatics pressure limits. Know these before building a single part. Inspectors check everything." },
          { emoji: "⚠️", name: "Violation Table", color: "bg-yellow-50 border-yellow-200", badge: "bg-yellow-100 text-yellow-700", desc: "Know which rules result in warnings vs. DQ vs. Match Affecting DQ. Some violations are fine occasionally; others end your tournament instantly." },
        ],
        callout: { type: "warning", text: "Read the Game Manual update log throughout the season. VEX releases Q&As and manual updates that change rules and clarify edge cases. Teams that miss updates get caught off guard at tournaments." },
      },
      {
        heading: "Calculating Maximum Scores",
        body: "Before designing your robot, calculate what winning actually looks like mathematically.\n\n**Step 1 — List every scoring action:**\n| Action | Points | Difficulty |\n|--------|--------|------------|\n| Score 1 ring on post | 3 pts | Easy |\n| Score ring on top post | 5 pts | Hard |\n| Park on platform | 10 pts | Medium |\n\n**Step 2 — Calculate theoretical maximum:**\n• If there are 20 rings worth 3 pts each = 60 pts\n• Plus 4 top rings at 5 pts each = 20 pts\n• Plus 2 platforms at 10 pts each = 20 pts\n• **Max = 100 pts**\n\n**Step 3 — Estimate realistic target:**\n• Top teams at Worlds typically reach ~60–75% of theoretical max.\n• Mid-season regional winners average ~40–50%.\n• Your first tournament target: ~25–35% of max.\n\n**Step 4 — Identify the highest-value actions per second:**\nA 3-point ring that takes 2 seconds to score = 1.5 pts/sec.\nA 10-point platform that takes 5 seconds to reach = 2.0 pts/sec.\nFocus your robot on maximizing points-per-second, not total possible points.",
        callout: { type: "tip", text: "Build this spreadsheet on Day 1 and update it every time you learn more about the meta-game. Sharing it with your team creates a common scoring language that improves every design discussion." },
      },
      {
        heading: "Identifying Priority Actions",
        body: "Not all scoring actions are worth pursuing. The best robot designs focus on 1–2 high-value actions and do them extremely well, rather than trying to do everything.\n\n**Framework for evaluating actions:**\n• **High value per second** — how many points does this generate per second of robot time?\n• **Repeatability** — can you do this action 5, 10, 20 times per match?\n• **Mechanism complexity** — does this require 1 motor or 4? Simple is more reliable.\n• **Consistency** — does this work every single time, or does it fail 20% of the time?\n• **Counter-play** — can your opponent block or undo this action easily?\n\n**Tier system:**\n• **Tier 1 (must-have):** High value, repeatable, simple. Build this first.\n• **Tier 2 (if motors remain):** Good value, moderate complexity. Add if Tier 1 is working well.\n• **Tier 3 (skip):** Low value, high complexity, or easily countered. Don't build this.",
        components: [
          { emoji: "⭐", name: "Tier 1 — Core Scorer", color: "bg-green-50 border-green-200", badge: "bg-green-100 text-green-700", desc: "The one action your robot absolutely must do reliably. Often the highest-frequency scoring action. Design everything else around supporting this." },
          { emoji: "🔧", name: "Tier 2 — Secondary", color: "bg-blue-50 border-blue-200", badge: "bg-blue-100 text-blue-700", desc: "Adds meaningful points without complicating Tier 1. Only build after Tier 1 is working consistently." },
          { emoji: "❌", name: "Tier 3 — Skip", color: "bg-red-50 border-red-200", badge: "bg-red-100 text-red-700", desc: "Too complex, too slow, too risky, or too easy for opponents to counter. Cutting these makes your robot more reliable overall." },
        ],
        callout: { type: "tip", text: "The classic VEX mistake: building a robot that does 5 things at 60% reliability instead of a robot that does 2 things at 95% reliability. Judges call the second robot a 'well-designed' robot. Your opponent calls it scary." },
      },
      {
        heading: "Planning Your Season",
        body: "A structured season plan prevents scrambling before tournaments and ensures your robot is ready when it counts.\n\n**Month 1 — Research & Concept:**\n• Finalize game analysis and priority actions\n• Build 2–3 prototype mechanisms (rough, fast, exploratory)\n• Choose your drivetrain and finalize motor allocation\n• Begin engineering notebook from Day 1\n\n**Month 2–3 — First Build:**\n• Build your first competition robot\n• Test and iterate on mechanisms\n• Write your first autonomous routine\n• Practice with your driver daily\n\n**Month 4 — First Tournament:**\n• Attend your first event with a working (not perfect) robot\n• Treat it as a data collection session — note what works, what breaks, what you see other teams doing\n• Rebuild based on tournament observations\n\n**Month 5–7 — Refinement:**\n• Iterate quickly — the best teams go through 3–5 full robot redesigns in a season\n• Build consistent autonomous routines\n• Focus heavily on driver practice\n• Submit for State and Regional qualifications",
        callout: { type: "info", text: "The teams that go to Worlds rarely have the most complex robots — they have the most *iterated* robots. Expect to rebuild your robot 2–3 times in a season. Each rebuild is faster and better than the last." },
      },
    ],
  },
];


// ---------- NAV ----------
// ---------- C++ LESSONS DATA ----------
const cppLessons = [
  {
    id: 1,
    title: "Hello, World!",
    category: "Getting Started",
    difficulty: "Beginner",
    explanation:
      "Every C++ program starts with a `main()` function — it's the entry point where execution begins. `cout` prints text to the console. This lesson walks through every single line so nothing is a mystery.",
    points: [
      "`#include <iostream>` — tells the compiler to load the input/output stream library so you can use `cout` and `cin`.",
      "`using namespace std;` — without this you'd have to write `std::cout` every time. This line saves you from that.",
      "`int main()` — the function the OS calls when your program starts. Every C++ program must have exactly one.",
      "`cout << \"text\" << endl;` — `<<` is the insertion operator. It sends data to the output stream. `endl` flushes the buffer and moves to the next line.",
      "`return 0;` — signals to the operating system that the program exited without errors. Non-zero means something went wrong.",
    ],
    code: `// ─────────────────────────────────────────────
// LESSON 1: Hello, World!
// Every C++ program must have a main() function.
// Execution always starts from the top of main().
// ─────────────────────────────────────────────

// Step 1: Include the input/output library.
// Without this, cout doesn't exist.
#include <iostream>

// Step 2: Use the standard namespace.
// This lets us write "cout" instead of "std::cout".
using namespace std;

// Step 3: Define the main function.
// "int" means this function returns a whole number (the exit code).
int main() {

    // cout = "character output" — prints to the terminal.
    // << is the insertion operator — it "inserts" text into the output stream.
    // "Hello, World!" is a string literal (text wrapped in double quotes).
    // endl = end line — moves the cursor to the next line AND flushes the buffer.
    cout << "Hello, World!" << endl;

    // You can chain multiple << operators to print different things on one line.
    // This prints: "VEX Team: 39C"
    cout << "VEX Team: " << "39C" << endl;

    // You can also print numbers directly — no quotes needed for numbers.
    cout << "Motor ports available: " << 21 << endl;

    // Printing multiple things on the same line:
    cout << "Building" << " + " << "Coding" << " + " << "Competing" << endl;

    // Step 4: Return 0 to tell the OS the program succeeded.
    // If something went wrong you'd return a non-zero number.
    return 0;

} // ← closing brace ends the main() function`,
  },
  {
    id: 2,
    title: "Variables & Data Types",
    category: "Fundamentals",
    difficulty: "Beginner",
    explanation:
      "Variables are named storage boxes in memory. C++ is strongly typed — every variable must declare what kind of data it holds. The type determines how much memory is used and what operations are allowed.",
    points: [
      "`int` — stores whole numbers (no decimals). Range: −2,147,483,648 to 2,147,483,647. Perfect for motor speeds, port numbers, loop counters.",
      "`double` — stores 64-bit floating-point decimals. Use for sensor readings, distances, battery voltages.",
      "`bool` — stores only `true` or `false`. Internally stored as 1 or 0. Used for button states, flags, competition modes.",
      "`char` — stores a single character like `'A'`. Uses single quotes.",
      "`string` — stores text of any length. Requires `#include <string>`. Uses double quotes.",
      "`const` — makes a variable read-only. The compiler will error if you try to change it. Use for fixed values like field dimensions.",
    ],
    code: `// ─────────────────────────────────────────────
// LESSON 2: Variables & Data Types
// Variables are named memory locations that store data.
// Every variable needs: a TYPE, a NAME, and a VALUE.
//   Syntax: type name = value;
// ─────────────────────────────────────────────

#include <iostream>
#include <string>   // ← needed for the string type
using namespace std;

int main() {

    // ── INT ──────────────────────────────────────
    // int = integer = whole numbers only (no decimals).
    // In VEX: motor speeds, port numbers, counts, scores.
    int motorSpeed = 75;          // motor runs at 75% power
    int motorPort  = 1;           // motor plugged into Brain port 1
    int teamScore  = 0;           // starts at zero, increases during match

    cout << "Motor speed: " << motorSpeed << "%" << endl;
    cout << "Motor port:  " << motorPort        << endl;
    cout << "Team score:  " << teamScore        << endl;  // 0 at match start

    // ── DOUBLE ───────────────────────────────────
    // double = 64-bit floating point = numbers with decimals.
    // In VEX: battery voltage, sensor distances, gear ratios.
    double batteryVoltage = 12.8;   // V5 battery is 12.8V when full
    double gearRatio      = 1.667;  // 60-tooth driven by 36-tooth = 1.667:1
    double fieldLength    = 141.0;  // VEX field is 141 inches wide

    cout << "Battery: "     << batteryVoltage << "V"   << endl;
    cout << "Gear ratio: "  << gearRatio      << ":1"  << endl;
    cout << "Field length: "<< fieldLength    << " in" << endl;

    // ── BOOL ─────────────────────────────────────
    // bool = boolean = only true or false.
    // In VEX: button states, competition mode, sensor triggers.
    bool isAutonomous    = true;   // true during 15-sec auto period
    bool buttonPressed   = false;  // L1 shoulder button not pressed
    bool objectDetected  = true;   // distance sensor sees something

    // boolalpha prints "true"/"false" instead of "1"/"0"
    cout << "Autonomous mode:  " << boolalpha << isAutonomous   << endl;
    cout << "L1 pressed:       " << boolalpha << buttonPressed  << endl;
    cout << "Object detected:  " << boolalpha << objectDetected << endl;

    // ── CHAR ─────────────────────────────────────
    // char = single character. Always use single quotes.
    char alliance = 'R';   // 'R' for Red alliance, 'B' for Blue
    cout << "Alliance: " << alliance << endl;

    // ── STRING ───────────────────────────────────
    // string = a sequence of characters (text).
    // Must #include <string> at the top.
    string teamName   = "Cyber Wolves";
    string teamNumber = "39C";
    string autoRoute  = "right_side";   // which autonomous routine to run

    cout << "Team: " << teamNumber << " - " << teamName << endl;
    cout << "Running: " << autoRoute << " autonomous" << endl;

    // ── CONST ────────────────────────────────────
    // const = constant — value CANNOT change after declaration.
    // Compiler will error if you try to modify it.
    const int    MAX_MOTORS  = 8;     // VEX rules: 88W budget = up to 8× 11W motors
    const double FIELD_SIZE  = 141.0; // field is always 141 inches wide
    const int    DRIVE_SPEED = 80;    // default drive speed

    cout << "Max motors allowed:  " << MAX_MOTORS  << endl;
    cout << "Field size:          " << FIELD_SIZE  << " in" << endl;
    cout << "Default drive speed: " << DRIVE_SPEED << "%" << endl;

    // ── ARITHMETIC WITH VARIABLES ─────────────────
    // Variables can be used in calculations just like numbers.
    int leftSpeed  = motorSpeed + 10;   // 75 + 10 = 85
    int rightSpeed = motorSpeed - 10;   // 75 - 10 = 65
    cout << "Left: " << leftSpeed << "%, Right: " << rightSpeed << "%" << endl;

    return 0;
}`,
  },
  {
    id: 3,
    title: "Operators",
    category: "Fundamentals",
    difficulty: "Beginner",
    explanation:
      "Operators perform actions on values. Arithmetic operators do math. Comparison operators ask true/false questions. Logical operators combine conditions. Knowing when to use each one is essential for writing robot logic.",
    points: [
      "Arithmetic: `+` add, `-` subtract, `*` multiply, `/` divide, `%` modulo (remainder).",
      "Integer division truncates: `7 / 2 = 3` not `3.5`. Cast to double first if you need decimals.",
      "Comparison operators (`==`, `!=`, `<`, `>`, `<=`, `>=`) always return a `bool`.",
      "`&&` (AND) — both sides must be true. `||` (OR) — at least one side must be true. `!` (NOT) — flips the value.",
      "Compound assignment: `x += 5` is shorthand for `x = x + 5`. Works with all operators.",
      "`++x` (pre-increment) increments before use. `x++` (post-increment) increments after use.",
    ],
    code: `// ─────────────────────────────────────────────
// LESSON 3: Operators
// Operators tell C++ what to DO with your values.
// ─────────────────────────────────────────────

#include <iostream>
using namespace std;

int main() {

    // ── ARITHMETIC OPERATORS ─────────────────────
    int a = 20;
    int b = 6;

    cout << "=== Arithmetic ===" << endl;
    cout << "a + b = " << a + b << endl;  // 26  — addition
    cout << "a - b = " << a - b << endl;  // 14  — subtraction
    cout << "a * b = " << a * b << endl;  // 120 — multiplication

    // INTEGER DIVISION: both operands are int, so result is int (truncated).
    // 20 / 6 = 3.333... but stored as int → result is 3 (decimal dropped).
    cout << "a / b = " << a / b << endl;  // 3   ← truncated, NOT 3.333!

    // To get the decimal, cast one value to double first:
    cout << "a / b (exact) = " << (double)a / b << endl; // 3.333...

    // MODULO: the remainder after division. Very useful!
    // 20 % 6 = 2 because 6 goes into 20 three times (18), remainder 2.
    cout << "a % b = " << a % b << endl;  // 2   — remainder

    // Practical use: check if a number is even or odd
    int num = 17;
    if (num % 2 == 0) cout << num << " is even" << endl;
    else              cout << num << " is odd"  << endl;  // prints: 17 is odd


    // ── COMPARISON OPERATORS ─────────────────────
    // These ALWAYS return true or false (bool).
    cout << "\n=== Comparisons ===" << endl;

    int distance = 150;   // mm reading from distance sensor

    cout << "distance == 150 : " << boolalpha << (distance == 150) << endl; // true
    cout << "distance != 200 : " << boolalpha << (distance != 200) << endl; // true
    cout << "distance < 100  : " << boolalpha << (distance < 100)  << endl; // false
    cout << "distance >= 100 : " << boolalpha << (distance >= 100) << endl; // true


    // ── LOGICAL OPERATORS ────────────────────────
    // Combine multiple conditions into one bool result.
    cout << "\n=== Logical ===" << endl;

    bool l1Pressed   = true;   // L1 shoulder button held down
    bool intakeReady = false;  // intake not ready yet
    int  speed       = 85;     // current drive speed

    // && (AND): BOTH must be true for the whole thing to be true.
    // Here: l1Pressed=true AND intakeReady=false → false → intake doesn't spin.
    if (l1Pressed && intakeReady) {
        cout << "Intake spinning!" << endl;
    } else {
        cout << "Intake NOT ready — both conditions must be true." << endl;
    }

    // || (OR): at least ONE side must be true.
    // speed>80 is true, so the whole condition is true even though l1Pressed=true.
    if (speed > 80 || intakeReady) {
        cout << "High speed OR intake ready — at least one is true." << endl;
    }

    // ! (NOT): flips true to false, false to true.
    if (!intakeReady) {
        cout << "Intake is NOT ready (! flipped false → true)." << endl;
    }


    // ── COMPOUND ASSIGNMENT ──────────────────────
    // These are shorthand — they modify the variable in place.
    cout << "\n=== Compound Assignment ===" << endl;

    int motorPower = 50;
    cout << "Start: " << motorPower << endl;  // 50

    motorPower += 20;   // same as: motorPower = motorPower + 20  → 70
    cout << "+= 20 → " << motorPower << endl;

    motorPower -= 10;   // same as: motorPower = motorPower - 10  → 60
    cout << "-= 10 → " << motorPower << endl;

    motorPower *= 2;    // same as: motorPower = motorPower * 2   → 120
    cout << "*= 2  → " << motorPower << endl;

    motorPower /= 3;    // same as: motorPower = motorPower / 3   → 40
    cout << "/= 3  → " << motorPower << endl;


    // ── INCREMENT / DECREMENT ────────────────────
    // ++ adds 1, -- subtracts 1. Very common in loops.
    int tick = 0;
    tick++;   // tick is now 1
    tick++;   // tick is now 2
    cout << "\nAfter 2 increments: tick = " << tick << endl;

    tick--;   // tick is now 1
    cout << "After 1 decrement:  tick = " << tick << endl;

    return 0;
}`,
  },
  {
    id: 4,
    title: "If / Else Statements",
    category: "Control Flow",
    difficulty: "Beginner",
    explanation:
      "If/else lets your program make decisions. Every time you check a sensor, a button, or a competition state in VEX — you're using if/else. This lesson covers every form of the conditional statement.",
    points: [
      "`if (condition)` — runs the block only when condition is `true`.",
      "`else if (condition)` — checked only if the previous `if` was false. You can chain as many as you need.",
      "`else` — the catch-all fallback. Runs when nothing above matched.",
      "Conditions must be booleans or expressions that evaluate to true/false.",
      "Ternary operator: `condition ? valueIfTrue : valueIfFalse` — one-line if/else for simple assignments.",
      "Nested if/else: you can put if statements inside other if statements.",
    ],
    code: `// ─────────────────────────────────────────────
// LESSON 4: If / Else Statements
// Decision-making — the brain of your robot logic.
// ─────────────────────────────────────────────

#include <iostream>
using namespace std;

int main() {

    // ── BASIC IF ────────────────────────────────
    // The condition is evaluated. If it's true, the block { } runs.
    // If it's false, the block is completely skipped.
    int batteryLevel = 45;  // percent remaining

    if (batteryLevel < 20) {
        // This block only runs when batteryLevel is less than 20.
        // batteryLevel=45, so 45 < 20 is FALSE → this block is SKIPPED.
        cout << "WARNING: Low battery! Plug in now." << endl;
    }
    cout << "Battery check complete." << endl;  // always prints


    // ── IF / ELSE ────────────────────────────────
    // "else" is the alternative — runs when the if condition is FALSE.
    bool isAutonomous = false;

    if (isAutonomous) {
        // isAutonomous = false, so this block is skipped.
        cout << "[AUTO] Running autonomous routine..." << endl;
    } else {
        // This block runs because isAutonomous was false.
        cout << "[DRIVER] Driver control active." << endl;
    }


    // ── IF / ELSE IF / ELSE CHAIN ─────────────────
    // C++ checks conditions TOP TO BOTTOM and stops at the FIRST true one.
    // Only one block ever runs — even if multiple conditions are true.
    int distanceMM = 180;  // distance sensor reading in millimeters

    if (distanceMM < 50) {
        // 180 < 50 is FALSE → skip
        cout << "EMERGENCY STOP — obstacle too close!" << endl;
    } else if (distanceMM < 150) {
        // 180 < 150 is FALSE → skip
        cout << "Slow down — approaching object." << endl;
    } else if (distanceMM < 300) {
        // 180 < 300 is TRUE → this block runs, rest are skipped.
        cout << "Caution zone — reduce to 50% speed." << endl;
    } else {
        // Would run only if ALL above conditions were false.
        cout << "Path clear — full speed ahead!" << endl;
    }


    // ── NESTED IF ────────────────────────────────
    // You can put an if statement inside another if statement.
    bool l1Pressed  = true;
    bool intakeHome = true;

    if (l1Pressed) {
        // First check: is L1 held down?
        cout << "L1 is pressed." << endl;

        if (intakeHome) {
            // Second check (only reached if L1 is pressed): is intake at home?
            cout << "Intake at home position — safe to extend." << endl;
        } else {
            cout << "Intake NOT at home — cannot extend!" << endl;
        }
    }


    // ── LOGICAL OPERATORS IN CONDITIONS ──────────
    int joystickValue = 85;
    bool buttonA = false;

    // && means BOTH must be true
    if (joystickValue > 10 && joystickValue < 100) {
        cout << "Joystick in valid range: " << joystickValue << endl;
    }

    // || means AT LEAST ONE must be true
    if (buttonA || joystickValue > 50) {
        cout << "Moving: either button pressed or joystick pushed far." << endl;
    }


    // ── TERNARY OPERATOR ─────────────────────────
    // A compact one-line version of if/else.
    // Syntax: condition ? value_if_true : value_if_false
    int speed = 90;
    string driveMode = (speed > 50) ? "turbo" : "normal";
    // If speed > 50 is true  → driveMode = "turbo"
    // If speed > 50 is false → driveMode = "normal"
    cout << "Drive mode: " << driveMode << endl;  // prints: turbo

    int absValue = (speed >= 0) ? speed : -speed;  // absolute value
    cout << "Absolute value of " << speed << " = " << absValue << endl;


    // ── VEX REAL-WORLD EXAMPLE ───────────────────
    // How motor speeds are set based on sensor input:
    int objectDist = 120;   // distance sensor reading
    int driveSpeed;         // will be set by conditions below

    if (objectDist < 60) {
        driveSpeed = 0;           // stop
    } else if (objectDist < 150) {
        driveSpeed = 30;          // crawl
    } else if (objectDist < 300) {
        driveSpeed = 60;          // medium
    } else {
        driveSpeed = 100;         // full speed
    }

    cout << "Object at " << objectDist << "mm → drive at " << driveSpeed << "%" << endl;

    return 0;
}`,
  },
  {
    id: 5,
    title: "Loops — for & while",
    category: "Control Flow",
    difficulty: "Beginner",
    explanation:
      "Loops repeat a block of code. In VEX robotics, your entire driver control program runs inside a `while(true)` loop that repeats every 20ms for the whole 1:45 match. Understanding loops is non-negotiable for robotics.",
    points: [
      "`for (init; condition; update)` — best when you know exactly how many times to repeat.",
      "`while (condition)` — best when you repeat until something changes.",
      "`do { } while (condition)` — always runs at least once, then checks the condition.",
      "`break` — immediately exits the loop, jumps to the line after the closing brace.",
      "`continue` — skips the rest of the current iteration and goes back to the top of the loop.",
      "Infinite loop `while(true)` — the standard VEX driver control pattern. Exits only when the match ends.",
    ],
    code: `// ─────────────────────────────────────────────
// LESSON 5: Loops — for & while
// Loops let you repeat code without copy-pasting it.
// In VEX, loops are used for: motor ramp-ups,
// autonomous sequences, and the entire driver control period.
// ─────────────────────────────────────────────

#include <iostream>
using namespace std;

int main() {

    // ── FOR LOOP ─────────────────────────────────
    // Use when you know exactly how many times to repeat.
    // Syntax: for (start; keep_going_while; do_each_time)
    //
    // Execution order:
    //   1. int i = 5        (runs ONCE at the start)
    //   2. i >= 1           (checked BEFORE each iteration)
    //   3. body { } runs    (if condition was true)
    //   4. i--              (runs AFTER each iteration)
    //   5. go back to step 2
    cout << "=== Countdown ===" << endl;
    for (int i = 5; i >= 1; i--) {
        cout << i << "... ";  // prints: 5... 4... 3... 2... 1...
    }
    cout << "GO!" << endl;

    // Loop that counts UP from 0 to 4 (5 total iterations):
    cout << "\n=== Motor Ports ===" << endl;
    for (int port = 1; port <= 5; port++) {
        cout << "Checking motor on port " << port << endl;
    }


    // ── FOR LOOP — BUILDING AN AUTONOMOUS SEQUENCE ─
    cout << "\n=== Autonomous Steps ===" << endl;
    string steps[] = {"Drive forward", "Turn right", "Score ring", "Return home"};
    int numSteps = 4;

    for (int s = 0; s < numSteps; s++) {
        // s = 0 → steps[0] = "Drive forward"
        // s = 1 → steps[1] = "Turn right"
        // s = 2 → steps[2] = "Score ring"
        // s = 3 → steps[3] = "Return home"
        cout << "Step " << (s + 1) << ": " << steps[s] << endl;
    }


    // ── WHILE LOOP ───────────────────────────────
    // Use when you don't know exactly how many times to repeat.
    // Keeps going as long as the condition is true.
    cout << "\n=== Motor Ramp-Up ===" << endl;
    int speed = 0;

    // This simulates gradually increasing motor speed (ramp-up).
    // In VEX, sudden 0→100 jumps can trip the motor's current limiter.
    while (speed < 100) {
        speed += 25;  // add 25% each iteration
        // Clamp to 100 so we don't overshoot
        if (speed > 100) speed = 100;
        cout << "Motor power: " << speed << "%" << endl;
        // Iteration 1: speed = 25
        // Iteration 2: speed = 50
        // Iteration 3: speed = 75
        // Iteration 4: speed = 100 → condition (100 < 100) is now FALSE → loop ends
    }
    cout << "Full speed reached!" << endl;


    // ── BREAK — EXIT A LOOP EARLY ─────────────────
    cout << "\n=== Break Example ===" << endl;
    for (int i = 0; i < 10; i++) {
        if (i == 5) {
            cout << "Object detected at step " << i << " — stopping scan!" << endl;
            break;  // immediately exits the for loop; skips i = 5, 6, 7, 8, 9
        }
        cout << "Scanning position " << i << endl;
    }
    cout << "Scan ended." << endl;


    // ── CONTINUE — SKIP AN ITERATION ─────────────
    cout << "\n=== Continue Example ===" << endl;
    // Print only ODD numbers 1-10
    for (int i = 1; i <= 10; i++) {
        if (i % 2 == 0) {
            continue;  // i is even → skip the cout below, jump back to i++
        }
        cout << i << " is odd." << endl;
    }


    // ── DO-WHILE LOOP ────────────────────────────
    // Like while, BUT the body runs at least once before checking the condition.
    cout << "\n=== Do-While ===" << endl;
    int attempts = 0;
    do {
        attempts++;
        cout << "Calibration attempt #" << attempts << endl;
        // Simulate: calibration succeeds after 3 tries
    } while (attempts < 3);   // keeps going while attempts < 3
    cout << "Calibration complete after " << attempts << " attempts." << endl;


    // ── VEX DRIVER CONTROL PATTERN ───────────────
    // In real VEX code, your usercontrol() function looks like this.
    // while(true) runs forever until the match timer ends.
    // task::sleep(20) tells the Brain to wait 20ms before the next iteration
    // — this gives other tasks CPU time and prevents overloading the Brain.
    cout << "\n=== Simulated Driver Control Loop ===" << endl;
    int matchTime = 0;  // simulating 3 ticks of the match

    while (matchTime < 3) {
        int joystickL = 80;  // pretend left joystick reads 80
        int joystickR = 80;  // pretend right joystick reads 80

        cout << "Tick " << matchTime
             << " | Left=" << joystickL
             << "% Right=" << joystickR << "%" << endl;

        // In real VEX: LeftDrive.spin(forward, joystickL, percent);
        //              RightDrive.spin(forward, joystickR, percent);
        //              task::sleep(20);  ← 20ms pause each loop

        matchTime++;
    }

    return 0;
}`,
  },
  {
    id: 6,
    title: "Functions",
    category: "Functions",
    difficulty: "Intermediate",
    explanation:
      "Functions let you name and reuse a block of code. In VEX, `autonomous()` and `usercontrol()` are functions. You'll write dozens of helper functions for driving, turning, scoring, and more. Functions make your code clean and testable.",
    points: [
      "Syntax: `returnType name(parameters) { body }` — all four parts matter.",
      "`void` means the function returns nothing. It just does something.",
      "Parameters are inputs — they're copies of what you pass in (pass by value).",
      "Pass by reference (`int& x`) lets a function modify the original variable.",
      "`return` immediately exits the function and sends a value back.",
      "Function prototypes (forward declarations) let you define functions after `main()`.",
    ],
    code: `// ─────────────────────────────────────────────
// LESSON 6: Functions
// Group reusable logic into named, callable blocks.
// In VEX, every robot action becomes a function.
// ─────────────────────────────────────────────

#include <iostream>
using namespace std;


// ── FUNCTION PROTOTYPES (forward declarations) ──
// These tell the compiler "this function exists, definition comes later."
// Needed when main() calls a function defined BELOW it in the file.
void printSeparator();
int  clamp(int value, int minVal, int maxVal);
double percentToRPM(int percent, int maxRPM);


// ── VOID FUNCTION — returns nothing, just does something ──
// Parameters: speed (int), durationMs (int)
// "void" means this function doesn't return a value.
void driveForward(int speed, int durationMs) {
    // speed and durationMs are LOCAL COPIES of what was passed in.
    // Changing them here does NOT affect variables outside this function.
    cout << "Driving FORWARD at " << speed << "% for "
         << durationMs << "ms" << endl;
    // In real VEX:
    // LeftDrive.spin(forward, speed, percent);
    // RightDrive.spin(forward, speed, percent);
    // task::sleep(durationMs);
    // LeftDrive.stop(brake);
    // RightDrive.stop(brake);
}

// Same pattern — but for turning:
void turnRight(int speed, int degrees) {
    cout << "Turning RIGHT " << degrees << "° at " << speed << "%" << endl;
    // In real VEX you'd turn until an IMU reads the target heading.
}


// ── FUNCTION WITH RETURN VALUE ───────────────────
// Returns int — the clamped value.
// "Clamp" constrains a value to a min/max range.
// VEX use: prevent joystick values from going beyond -100 to 100.
int clamp(int value, int minVal, int maxVal) {
    if (value < minVal) return minVal;  // too low → return the minimum
    if (value > maxVal) return maxVal;  // too high → return the maximum
    return value;                       // within range → return as-is
}

// Returns double — the RPM equivalent of a percentage.
double percentToRPM(int percent, int maxRPM) {
    // Formula: (percent / 100) * maxRPM
    // Cast percent to double so division gives decimals, not truncated int.
    return (double)percent / 100.0 * maxRPM;
}

// Returns bool — true if the motor is overheating.
bool isOverheating(double tempCelsius) {
    return tempCelsius > 55.0;   // V5 motors thermal-limit around 55°C
}


// ── PASS BY REFERENCE ────────────────────────────
// A regular parameter is a COPY — the original is not changed.
// A reference parameter (int& x) IS the original — changes affect the caller.
void applyDeadband(int& joystick, int threshold) {
    // If the joystick is within the threshold of zero, force it to zero.
    // This prevents motors from whining when the stick barely moves.
    // The & means we're modifying the ORIGINAL variable, not a copy.
    if (joystick > -threshold && joystick < threshold) {
        joystick = 0;   // this DOES change the caller's variable
    }
}


// ── HELPER FUNCTION ──────────────────────────────
// A simple utility called multiple times.
void printSeparator() {
    cout << "─────────────────────" << endl;
}


// ── DEFAULT PARAMETERS ───────────────────────────
// Parameters can have defaults — used when the caller doesn't provide them.
void stopAllMotors(string reason = "unknown") {
    cout << "ALL MOTORS STOPPED. Reason: " << reason << endl;
}


// ── MAIN ─────────────────────────────────────────
int main() {

    // Call void functions — just run them, no return value to capture.
    driveForward(80, 1000);     // drive at 80% for 1000ms
    driveForward(60, 500);      // drive at 60% for 500ms
    turnRight(40, 90);          // turn right 90 degrees at 40%
    printSeparator();

    // Call clamp() — capture its return value in a variable.
    int rawJoystick = 130;      // joystick somehow read above 100
    int safeSpeed   = clamp(rawJoystick, -100, 100);
    cout << "Raw joystick: " << rawJoystick
         << " → clamped to: " << safeSpeed << endl;

    printSeparator();

    // percentToRPM: 75% of a blue motor (600 RPM max) = 450 RPM
    double rpm = percentToRPM(75, 600);
    cout << "75% of 600 RPM motor = " << rpm << " RPM" << endl;

    // Green motor (200 RPM max) at 50%:
    cout << "50% of 200 RPM motor = " << percentToRPM(50, 200) << " RPM" << endl;

    printSeparator();

    // isOverheating — use return value in an if condition:
    double motorTemp = 58.5;
    if (isOverheating(motorTemp)) {
        cout << "Motor at " << motorTemp << "°C — OVERHEATING! Reducing power." << endl;
    }

    printSeparator();

    // Pass by reference — applyDeadband modifies the variable directly:
    int leftStick  = 4;    // barely touching the joystick
    int rightStick = 85;   // strongly pushed

    cout << "Before deadband: left=" << leftStick << " right=" << rightStick << endl;
    applyDeadband(leftStick,  10);  // 4 is within ±10 → set to 0
    applyDeadband(rightStick, 10);  // 85 is outside ±10 → unchanged
    cout << "After  deadband: left=" << leftStick << " right=" << rightStick << endl;

    printSeparator();

    // Default parameter — call with and without the reason:
    stopAllMotors("match ended");   // provides the optional reason
    stopAllMotors();                // uses the default reason: "unknown"

    return 0;
}`,
  },
  {
    id: 7,
    title: "Arrays & Vectors",
    category: "Data Structures",
    difficulty: "Intermediate",
    explanation:
      "Arrays and vectors store collections of values under one name. In VEX you use them for sensor history buffers, autonomous waypoints, motor port lists, and PID error logs. Vectors are the modern, safer choice — prefer them over raw arrays.",
    points: [
      "Array: fixed-size, declared at compile time. `int arr[5]` — always exactly 5 elements.",
      "Index is 0-based: `arr[0]` is first, `arr[4]` is last in a size-5 array. `arr[5]` is a bug!",
      "`vector<T>` — resizable, bounds-checkable, from `<vector>`. Always prefer this.",
      "`.push_back(val)` adds to the end. `.pop_back()` removes the last element.",
      "`.size()` returns the count. `.clear()` empties it. `.empty()` checks if empty.",
      "Range-based for loop: `for (int x : vec)` — cleanest way to iterate.",
    ],
    code: `// ─────────────────────────────────────────────
// LESSON 7: Arrays & Vectors
// Store multiple values under one name.
// ─────────────────────────────────────────────

#include <iostream>
#include <vector>    // ← needed for vector
#include <numeric>   // ← needed for accumulate (sum)
using namespace std;


int main() {

    // ══ PART 1: RAW ARRAYS ═══════════════════════
    // Arrays have a FIXED size set at compile time.
    // You CANNOT resize a raw array after creating it.
    cout << "=== Raw Arrays ===" << endl;

    // Declare and initialize an array of 5 ints:
    int motorPorts[5] = {1, 2, 9, 10, 11};
    //                   [0][1][2][3] [4]   ← index numbers

    // Access elements using their index (starts at 0!):
    cout << "Front-left  motor → PORT " << motorPorts[0] << endl;  // 1
    cout << "Front-right motor → PORT " << motorPorts[1] << endl;  // 2
    cout << "Back-left   motor → PORT " << motorPorts[2] << endl;  // 9

    // Loop through every element using the array size:
    cout << "\nAll motor ports: ";
    for (int i = 0; i < 5; i++) {
        cout << motorPorts[i] << " ";
    }
    cout << endl;

    // Modify an element (just like a regular variable):
    motorPorts[2] = 8;   // moved back-left motor to port 8
    cout << "Back-left motor moved to PORT " << motorPorts[2] << endl;

    // ⚠ WARNING: Out-of-bounds access is a serious bug!
    // motorPorts[5] — does NOT exist (valid indices are 0-4).
    // C++ will NOT warn you — it just reads garbage memory. Always stay within bounds.


    // ══ PART 2: VECTORS ══════════════════════════
    // Vectors are resizable arrays. ALWAYS prefer these over raw arrays.
    cout << "\n=== Vectors ===" << endl;

    // Create an empty vector of ints:
    vector<int> sensorReadings;  // starts with 0 elements

    // .push_back() adds an element to the END:
    sensorReadings.push_back(142);  // reading #1
    sensorReadings.push_back(139);  // reading #2
    sensorReadings.push_back(145);  // reading #3
    sensorReadings.push_back(141);  // reading #4
    sensorReadings.push_back(143);  // reading #5

    // .size() tells you how many elements are in the vector:
    cout << "Sensor readings collected: " << sensorReadings.size() << endl;

    // Access elements the same way as arrays — using [index]:
    cout << "First reading: " << sensorReadings[0] << " mm" << endl;
    cout << "Last  reading: " << sensorReadings[sensorReadings.size() - 1] << " mm" << endl;

    // Calculate the average sensor reading:
    int total = 0;
    for (int i = 0; i < sensorReadings.size(); i++) {
        total += sensorReadings[i];   // add each reading to total
    }
    double average = (double)total / sensorReadings.size();
    cout << "Average distance: " << average << " mm" << endl;


    // ── RANGE-BASED FOR LOOP ──────────────────────
    // The cleanest way to iterate — no index variable needed.
    // "int reading" takes on the VALUE of each element one by one.
    cout << "\nAll readings: ";
    for (int reading : sensorReadings) {
        cout << reading << " ";
    }
    cout << endl;


    // ── VECTOR INITIALIZED WITH VALUES ───────────
    vector<string> autoRoutines = {"left_side", "right_side", "center", "skills"};

    cout << "\nAvailable autonomous routines:" << endl;
    for (int i = 0; i < autoRoutines.size(); i++) {
        cout << "  [" << i << "] " << autoRoutines[i] << endl;
    }

    // .pop_back() removes the LAST element:
    autoRoutines.pop_back();   // removes "skills"
    cout << "After pop_back: " << autoRoutines.size() << " routines remain" << endl;

    // .clear() removes ALL elements:
    sensorReadings.clear();
    cout << "After clear: sensorReadings has " << sensorReadings.size() << " elements" << endl;

    // .empty() checks if the vector has zero elements:
    if (sensorReadings.empty()) {
        cout << "Buffer is empty — ready for fresh readings." << endl;
    }


    // ── VECTOR OF PAIRS — WAYPOINTS ──────────────
    // Store (x, y) autonomous path coordinates.
    // pair<int,int> holds two ints. Access with .first and .second.
    vector< pair<int,int> > waypoints;
    waypoints.push_back({0,   0  });   // start position
    waypoints.push_back({24,  0  });   // drive forward 24 inches
    waypoints.push_back({24,  24 });   // turn and drive 24 inches
    waypoints.push_back({48,  24 });   // drive to goal

    cout << "\nAutonomous path waypoints:" << endl;
    for (int i = 0; i < waypoints.size(); i++) {
        cout << "  Step " << i << ": ("
             << waypoints[i].first << "in, "
             << waypoints[i].second << "in)" << endl;
    }

    return 0;
}`,
  },
  {
    id: 8,
    title: "Strings",
    category: "Data Structures",
    difficulty: "Intermediate",
    explanation:
      "Strings store and manipulate text. In VEX you use strings to display messages on the Brain screen, name autonomous routines, format debug output, and build user interfaces. The `string` class comes with a powerful set of built-in methods.",
    points: [
      "`string` is a class, not a primitive type. It lives in `<string>`. Always `#include <string>`.",
      "`+` concatenates strings. You cannot add a string and a number directly — use `to_string()`.",
      "`.length()` / `.size()` — number of characters. `.empty()` — checks if it has zero length.",
      "`.find(sub)` — returns the index of the first match, or `string::npos` if not found.",
      "`.substr(start, len)` — extracts a portion of the string.",
      "`.at(i)` — access a character safely (throws an exception if out of bounds, unlike `[i]`).",
    ],
    code: `// ─────────────────────────────────────────────
// LESSON 8: Strings
// Text storage and manipulation.
// In VEX: Brain screen messages, auto selection, debug logs.
// ─────────────────────────────────────────────

#include <iostream>
#include <string>     // ← needed for string
using namespace std;

int main() {

    // ── DECLARING STRINGS ────────────────────────
    // Always use double quotes for strings (single quotes are for char).
    string teamNumber = "39C";
    string teamName   = "Cyber Wolves";
    string alliance   = "Red";
    string autoMode   = "left_high_goal";

    cout << "Team: " << teamNumber << " – " << teamName << endl;
    cout << "Alliance: " << alliance << endl;


    // ── CONCATENATION WITH + ──────────────────────
    // The + operator joins strings together.
    string fullTeam = teamNumber + " – " + teamName;
    cout << "Full name: " << fullTeam << endl;

    // ⚠ You CANNOT add a number directly to a string with +:
    // string bad = "Speed: " + 75;   ← COMPILE ERROR
    // Use to_string() to convert numbers to string first:
    int motorSpeed = 75;
    string speedMsg = "Motor speed: " + to_string(motorSpeed) + "%";
    cout << speedMsg << endl;

    // Build a status line like you'd show on the Brain LCD:
    int   score    = 42;
    int   timeLeft = 83;
    string status  = "Score:" + to_string(score) + "  Time:" + to_string(timeLeft) + "s";
    cout << "[Brain LCD] " << status << endl;


    // ── STRING LENGTH ─────────────────────────────
    // .length() and .size() both return the number of characters.
    cout << "\nteamName length: " << teamName.length() << " chars" << endl;
    cout << "autoMode length: " << autoMode.size()   << " chars" << endl;

    // .empty() returns true if the string has 0 characters:
    string emptyStr = "";
    if (emptyStr.empty()) {
        cout << "emptyStr is empty!" << endl;
    }


    // ── ACCESSING INDIVIDUAL CHARACTERS ──────────
    // Strings are arrays of characters. Index is 0-based.
    // teamNumber = "39C"
    //               [0][1][2]
    cout << "\nteamNumber[0] = '" << teamNumber[0] << "'"   << endl;  // '3'
    cout << "teamNumber[1] = '" << teamNumber[1] << "'"     << endl;  // '9'
    cout << "teamNumber[2] = '" << teamNumber[2] << "'"     << endl;  // 'C'

    // .at(i) does the same but safely throws an error if i is out of bounds:
    cout << "teamNumber.at(2) = '" << teamNumber.at(2) << "'" << endl;  // 'C'


    // ── SUBSTR ───────────────────────────────────
    // Extract part of a string.
    // .substr(startIndex, length)
    // fullTeam = "39C – Cyber Wolves"
    string extracted = fullTeam.substr(0, 3);   // start at index 0, take 3 chars
    cout << "\nExtracted team number: " << extracted << endl;  // "39C"

    string namePart = fullTeam.substr(6);       // everything from index 6 onward
    cout << "Name part: " << namePart << endl;  // "Cyber Wolves"


    // ── FIND ─────────────────────────────────────
    // .find(str) searches for a substring and returns its START index.
    // Returns string::npos (a huge number) if NOT found.
    size_t pos = autoMode.find("high");
    if (pos != string::npos) {
        cout << "\nFound 'high' at index " << pos << " in autoMode." << endl;
    } else {
        cout << "\n'high' not found in autoMode." << endl;
    }

    // Practical VEX use: pick autonomous routine based on string content:
    if (autoMode.find("left") != string::npos) {
        cout << "Selecting LEFT side autonomous." << endl;
    } else if (autoMode.find("right") != string::npos) {
        cout << "Selecting RIGHT side autonomous." << endl;
    }


    // ── COMPARISON ───────────────────────────────
    // Use == to compare strings (same as any other type).
    if (alliance == "Red") {
        cout << "\nRed alliance — starting on the right side." << endl;
    } else if (alliance == "Blue") {
        cout << "\nBlue alliance — starting on the left side." << endl;
    }


    // ── MODIFYING STRINGS ────────────────────────
    // Strings are mutable — you can change them after creation.
    string msg = "Hello";
    msg += ", VEX!";          // append using +=
    cout << "\nModified string: " << msg << endl;

    msg = "New message";      // reassign entirely
    cout << "Reassigned string: " << msg << endl;


    // ── PRACTICAL VEX EXAMPLE ────────────────────
    // Build a debug message to print to the Brain screen:
    string robotName = "Titan";
    double batteryPct = 87.5;
    int    matchSec   = 105;

    string debugLine = "[" + robotName + "] "
                     + "Batt:" + to_string((int)batteryPct) + "% "
                     + "Time:" + to_string(matchSec) + "s";
    cout << "\nBrain display: " << debugLine << endl;

    return 0;
}`,
  },
  {
    id: 9,
    title: "Classes & Objects",
    category: "OOP",
    difficulty: "Advanced",
    explanation:
      "Classes are blueprints for creating objects. Every VEX device is a class — `vex::motor`, `vex::inertial`, `vex::controller` are all classes you create objects from. Understanding OOP lets you write modular, professional-grade robot code.",
    points: [
      "A class defines WHAT data it holds (`private` members) and WHAT it can do (`public` methods).",
      "An object is one specific instance created from the class blueprint.",
      "Constructor — a special function that runs automatically when an object is created. Sets initial values.",
      "`private:` data can only be read/modified through public methods (encapsulation — protects data integrity).",
      "Getter/setter methods provide controlled access to private data.",
      "Classes can contain other objects — a `Robot` class can have `Motor` and `Sensor` members.",
    ],
    code: `// ─────────────────────────────────────────────
// LESSON 9: Classes & Objects
// Model real-world things (motors, sensors) as code objects.
// This is exactly how the VEX SDK is built internally.
// ─────────────────────────────────────────────

#include <iostream>
#include <string>
using namespace std;


// ══════════════════════════════════════════════
// CLASS DEFINITION: Motor
// Models a VEX V5 Smart Motor.
// ══════════════════════════════════════════════
class Motor {
    // ── PRIVATE SECTION ──────────────────────
    // Private members can ONLY be accessed from inside this class.
    // External code cannot do: myMotor.port = 5; ← COMPILE ERROR
    // This protects against accidental corruption of internal state.
private:
    int    port;       // which Brain port (1–21)
    int    speed;      // current speed in percent (-100 to 100)
    bool   reversed;   // true = motor physically mounted backwards
    double tempC;      // simulated temperature in Celsius

    // ── PUBLIC SECTION ────────────────────────
    // Public members ARE accessible from outside the class.
    // These are the "controls" the rest of your code uses.
public:
    string name;       // motor name (public so you can read it directly)

    // ── CONSTRUCTOR ──────────────────────────
    // Runs automatically when you create a Motor object.
    // Parameters set the initial state.
    // The "= false" gives reversed a default value if not specified.
    Motor(string motorName, int brainPort, bool isReversed = false) {
        name     = motorName;   // store the name
        port     = brainPort;   // store the port
        reversed = isReversed;  // store the direction flag
        speed    = 0;           // always start stopped
        tempC    = 22.0;        // room temperature at start
    }

    // ── METHODS (member functions) ─────────────
    // spin(): set the motor to a speed percentage.
    // If reversed, negate the speed so the physical direction is correct.
    void spin(int percent) {
        speed = reversed ? -percent : percent;
        cout << name << " [PORT " << port << "] spinning at "
             << speed << "%" << endl;
        tempC += 0.5;   // temperature rises slightly each call
    }

    // stop(): halt the motor and reset speed.
    void stop() {
        speed = 0;
        cout << name << " stopped." << endl;
    }

    // Getter: read-only access to the private 'speed' variable.
    // External code calls motor.getSpeed() instead of motor.speed directly.
    int getSpeed() const {    // 'const' means this method doesn't modify anything
        return speed;
    }

    // Getter for temperature:
    double getTemp() const {
        return tempC;
    }

    // Check if motor is overheating (over 55°C):
    bool isOverheating() const {
        return tempC > 55.0;
    }

    // Print full status — useful for debugging:
    void printStatus() const {
        cout << "── " << name << " ──" << endl;
        cout << "   Port:     " << port               << endl;
        cout << "   Speed:    " << speed << "%"        << endl;
        cout << "   Temp:     " << tempC << "°C"       << endl;
        cout << "   Reversed: " << boolalpha << reversed << endl;
    }
};


// ══════════════════════════════════════════════
// CLASS DEFINITION: Drivetrain
// Composed of Motor objects — classes can contain other objects!
// ══════════════════════════════════════════════
class Drivetrain {
private:
    Motor leftMotor;    // left drive motor object
    Motor rightMotor;   // right drive motor object

public:
    // Constructor: creates both motors.
    // Note the initializer list syntax ": leftMotor(...), rightMotor(...)"
    // This is how you initialize member objects that themselves need arguments.
    Drivetrain(int leftPort, int rightPort)
        : leftMotor("LeftDrive", leftPort, false),
          rightMotor("RightDrive", rightPort, true) {
        // rightMotor is reversed (true) because it's mounted the opposite way.
        cout << "Drivetrain initialized." << endl;
    }

    // Tank drive: each side gets its own speed.
    void tankDrive(int leftSpeed, int rightSpeed) {
        leftMotor.spin(leftSpeed);
        rightMotor.spin(rightSpeed);
    }

    // Arcade drive: one joystick for power, one for turn.
    void arcadeDrive(int power, int turn) {
        int left  = power + turn;
        int right = power - turn;
        leftMotor.spin(left);
        rightMotor.spin(right);
    }

    void stopAll() {
        leftMotor.stop();
        rightMotor.stop();
    }

    // Report health of all drive motors:
    void healthCheck() {
        cout << "=== Drivetrain Health ===" << endl;
        leftMotor.printStatus();
        rightMotor.printStatus();
        if (leftMotor.isOverheating() || rightMotor.isOverheating()) {
            cout << "⚠ OVERHEATING — reduce speed!" << endl;
        } else {
            cout << "✓ Temperatures normal." << endl;
        }
    }
};


// ══════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════
int main() {

    // ── CREATING OBJECTS (instances) ──────────────
    // Each object is independent — they don't share speed or temp.
    Motor lift("Lift", 5, false);         // single lift motor on port 5
    Motor intake("Intake", 6, true);      // intake motor on port 6, reversed

    // ── CALLING METHODS ───────────────────────────
    lift.spin(80);      // lift goes up at 80%
    intake.spin(100);   // intake runs at full speed

    cout << "Lift speed:   " << lift.getSpeed()   << "%" << endl;
    cout << "Intake speed: " << intake.getSpeed() << "%" << endl;

    lift.stop();
    intake.stop();

    cout << endl;

    // ── USING THE DRIVETRAIN CLASS ─────────────────
    Drivetrain drive(1, 10);   // left motor port 1, right motor port 10

    cout << "\n── Tank Drive ──" << endl;
    drive.tankDrive(80, 80);   // both sides forward at 80%

    cout << "\n── Arcade Drive ──" << endl;
    drive.arcadeDrive(70, 20); // power 70, turn right (20)

    drive.stopAll();

    cout << endl;
    drive.healthCheck();

    // ── DIRECT OBJECT STATUS ───────────────────────
    cout << endl;
    lift.printStatus();

    return 0;
}`,
  },
  {
    id: 10,
    title: "VEX C++ Basics",
    category: "VEX Specific",
    difficulty: "Advanced",
    explanation:
      "This lesson simulates a complete VEX competition program — the exact structure you'd upload to a V5 Brain. It covers the competition template, tank drive, button controls, sensor logic, and autonomous routines.",
    points: [
      "VEX programs have three main functions: `pre_auton()`, `autonomous()`, and `usercontrol()`.",
      "`pre_auton()` runs before the match — calibrate sensors, reset positions, display ready status.",
      "`autonomous()` runs for 15 seconds with no driver input — pre-programmed moves only.",
      "`usercontrol()` runs for 1 minute 45 seconds — reads controller inputs every 20ms.",
      "The `while(true) { task::sleep(20); }` loop is the heartbeat of driver control.",
      "Controller axis values are -127 to 127. Motor spin functions accept -100 to 100 percent.",
    ],
    code: `// ─────────────────────────────────────────────
// LESSON 10: Full VEX Competition Program
// This simulates the exact structure of a real VEXcode file.
// In VEXcode Pro, you'd replace the mock types with real vex:: objects.
// ─────────────────────────────────────────────

#include <iostream>
#include <string>
#include <cmath>      // for abs()
using namespace std;


// ══════════════════════════════════════════════
// SIMULATED VEX SDK TYPES
// In real VEXcode: #include "vex.h" gives you all of these.
// Here we simulate them so you can see the output.
// ══════════════════════════════════════════════

struct SimMotor {
    string name;
    int    speed = 0;
    SimMotor(string n) : name(n) {}

    // In real VEX: Motor.spin(forward, speed, percent);
    void spin(int pct) {
        speed = pct;
        string dir = pct >= 0 ? "FWD" : "REV";
        cout << "  [MOTOR] " << name << " → " << dir << " " << abs(pct) << "%" << endl;
    }

    // In real VEX: Motor.stop(brake);
    void stop() {
        speed = 0;
        cout << "  [MOTOR] " << name << " → STOPPED" << endl;
    }

    int getPosition() { return speed * 10; } // fake encoder value
};

struct SimBrain {
    // In real VEX: Brain.Screen.print("text");
    void print(string msg) {
        cout << "  [BRAIN LCD] " << msg << endl;
    }
};

struct SimController {
    // Simulated joystick values (-127 to 127).
    // In real VEX these come from the physical controller in real-time.
    int Axis3 = 90;   // left stick vertical  → forward/back
    int Axis1 = 20;   // right stick horizontal → turning

    bool ButtonL1 = false;   // intake in
    bool ButtonR1 = true;    // intake out — currently held
    bool ButtonA  = false;   // lift up
    bool ButtonB  = false;   // lift down
};

// ── Helper: clamp joystick to valid range ─────
int clamp(int v, int lo, int hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

// ── Helper: deadband — zero out small joystick movements ──
// Prevents motors from whining when stick is barely touched.
int deadband(int v, int threshold = 10) {
    return (abs(v) < threshold) ? 0 : v;
}

// ── Helper: map -127..127 to -100..100 percent ──
int axisToPct(int axisVal) {
    return clamp((int)(axisVal / 127.0 * 100.0), -100, 100);
}


// ══════════════════════════════════════════════
// GLOBAL DEVICE OBJECTS
// In real VEX these go in robot-config.h or at the top of main.cpp.
// Each one maps to a physical device plugged into the Brain.
// ══════════════════════════════════════════════

SimMotor LeftFront  ("LeftFront  [PORT 1 ]");  // front-left drive motor
SimMotor LeftBack   ("LeftBack   [PORT 2 ]");  // back-left drive motor
SimMotor RightFront ("RightFront [PORT 10]");  // front-right drive motor (reversed)
SimMotor RightBack  ("RightBack  [PORT 11]");  // back-right drive motor (reversed)
SimMotor Intake     ("Intake     [PORT 5 ]");  // intake roller motor
SimMotor Lift       ("Lift       [PORT 6 ]");  // lift arm motor

SimBrain      Brain;
SimController Controller1;


// ══════════════════════════════════════════════
// DRIVETRAIN HELPERS
// Group the four drive motors so you control them together.
// ══════════════════════════════════════════════

// Spin all four drive motors — positive = forward, negative = reverse.
// Left and right can be different (tank drive).
void setDrive(int leftPct, int rightPct) {
    LeftFront.spin(leftPct);
    LeftBack.spin(leftPct);
    // Right motors are physically reversed so we negate their value:
    RightFront.spin(-rightPct);
    RightBack.spin(-rightPct);
}

void stopDrive() {
    LeftFront.stop();  LeftBack.stop();
    RightFront.stop(); RightBack.stop();
}


// ══════════════════════════════════════════════
// PRE_AUTON
// Runs before the match starts (before autonomous).
// Use it to: calibrate sensors, home mechanisms,
// display ready status, select autonomous route.
// ══════════════════════════════════════════════
void pre_auton() {
    cout << "\n╔══ PRE-AUTONOMOUS ══╗" << endl;

    Brain.print("Calibrating IMU...");
    // In real VEX: Imu.calibrate(); while(Imu.isCalibrating()) task::sleep(20);
    cout << "  [IMU] Calibration complete. Heading: 0°" << endl;

    Brain.print("Homing lift...");
    // In real VEX: move lift to bottom limit switch
    cout << "  [LIFT] Homed at bottom position." << endl;

    Brain.print("Ready! Team 39C");
    cout << "  System ready." << endl;
    cout << "╚════════════════════╝" << endl;
}


// ══════════════════════════════════════════════
// AUTONOMOUS
// Runs for 15 seconds with NO driver input.
// Every move must be pre-programmed.
// This example: drive to goal, score, return.
// ══════════════════════════════════════════════
void autonomous() {
    cout << "\n╔══ AUTONOMOUS (15 sec) ══╗" << endl;
    Brain.print("AUTO: Drive to goal");

    // STEP 1: Drive forward at 80% for ~1000ms
    cout << "\n[Step 1] Drive forward to goal..." << endl;
    setDrive(80, 80);
    // In real VEX: task::sleep(1000);
    // (We skip the sleep here — can't wait in a simulation)
    stopDrive();

    // STEP 2: Turn right 90 degrees using IMU
    // In real VEX:
    //   Imu.resetHeading();
    //   setDrive(40, -40);   // left forward, right backward = turn right
    //   while(Imu.heading() < 90) task::sleep(20);
    //   stopDrive();
    cout << "[Step 2] Turning right 90°..." << endl;
    setDrive(40, -40);   // left forward, right backward
    stopDrive();
    Brain.print("AUTO: Turned 90 deg");

    // STEP 3: Drive to scoring position
    cout << "[Step 3] Drive to scoring zone..." << endl;
    setDrive(60, 60);
    stopDrive();

    // STEP 4: Deploy intake to score rings
    cout << "[Step 4] Scoring rings..." << endl;
    Brain.print("AUTO: Scoring");
    Intake.spin(100);    // intake at full speed
    // task::sleep(1500);  // run intake for 1.5 seconds
    Intake.stop();

    // STEP 5: Back up and return
    cout << "[Step 5] Returning to safe zone..." << endl;
    setDrive(-60, -60);  // negative = reverse
    stopDrive();

    Brain.print("AUTO: Complete!");
    cout << "╚══════════════════════════╝" << endl;
}


// ══════════════════════════════════════════════
// USERCONTROL
// Runs for 1 min 45 sec — driver is in control.
// This while(true) loop runs every 20ms.
// Every 20ms: read controller, update motors, repeat.
// ══════════════════════════════════════════════
void usercontrol() {
    cout << "\n╔══ DRIVER CONTROL (1:45) ══╗" << endl;
    Brain.print("Driver Control Active");

    // Simulate 3 ticks of the driver control loop
    // (In real VEX this runs thousands of times over 105 seconds)
    for (int tick = 0; tick < 3; tick++) {
        cout << "\n[Tick " << tick << "] Reading controller..." << endl;

        // ── ARCADE DRIVE ─────────────────────────
        // Read left stick (forward/back) and right stick (turn).
        // Apply deadband first to zero out tiny stick movements.
        int power = deadband(Controller1.Axis3);   // forward/back
        int turn  = deadband(Controller1.Axis1);   // left/right

        // Convert from axis range (-127 to 127) to motor percent (-100 to 100):
        int leftSpeed  = axisToPct(power + turn);   // add turn to left
        int rightSpeed = axisToPct(power - turn);   // subtract turn from right
        // Example: power=90, turn=20 → left=86%, right=57%
        // The turn makes the robot arc instead of going straight.

        cout << "  Joystick → power=" << power << " turn=" << turn << endl;
        setDrive(leftSpeed, rightSpeed);

        // ── INTAKE CONTROL ────────────────────────
        // R1 = intake in (collect rings), L1 = intake out (eject).
        if (Controller1.ButtonR1) {
            cout << "  R1 held → Intake IN" << endl;
            Intake.spin(100);   // full speed in
        } else if (Controller1.ButtonL1) {
            cout << "  L1 held → Intake OUT" << endl;
            Intake.spin(-80);   // reverse at 80%
        } else {
            Intake.stop();      // neither button → stop intake
        }

        // ── LIFT CONTROL ──────────────────────────
        // A = lift up, B = lift down.
        if (Controller1.ButtonA) {
            cout << "  A held → Lift UP" << endl;
            Lift.spin(75);
        } else if (Controller1.ButtonB) {
            cout << "  B held → Lift DOWN" << endl;
            Lift.spin(-50);
        } else {
            Lift.stop();
        }

        // In real VEX: task::sleep(20);  ← wait 20ms before next loop tick.
        // This is critical — without it the Brain gets flooded with commands.
    }

    // Match ended — stop everything.
    stopDrive();
    Intake.stop();
    Lift.stop();
    Brain.print("Match Over. GG!");
    cout << "\n╚═══════════════════════════╝" << endl;
}


// ══════════════════════════════════════════════
// MAIN
// The entry point. Sets up competition callbacks.
// In real VEX: Competition.autonomous(autonomous);
//              Competition.drivercontrol(usercontrol);
// ══════════════════════════════════════════════
int main() {
    cout << "╔════════════════════════════╗" << endl;
    cout << "║  VEX Competition Program   ║" << endl;
    cout << "║  Team 39C — Cyber Wolves   ║" << endl;
    cout << "╚════════════════════════════╝" << endl;

    pre_auton();      // setup phase
    autonomous();     // 15-second auto period
    usercontrol();    // 1:45 driver control

    return 0;
}`,
  },
];

// ---------- CODE LAB ----------
const aiLog = createLogger("codelab");
function CodeLab() {
  const SANDBOX_STARTER = `#include <iostream>
using namespace std;

int main() {
    // Write your code here — this is your free playground.
    // Run it instantly with the ▶ Run button.

    return 0;
}`;

  const [selectedIdx, setSelectedIdx] = useState(0); // null = sandbox, 0-9 = lessons
  const [sandboxCode, setSandboxCode] = useState(SANDBOX_STARTER);
  const [lessonCode, setLessonCode] = useState(cppLessons[0].code);
  const [output, setOutput] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [activeTab, setActiveTab] = useState("lesson");

  // AI chat state
  const [messages, setMessages] = useState([
    { role: "assistant", content: "Hey! I'm Voltz 👋 I know everything about VEX — Override (2026–27 upcoming), High Stakes (2024–25), Over Under (2023–24), all past games, C++, robot design, auton strategies, you name it. What do you wanna talk about?" }
  ]);
  const [chatInput, setChatInput] = useState("");
  const [isChatting, setIsChatting] = useState(false);
  const chatEndRef = React.useRef(null);

  // One-time cleanup: older builds stored a personal Groq key in plaintext
  // localStorage. The AI now runs through the server-side /api/groq-chat proxy,
  // so purge any lingering key to remove the stored-secret exposure.
  React.useEffect(() => {
    try { if (localStorage.getItem("groqApiKey")) localStorage.removeItem("groqApiKey"); } catch {}
  }, []);

  const isSandbox = selectedIdx === null;
  const code = isSandbox ? sandboxCode : lessonCode;
  const setCode = isSandbox ? setSandboxCode : setLessonCode;

  const lesson = isSandbox ? null : cppLessons[selectedIdx];

  const openSandbox = () => {
    setSelectedIdx(null);
    setOutput("");
    setActiveTab("output");
  };

  const selectLesson = (idx) => {
    setSelectedIdx(idx);
    setLessonCode(cppLessons[idx].code);
    setOutput("");
    setActiveTab("lesson");
  };

  const exportToVexcode = () => {
    const commentedCode = code
      .split("\n")
      .map((line) => `//  ${line}`)
      .join("\n");

    const lessonTitle = isSandbox ? "Free Playground" : lesson.title;

    const template = `/*---------------------------------------------------------
 *  Exported from VEX Learning Hub
 *  Lesson: ${lessonTitle}
 *
 *  HOW TO UPLOAD TO YOUR V5 BRAIN:
 *  1. Open VEXcode V5  →  vex.com/vexcode
 *  2. File > New Project > C++ > Competition Template
 *  3. Replace the contents of main.cpp with this file
 *  4. Move your logic into autonomous() or usercontrol()
 *  5. Plug in your V5 Brain via USB-C
 *  6. Click the Download button in VEXcode
 *---------------------------------------------------------*/

#include "vex.h"
using namespace vex;

// ---- Robot Configuration (uncomment & edit ports as needed) ----
brain        Brain;
// motor     LeftDrive  = motor(PORT1,  ratio18_1, false);
// motor     RightDrive = motor(PORT10, ratio18_1, true);
// controller Controller1 = controller(primary);

competition Competition;

// ---- Your Practice Code (reference) ----
// The code you wrote in Code Lab is below.
// Adapt it into autonomous() or usercontrol() above.
//
${commentedCode}

// ---- Pre-Autonomous ----
void pre_auton(void) {
  vexcodeInit();
  Brain.Screen.print("Ready!");
}

// ---- Autonomous (15 seconds) ----
void autonomous(void) {
  // TODO: Add your autonomous routine here
  // Example:
  //   LeftDrive.spinFor(forward, 2.0, turns);
  //   RightDrive.spinFor(forward, 2.0, turns);
}

// ---- Driver Control ----
void usercontrol(void) {
  while (true) {
    // TODO: Add your driver control code here
    // Example:
    //   LeftDrive.spin(forward,  Controller1.Axis3.value(), percent);
    //   RightDrive.spin(forward, Controller1.Axis3.value(), percent);

    wait(20, msec);
  }
}

int main() {
  Competition.autonomous(autonomous);
  Competition.drivercontrol(usercontrol);
  pre_auton();
  while (true) { wait(100, msec); }
}
`;

    const blob = new Blob([template], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vexcode_${lessonTitle.replace(/[^a-z0-9]/gi, "_").toLowerCase()}.cpp`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const runCode = useCallback(async () => {
    setIsRunning(true);
    setActiveTab("output");
    setOutput("Compiling and running...");

    try {
      // Wandbox API — free, no key needed, reliable C++ execution
      const res = await fetch("https://wandbox.org/api/compile.json", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          compiler: "gcc-head",
          options: "warning,gnu++17",
          "compiler-option-raw": "-O2",
        }),
      });

      const result = await res.json();

      if (result.compiler_error && result.compiler_error.trim()) {
        setOutput(`Compile Error:\n\n${result.compiler_error}`);
      } else if (result.program_error && result.program_error.trim()) {
        setOutput(`Runtime Error:\n\n${result.program_error}`);
      } else if (result.program_output && result.program_output.trim()) {
        setOutput(result.program_output);
      } else {
        setOutput("Compiled successfully — no output produced.");
      }
    } catch (e) {
      setOutput(`Network error: ${e.message}\n\nCheck your internet connection.`);
    } finally {
      setIsRunning(false);
    }
  }, [code]);

  const sendMessage = async () => {
    const text = chatInput.trim();
    if (!text || isChatting) return;

    const userMsg = { role: "user", content: text };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setChatInput("");
    setIsChatting(true);

    setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);

    const lessonCtx = isSandbox
      ? "Free Playground (no specific lesson)"
      : `Lesson: ${lesson?.title} (${lesson?.category})`;

    const systemPrompt = `You are Voltz, a chill and knowledgeable coding buddy for VEX Robotics students. You know everything about C++ and VEX inside out. Talk like a real person — casual, warm, vary your response length naturally (short for chat, longer only when actually needed). Always use \`\`\`cpp code blocks for code, and \`backticks\` for inline code references.

============================
C++ KNOWLEDGE (FULL)
============================
- Fundamentals: variables, data types (int, float, double, bool, char, string), operators, expressions, type casting
- Control flow: if/else if/else, switch/case, ternary operator
- Loops: for, while, do-while, range-based for, break, continue
- Functions: declaration, definition, parameters, return types, overloading, default params, pass by value/reference/pointer, recursion
- Pointers & references: *, &, nullptr, pointer arithmetic, dynamic memory (new/delete)
- Arrays: fixed arrays, multi-dimensional, decay to pointer
- STL: vector, map, unordered_map, set, queue, stack, pair, string, algorithm (sort, find, min, max)
- OOP: classes, objects, constructors/destructors, access specifiers (public/private/protected), getters/setters, inheritance, polymorphism, virtual functions, abstract classes, interfaces, operator overloading
- Templates: function templates, class templates
- Error handling: try/catch, throw, exception types
- Preprocessor: #include, #define, #ifdef, #pragma once
- Namespaces: using namespace, scope resolution ::
- Modern C++ (C++11/14/17): auto, nullptr, range-for, lambda expressions, smart pointers (unique_ptr, shared_ptr), initializer lists, constexpr, structured bindings
- Memory model: stack vs heap, RAII
- Common bugs: off-by-one, integer overflow, null pointer dereference, memory leaks, dangling pointers, infinite loops, uninitialized variables

============================
VEX V5 HARDWARE
============================
- V5 Brain: dual-core ARM Cortex-A9, 21 Smart Ports, 8 Three-Wire (ADI) ports, 480×272 color touchscreen, microSD slot, wireless download via V5 Radio, USB programming
- V5 Battery: 12.8V LiFePO4, ~1100mAh, smart battery with charge level reporting
- V5 Controller: 2 joysticks (Axis 1-4), 4 face buttons (A/B/X/Y), 4 shoulder buttons (L1/L2/R1/R2), D-pad, 2.4GHz radio, LCD screen
- V5 Smart Motors: 11W, 600RPM (blue), 200RPM (green), 100RPM (red) cartridges, built-in encoder, temperature sensing, internal PID
- Sensors: Inertial (IMU - 6-axis gyro+accel), Distance (laser ToF, 20-2000mm), Rotation (absolute, 0.088° precision), Optical (color/proximity/gesture), Vision (camera, color signatures), GPS (field-relative positioning), Bumper switch, Limit switch, Potentiometer, Encoder (ADI), Pneumatic solenoid (ADI)
- Smart Cables: proprietary 4-wire, multiple lengths (6in to 4ft), carry data+power
- Pneumatics: air tank, solenoids, tubing, pistons — used for fast actuation

============================
VEXCODE C++ API
============================
Brain & Display:
  vex::brain Brain;
  Brain.Screen.print("text");
  Brain.Screen.printAt(x, y, "text");
  Brain.Screen.clearScreen();
  Brain.Screen.setFillColor(vex::red);
  Brain.Screen.drawCircle(x, y, r);
  Brain.Battery.capacity(); // 0-100%

Motors:
  vex::motor M(vex::PORT1);                          // basic
  vex::motor M(vex::PORT1, vex::ratio18_1, true);    // with gearset + reversed
  M.spin(vex::forward, 80, vex::percent);
  M.spin(vex::reverse, 50, vex::percent);
  M.spinFor(vex::forward, 2.0, vex::turns);
  M.spinFor(vex::forward, 1000, vex::msec);
  M.spinToPosition(90, vex::degrees);
  M.stop(vex::brake);   // brake / coast / hold
  M.setVelocity(75, vex::percent);
  M.setMaxTorque(80, vex::percent);
  M.position(vex::degrees);
  M.velocity(vex::percent);
  M.temperature(vex::celsius);
  M.resetPosition();

Motor Groups:
  vex::motor_group LeftDrive(LF, LB);
  LeftDrive.spin(vex::forward, 80, vex::percent);
  LeftDrive.spinFor(vex::forward, 500, vex::msec);
  LeftDrive.stop(vex::brake);

Controller:
  vex::controller Controller1(vex::primary);
  Controller1.Axis3.value()  // -127 to 127 (left stick vertical)
  Controller1.Axis4.value()  // left stick horizontal
  Controller1.Axis1.value()  // right stick horizontal
  Controller1.Axis2.value()  // right stick vertical
  Controller1.ButtonA.pressing()   // bool
  Controller1.ButtonL1.pressing()
  Controller1.ButtonR1.pressing()
  Controller1.Screen.print("text");
  Controller1.Screen.clearLine(1);
  Controller1.rumble(".");  // vibrate pattern

Sensors:
  vex::inertial Imu(vex::PORT5);
  Imu.calibrate(); while(Imu.isCalibrating()) { wait(20,msec); }
  Imu.heading()      // 0-360°
  Imu.rotation()     // continuous degrees
  Imu.gyroRate(vex::zaxis, vex::dps)
  Imu.resetHeading();

  vex::distance Dist(vex::PORT6);
  Dist.objectDistance(vex::mm)
  Dist.isObjectDetected()

  vex::rotation Rot(vex::PORT7);
  Rot.angle()        // 0-360°
  Rot.position(vex::degrees)
  Rot.resetPosition()

  vex::optical Opt(vex::PORT8);
  Opt.hue()          // 0-360
  Opt.brightness()   // 0-100
  Opt.isNearObject()
  Opt.setLight(vex::ledState::on)

  vex::vision Vis(vex::PORT9, 50, SIGNATURE_1);
  Vis.takeSnapshot(SIGNATURE_1);
  Vis.largestObject.centerX   // pixel X of largest detected object
  Vis.largestObject.width

  vex::bumper Bump(Brain.ThreeWirePort.A);
  Bump.pressing()   // bool

  vex::encoder Enc(Brain.ThreeWirePort.A);
  Enc.rotation(vex::degrees)
  Enc.resetRotation()

Timing & Tasks:
  wait(500, vex::msec);
  wait(1, vex::seconds);
  vex::task myTask(myFunction);  // run function in parallel
  vex::task::sleep(20);

Competition Template:
  vex::competition Competition;
  void pre_auton() { vexcodeInit(); }
  void autonomous() { /* 15 sec auto */ }
  void usercontrol() { while(true) { /* driver code */ wait(20, msec); } }
  int main() {
    Competition.autonomous(autonomous);
    Competition.drivercontrol(usercontrol);
    pre_auton();
    while(true) { wait(100, msec); }
  }

============================
PROGRAMMING PATTERNS
============================
Tank Drive:
  int left  = Controller1.Axis3.value();
  int right = Controller1.Axis2.value();
  LeftDrive.spin(fwd, left, pct);
  RightDrive.spin(fwd, right, pct);

Arcade Drive:
  int power = Controller1.Axis3.value();
  int turn  = Controller1.Axis1.value();
  LeftDrive.spin(fwd, power + turn, pct);
  RightDrive.spin(fwd, power - turn, pct);

Deadband (prevent motor drift):
  if (abs(Controller1.Axis3.value()) > 5) { ... }

PID Controller:
  double kP=0.5, kI=0.001, kD=0.1;
  double error, prevError=0, integral=0, derivative;
  error = target - sensor.position(degrees);
  integral += error;
  derivative = error - prevError;
  double output = kP*error + kI*integral + kD*derivative;
  prevError = error;

Timed Autonomous:
  LeftDrive.spinFor(fwd, 1000, msec, false);
  RightDrive.spinFor(fwd, 1000, msec);  // last true = wait

Turn with IMU:
  Imu.resetHeading();
  LeftDrive.spin(fwd, 30, pct);
  RightDrive.spin(reverse, 30, pct);
  while(Imu.heading() < 90) { wait(20, msec); }
  LeftDrive.stop(brake); RightDrive.stop(brake);

============================
DRIVETRAIN TYPES
============================
- Tank (6-wheel drop center): most common, push power, simple
- 4-wheel tank: lighter, can rock
- X-Drive (holonomic): 4 omni at 45°, can strafe, complex
- H-Drive: tank + center perpendicular omni wheel for strafing
- Mecanum: roller wheels for omni movement

============================
MECHANISMS & DESIGN
============================
- 4-Bar Lift: parallel linkage, keeps end level, ~12" height
- 6-Bar Lift: more height (~18"), same principle
- DR4B (Double Reverse 4-Bar): 30"+ height, top teams use it
- Linear Lift/Cascade: chain or lead screw, compact
- Scissor Lift: X-shape, good mid-height range
- Roller Intake: rubber flex wheels or anti-static flaps
- Claw: pneumatic or motor-driven, grab/release objects
- Flywheel: high-speed spinning wheel for launching discs/balls
- Catapult/Puncher: tensioned rubber bands, fast launch
- Conveyor Belt: chain + plates, move objects vertically

Gear Ratios:
- Torque ratio (output > input): slower but more force
- Speed ratio (input > output): faster but less torque
- 1:1 direct: no change, most efficient
- Common combos: 36:60 (torque), 12:84 (high torque lift)

============================
VEX COMPETITION FORMAT
============================
- Match: 15 sec autonomous + 1:45 driver control = 2 min total
- Alliance: 2 robots per alliance (red vs blue)
- Skills: 60 sec solo runs — Driving Skills + Autonomous Coding Skills
- Qualification: Swiss-style rounds, earn WP/AP/SP ranking points
- Alliance Selection: top ranked teams pick partners
- Eliminations: 2-alliance brackets, best-of-3
- Awards: Tournament Champion, Excellence, Design, Innovate, Judges, Sportsmanship, Think, Build, Skills Champion
- Excellence Award: most prestigious — requires top notebook + performance
- Engineering Notebook: document every meeting, design decision, test result

============================
DEBUGGING TIPS
============================
- Brain.Screen.print() to log values live
- Controller1.Screen.print() for quick readouts during driving
- Check motor temps: if >55°C slow down or stop
- Use Imu.heading() to verify turns
- Print sensor values to verify wiring
- Deadband on joysticks prevents motor whine when idle
- If robot drifts: check motor reversed flag, check gear mesh
- Compile error "expected ';'": missing semicolon on previous line
- "Was not declared": check spelling, check #include, check scope

============================
CURRENT GAME — OVERRIDE (2026–2027)
============================
Game overview:
Override is the V5RC game for the 2026–2027 season, unveiled at the VEX Robotics World Championship in April 2026. Two alliances of 2 robots compete on a 12×12 ft field. 15-sec autonomous + 1:45 driver control; the Endgame is the final 10 seconds.

Key facts (Game Manual v1.0):
- Scoring: alliance-colored Pin scored in a Goal = 5 pts; owned yellow Pin = 10 pts; each robot in the Midfield at match end = 8 pts; Autonomous Bonus = 12 pts (tie → 6 each).
- Field: 56 Cups (36 start on field, 20 match loads), 63 Pins, 9 Goals (2 red, 2 blue, 4 neutral short, 1 neutral tall), 4 Toggles, 4 Loaders (2 per alliance).
- Toggles control yellow-Pin ownership per quadrant (must be fully seated and untouched to count, SC4); yellow Pins in the Midfield go to the alliance with more robots there at match end.
- Possession limit: max 1 Pin and 1 Cup at a time (SG6); plowing is allowed.
- AWP (SC8): ≥7 Pins scored + ≥3 Goals with ≥2 of your Pins (your side of the Autonomous Line) + neither robot touching the field perimeter, with zero auton violations.
- Sizes: start 18"×18"×18"; expansion max 24"×24" horizontal, 50" tall; in the Midfield during Endgame robots must stay near starting height (soft limit, SG12).
- Motors: 88W total (R10), max 55W on the drivetrain/Subsystem 2 (R11).
- This is NOT a rings/mobile goals game — that was High Stakes (2024-25). Override uses cups and pins.

NOTE: Override is only the game name. It has nothing to do with a controller override button or any software feature.

============================
PAST VEX GAMES — COMPLETE HISTORY
============================
NOTE ON OVERRIDE: Override is the 2026-2027 game (upcoming), NOT 2025-2026. It uses cups and pins stacking.

HIGH STAKES (2024–2025)
- Objects: Rings (small rubber rings) + Mobile Goals (tall pole goals)
- Stakes: Wall Stakes (fixed on field walls), Alliance Stakes (in alliance corners), Neutral Stake (center field)
- Scoring: Rings on stakes — top ring determines controlling alliance; highest ring wins the stake
- Positive Corner / Negative Corner: alliance corners that add/subtract from score; possessing mobile goals in positive = +3, negative = −3
- Auton: autonomous bonus + AWP (complete challenge)
- Endgame: Elevation on alliance bars (tier scoring: A/B/C/D)
- Meta: fast mobile goal rush, ring staking, corner control, elevation bot = ~20+ pts

OVER UNDER (2023–2024)
- Objects: Triballs (green triball game objects, triangular prism shape)
- Field: two 6-bar elevated zones, centre barrier (robots can go under), Elevation Bars in corners
- Scoring: Triballs in own zone (1 pt each), Triballs in opponent's zone = 0; push under barrier counts
- Auton: matchload triballs, autonomous line — triball in zone + crossing line = AWP
- Endgame: climb elevation bars (A/B tiers — A = both robots on bar, B = 1 robot)
- Meta: strong pushing bots, tri-ball wallbots, catapults for shooting under barrier

SPIN UP (2022–2023)
- Objects: Discs (flat coloured frisbees, 3 per robot max held)
- Field: two roller goals on field walls (spin to change colour), disc scoring zones (low/high goals), expansion zones
- Scoring: Disc in low goal = 1 pt, high goal = 2 pts; roller = 10 pts per roller controlled; coverage (discs on floor in own zone) = 1 pt each
- Auton: rollers + discs + autonomous win point
- Endgame: expansion (string/pneumatic expansion within own zone)
- Meta: flywheel/launcher bots for high goal, roller spinners, expansion for endgame coverage

TIPPING POINT (2021–2022)
- Objects: Rings (mobile), Mobile Goals (4 small yellow, 2 large yellow), Alliance-coloured Mobile Goals
- Field: platform in centre, 4 corner goals (stationary), 6 mobile goals
- Scoring: Rings on mobile goal posts (1 pt each), goal zone scored by owning team, platform balance bonus
- Auton: auton bonus + mobile goal possession
- Endgame: balance on platform (small bots or lightweight config) for tipping bonus
- Meta: mobile goal rush, ring loading, goal protection/tipping, platform parking

CHANGE UP (2020–2021)
- Objects: Balls (red, blue, neutral grey) — 3-ball stack scoring
- Field: 9 connected goals arranged in a 3×3 grid; goals connected in rows/columns
- Scoring: Ball in goal = 1 pt, but connected row/column of 3 goals all owned by same alliance = row bonus
- Home Row: alliance's home row of 3 goals; important for bonus
- Auton: autonomous line + ball scoring
- Meta: connected goal control, defensive ball placement, row completion combos

TOWER TAKEOVER (2019–2020)
- Objects: Cubes (7 colours, different point values based on stacking)
- Field: 3 towers per side (goal zones), 66 total cubes on field
- Scoring: Cube in zone = points (by cube colour); cube on tower = multiplier for that colour
- Towers: placing your colour cube in tower multiplies that colour's value for your alliance
- Auton: cube in zone + autonomous bonus
- Meta: tall stack bots (conveyor/tray intake), tower control, defensive dumping

TURNING POINT (2018–2019)
- Objects: Caps (reversible coloured discs on poles), Balls (for flags + caps)
- Field: 4 platforms (2 per alliance), 6 flags (high/low pairs on posts), 10 caps on poles/ground
- Scoring: Flag up in your colour = 1-2 pts; Cap your colour = 1 pt; Park on platform (low/high)
- Auton: 4 flags + caps + park
- Meta: flywheel for flags, puncher for far flags, platform parking bots

IN THE ZONE (2017–2018)
- Objects: Cones (20 cones per alliance + 10 neutral), Mobile Goals (5 per alliance, 1 neutral)
- Field: 5 scoring zones, mobile goals worth base points + cone multiplier
- Scoring: Mobile goal in zone = base value; each cone stacked = adds value × zone multiplier
- Auton: preloads + mobile goals
- Meta: fast mobile goal acquisition, tall cone stackers, zone control

STARSTRUCK (2016–2017)
- Objects: Stars (8-pointed foam) + Cubes; separated by foam fence
- Field: foam fence across the middle (40in); throw stars/cubes to opponent's side
- Scoring: Stars/cubes on opponent's field = negative for opponent; yours on your side = positive
- Auton: stars + hanging on fence
- Endgame: hang on fence (low/high hang)
- Meta: large throwing mechanisms, defensive bots, fence hangers

NOTHING BUT NET (2015–2016)
- Objects: Balls (foam balls of multiple sizes)
- Field: high goal (30in raised net), low goal (ground level net), field balls
- Scoring: High net = 5 pts (if not blocked), Low net = 2 pts, Far zone = bonus
- Autonomous Coding Skills: solo autonomous run through entire field
- Meta: accurate launchers (flywheels), ball feeds, consistent auton

SKYRISE (2014–2015)
- Objects: Skyrise Sections (blue/red cube-shaped pieces), Cubes (scored on Skyrise)
- Field: Skyrise base posts, scoring zones, 10 Skyrise sections per alliance
- Scoring: Skyrise section = 2 pts each (up to 7 sections tall), Cube on Skyrise = 1 pt
- Auton: preloads + Skyrise sections + auton bonus
- Meta: fast Skyrise builders, cube placers, reliable auton

============================
VEX IQ CHALLENGE GAMES (RECENT)
============================
- 2025-26: Override (IQ) — ball + hub game with robot positioning/pushing
- 2024-25: Rapid Relay — ball passing between robots across field obstacles
- 2023-24: Full Volume — note stacking/sorting, elevation
- 2022-23: Slapshot — disc/puck pushing into goals

============================
COMPETITION STRATEGY & SCOUTING
============================
Scouting what to look for:
- Consistency > peak performance (a team that scores 30 every match > one that sometimes scores 50)
- Autonomous reliability (especially AWP capability)
- Defense capability (can they handle aggressive bots?)
- Endgame reliability (elevation/climb success %)
- Cycle time (how fast can they pick up + score one cycle?)

Alliance selection strategy:
- Pick for complementarity (fast scorer + defensive bot)
- Avoid double-picking the same mechanism type
- Evaluate skills scores for autonomous capability indicator
- Talk to teams before picking — understand their robot's strengths

Autonomous programming best practices:
- Use encoders + IMU for accurate movement, not pure time-based
- Add sensor feedback to verify states (e.g., "did I pick up the object?")
- Handle edge cases (what if starting position is slightly off?)
- Test auton at least 20 times before competition
- Have a backup simpler auton in case primary fails

Current context: ${lessonCtx}
Current code in editor:
\`\`\`cpp
${code}
\`\`\``;

    try {
      const res = await fetch("/api/groq-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            { role: "system", content: systemPrompt },
            ...newMessages.map(m => ({ role: m.role, content: m.content })),
          ],
          max_tokens: 1024,
          temperature: 0.75,
        }),
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      const reply = data.choices?.[0]?.message?.content || "No response.";
      setMessages(prev => [...prev, { role: "assistant", content: reply }]);
    } catch (e) {
      aiLog.error("Voltz chat request failed", e?.message || e);
      setMessages(prev => [...prev, { role: "assistant", content: `Sorry — I couldn't reach the AI service just now. ${e.message}` }]);
    } finally {
      setIsChatting(false);
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    }
  };

  const categoryColors = {
    "Getting Started": "text-green-400",
    "Fundamentals": "text-blue-400",
    "Control Flow": "text-yellow-400",
    "Functions": "text-purple-400",
    "Data Structures": "text-orange-400",
    "OOP": "text-red-400",
    "VEX Specific": "text-red-500",
  };

  const difficultyBadge = {
    Beginner:     "bg-green-900 text-green-300",
    Intermediate: "bg-yellow-900 text-yellow-300",
    Advanced:     "bg-red-900 text-red-300",
  };

  const [sidebarOpen, setSidebarOpen] = React.useState(false);

  return (
    <div className="flex h-screen text-white pt-[57px] lg:pt-[65px] relative" style={{ background: DARK_PAGE_BG }}> {/* offset = Apple nav height */}
      {/* ── MOBILE SIDEBAR OVERLAY ── */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-20 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* ── SIDEBAR ── */}
      <aside className={`
        fixed lg:relative z-30 lg:z-auto top-[57px] lg:top-0 h-[calc(100vh-57px)] lg:h-auto
        w-64 shrink-0 bg-[#161617] border-r border-white/10 overflow-y-auto flex flex-col
        transition-transform duration-300
        ${sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}
      `}>
        <div className="px-4 py-4 border-b border-white/10">
          <h2 className="text-xs uppercase tracking-widest text-gray-400 font-bold mb-1">C++ Curriculum</h2>
          <p className="text-xs text-gray-500">{cppLessons.length} lessons</p>
        </div>

        {/* Sandbox button */}
        <button
          onClick={openSandbox}
          className={`w-full text-left px-4 py-3 flex items-center gap-3 border-b border-white/10 hover:bg-white/5 transition ${
            isSandbox ? "bg-white/10 border-l-2 border-yellow-400" : ""
          }`}
        >
          <div>
            <p className={`text-sm font-semibold ${isSandbox ? "text-white" : "text-gray-300"}`}>
              Free Playground
            </p>
            <p className="text-xs text-yellow-500">Write anything</p>
          </div>
        </button>

        <nav className="flex-1 py-2">
          {cppLessons.map((l, i) => (
            <button
              key={l.id}
              onClick={() => selectLesson(i)}
              className={`w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-white/5 transition ${
                selectedIdx === i ? "bg-white/10 border-l-2 border-red-500" : ""
              }`}
            >
              <span className="text-gray-500 text-xs font-mono mt-0.5 w-5 shrink-0">
                {String(l.id).padStart(2, "0")}
              </span>
              <div className="min-w-0">
                <p className={`text-sm font-medium truncate ${selectedIdx === i ? "text-white" : "text-gray-300"}`}>
                  {l.title}
                </p>
                <p className={`text-xs truncate ${categoryColors[l.category] || "text-gray-500"}`}>
                  {l.category}
                </p>
              </div>
            </button>
          ))}
        </nav>

        {/* Powered by */}
        <div className="px-4 py-3 border-t border-white/10">
          <p className="text-xs text-gray-600 text-center">Powered by Wandbox · Free · No login</p>
        </div>
      </aside>

      {/* ── MAIN ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <div className="flex items-center justify-between px-3 lg:px-5 py-3 border-b border-white/10 bg-[#161617] shrink-0">
          <div className="flex items-center gap-2 lg:gap-3">
            {/* Mobile sidebar toggle */}
            <button
              className="lg:hidden p-1.5 rounded hover:bg-white/10 transition"
              onClick={() => setSidebarOpen(o => !o)}
              aria-label="Toggle lessons"
            >
              <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            {isSandbox ? (
              <>
                <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-yellow-900 text-yellow-300">
                  Sandbox
                </span>
                <h1 className="text-sm font-bold text-white">Free Playground</h1>
              </>
            ) : (
              <>
                <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${difficultyBadge[lesson.difficulty]}`}>
                  {lesson.difficulty}
                </span>
                <span className={`text-xs font-semibold ${categoryColors[lesson.category] || ""}`}>
                  {lesson.category}
                </span>
                <h1 className="text-sm font-bold text-white">{lesson.title}</h1>
              </>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => isSandbox ? setSandboxCode(SANDBOX_STARTER) : setLessonCode(cppLessons[selectedIdx].code)}
              className="text-xs text-gray-400 hover:text-white px-3 py-1.5 rounded border border-white/10 hover:border-white/30 transition"
            >
              Reset
            </button>
            <button
              onClick={exportToVexcode}
              className="text-xs text-gray-300 hover:text-white px-3 py-1.5 rounded border border-white/20 hover:border-white/40 bg-white/5 hover:bg-white/10 transition"
              title="Download as VEXcode-ready main.cpp"
            >
              Export to VEXcode
            </button>
            {isSandbox && (
              <button
                onClick={runCode}
                disabled={isRunning}
                className={`flex items-center gap-2 px-4 py-1.5 rounded font-semibold text-sm transition ${
                  isRunning
                    ? "bg-gray-600 cursor-not-allowed"
                    : "bg-red-600 hover:bg-red-500"
                }`}
              >
                {isRunning ? (
                  <>
                    <span className="animate-spin inline-block w-3 h-3 border-2 border-white/30 border-t-white rounded-full" />
                    Running…
                  </>
                ) : (
                  <>▶ Run</>
                )}
              </button>
            )}
          </div>
        </div>

        {/* Editor + panels */}
        <div className="flex flex-col lg:flex-row flex-1 min-h-0">
          {/* Monaco editor */}
          <div className="flex-1 min-w-0 min-h-[40vh] lg:min-h-0">
            <Editor
              height="100%"
              language="cpp"
              theme="vs-dark"
              value={code}
              onChange={(val) => setCode(val || "")}
              options={{
                fontSize: 14,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                lineNumbers: "on",
                tabSize: 4,
                wordWrap: "on",
                fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
              }}
            />
          </div>

          {/* Right panel */}
          <div className="w-full lg:w-80 shrink-0 flex flex-col border-t lg:border-t-0 lg:border-l border-white/10 bg-[#161617] max-h-[55vh] lg:max-h-none">
            {/* Tabs */}
            <div className="flex border-b border-white/10 shrink-0">
              {(isSandbox ? ["output", "ai"] : ["lesson", "ai"]).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`flex-1 py-2 text-xs font-semibold capitalize transition ${
                    activeTab === tab
                      ? "text-white border-b-2 border-red-500"
                      : "text-gray-500 hover:text-gray-300"
                  }`}
                >
                  {tab === "lesson" ? "Lesson" : tab === "output" ? "Output" : "AI Tutor"}
                </button>
              ))}
            </div>

            {/* Lesson tab */}
            {activeTab === "lesson" && !isSandbox && lesson && (
              <div className="flex-1 overflow-y-auto p-4 space-y-4 text-sm">
                <p className="text-gray-300 leading-relaxed">{lesson.explanation}</p>
                <ul className="space-y-2">
                  {lesson.points.map((p, i) => (
                    <li key={i} className="flex gap-2 text-gray-400 leading-relaxed">
                      <span className="text-red-400 shrink-0">•</span>
                      <span dangerouslySetInnerHTML={{
                        __html: p.replace(/`([^`]+)`/g, '<code class="bg-white/10 text-yellow-300 px-1 rounded text-xs font-mono">$1</code>')
                      }} />
                    </li>
                  ))}
                </ul>
                <div className="rounded-lg bg-white/5 border border-white/10 p-3 text-xs text-gray-400">
                  💡 Read through the code and comments on the left. Head to <strong className="text-white">Free Playground</strong> to run your own code.
                </div>
              </div>
            )}

            {/* Output tab */}
            {activeTab === "output" && (
              <div className="flex-1 overflow-y-auto p-4">
                {output ? (
                  <pre className="text-xs font-mono leading-relaxed whitespace-pre-wrap text-gray-200">{output}</pre>
                ) : (
                  <div className="flex flex-col items-center justify-center h-full text-gray-600 text-sm text-center gap-2">
                    <span className="text-3xl">▶</span>
                    <p>Press Run to execute your code</p>
                  </div>
                )}
              </div>
            )}

            {/* AI Tutor tab */}
            {activeTab === "ai" && (
              <div className="flex-1 flex flex-col min-h-0">
                {/* Messages */}
                <div className="flex-1 overflow-y-auto p-3 space-y-3">
                  {messages.map((msg, i) => (
                    <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                      <div className={`max-w-[90%] rounded-2xl px-3 py-2 ${
                        msg.role === "user"
                          ? "bg-red-600 text-white rounded-br-sm text-xs"
                          : "bg-white/10 rounded-bl-sm"
                      }`}>
                        <ChatMessage content={msg.content} isUser={msg.role === "user"} />
                      </div>
                    </div>
                  ))}
                  {isChatting && (
                    <div className="flex justify-start">
                      <div className="bg-white/10 rounded-2xl rounded-bl-sm px-3 py-2 text-xs text-gray-400 flex gap-1 items-center">
                        <span className="animate-bounce" style={{animationDelay:"0ms"}}>•</span>
                        <span className="animate-bounce" style={{animationDelay:"150ms"}}>•</span>
                        <span className="animate-bounce" style={{animationDelay:"300ms"}}>•</span>
                      </div>
                    </div>
                  )}
                  <div ref={chatEndRef} />
                </div>

                {/* Input */}
                <div className="p-3 border-t border-white/10 flex gap-2 shrink-0">
                  <input
                    type="text"
                    value={chatInput}
                    onChange={e => setChatInput(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && !e.shiftKey && sendMessage()}
                    placeholder="Ask anything about C++..."
                    aria-label="Ask Voltz a question"
                    className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-red-500 transition"
                  />
                  <button
                    onClick={sendMessage}
                    disabled={isChatting || !chatInput.trim()}
                    aria-label="Send message to Voltz"
                    className="px-3 py-2 bg-red-600 hover:bg-red-500 disabled:opacity-40 rounded-lg text-xs font-semibold transition"
                  >
                    Send
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


function ChatMessage({ content, isUser }) {
  if (isUser) {
    return <div className="text-xs leading-relaxed whitespace-pre-wrap">{content}</div>;
  }

  // ── Split into code-block segments and text segments ─────────────────────
  const parts = [];
  const codeRe = /```(\w+)?\n?([\s\S]*?)```/g;
  let last = 0, m;
  while ((m = codeRe.exec(content)) !== null) {
    if (m.index > last) parts.push({ type:"text", content:content.slice(last, m.index) });
    parts.push({ type:"code", lang:m[1]||"cpp", content:m[2].trim() });
    last = m.index + m[0].length;
  }
  if (last < content.length) parts.push({ type:"text", content:content.slice(last) });

  // ── Inline markdown → HTML (bold, italic, inline-code) ───────────────────
  const inlineHtml = (txt) =>
    txt
      .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
      .replace(/\*\*(.+?)\*\*/g, '<strong style="color:#fff;font-weight:700">$1</strong>')
      .replace(/\*(.+?)\*/g,     '<em style="color:#d1d5db">$1</em>')
      .replace(/`([^`]+)`/g,     '<code style="background:rgba(255,255,255,0.12);color:#fde68a;padding:1px 4px;border-radius:4px;font-family:monospace;font-size:10px">$1</code>');

  // ── Render a text block with paragraphs, bullets, numbered lists ──────────
  const renderText = (text, key) => {
    const paras = text.trim().split(/\n{2,}/);
    return (
      <div key={key} className="space-y-2">
        {paras.map((para, pi) => {
          const lines = para.split("\n").map(l => l.trimEnd()).filter(Boolean);
          if (!lines.length) return null;

          // Bullet list (-, *, •)
          if (lines.every(l => /^[\-\*•]\s/.test(l.trimStart()))) {
            return (
              <ul key={pi} className="space-y-1 pl-0">
                {lines.map((line, li) => (
                  <li key={li} style={{ display:"flex", gap:6, alignItems:"flex-start" }}>
                    <span style={{ color:"#f87171", flexShrink:0, marginTop:1, lineHeight:1.4 }}>•</span>
                    <span style={{ color:"#d1d5db", fontSize:12, lineHeight:1.5 }}
                      dangerouslySetInnerHTML={{ __html: inlineHtml(line.replace(/^[\-\*•]\s+/,"")) }}/>
                  </li>
                ))}
              </ul>
            );
          }

          // Numbered list (1. 2.)
          if (lines.every(l => /^\d+[.)]\s/.test(l.trimStart()))) {
            return (
              <ol key={pi} className="space-y-1 pl-0">
                {lines.map((line, li) => (
                  <li key={li} style={{ display:"flex", gap:6, alignItems:"flex-start" }}>
                    <span style={{ color:"#f87171", flexShrink:0, fontWeight:700, fontSize:11, minWidth:16, lineHeight:1.5 }}>{li+1}.</span>
                    <span style={{ color:"#d1d5db", fontSize:12, lineHeight:1.5 }}
                      dangerouslySetInnerHTML={{ __html: inlineHtml(line.replace(/^\d+[.)]\s+/,"")) }}/>
                  </li>
                ))}
              </ol>
            );
          }

          // Heading line (## or ### or bold-only line)
          if (lines.length === 1 && /^#{1,3}\s/.test(lines[0])) {
            return (
              <p key={pi} style={{ color:"#fff", fontWeight:700, fontSize:12, marginBottom:2 }}
                dangerouslySetInnerHTML={{ __html: inlineHtml(lines[0].replace(/^#{1,3}\s+/,"")) }}/>
            );
          }

          // Normal paragraph — join single line breaks with <br/>
          return (
            <p key={pi} style={{ color:"#d1d5db", fontSize:12, lineHeight:1.6, margin:0 }}
              dangerouslySetInnerHTML={{ __html: lines.map(inlineHtml).join("<br/>") }}/>
          );
        })}
      </div>
    );
  };

  return (
    <div className="text-xs leading-relaxed space-y-2">
      {parts.map((part, i) =>
        part.type === "code" ? (
          <div key={i} className="rounded-lg overflow-hidden">
            <SyntaxHighlighter
              language={part.lang}
              style={vscDarkPlus}
              customStyle={{ margin:0, borderRadius:"8px", fontSize:"11px", padding:"10px" }}
              wrapLongLines
            >
              {part.content}
            </SyntaxHighlighter>
          </div>
        ) : renderText(part.content, i)
      )}
    </div>
  );
}

// ── AuthModal ─────────────────────────────────────────────────────────────
// "Continue with Google" — Supabase OAuth. Redirects out to Google's consent
// screen, so no credentials are ever handled in-app. Reused by AuthModal + the
// engagement-triggered SignInPrompt.
//
// Google OAuth itself has no separate "create" vs "sign in" mode — Supabase
// happily signs in an existing account OR creates a new one from the same
// button. That's correct almost everywhere (SignInPrompt, the Community gate
// — ambiguous intent is fine there), but the AuthModal's Create Account tab
// specifically must reject an existing account rather than quietly logging
// the person into it. Since a full-page OAuth redirect throws away all React
// state, the requested `intent` is stashed in localStorage before leaving and
// read back after the redirect returns (see the enforcement effect in
// VexLearningHubInner) — the only way to carry it across that round trip.
const GOOGLE_OAUTH_INTENT_KEY = "voltz_google_oauth_intent";
function GoogleButton({ label = "Continue with Google", onError, intent }) {
  const { signInWithGoogle } = useAuth();
  const [busy, setBusy] = React.useState(false);
  const go = async () => {
    setBusy(true);
    if (intent) { try { localStorage.setItem(GOOGLE_OAUTH_INTENT_KEY, intent); } catch { /* ignore */ } }
    // Failsafe: on success the whole page redirects to Google almost
    // immediately, so this component unmounts before its state matters.
    // But if that redirect is blocked or delayed (network hiccup, a browser
    // extension, a config issue) with no error thrown, the button was
    // getting stuck on "Redirecting…" forever with zero feedback — recover
    // after a timeout instead of hanging indefinitely. Cleared on success
    // (moot — page navigates away) or on any error/thrown exception.
    const timeout = setTimeout(() => {
      setBusy(false);
      try { localStorage.removeItem(GOOGLE_OAUTH_INTENT_KEY); } catch { /* ignore */ }
      onError?.("Google sign-in is taking too long — check your connection, or use email sign-in below.");
    }, 8000);
    try {
      const { error } = (await signInWithGoogle()) || {};
      if (error) {
        clearTimeout(timeout);
        setBusy(false);
        try { localStorage.removeItem(GOOGLE_OAUTH_INTENT_KEY); } catch { /* ignore */ }
        onError?.(error.message || "Google sign-in unavailable");
      }
      // on success the browser redirects to Google — no further UI needed.
    } catch (e) {
      clearTimeout(timeout);
      setBusy(false);
      try { localStorage.removeItem(GOOGLE_OAUTH_INTENT_KEY); } catch { /* ignore */ }
      onError?.(e?.message || "Google sign-in failed — try email sign-in below.");
    }
  };
  return (
    <button onClick={go} disabled={busy}
      className="w-full py-3 rounded-xl font-semibold text-sm flex items-center justify-center gap-2.5 transition hover:bg-gray-50 disabled:opacity-60"
      style={{ border: "1px solid #dcdce3", color: "#1d1d1f", background: "#fff" }}>
      <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true">
        <path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"/>
        <path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"/>
        <path fill="#FBBC05" d="M11.69 28.18c-.44-1.32-.69-2.73-.69-4.18s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"/>
        <path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"/>
      </svg>
      {busy ? "Redirecting…" : label}
    </button>
  );
}

function AuthModal({ onClose, defaultEmail = "" }) {
  const { signIn, signUp, resetPasswordForEmail } = useAuth();
  const [tab, setTab]   = React.useState("signin"); // "signin" | "signup"
  const [email, setEmail]   = React.useState(defaultEmail);
  const [pw, setPw]         = React.useState("");
  const [pw2, setPw2]       = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [err, setErr]       = React.useState("");
  const [done, setDone]     = React.useState(false);
  const [showReset, setShowReset] = React.useState(false); // "Forgot password?" mini-flow
  const [resetSent, setResetSent] = React.useState(false);

  // Switch tabs without losing what they typed — used both by the manual
  // "Sign in instead" / "Create an account" links and by the auto-redirect
  // below when someone lands on the wrong tab for their email.
  const switchTab = (t) => { setTab(t); setErr(""); setPw(""); setPw2(""); setShowReset(false); setResetSent(false); };

  // Emails a one-time reset link (Supabase's own flow — a click brings them
  // back here signed in via a recovery session; ResetPasswordModal, mounted
  // in the app shell, then gates them into setting a new password).
  const sendReset = async () => {
    setErr("");
    if (!email) { setErr("Enter your email first."); return; }
    setLoading(true);
    try {
      const { error } = await resetPasswordForEmail(email);
      setLoading(false);
      // Same anti-enumeration shape as sign-up/sign-in: Supabase doesn't
      // reveal whether the email exists, so this "sends" either way — that's
      // intentional, not a bug to work around.
      if (error) { setErr(error.message); return; }
      setResetSent(true);
    } catch (e) {
      setLoading(false);
      setErr(e?.message || "Something went wrong — try again.");
    }
  };

  const submit = async () => {
    setErr("");
    if (!email || !pw) { setErr("Enter your email and password."); return; }
    if (tab === "signup" && pw !== pw2) { setErr("Passwords don't match."); return; }
    setLoading(true);
    try {
      if (tab === "signin") {
        const { error } = await signIn(email, pw);
        setLoading(false);
        if (error) {
          // Supabase deliberately returns the same generic message whether the
          // email doesn't exist or the password is wrong (anti-enumeration) —
          // so give a clear next step either way instead of a dead-end error.
          setErr("Incorrect email or password. New here? Create an account instead.");
          return;
        }
        onClose();
      } else {
        const { data, error } = await signUp(email, pw);
        setLoading(false);
        // Supabase's "already registered" signals, checked every way it's known
        // to surface across project configs/versions — none of these are 100%
        // guaranteed alone, so any one of them triggers the redirect:
        //  1. An explicit error naming it (wording varies by version/config).
        //  2. GoTrue's documented error code for it, when present.
        //  3. The anti-enumeration trick: signing up an existing *confirmed*
        //     email returns NO error but a user with an EMPTY identities array
        //     (rather than leaking that the account exists via a hard error).
        //  4. An existing but *unconfirmed* email: resubmitting just resends
        //     the confirmation mail and returns the ORIGINAL user record —
        //     its created_at is from the earlier signup, not "just now", which
        //     the identities check alone doesn't catch (identities isn't empty
        //     for this case since the original identity is already attached).
        const msg = error?.message || "";
        const createdAt = data?.user?.created_at ? new Date(data.user.created_at).getTime() : null;
        const alreadyRegistered =
          (error && /already\s*(been\s*)?registered|already exists|user.?already.?exists/i.test(msg))
          || error?.code === "user_already_exists"
          || (!error && Array.isArray(data?.user?.identities) && data.user.identities.length === 0)
          || (!error && !data?.session && createdAt && (Date.now() - createdAt > 15_000));
        if (alreadyRegistered) {
          switchTab("signin");
          // We can detect THAT an account exists (the anti-enumeration signals
          // above), but not client-side whether it has a password at all — a
          // very common case here is a Google-only account (no password ever
          // set), where "sign in" alone would send them straight into another
          // dead end. Point at both real options instead of assuming one.
          setErr("You already have an account with this email. If you signed up with Google, use Continue with Google above — otherwise sign in with your password.");
          return;
        }
        if (error) { setErr(error.message); return; }
        setDone(true);
      }
    } catch (e) {
      setLoading(false);
      setErr(e?.message || "Something went wrong — try again.");
    }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-sm bg-white rounded-3xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-8 pt-8 pb-6">
          <div className="flex items-center justify-between mb-6">
            <div className="w-10 h-10 rounded-xl bg-red-600 flex items-center justify-center">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
              </svg>
            </div>
            <button onClick={onClose} className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-400 hover:bg-gray-200 transition text-sm">✕</button>
          </div>

          {done ? (
            <div className="text-center py-4">
              <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
                <svg width="24" height="20" viewBox="0 0 24 20" fill="none"><path d="M2 10l7 7L22 2" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </div>
              <p className="text-gray-900 font-bold text-lg mb-1">Check your email</p>
              <p className="text-gray-400 text-sm">We sent a confirmation link to <strong>{email}</strong>. Click it to activate your account.</p>
              <button onClick={onClose} className="mt-6 w-full py-3 rounded-xl bg-red-600 text-white font-bold text-sm hover:opacity-90 transition">Done</button>
            </div>
          ) : showReset ? (
            resetSent ? (
              <div className="text-center py-4">
                <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
                  <svg width="24" height="20" viewBox="0 0 24 20" fill="none"><path d="M2 10l7 7L22 2" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </div>
                <p className="text-gray-900 font-bold text-lg mb-1">Check your email</p>
                <p className="text-gray-400 text-sm">If <strong>{email}</strong> has an account, we sent a link to reset the password. Click it to set a new one.</p>
                <button onClick={() => { setShowReset(false); setResetSent(false); }}
                  className="mt-6 w-full py-3 rounded-xl bg-red-600 text-white font-bold text-sm hover:opacity-90 transition">Back to Sign In</button>
              </div>
            ) : (
              <>
                <p className="text-gray-900 font-bold text-lg mb-1">Reset your password</p>
                <p className="text-gray-400 text-sm mb-5">Enter your email and we'll send you a link to set a new password.</p>
                <div>
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider block mb-1">Email</label>
                  <input type="email" value={email} onChange={e=>setEmail(e.target.value)}
                    placeholder="you@example.com" onKeyDown={e=>e.key==="Enter"&&sendReset()} autoFocus
                    className="w-full rounded-xl px-4 py-2.5 text-sm text-gray-900 outline-none"
                    style={LIGHT_CARD}/>
                </div>
                {err && <p className="text-red-500 text-xs mt-2">{err}</p>}
                <button onClick={sendReset} disabled={loading}
                  className="mt-4 w-full py-3 rounded-xl text-white font-bold text-sm transition hover:opacity-90 disabled:opacity-60"
                  style={{background:"#dc2626"}}>
                  {loading ? "..." : "Send reset link"}
                </button>
                <button onClick={() => { setShowReset(false); setErr(""); }}
                  className="w-full mt-2 py-2 text-sm font-medium text-gray-400 hover:text-gray-600 transition">
                  ← Back to Sign In
                </button>
              </>
            )
          ) : (<>
            {/* Tabs */}
            <div className="flex gap-1 p-1 rounded-xl mb-6" style={{background:"#f3f4f6"}}>
              {[["signin","Sign In"],["signup","Create Account"]].map(([t,l])=>(
                <button key={t} onClick={()=>switchTab(t)}
                  className="flex-1 py-2 rounded-lg text-sm font-semibold transition"
                  style={{background:tab===t?"#ffffff":"transparent",color:tab===t?"#111827":"#9ca3af",
                    boxShadow:tab===t?"0 1px 4px rgba(0,0,0,0.08)":"none"}}>
                  {l}
                </button>
              ))}
            </div>

            {/* Fast path first — Google, then email below the divider. `intent`
                mirrors the active tab so Google is held to the same rule as
                the email/password fields below it: Sign In requires an
                existing account, Create Account requires a new one. */}
            <GoogleButton onError={setErr} intent={tab === "signup" ? "signup" : "signin"} />

            <div className="flex items-center gap-3 my-4">
              <div className="flex-1 h-px" style={{ background: "#ececf1" }} />
              <span className="text-[11px] uppercase tracking-wider" style={{ color: "#9ca3af" }}>or continue with email</span>
              <div className="flex-1 h-px" style={{ background: "#ececf1" }} />
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider block mb-1">Email</label>
                <input type="email" value={email} onChange={e=>setEmail(e.target.value)}
                  placeholder="you@example.com" onKeyDown={e=>e.key==="Enter"&&submit()}
                  className="w-full rounded-xl px-4 py-2.5 text-sm text-gray-900 outline-none"
                  style={LIGHT_CARD}/>
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Password</label>
                  {tab === "signin" && (
                    <button type="button" onClick={() => { setShowReset(true); setErr(""); }}
                      className="text-xs font-semibold text-red-500 hover:underline">
                      Forgot password?
                    </button>
                  )}
                </div>
                <input type="password" value={pw} onChange={e=>setPw(e.target.value)}
                  placeholder="••••••••" onKeyDown={e=>e.key==="Enter"&&submit()}
                  className="w-full rounded-xl px-4 py-2.5 text-sm text-gray-900 outline-none"
                  style={LIGHT_CARD}/>
              </div>
              {tab==="signup"&&(
                <div>
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider block mb-1">Confirm Password</label>
                  <input type="password" value={pw2} onChange={e=>setPw2(e.target.value)}
                    placeholder="••••••••" onKeyDown={e=>e.key==="Enter"&&submit()}
                    className="w-full rounded-xl px-4 py-2.5 text-sm text-gray-900 outline-none"
                    style={LIGHT_CARD}/>
                </div>
              )}
              {err&&<p className="text-red-500 text-xs">{err}</p>}
            </div>

            <button onClick={submit} disabled={loading}
              className="mt-4 w-full py-3 rounded-xl text-white font-bold text-sm transition hover:opacity-90 disabled:opacity-60"
              style={{background:"#dc2626"}}>
              {loading ? "..." : tab==="signin" ? "Sign In" : "Create Account"}
            </button>

            {tab==="signin" ? (
              <p className="text-center text-xs text-gray-400 mt-3">
                No account?{" "}
                <button onClick={()=>switchTab("signup")} className="text-red-500 font-semibold hover:underline">Sign up free</button>
              </p>
            ) : (
              <p className="text-center text-xs text-gray-400 mt-3">
                Already have an account?{" "}
                <button onClick={()=>switchTab("signin")} className="text-red-500 font-semibold hover:underline">Sign in</button>
              </p>
            )}
          </>)}
        </div>
      </div>
    </div>
  );
}

// Google One Tap — the inline account-picker popup (top-right card listing the
// visitor's Google accounts), via Google Identity Services. No full-page
// redirect: the visitor clicks their account and is signed in through Supabase's
// signInWithIdToken. Fails silently (logs) if the client id / origin isn't set
// up, so the "Continue with Google" redirect button remains the fallback.
//
// REQUIRES (Google console): the app's exact origin — e.g. http://localhost:5173
// and your production URL — added to the OAuth client's "Authorized JavaScript
// origins". One Tap won't render on an unlisted origin.
const oneTapLog = createLogger("google-onetap");
function GoogleOneTap() {
  const { user, authLoading } = useAuth();
  React.useEffect(() => {
    // Never prompt a signed-in user. Wait until Supabase has restored the session
    // (authLoading === false) so returning visitors don't get a flash of One Tap
    // before their session loads. If a user is present, dismiss any shown prompt.
    if (user) { try { window.google?.accounts?.id?.cancel(); } catch { /* ignore */ } return; }
    if (authLoading || !GOOGLE_CLIENT_ID) return;
    const sb = getSB();
    if (!sb) return;
    let cancelled = false;
    const SRC = "https://accounts.google.com/gsi/client";

    // Secure nonce: give Google the SHA-256 hash (embedded in the id token),
    // hand Supabase the raw value; Supabase re-hashes and compares.
    const makeNonce = async () => {
      const raw = (crypto.randomUUID?.() || String(Math.abs(Date.now()))) + "-" + (crypto.randomUUID?.() || "n");
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
      const hashed = btoa(String.fromCharCode(...new Uint8Array(buf)));
      return { raw, hashed };
    };

    const init = async () => {
      if (cancelled || !window.google?.accounts?.id) return;
      try {
        const { raw, hashed } = await makeNonce();
        window.google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          nonce: hashed,
          use_fedcm_for_prompt: true,
          callback: async (resp) => {
            const { error } = await sb.auth.signInWithIdToken({ provider: "google", token: resp.credential, nonce: raw });
            if (error) oneTapLog.warn("One Tap sign-in failed", { msg: error.message });
            else oneTapLog.info("signed in via One Tap");
          },
        });
        window.google.accounts.id.prompt();
      } catch (e) { oneTapLog.warn("One Tap init failed", { msg: e?.message }); }
    };

    if (window.google?.accounts?.id) { init(); return () => { cancelled = true; }; }
    let script = document.querySelector(`script[src="${SRC}"]`);
    if (!script) {
      script = document.createElement("script");
      script.src = SRC; script.async = true; script.defer = true;
      document.head.appendChild(script);
    }
    const onLoad = () => init();
    script.addEventListener("load", onLoad, { once: true });
    return () => {
      cancelled = true;
      script?.removeEventListener("load", onLoad);
      try { window.google?.accounts?.id?.cancel(); } catch { /* ignore */ }
    };
  }, [user, authLoading]);
  return null;
}

// Engagement-triggered sign-in nudge. Never a hard gate — it appears once the
// visitor has actually explored (time on site + scroll depth), is dismissible,
// and won't reappear for days (cooldown). Signed-in users never see it. All
// thresholds + the decision live in lib/analytics.js (pure + tested).
// Gates someone into setting a new password right after they click a "reset
// your password" email link (AuthModal's "Forgot password?" -> Supabase mails
// a link -> clicking it signs them in via a short-lived recovery session and
// fires the PASSWORD_RECOVERY event, which AuthProvider turns into
// passwordRecovery=true). `visible` is a local latch set once from that flag
// rather than reading it directly on every render — updatePasswordAndClear
// Recovery() clears passwordRecovery the instant it succeeds, which would
// otherwise unmount this modal before its own "password updated" message
// ever had a chance to show.
function ResetPasswordModal() {
  const { user, passwordRecovery, updatePasswordAndClearRecovery } = useAuth() || {};
  const [visible, setVisible] = React.useState(false);
  React.useEffect(() => { if (passwordRecovery) setVisible(true); }, [passwordRecovery]);
  const [pw, setPw]     = React.useState("");
  const [pw2, setPw2]   = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [err, setErr]   = React.useState("");
  const [done, setDone] = React.useState(false);
  const [savedEmail, setSavedEmail] = React.useState(""); // captured before sign-out clears `user`
  if (!visible) return null;
  const save = async () => {
    setErr("");
    if (pw.length < 6) { setErr("Password must be at least 6 characters."); return; }
    if (pw !== pw2) { setErr("Passwords don't match."); return; }
    const emailForSignIn = user?.email || ""; // read now — updatePasswordAndClearRecovery signs out below
    setSaving(true);
    const { error } = await updatePasswordAndClearRecovery(pw);
    setSaving(false);
    if (error) { setErr(error.message || "Could not update password — try again."); return; }
    setSavedEmail(emailForSignIn);
    setDone(true);
  };
  // Signed out on purpose (see updatePasswordAndClearRecovery) — send them
  // straight to Sign In with their email pre-filled instead of just closing.
  const continueToSignIn = () => {
    setVisible(false);
    window.dispatchEvent(new CustomEvent("voltz-open-auth", { detail: { email: savedEmail } }));
  };
  return (
    <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
      <div className="w-full max-w-sm bg-white rounded-3xl shadow-2xl p-8">
        {done ? (
          <div className="text-center py-4">
            <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
              <svg width="24" height="20" viewBox="0 0 24 20" fill="none"><path d="M2 10l7 7L22 2" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </div>
            <p className="text-gray-900 font-bold text-lg mb-1">Password updated</p>
            <p className="text-gray-400 text-sm mb-5">Sign in with your new password to continue.</p>
            <button onClick={continueToSignIn}
              className="w-full py-3 rounded-xl bg-red-600 text-white font-bold text-sm hover:opacity-90 transition">
              Continue to Sign In
            </button>
          </div>
        ) : (
          <>
            <div className="w-14 h-14 rounded-full overflow-hidden mx-auto mb-4" style={{ background: "radial-gradient(circle at 50% 32%, #2b2e35, #141519)" }}>
              <VoltLogo size={56} />
            </div>
            <h3 className="text-xl font-semibold tracking-tight text-center mb-1.5" style={{ color: "#1d1d1f" }}>Set a new password</h3>
            <p className="text-sm text-center leading-relaxed mb-5" style={{ color: "#6e6e73" }}>
              Choose a new password for your account.
            </p>
            <div className="space-y-3">
              <input type="password" value={pw} onChange={(e) => { setPw(e.target.value); setErr(""); }} onKeyDown={(e) => e.key === "Enter" && save()}
                placeholder="New password" autoFocus
                className="w-full rounded-xl px-4 py-3 text-sm text-gray-900 outline-none" style={LIGHT_CARD} />
              <input type="password" value={pw2} onChange={(e) => { setPw2(e.target.value); setErr(""); }} onKeyDown={(e) => e.key === "Enter" && save()}
                placeholder="Confirm new password"
                className="w-full rounded-xl px-4 py-3 text-sm text-gray-900 outline-none" style={LIGHT_CARD} />
            </div>
            {err && <p className="text-red-500 text-xs mt-2">{err}</p>}
            <button onClick={save} disabled={saving}
              className="mt-4 w-full py-3 rounded-xl text-white font-bold text-sm transition hover:opacity-90 disabled:opacity-60" style={{ background: "#dc2626" }}>
              {saving ? "Saving…" : "Update password"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// One-time username prompt shown right after a user signs in without a username
// set. The chosen name becomes their identity everywhere — the Nav corner (in
// place of their email) and the Community chat — so they can never be confused
// with, or impersonated by, anyone else. Saved to the account (user_metadata).
function UsernameSetup() {
  const { user } = useAuth() || {};
  const needsUsername = !!user && !(user.user_metadata?.username);
  const [name, setName]     = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [err, setErr]       = React.useState("");
  React.useEffect(() => {
    if (needsUsername) setName(userDisplayName(user)); // suggest from Google name / email
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsUsername, user?.id]);
  if (!needsUsername) return null;
  const save = async () => {
    const clean = name.trim().replace(/\s+/g, " ");
    if (clean.length < 2) { setErr("Pick a username (at least 2 characters)."); return; }
    setSaving(true);
    const { error } = await getSB().auth.updateUser({ data: { username: clean, chat_name: clean } });
    setSaving(false);
    if (error) { setErr(error.message || "Could not save — try again."); return; }
    try { localStorage.setItem("chat_name", clean); } catch { /* ignore */ }
    // AuthProvider's onAuthStateChange updates `user` → needsUsername flips false → this hides.
  };
  return (
    <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
      <div className="w-full max-w-sm bg-white rounded-3xl shadow-2xl p-8">
        <div className="w-14 h-14 rounded-full overflow-hidden mx-auto mb-4" style={{ background: "radial-gradient(circle at 50% 32%, #2b2e35, #141519)" }}>
          <VoltLogo size={56} />
        </div>
        <h3 className="text-xl font-semibold tracking-tight text-center mb-1.5" style={{ color: "#1d1d1f" }}>Pick your username</h3>
        <p className="text-sm text-center leading-relaxed mb-5" style={{ color: "#6e6e73" }}>
          This is how you'll show up across Voltz — in the top corner and in the Community. Not your email, and no one else can use it as you.
        </p>
        <input value={name} onChange={(e) => { setName(e.target.value); setErr(""); }} onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder="e.g. RyanBuilds" autoFocus maxLength={24}
          className="w-full rounded-xl px-4 py-3 text-sm text-gray-900 outline-none" style={LIGHT_CARD} />
        {err && <p className="text-red-500 text-xs mt-2">{err}</p>}
        <button onClick={save} disabled={saving}
          className="mt-4 w-full py-3 rounded-xl text-white font-bold text-sm transition hover:opacity-90 disabled:opacity-60" style={{ background: "#dc2626" }}>
          {saving ? "Saving…" : "Set username"}
        </button>
      </div>
    </div>
  );
}

// Hard sign-in gate: 30s after a signed-out visitor lands, this covers the app
// and can't be dismissed — no "Maybe later", no backdrop-click close, no
// cooldown. (Previously this was a soft, dismissible nudge gated on time AND
// scroll depth via shouldPromptSignIn(); those helpers stay in lib/analytics.js
// but are no longer what drives this component.) Signing in is the only way
// past it, so keep an eye on bounce/signup numbers after changing this.
const FORCE_SIGNIN_AFTER_MS = 30_000;
function SignInPrompt() {
  const { user } = useAuth();
  const [show, setShow]   = React.useState(false);
  const [err, setErr]     = React.useState("");

  React.useEffect(() => {
    if (user) { setShow(false); return; } // signed in — never gate
    const t = setTimeout(() => setShow(true), FORCE_SIGNIN_AFTER_MS);
    return () => clearTimeout(t);
  }, [user]);

  if (!show || user) return null;
  return (
    <div className="fixed inset-0 z-[190] flex items-center justify-center bg-black/50 backdrop-blur-sm px-4">
      <div className="w-full max-w-sm bg-white rounded-3xl shadow-2xl overflow-hidden" data-reveal="scale">
        <div className="p-7 sm:p-8">
          <div className="w-14 h-14 rounded-full overflow-hidden mx-auto mb-4"
            style={{ background: "radial-gradient(circle at 50% 32%, #2b2e35, #141519)" }}>
            <VoltLogo size={56} />
          </div>
          <h3 className="text-xl font-semibold tracking-tight text-center mb-1.5" style={{ color: "#1d1d1f" }}>Sign in to keep going</h3>
          <p className="text-sm text-center leading-relaxed mb-6" style={{ color: "#6e6e73" }}>
            Create a free account to keep using Voltz — lessons, Code Lab, CAD, and the Community, with your progress synced across devices.
          </p>
          {err && <p className="text-red-500 text-xs text-center mb-3">{err}</p>}
          <GoogleButton onError={setErr} />
          <button onClick={() => window.dispatchEvent(new CustomEvent("voltz-open-auth"))}
            className="w-full mt-2.5 py-3 rounded-xl text-sm font-semibold transition hover:bg-gray-50"
            style={{ border: "1px solid #dcdce3", color: "#1d1d1f", background: "#fff" }}>
            Sign in with email
          </button>
        </div>
      </div>
    </div>
  );
}

// Voltz brand marks — red squircle + lightning bolt (the logo). VoltzMark is the
// full badge (nav, app-icon); VoltzBolt is just the bolt glyph for tight circular
// spots like the chat launcher.
function VoltzMark({ size = 32, className = "" }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className={className} role="img" aria-label="Voltz">
      <rect x="4" y="4" width="92" height="92" rx="24" fill="#dc2626" />
      <circle cx="50" cy="50" r="32" fill="none" stroke="#ffffff" strokeOpacity="0.16" strokeWidth="3" />
      <path d="M54 14 L30 58 L46 58 L40 86 L70 40 L52 40 Z" fill="#ffffff" />
    </svg>
  );
}

function VoltzBolt({ size = 24, color = "#ffffff", className = "" }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className={className} role="img" aria-hidden="true">
      <path d="M54 14 L30 58 L46 58 L40 86 L70 40 L52 40 Z" fill={color} />
    </svg>
  );
}

// Volt — the Voltz mascot + AI face. Glossy red robot, glowing cyan eyes, bolt
// antenna. Used as the brand mark (nav), the chat launcher, and the assistant
// avatar. useId keeps the gradient ids unique across the many instances.
function VoltMascot({ size = 40, className = "" }) {
  const u = React.useId().replace(/:/g, "");
  const g = (n) => `${n}${u}`;
  return (
    <svg viewBox="0 0 100 92" width={size} height={size} className={className} role="img" aria-label="Voltz">
      <defs>
        <linearGradient id={g("shell")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ff6f6f" /><stop offset="0.5" stopColor="#e22b2b" /><stop offset="1" stopColor="#a81818" />
        </linearGradient>
        <linearGradient id={g("ear")} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#d83333" /><stop offset="1" stopColor="#8f1414" /></linearGradient>
        <linearGradient id={g("visor")} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#2b2b38" /><stop offset="1" stopColor="#0c0c13" /></linearGradient>
        <radialGradient id={g("eye")} cx="0.5" cy="0.4" r="0.7"><stop offset="0" stopColor="#d6fbff" /><stop offset="0.45" stopColor="#36d8ec" /><stop offset="1" stopColor="#1488a8" /></radialGradient>
      </defs>
      <rect x="49" y="22" width="3" height="9" rx="1.5" fill="#9f1414" />
      <path d="M55 2 L46 15 L51.5 15 L48 25 L59 11 L53 11 Z" fill="#ffd60a" />
      <rect x="10" y="46" width="11" height="20" rx="5.5" fill={`url(#${g("ear")})`} />
      <rect x="79" y="46" width="11" height="20" rx="5.5" fill={`url(#${g("ear")})`} />
      <rect x="18" y="28" width="64" height="58" rx="20" fill={`url(#${g("shell")})`} />
      <ellipse cx="38" cy="40" rx="18" ry="9" fill="#ffffff" opacity="0.18" />
      <rect x="26" y="40" width="48" height="32" rx="14" fill={`url(#${g("visor")})`} />
      <rect x="35" y="48" width="10" height="14" rx="5" fill={`url(#${g("eye")})`} />
      <rect x="55" y="48" width="10" height="14" rx="5" fill={`url(#${g("eye")})`} />
      <circle cx="38" cy="51.5" r="2" fill="#ffffff" />
      <circle cx="58" cy="51.5" r="2" fill="#ffffff" />
      <path d="M42 65 Q50 70 58 65" fill="none" stroke="#36d8ec" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}

// The Voltz logo/mascot as a real image asset (public/volt.png) — the robot artwork.
// Rendered in a circle (objectFit cover clips the artwork's background corners). Falls
// back to the flat VoltMascot if the file is missing so the UI never shows a broken img.
function VoltLogo({ size = 40, className = "" }) {
  const [failed, setFailed] = React.useState(false);
  if (failed) return <VoltMascot size={size} className={className} />;
  return (
    <img src="/volt.png" alt="Voltz" width={size} height={size} draggable={false}
      onError={() => setFailed(true)} className={className}
      style={{ width: size, height: size, objectFit: "cover", borderRadius: "9999px", display: "block", pointerEvents: "none" }} />
  );
}

function Nav({ currentPage, setCurrentPage, onSignIn }) {
  const { user, signOut } = useAuth() || {};
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [userMenuOpen, setUserMenuOpen] = React.useState(false);
  const navLinks = [
    { label: "Home",      page: "home" },
    { label: "Lessons",   page: "lessons" },
    { label: "Code Lab",  page: "codelab" },
    { label: "CAD Lab",   page: "cad" },
    { label: "Dashboard", page: "dashboard" },
    { label: "Resources",  page: "resources" },
    { label: "Community",  page: "community" },
  ];

  const displayName = userDisplayName(user);
  const initials = displayName ? displayName.slice(0,2).toUpperCase() : "?";

  return (
    /* Apple-style nav: single consistent frosted graphite bar on every page */
    <nav className="fixed top-0 left-0 right-0 backdrop-blur-xl border-b text-white px-6 lg:px-10 py-3.5 lg:py-4 flex items-center justify-between z-50"
      style={{ background: "rgba(22,22,23,0.72)", borderColor: "rgba(255,255,255,0.1)" }}>
      {/* Logo */}
      <div className="flex items-center gap-2.5">
        <VoltLogo size={38} className="shrink-0" />
        <h1 className="brand-wordmark text-[22px] lg:text-[26px] leading-none">Voltz</h1>
      </div>

      {/* Desktop nav */}
      <div className="hidden lg:flex items-center gap-11 text-[13px] font-normal">
        {navLinks.map(({ label, page }) => (
          <button
            key={label}
            onClick={() => page && setCurrentPage(page)}
            className={`${
              page && currentPage === page ? "text-white font-medium" : "text-[#e8e8ed]/80"
            } hover:text-white transition`}
          >
            {label}
          </button>
        ))}
        {user ? (
          <div className="relative">
            <button onClick={()=>setUserMenuOpen(o=>!o)}
              className="flex items-center gap-2.5 px-3 py-2 rounded-2xl transition hover:bg-white/10">
              <div className="w-8 h-8 rounded-full bg-red-600 flex items-center justify-center text-white text-xs font-black">{initials}</div>
              <span className="text-sm text-gray-200 max-w-[120px] truncate">{displayName}</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6"/></svg>
            </button>
            {userMenuOpen && (
              <div className="absolute right-0 top-full mt-2 w-48 bg-white rounded-2xl shadow-xl overflow-hidden z-50 border border-gray-100">
                <div className="px-4 py-3 border-b border-gray-100">
                  <p className="text-gray-900 text-sm font-bold truncate">{displayName}</p>
                  <p className="text-gray-400 text-xs truncate mt-0.5">{user.email}</p>
                </div>
                <button onClick={()=>{signOut();setUserMenuOpen(false);}}
                  className="w-full text-left px-4 py-3 text-sm text-red-600 font-semibold hover:bg-red-50 transition">
                  Sign Out
                </button>
              </div>
            )}
          </div>
        ) : (
          <button onClick={onSignIn} className="px-4 py-1.5 rounded-full text-[13px] font-medium transition"
            style={{ background: "#0071e3", color: "#fff" }}>
            Sign In
          </button>
        )}
      </div>

      {/* Mobile hamburger */}
      <button
        className="lg:hidden flex flex-col gap-1.5 p-2"
        onClick={() => setMenuOpen(o => !o)}
        aria-label="Menu"
      >
        <span className={`block w-6 h-0.5 bg-white transition-all ${menuOpen ? "rotate-45 translate-y-2" : ""}`} />
        <span className={`block w-6 h-0.5 bg-white transition-all ${menuOpen ? "opacity-0" : ""}`} />
        <span className={`block w-6 h-0.5 bg-white transition-all ${menuOpen ? "-rotate-45 -translate-y-2" : ""}`} />
      </button>

      {/* Mobile drawer */}
      {menuOpen && (
        <div className="lg:hidden absolute top-full left-0 right-0 bg-black/95 border-b border-white/10 py-4 px-6 flex flex-col gap-1">
          {navLinks.map(({ label, page }) => (
            <button
              key={label}
              onClick={() => { if (page) { setCurrentPage(page); setMenuOpen(false); } }}
              className={`text-left py-3 text-base font-medium border-b border-white/5 ${
                page && currentPage === page ? "text-red-500" : "text-white"
              }`}
            >
              {label}
            </button>
          ))}
          {user ? (
            <button onClick={()=>{signOut();setMenuOpen(false);}}
              className="mt-3 border border-white/20 py-3 rounded-xl font-semibold text-gray-300 transition hover:bg-white/10">
              Sign Out ({displayName})
            </button>
          ):(
            <button onClick={()=>{onSignIn();setMenuOpen(false);}}
              className="mt-3 py-3 rounded-full font-medium transition"
              style={{ background: "#0071e3", color: "#fff" }}>
              Sign In
            </button>
          )}
        </div>
      )}
    </nav>
  );
}

// ---------- HOME ----------
function Home({ setCurrentPage }) {
  return (
    <div>
      {/* HERO */}
      <section
        className="relative text-white bg-cover bg-center"
        style={{
          backgroundImage: `url(${ROBOT_IMAGE})`,
          backgroundSize: "72%",
          backgroundPosition: "right center",
          backgroundRepeat: "no-repeat",
          backgroundColor: "#000",
          height: "580px",
        }}
      >
        {/* Overlay: near-black on left, transparent on right */}
        <div
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(to right, rgba(0,0,0,0.97) 0%, rgba(0,0,0,0.93) 20%, rgba(0,0,0,0.75) 35%, rgba(0,0,0,0.45) 50%, rgba(0,0,0,0.15) 65%, rgba(0,0,0,0) 80%)",
          }}
        />

        {/* TEXT — data-parallax: drifts up gently as the hero scrolls away (GSAP scrub) */}
        <div className="relative z-10 h-full flex items-center px-6 sm:px-12 lg:px-16 py-12">
          <div className="max-w-lg w-full">
            {/* GSAP reveal cascade: badge slides in, then headline/copy/CTAs rise in sequence */}
            <div className="mb-4 flex items-center gap-3" data-reveal="left">
              <div className="w-8 lg:w-10 h-[2px] bg-red-600"></div>
              <p className="uppercase tracking-widest text-red-500 text-[10px] lg:text-xs font-semibold">
                Learn VEX Robotics Smarter
              </p>
            </div>

            <h1 className="text-5xl sm:text-6xl lg:text-7xl font-black leading-tight mb-4 lg:mb-5" data-reveal="up" data-reveal-delay="0.1">
              BUILD CODE
              <br />
              <span className="text-red-600">COMPETE</span>
            </h1>

            <p className="text-gray-300 mb-6 lg:mb-8 leading-relaxed text-sm lg:text-base" data-reveal="up" data-reveal-delay="0.2">
              A student-friendly platform to master coding, robot design,
              teamwork, and competition strategies — all in one place.
            </p>

            <div className="flex flex-wrap gap-3" data-reveal="up" data-reveal-delay="0.3">
              <button
                onClick={() => setCurrentPage("lessons")}
                className="bg-red-600 hover:bg-red-700 px-6 lg:px-7 py-3 lg:py-3.5 rounded-lg font-semibold transition text-sm lg:text-base"
              >
                Start Learning
              </button>
              <button onClick={() => setCurrentPage("community")} className="border-2 border-white/60 hover:bg-white hover:text-black px-6 lg:px-7 py-3 lg:py-3.5 rounded-lg font-semibold transition text-sm lg:text-base">
                Join Community
              </button>
            </div>
          </div>
        </div>

        {/* STATS BAR */}
      </section>

      {/* FEATURES */}
      <section className="bg-gray-50 py-28 px-8">
        <div className="max-w-6xl mx-auto">
          {/* GSAP reveal: section header rises in, then the card grid staggers its children */}
          <div className="text-center mb-16" data-reveal="up">
            <p className="text-red-600 uppercase tracking-[0.25em] text-sm font-semibold mb-4">
              Everything You Need to Succeed in VEX
            </p>

            <h2 className="text-5xl font-black text-gray-900">
              Learn Design Compete Win
            </h2>

            <div className="w-28 h-1 bg-red-600 mx-auto mt-5 rounded-full"></div>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8" data-reveal="stagger">
            <FeatureCard
              icon="💻"
              title="Learn to Code"
              description="Master VEXcode C++ with step-by-step lessons and real examples."
            />

            <FeatureCard
              icon="🔧"
              title="Design Robots"
              description="Explore mechanisms, CAD systems, and robot engineering."
            />

            <FeatureCard
              icon="👥"
              title="Team Strategy"
              description="Improve communication, match strategy, and teamwork."
            />

            <FeatureCard
              icon="🏆"
              title="Compete & Win"
              description="Use advanced strategies to dominate competitions."
            />
          </div>
        </div>
      </section>
    </div>
  );
}

function FeatureCard({ icon, title, description }) {
  return (
    <div className="bg-white p-8 rounded-3xl border border-gray-100 hover:-translate-y-2 hover:shadow-2xl transition duration-300">
      <h3 className="text-2xl font-bold text-gray-900 mb-3">{title}</h3>

      <p className="text-gray-600 leading-relaxed">{description}</p>
    </div>
  );
}

// ---------- HELPERS ----------
const levelColors = {
  Beginner:     { bg: "bg-green-100",  text: "text-green-700",  border: "border-green-200" },
  Intermediate: { bg: "bg-blue-100",   text: "text-blue-700",   border: "border-blue-200"  },
  Advanced:     { bg: "bg-purple-100", text: "text-purple-700", border: "border-purple-200" },
};

const calloutStyles = {
  tip:     { accent: "#16a34a", label: "TIP"     },
  warning: { accent: "#d97706", label: "WARNING" },
  info:    { accent: "#2563eb", label: "INFO"    },
  note:    { accent: "#6e6e73", label: "NOTE"    },
};

// Bullet lines that start with a color-circle emoji (🔴🟢🔵 …) get that emoji
// swapped for a clean designed swatch instead — no AI-looking emoji in the copy.
const COLOR_EMOJI = { "🔴": "#dc2626", "🟢": "#1f9d4d", "🔵": "#2563eb", "🟠": "#ea580c", "🟡": "#e0a106", "🟣": "#8b5cf6", "⚪": "#cbd5e1", "⚫": "#374151", "🟤": "#9a6a3a" };
const COLOR_EMOJI_KEYS = Object.keys(COLOR_EMOJI);

// Shared styled code block (mac-window chrome + syntax highlighting). Used by
// the section `code` field AND by fenced ```blocks``` inside lesson body text.
function CodeCard({ code, lang = "cpp", label = "C++ — VEXcode Pro V5", file = ".cpp" }) {
  return (
    <div data-reveal="up" className="rounded-2xl overflow-hidden shadow-lg border border-white/10 my-6">
      <div className="bg-gray-800 px-5 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 bg-red-500 rounded-full"></span>
          <span className="w-3 h-3 bg-yellow-400 rounded-full"></span>
          <span className="w-3 h-3 bg-green-500 rounded-full"></span>
          <span className="text-gray-400 text-xs ml-2 font-mono tracking-wide">{label}</span>
        </div>
        <span className="text-xs text-gray-500 font-mono">{file}</span>
      </div>
      <SyntaxHighlighter
        language={lang}
        style={vscDarkPlus}
        showLineNumbers
        lineNumberStyle={{ color: "#4b5563", fontSize: "12px", minWidth: "2.5em" }}
        customStyle={{ margin: 0, borderRadius: 0, fontSize: "13px", lineHeight: "1.7", padding: "1.5rem" }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}

function RichBody({ text }) {
  if (!text) return null;
  // Body text may embed fenced code blocks (```cpp … ```). Split those out and
  // render each as a real CodeCard; prose between fences flows through the normal
  // inline/bullet renderer below. Without this, the fences printed as literal
  // backticks and the code dumped out as unstyled, unbounded paragraph text.
  if (text.includes("```")) {
    const segments = text.split(/```/);
    return (
      <div className="space-y-4">
        {segments.map((seg, i) => {
          if (i % 2 === 1) {
            // inside a fence: first token may be a language tag (e.g. "cpp")
            const nl = seg.indexOf("\n");
            const first = seg.slice(0, nl < 0 ? seg.length : nl).trim();
            const known = ["cpp", "c", "c++", "python", "py", "js", "javascript", "java", "json", "bash", "sh"];
            const hasLang = known.includes(first.toLowerCase());
            const lang = hasLang ? (first.toLowerCase() === "c++" ? "cpp" : first.toLowerCase()) : "cpp";
            const code = (hasLang ? seg.slice(nl + 1) : seg).replace(/^\n+|\n+$/g, "");
            if (!code) return null;
            return <CodeCard key={i} code={code} lang={lang} />;
          }
          const trimmed = seg.replace(/^\n+|\n+$/g, "");
          if (!trimmed) return null;
          return <RichBody key={i} text={trimmed} />;
        })}
      </div>
    );
  }
  const renderInline = (str, baseKey) => {
    const parts = str.split(/(`[^`]+`)/g);
    return parts.map((chunk, ci) => {
      if (chunk.startsWith("`") && chunk.endsWith("`")) {
        return (
          <code key={`${baseKey}-c${ci}`}
            className="font-mono text-[13px] font-medium px-1.5 py-0.5 rounded-md"
            style={{ background: "#f5f5f7", color: "#dc2626", border: "1px solid #ebebef" }}>
            {chunk.slice(1, -1)}
          </code>
        );
      }
      return chunk.split("**").map((part, bi) =>
        bi % 2 === 1
          ? <strong key={`${baseKey}-b${bi}`} className="font-semibold" style={{ color: "#1d1d1f" }}>{part}</strong>
          : <React.Fragment key={`${baseKey}-t${bi}`}>{part}</React.Fragment>
      );
    });
  };

  // Every block gets a visible boundary — a soft tinted panel — so no run of
  // text floats unbounded inside the section card. Lead label lines become the
  // panel's header; bullets and numbered steps render as designed list rows.
  const panelCls   = "rounded-[18px] p-5 lg:p-6";
  const panelStyle = { background: "#f8f8fb", border: "1px solid #ececf1" };
  const isNum = (l) => /^\d+[.)]\s/.test(l.trimStart());

  const paragraphs = text.split(/\n\n+/);
  return (
    <div className="space-y-3.5">
      {paragraphs.map((para, pi) => {
        const lines = para.split("\n");
        const hasBullets  = lines.some((l) => l.trimStart().startsWith("•"));
        const hasNumbered = lines.some(isNum);

        // A lone short label line ending in ":" — sub-heading, no box (it heads
        // whatever block follows).
        if (lines.length === 1) {
          const only = lines[0].trim();
          if (/^\*?\*?[^\n]{2,44}:\*?\*?$/.test(only) && !only.startsWith("•") && !isNum(only)) {
            const clean = only.replace(/\*\*/g, "").replace(/:$/, "");
            return (
              <p key={pi} className="flex items-center gap-2 text-[13px] font-bold uppercase tracking-[0.08em] pt-1" style={{ color: "#1d1d1f" }}>
                <span className="w-3 h-[2px] rounded-full" style={{ background: "#dc2626" }} />
                {clean}
              </p>
            );
          }
        }

        // Bullet or numbered group → bounded panel. A non-list lead line becomes
        // the panel header; color-circle emojis (🔴🟢🔵) become clean swatches.
        if (hasBullets || hasNumbered) {
          return (
            <div key={pi} className={`${panelCls} space-y-2.5`} style={panelStyle}>
              {lines.map((line, li) => {
                const trimmed = line.trimStart();
                if (!trimmed.startsWith("•") && !isNum(trimmed)) {
                  return <p key={li} className="text-[15px] font-semibold leading-[1.5] mb-1" style={{ color: "#1d1d1f" }}>{renderInline(trimmed.replace(/:$/, ""), `${pi}-${li}`)}</p>;
                }
                if (isNum(trimmed)) {
                  const numMatch = trimmed.match(/^(\d+)[.)]\s+(.*)$/);
                  const num = numMatch ? numMatch[1] : "";
                  const rest = numMatch ? numMatch[2] : trimmed;
                  return (
                    <div key={li} className="flex items-start gap-3 text-[15px] leading-[1.7]" style={{ color: "#2b2b30" }}>
                      <span className="shrink-0 mt-[1px] w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold" style={{ background: "#fdecec", color: "#dc2626" }}>{num}</span>
                      <span>{renderInline(rest, `${pi}-${li}`)}</span>
                    </div>
                  );
                }
                let txt = trimmed.replace(/^•\s*/, "");
                const lead = COLOR_EMOJI_KEYS.find((e) => txt.startsWith(e));
                if (lead) txt = txt.slice(lead.length).replace(/^\s+/, "");
                return (
                  <div key={li} className="flex items-start gap-3 text-[15px] leading-[1.7]" style={{ color: "#2b2b30" }}>
                    {lead
                      ? <span className="shrink-0 mt-[4px] w-3.5 h-3.5 rounded-[4px]" style={{ background: COLOR_EMOJI[lead], boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.10)" }} />
                      : <span className="shrink-0 mt-[8px] w-[5px] h-[5px] rounded-full" style={{ background: "#c23a43" }} />}
                    <span>{renderInline(txt, `${pi}-${li}`)}</span>
                  </div>
                );
              })}
            </div>
          );
        }

        // Plain prose → bounded panel too, so every block reads as its own card.
        return (
          <div key={pi} className={panelCls} style={panelStyle}>
            <p className="text-[15px] leading-[1.75]" style={{ color: "#2b2b30" }}>
              {lines.map((line, li) => (
                <React.Fragment key={li}>
                  {renderInline(line, `${pi}-${li}`)}
                  {li < lines.length - 1 && <br />}
                </React.Fragment>
              ))}
            </p>
          </div>
        );
      })}
    </div>
  );
}

// ---------- LESSON DETAIL ----------
// One alternating image⇄text feature row (premium editorial layout). The photo
// sits on its own floating white panel so it never overlaps the copy; the two
// halves slide in from opposite sides as the row scrolls into view.
function LessonFeatureRow({ c, flip }) {
  return (
    <div className="grid lg:grid-cols-2 gap-5 lg:gap-9 items-center">
      <div data-reveal={flip ? "right" : "left"} className={flip ? "lg:order-2" : ""}>
        <div className="rounded-3xl bg-white flex items-center justify-center p-5 lg:p-6"
          style={{ minHeight: 150, boxShadow: "0 8px 28px rgba(0,0,0,0.06), 0 1px 5px rgba(0,0,0,0.04)" }}>
          <img src={c.img} alt={c.name} loading="lazy" className="max-h-36 lg:max-h-40 w-auto object-contain" />
        </div>
      </div>
      <div data-reveal={flip ? "left" : "right"} className={flip ? "lg:order-1" : ""}>
        <h3 className="text-xl lg:text-2xl font-semibold tracking-tight leading-tight mb-2" style={{ color: "#1d1d1f" }}>{c.name}</h3>
        <p className="text-[15px] lg:text-base leading-[1.6]" style={{ color: "#3a3a3c" }}>{c.desc}</p>
      </div>
    </div>
  );
}

function LessonDetail({ lesson, onBack }) {
  const handleBack = onBack;
  const fxRef = useRef(null);
  // LessonDetail mounts inside the already-active "lessons" page, so the app-level
  // <ScrollFx> won't re-scan it — kick the reveal/scroll animations here on mount
  // and whenever the lesson changes (cleanup reverts the previous context). Scan
  // after a frame (DOM committed), then re-measure trigger positions as the hero +
  // part photos finish loading — otherwise their late layout shift leaves reveals
  // firing mid-screen and content appears to blink out while scrolling.
  React.useLayoutEffect(() => {
    const root = fxRef.current;
    if (!root) return;
    // Pre-paint (layout effect, no rAF): reveals are hidden before the browser
    // ever paints them, so there is no visible flash-then-fade on entry.
    const cleanup = initScrollFx(root);
    const imgs = Array.from(root.querySelectorAll("img")).filter((i) => !i.complete);
    const onLoad = () => refreshScrollFx();
    imgs.forEach((i) => i.addEventListener("load", onLoad));
    return () => {
      cleanup();
      imgs.forEach((i) => i.removeEventListener("load", onLoad));
    };
  }, [lesson]);

  // Stitch "technical dossier" framing: monospace track/section codes, grayscale
  // hero image, section list with R#.# tags. Full lesson content kept below.
  const img      = (LESSON_META[lesson.title] || {}).img;
  const trackNum = Math.max(0, lessons.findIndex(l => l.title === lesson.title)) + 1;
  const code     = String(trackNum).padStart(2, "0");
  const levelTag = `L${code}_${(lesson.level || "LESSON").toUpperCase()}`;
  const scrollToSection = (i) => {
    const el = document.getElementById(`section-${i}`);
    if (el) {
      const top = el.getBoundingClientRect().top + window.scrollY - 88;
      window.scrollTo({ top, behavior: "smooth" });
    }
  };

  return (
    <div className="min-h-screen pb-24" style={{ background: LIGHT_PAGE_BG }}>
      <div className="max-w-5xl mx-auto px-4 sm:px-8 pt-28 lg:pt-32">
        <button onClick={handleBack}
          className="inline-flex items-center gap-2 text-[13px] font-medium text-gray-400 hover:text-red-600 transition-colors mb-10">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 12L6 8l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          Back to Lessons
        </button>

        {/* ── Track dossier block — landscape banner + content card ── */}
        <div className="bg-white overflow-hidden rounded-xl" style={{ border: "1px solid #e5e5ea", borderTop: "3px solid #dc2626" }}>
          {/* Landscape banner image (full colour, 16:9 so the whole shot shows) */}
          <div className="relative w-full aspect-[16/9] sm:aspect-[21/9] bg-gray-900 overflow-hidden">
            {img && (
              <img src={img} alt={lesson.title} decoding="async" className="w-full h-full object-cover" />
            )}
            <div className="absolute inset-0" style={{ background: "linear-gradient(180deg, rgba(0,0,0,0) 55%, rgba(0,0,0,0.45) 100%)" }} />
            <span className="absolute bottom-3 left-3 font-mono text-[10px] tracking-wider text-white/85 bg-black/45 px-2 py-1 backdrop-blur-sm">SYS_VIEW_{code}</span>
          </div>
          {/* Content */}
          <div className="p-7 lg:p-10 flex flex-col">
            <span className="w-fit font-mono text-[10px] font-bold tracking-widest px-2 py-1 mb-5" style={{ background: "#dc2626", color: "#fff" }}>{levelTag}</span>
            <h1 className="text-3xl lg:text-5xl font-bold tracking-tight uppercase leading-[1.05] mb-3" style={{ color: "#1d1d1f" }}>{lesson.title}</h1>
            <p className="text-sm leading-relaxed mb-7 max-w-2xl" style={{ color: "#6e6e73" }}>{lesson.description}</p>

            {/* Section list */}
            <div className="border-t" style={{ borderColor: "#e5e5ea" }}>
              {lesson.sections.map((s, i) => (
                <button key={i} onClick={() => scrollToSection(i)}
                  className="group w-full flex items-center gap-4 py-4 border-b text-left transition-colors hover:bg-[#f9f9fb]"
                  style={{ borderColor: "#f0f0f2" }}>
                  <span className="text-[13px] font-semibold tabular-nums shrink-0 w-7" style={{ color: "#b4b4bd" }}>{String(i + 1).padStart(2, "0")}</span>
                  <span className="flex-1 text-[14px] font-medium" style={{ color: "#1d1d1f" }}>{s.heading}</span>
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="shrink-0 transition-transform group-hover:translate-x-1" style={{ color: "#c7c7cc" }}><path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </button>
              ))}
            </div>

            <button onClick={() => scrollToSection(0)}
              className="mt-8 self-start inline-flex items-center gap-2.5 text-[13px] font-semibold tracking-wide px-6 py-3.5 rounded-xl transition-all hover:opacity-90 hover:scale-[1.01]"
              style={{ background: "#dc2626", color: "#fff", boxShadow: "0 4px 14px rgba(220,38,38,0.28)" }}>
              Start Lesson
              <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M5.5 2.5L10 7l-4.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/></svg>
            </button>
          </div>
        </div>
      </div>

      {/* Sections — premium editorial layout (alternating media rows + animated reveals) */}
      <div ref={fxRef} data-fx-scope className="max-w-5xl mx-auto px-4 sm:px-8 mt-10 lg:mt-12">
        {lesson.sections.map((section, i) => {
          const comps  = section.components || [];
          const imaged = comps.filter((c) => c.img);
          const plain  = comps.filter((c) => !c.img);
          const asRows = imaged.length >= 1 && imaged.length <= 4;
          return (
            <section key={i} id={`section-${i}`} className={i > 0 ? "mt-7 lg:mt-9" : ""}>
              <div className="rounded-[26px] bg-white p-6 sm:p-8 lg:p-10"
                style={{ border: "1px solid #e6e6ec", boxShadow: "0 1px 3px rgba(0,0,0,0.04), 0 12px 36px rgba(0,0,0,0.05)" }}>
              {/* Header — big red shimmering index marks each section */}
              <div data-reveal="up" className="mb-6 lg:mb-8">
                <span className="lesson-index block text-[2.6rem] lg:text-[3.4rem] font-extrabold leading-none tabular-nums mb-2 select-none">{String(i + 1).padStart(2, "0")}</span>
                <h2 className="text-[1.9rem] lg:text-[2.6rem] font-semibold tracking-tight leading-[1.08] mb-5" style={{ color: "#1d1d1f" }}>{section.heading}</h2>
                {section.body && <div className="max-w-3xl"><RichBody text={section.body} /></div>}
              </div>

              {/* Imaged components — alternating feature rows (≤4) or card grid (≥5) */}
              {asRows && (
                <div className="space-y-7 lg:space-y-9">
                  {imaged.map((c, ci) => <LessonFeatureRow key={ci} c={c} flip={ci % 2 === 1} />)}
                </div>
              )}
              {imaged.length >= 5 && (
                <div data-reveal="stagger" className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
                  {imaged.map((c, ci) => (
                    <div key={ci} className="rounded-2xl bg-white overflow-hidden transition-shadow hover:shadow-lg"
                      style={{ border: "1px solid #ececef", boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
                      <div className="h-44 flex items-center justify-center p-6" style={{ background: "#fff", borderBottom: "1px solid #f2f2f4" }}>
                        <img src={c.img} alt={c.name} loading="lazy" className="max-h-full max-w-full object-contain" />
                      </div>
                      <div className="p-5">
                        <h4 className="font-semibold text-[15px] tracking-tight mb-1.5" style={{ color: "#1d1d1f" }}>{c.name}</h4>
                        <p className="text-sm leading-relaxed" style={{ color: "#48484a" }}>{c.desc}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Image-less components — clean text cards */}
              {plain.length > 0 && (
                <div data-reveal="stagger" className={`grid sm:grid-cols-2 ${plain.length >= 3 ? "lg:grid-cols-3" : ""} gap-4 ${imaged.length ? "mt-8" : ""}`}>
                  {plain.map((c, ci) => (
                    <div key={ci} className="rounded-2xl p-5 lg:p-6" style={{ background: "#fff", border: "1px solid #ececef" }}>
                      <div className="flex items-center gap-2 mb-2">
                        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: "#dc2626" }} />
                        <h4 className="font-semibold text-[15px] tracking-tight" style={{ color: "#1d1d1f" }}>{c.name}</h4>
                      </div>
                      <p className="text-sm leading-relaxed" style={{ color: "#48484a" }}>{c.desc}</p>
                    </div>
                  ))}
                </div>
              )}

              {/* Code block */}
              {section.code && (
                <div className="mt-8"><CodeCard code={section.code} /></div>
              )}

              {/* Callout */}
              {section.callout && (() => {
                const s = calloutStyles[section.callout.type] || calloutStyles.note;
                return (
                  <div data-reveal="up" className="rounded-2xl p-5 lg:p-6 mt-8 flex gap-4"
                    style={{ background: `${s.accent}0a`, border: `1px solid ${s.accent}24` }}>
                    <span className="shrink-0 w-1 rounded-full self-stretch" style={{ background: s.accent }} />
                    <div>
                      <p className="text-[11px] font-bold uppercase tracking-[0.14em] mb-2" style={{ color: s.accent }}>{s.label}</p>
                      <p className="text-[15px] leading-[1.7]" style={{ color: "#2b2b30" }}>{section.callout.text}</p>
                    </div>
                  </div>
                );
              })()}
              </div>
            </section>
          );
        })}

        <div className="pt-6 flex justify-center">
          <button onClick={handleBack}
            className="inline-flex items-center gap-2 text-[13px] font-medium text-gray-400 hover:text-red-600 transition-colors px-6 py-3 rounded-xl"
            style={{ border: "1px solid #e5e5ea" }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 12L6 8l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            Back to Lessons
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- LESSONS ----------
// Per-lesson presentation metadata: filter category + header photo (assets live
// in /public). Keyed by lesson title so the `lessons` data stays untouched.
const LESSON_META = {
  "VEX Basics":             { cat: "Hardware",    img: "/vex-basics.jpg" },
  "Autonomous Programming": { cat: "Coding",      img: "/autonomous-programming.jpg" },
  "Robot Design":           { cat: "Engineering", img: "/robot-design.jpg" },
  "Competition Strategy":   { cat: "Strategy",    img: "/competition-strategy.jpg" },
  "Drivetrain Design":      { cat: "Engineering", img: "/drivetrain-design.jpg" },
  "Sensor Integration":     { cat: "Hardware",    img: "/sensor-integration.jpg" },
  "PID Control":            { cat: "Coding",      img: "/pid-control.jpg" },
  "Game Analysis":          { cat: "Strategy",    img: "/game-analysis.jpg" },
};
const LESSON_CATS = ["All Lessons", "Coding", "Engineering", "Strategy", "Hardware"];

function Lessons() {
  const [selected, setSelected] = useState(null);
  const [cat, setCat] = useState("All Lessons");
  const { store } = useStore();
  const overviewRef = useRef(null);

  // Overview scroll reveals: the app-level <ScrollFx> only re-scans on a page
  // change, but this component remounts (Lessons-tab key bump) and toggles back
  // from a lesson detail without one — so scan our own subtree whenever the
  // overview is shown to (re)play its entrance animation. Scan synchronously (the
  // overview DOM is already committed when this effect runs — no rAF needed), then
  // re-measure as the lesson card photos load and shift layout.
  React.useLayoutEffect(() => {
    if (selected) return;
    const root = overviewRef.current;
    if (!root) return;
    const cleanup = initScrollFx(root);
    const imgs = Array.from(root.querySelectorAll("img")).filter((i) => !i.complete);
    const onLoad = () => refreshScrollFx();
    imgs.forEach((i) => i.addEventListener("load", onLoad));
    return () => { cleanup(); imgs.forEach((i) => i.removeEventListener("load", onLoad)); };
  }, [selected]);

  if (selected) {
    return (
      <div style={{ animation: "pageIn 0.5s cubic-bezier(0.22, 1, 0.36, 1) both" }}>
        <LessonDetail lesson={selected} onBack={() => setSelected(null)} />
      </div>
    );
  }

  // ── Filter ──
  const shown = lessons.filter(l => cat === "All Lessons" || LESSON_META[l.title]?.cat === cat);

  return (
    <div ref={overviewRef} data-fx-scope className="min-h-screen pt-28 lg:pt-32 px-4 sm:px-8 pb-20" style={{ background: LIGHT_PAGE_BG }}> {/* theme: flat Apple page */}
      <div className="max-w-6xl mx-auto">

        {/* ── CURRENT TRACK hero ── */}
        <div className="mb-12" data-reveal="up">
          <p className="text-xs font-bold tracking-widest uppercase mb-2" style={{ color: "#dc2626" }}>Current Track</p>
          <h2 className="text-4xl lg:text-6xl font-bold tracking-tight" style={{ color: "#1d1d1f" }}>Zero to Competition</h2>
          <p className="text-base lg:text-lg mt-3 max-w-2xl leading-relaxed" style={{ color: "#6e6e73" }}>Everything you need, from your first part to your first win.</p>
        </div>

        {/* ── Category filter pills ── */}
        <div className="flex flex-wrap gap-2.5 pb-6 mb-10 border-b border-gray-200" data-reveal="up">
          {LESSON_CATS.map(c => {
            const on = cat === c;
            return (
              <button key={c} onClick={() => setCat(c)}
                className="px-5 py-2 rounded-full text-sm font-semibold transition"
                style={{
                  background: on ? "#dc2626" : "#ffffff",
                  color:      on ? "#ffffff" : "#6e6e73",
                  border:     on ? "1px solid #dc2626" : "1px solid #e5e5ea",
                }}>
                {c}
              </button>
            );
          })}
        </div>

        {/* ── Lesson cards — photo header + meta ── */}
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6" data-reveal="stagger">
          {shown.map((l, i) => {
            const done = store.completedLessons.includes(l.title);
            const meta = LESSON_META[l.title] || {};
            return (
              <button key={l.title} onClick={() => setSelected(l)}
                className="group text-left rounded-2xl overflow-hidden bg-white border border-gray-100 hover:shadow-xl hover:-translate-y-1 transition-all duration-300 flex flex-col">
                {/* Photo header */}
                <div className="relative h-44 overflow-hidden bg-gray-200">
                  {meta.img && (
                    <img src={meta.img} alt={l.title} loading="lazy"
                      className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" />
                  )}
                  {done && (
                    <div className="absolute top-3 right-3 w-7 h-7 bg-green-500 rounded-full flex items-center justify-center shadow">
                      <span className="text-white text-xs font-black">✓</span>
                    </div>
                  )}
                </div>
                {/* Body */}
                <div className="p-5 flex flex-col flex-1">
                  <p className="text-[11px] font-bold tracking-widest uppercase mb-1.5" style={{ color: "#dc2626" }}>{meta.cat || "Lesson"}</p>
                  <h3 className="text-xl font-bold tracking-tight mb-2" style={{ color: "#1d1d1f" }}>{l.title}</h3>
                  <p className="text-sm leading-relaxed mb-4 line-clamp-2" style={{ color: "#6e6e73" }}>{l.description}</p>
                  <span className="mt-auto text-sm font-semibold inline-flex items-center gap-1" style={{ color: "#dc2626" }}>
                    {done ? "Review Lesson" : "Start Lesson"} <span className="transition-transform group-hover:translate-x-1">→</span>
                  </span>
                </div>
              </button>
            );
          })}
        </div>
        {shown.length === 0 && (
          <p className="text-center text-gray-400 py-16 text-sm">No lessons in this category yet.</p>
        )}
      </div>
    </div>
  );
}

// ---------- CAD ----------
const VEX_PARTS = [
  // ── Structure ────────────────────────────────────────────────────────────────
  { id: "cchannel-s",   label: 'C-Channel 1×2×1 (5-hole)',  category: "Structure",   color: "#94a3b8", geo: "box",      scale: [2.5,  0.18, 0.35] },
  { id: "cchannel-m",   label: 'C-Channel 1×2×2 (9-hole)',  category: "Structure",   color: "#94a3b8", geo: "box",      scale: [4.0,  0.18, 0.35] },
  { id: "cchannel-l",   label: 'C-Channel 1×2×4 (17-hole)', category: "Structure",   color: "#94a3b8", geo: "box",      scale: [5.5,  0.18, 0.35] },
  { id: "cchannel-2x2", label: 'C-Channel 2×2 (5-hole)',    category: "Structure",   color: "#8898ac", geo: "box",      scale: [2.5,  0.35, 0.35] },
  { id: "flatplate-s",  label: 'Flat Plate 2×4',            category: "Structure",   color: "#b0bec5", geo: "box",      scale: [2.5,  0.06, 1.0 ] },
  { id: "flatplate",    label: 'Flat Plate 4×8',            category: "Structure",   color: "#b0bec5", geo: "box",      scale: [4.5,  0.06, 2.0 ] },
  { id: "anglebar",     label: 'Angle Bar (Short)',          category: "Structure",   color: "#90a4ae", geo: "box",      scale: [2.0,  0.18, 0.18] },
  { id: "anglebar-l",   label: 'Angle Bar (Long)',           category: "Structure",   color: "#90a4ae", geo: "box",      scale: [3.5,  0.18, 0.18] },
  { id: "squarebar",    label: 'Square Bar',                 category: "Structure",   color: "#9aa8b4", geo: "box",      scale: [3.5,  0.12, 0.12] },
  { id: "standoff-s",   label: 'Standoff 0.5"',             category: "Structure",   color: "#cfd8dc", geo: "cylinder", scale: [0.08, 0.08, 0.4 ] },
  { id: "standoff",     label: 'Standoff 1.0"',             category: "Structure",   color: "#cfd8dc", geo: "cylinder", scale: [0.08, 0.08, 0.8 ] },
  { id: "standoff-l",   label: 'Standoff 1.5"',             category: "Structure",   color: "#cfd8dc", geo: "cylinder", scale: [0.08, 0.08, 1.2 ] },
  { id: "spacer-1",     label: 'Spacer 1/8"',               category: "Structure",   color: "#d0d8e0", geo: "cylinder", scale: [0.06, 0.06, 0.12] },
  { id: "spacer-2",     label: 'Spacer 1/4"',               category: "Structure",   color: "#d0d8e0", geo: "cylinder", scale: [0.06, 0.06, 0.25] },
  { id: "collar",       label: 'Shaft Collar',              category: "Structure",   color: "#c8d2da", geo: "cylinder", scale: [0.09, 0.09, 0.18] },
  { id: "screw",        label: 'Screw 8-32 ½"',             category: "Structure",   color: "#b8c4cc", geo: "cylinder", scale: [0.05, 0.05, 0.5 ] },

  // ── Drive ────────────────────────────────────────────────────────────────────
  // spawnRot: wheels/axles spawn upright (rolling along Z); [0,0,PI/2] tips the Y-axis cylinder onto its side
  { id: "wheel-275",    label: '2.75" Traction Wheel',      category: "Drive",       color: "#1a1a1a", geo: "cylinder", scale: [0.46, 0.46, 0.28], spawnRot: [0, 0, Math.PI/2] },
  { id: "wheel-325",    label: '3.25" Traction Wheel',      category: "Drive",       color: "#212121", geo: "cylinder", scale: [0.55, 0.55, 0.32], spawnRot: [0, 0, Math.PI/2] },
  { id: "wheel-4",      label: '4" Traction Wheel',         category: "Drive",       color: "#151515", geo: "cylinder", scale: [0.68, 0.68, 0.36], spawnRot: [0, 0, Math.PI/2] },
  { id: "omni-275",     label: '2.75" Omni Wheel',          category: "Drive",       color: "#37474f", geo: "cylinder", scale: [0.46, 0.46, 0.28], spawnRot: [0, 0, Math.PI/2] },
  { id: "omni",         label: '3.25" Omni Wheel',          category: "Drive",       color: "#37474f", geo: "cylinder", scale: [0.55, 0.55, 0.32], spawnRot: [0, 0, Math.PI/2] },
  { id: "axle-s",       label: 'HS Axle 2"',                category: "Drive",       color: "#78909c", geo: "cylinder", scale: [0.06, 0.06, 2.0 ], spawnRot: [0, 0, Math.PI/2] },
  { id: "axle",         label: 'HS Axle 4"',                category: "Drive",       color: "#78909c", geo: "cylinder", scale: [0.06, 0.06, 4.0 ], spawnRot: [0, 0, Math.PI/2] },
  { id: "axle-l",       label: 'HS Axle 6"',                category: "Drive",       color: "#78909c", geo: "cylinder", scale: [0.06, 0.06, 6.0 ], spawnRot: [0, 0, Math.PI/2] },
  { id: "gear-12",      label: '12T Pinion Gear',           category: "Drive",       color: "#90a4ae", geo: "cylinder", scale: [0.24, 0.24, 0.12] },
  { id: "gear-36",      label: '36T Gear',                  category: "Drive",       color: "#90a4ae", geo: "cylinder", scale: [0.58, 0.58, 0.12] },
  { id: "gear-60",      label: '60T Gear',                  category: "Drive",       color: "#90a4ae", geo: "cylinder", scale: [0.98, 0.98, 0.12] },
  { id: "gear-84",      label: '84T Gear',                  category: "Drive",       color: "#90a4ae", geo: "cylinder", scale: [1.35, 1.35, 0.12] },
  { id: "sprocket-18",  label: '18T Sprocket',              category: "Drive",       color: "#808890", geo: "cylinder", scale: [0.35, 0.35, 0.10] },
  { id: "sprocket-24",  label: '24T Sprocket',              category: "Drive",       color: "#808890", geo: "cylinder", scale: [0.46, 0.46, 0.10] },
  { id: "chain",        label: 'Chain (section)',           category: "Drive",       color: "#555560", geo: "box",      scale: [2.0,  0.08, 0.10] },
  { id: "motor-cart-r", label: 'Motor Cart. 100rpm (Red)',  category: "Drive",       color: "#b91c1c", geo: "box",      scale: [0.62, 0.32, 0.38] },
  { id: "motor-cart-g", label: 'Motor Cart. 200rpm (Green)',category: "Drive",       color: "#15803d", geo: "box",      scale: [0.62, 0.32, 0.38] },
  { id: "motor-cart-b", label: 'Motor Cart. 600rpm (Blue)', category: "Drive",       color: "#1d4ed8", geo: "box",      scale: [0.62, 0.32, 0.38] },

  // ── Electronics ──────────────────────────────────────────────────────────────
  { id: "brain",        label: 'V5 Brain',                  category: "Electronics", color: "#1c1c22", geo: "box",      scale: [2.2,  0.7,  1.6 ] },
  { id: "motor",        label: 'V5 Smart Motor',            category: "Electronics", color: "#0c1826", geo: "box",      scale: [0.85, 0.85, 1.1 ] },
  { id: "battery",      label: 'V5 Battery',                category: "Electronics", color: "#ca8a04", geo: "box",      scale: [1.6,  0.85, 0.65] },
  { id: "controller",   label: 'V5 Controller',             category: "Electronics", color: "#20222a", geo: "box",      scale: [1.9,  0.7,  1.15] },
  { id: "radio",        label: 'V5 Radio',                  category: "Electronics", color: "#0a0a10", geo: "box",      scale: [0.65, 0.28, 0.60] },
  { id: "expander",     label: '3-Wire Expander',           category: "Electronics", color: "#2a2a32", geo: "box",      scale: [0.85, 0.40, 0.70] },
  { id: "cable-s",      label: 'Smart Cable 6"',            category: "Electronics", color: "#cc2222", geo: "cylinder", scale: [0.03, 0.03, 1.5 ], spawnRot: [0, 0, Math.PI/2] },
  { id: "cable-l",      label: 'Smart Cable 24"',           category: "Electronics", color: "#cc2222", geo: "cylinder", scale: [0.03, 0.03, 6.0 ], spawnRot: [0, 0, Math.PI/2] },

  // ── Sensors ──────────────────────────────────────────────────────────────────
  { id: "imu",          label: 'Inertial Sensor',           category: "Sensors",     color: "#0d9488", geo: "box",      scale: [0.50, 0.30, 0.50] },
  { id: "distance",     label: 'Distance Sensor',           category: "Sensors",     color: "#059669", geo: "box",      scale: [0.55, 0.35, 0.35] },
  { id: "optical",      label: 'Optical Sensor',            category: "Sensors",     color: "#7c3aed", geo: "box",      scale: [0.50, 0.30, 0.50] },
  { id: "rotation",     label: 'Rotation Sensor',           category: "Sensors",     color: "#1d4ed8", geo: "box",      scale: [0.55, 0.35, 0.40] },
  { id: "vision",       label: 'Vision Sensor',             category: "Sensors",     color: "#1e3a5f", geo: "box",      scale: [0.75, 0.55, 0.42] },
  { id: "bumper",       label: 'Bumper Switch',             category: "Sensors",     color: "#dc2626", geo: "box",      scale: [0.60, 0.25, 0.35] },
  { id: "limit",        label: 'Limit Switch',              category: "Sensors",     color: "#b91c1c", geo: "box",      scale: [0.50, 0.22, 0.30] },
  { id: "gps",          label: 'GPS Sensor',                category: "Sensors",     color: "#0e7490", geo: "box",      scale: [0.62, 0.38, 0.40] },

  // ── Pneumatics ───────────────────────────────────────────────────────────────
  { id: "pneu-tank",    label: 'Air Reservoir',             category: "Pneumatics",  color: "#334155", geo: "cylinder", scale: [0.30, 0.30, 2.2 ], spawnRot: [0, 0, Math.PI/2] },
  { id: "solenoid",     label: 'Solenoid Valve',            category: "Pneumatics",  color: "#1e293b", geo: "box",      scale: [0.55, 0.40, 0.28] },
  { id: "pneu-cyl",     label: 'Pneumatic Cylinder',        category: "Pneumatics",  color: "#475569", geo: "cylinder", scale: [0.18, 0.18, 1.5 ], spawnRot: [0, 0, Math.PI/2] },
  { id: "tubing",       label: 'Pneumatic Tubing',          category: "Pneumatics",  color: "#e2e8f0", geo: "cylinder", scale: [0.03, 0.03, 3.0 ], spawnRot: [0, 0, Math.PI/2] },
];

// ── GLB Model loader ─────────────────────────────────────
//
// HOW TO USE REAL VEX MODELS:
//  VEX only ships STEP files. Convert them to GLB, then drop the file here:
//    /frontend/public/models/[part-id].glb
//
//  Part IDs (file names to use):
//    brain.glb  motor.glb  battery.glb  controller.glb
//    cchannel-s.glb  cchannel-l.glb  flatplate.glb  anglebar.glb
//    standoff.glb  axle.glb  wheel-325.glb  omni.glb
//    gear-36.glb  gear-84.glb  imu.glb  distance.glb  optical.glb  bumper.glb
//
//  CONVERSION WORKFLOW (easiest — no software install):
//   1. Go to https://cad.onshape.com  (free with a school email)
//   2. Search "VEX V5" in the public library — official VEX parts are there
//   3. Open any part, click the part name tab → Export
//   4. Choose format: "glTF" → Download  → rename to e.g. "brain.glb"
//   5. Drop it into /frontend/public/models/
//   The app auto-detects it and replaces the procedural shape instantly.
//
//  CONVERSION WORKFLOW (Blender — more control):
//   1. Download the official .STEP from https://www.vexrobotics.com/cad
//   2. Open FreeCAD → File > Open the .STEP → File > Export → .OBJ
//   3. Open Blender → File > Import > Wavefront (.obj)
//   4. File > Export > glTF 2.0 (.glb) — keep "Apply Modifiers" checked
//   5. Save as the part-id name above and drop into /frontend/public/models/

// Module-level cache so HEAD requests run only once per URL per session
const _glbExists = {};

// Inner component — only mounted when we already know the file exists
function GlbModel({ url, emissiveColor, emissiveIntensity }) {
  const { scene } = useGLTF(url);
  const cloned = React.useMemo(() => scene.clone(true), [scene]);
  React.useEffect(() => {
    cloned.traverse((child) => {
      if (child.isMesh && child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach(m => {
          if (m.emissive) m.emissive.set(emissiveColor);
          if (m.emissiveIntensity !== undefined) m.emissiveIntensity = emissiveIntensity;
        });
      }
    });
  }, [cloned, emissiveColor, emissiveIntensity]);
  return <primitive object={cloned} scale={0.01} />;
}

// Error boundary — last-resort safety net if GlbModel throws despite the HEAD check
class GlbErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidUpdate(prev) {
    if (prev.url !== this.props.url) this.setState({ failed: false });
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

// SmartPart: HEAD-checks for a real GLB before ever calling useGLTF.
// If the file doesn't exist the HEAD request returns 404 and we go straight
// to PartShape — useGLTF never sees the missing URL so there's no error loop.
function SmartPart({ partDef, emissiveColor, emissiveIntensity }) {
  const url = `/models/${partDef.id}.glb`;

  // undefined = still checking, true = file exists, false = not found
  const cached = _glbExists[url];
  const [exists, setExists] = React.useState(cached);

  React.useEffect(() => {
    if (cached !== undefined) { setExists(cached); return; }
    let alive = true;
    fetch(url, { method: "HEAD" })
      .then(r  => { _glbExists[url] = r.ok;    if (alive) setExists(r.ok);    })
      .catch(() => { _glbExists[url] = false;   if (alive) setExists(false);   });
    return () => { alive = false; };
  }, [url, cached]);

  const fallback = (
    <PartShape partDef={partDef} emissiveColor={emissiveColor} emissiveIntensity={emissiveIntensity} />
  );

  // While checking (undefined) or confirmed absent (false) → procedural shape
  if (!exists) return fallback;

  // File confirmed present → load the real GLB with a safety net
  return (
    <GlbErrorBoundary url={url} fallback={fallback}>
      <React.Suspense fallback={fallback}>
        <GlbModel url={url} emissiveColor={emissiveColor} emissiveIntensity={emissiveIntensity} />
      </React.Suspense>
    </GlbErrorBoundary>
  );
}

// Material presets that match real VEX materials
const MAT = {
  aluminum:  { roughness: 0.12, metalness: 1.0  },   // anodized 6061 aluminium
  steel:     { roughness: 0.18, metalness: 0.95 },   // HS steel axles / hardware
  rubber:    { roughness: 0.92, metalness: 0.0  },   // wheel tires
  abs:       { roughness: 0.55, metalness: 0.05 },   // plastic brain / controller body
  motor:     { roughness: 0.45, metalness: 0.4  },   // motor housing
  pcb:       { roughness: 0.35, metalness: 0.1  },   // circuit-board-like surfaces
  hub:       { roughness: 0.15, metalness: 0.92 },   // machined hub / bore
};

// PartShape: procedural fallback geometry (used when no GLB exists)
function PartShape({ partDef, emissiveColor: em, emissiveIntensity: ei }) {
  const c = partDef.color;

  // ── C-Channel ─────────────────────────────────────────
  if (partDef.id === "cchannel-s" || partDef.id === "cchannel-l") {
    const [len, ht, dp] = partDef.scale;
    const t  = ht * 0.38;
    const hR = 0.072;  // VEX #8-32 hole — enlarged for visibility
    // VEX standard: one hole per 0.5" of length
    const hN  = Math.max(2, Math.round(len / 0.5));
    const hSp = len / hN;
    const xs  = Array.from({ length: hN }, (_, i) => -len/2 + (i + 0.5) * hSp);
    const bodyCol  = "#c0c8ce";
    const holeCol  = "#06080e";   // near-black inside hole
    const rimCol   = "#dce6f0";   // bright chamfer rim
    return (
      <group>
        {/* ── Flange bodies ── */}
        <mesh position={[0, -ht/2 + t/2, 0]} castShadow receiveShadow>
          <boxGeometry args={[len, t, dp]} />
          <meshStandardMaterial color={bodyCol} emissive={em} emissiveIntensity={ei} {...MAT.aluminum} />
        </mesh>
        <mesh position={[0,  ht/2 - t/2, 0]} castShadow receiveShadow>
          <boxGeometry args={[len, t, dp]} />
          <meshStandardMaterial color={bodyCol} emissive={em} emissiveIntensity={ei} {...MAT.aluminum} />
        </mesh>
        {/* ── Web (back wall) ── */}
        <mesh position={[0, 0, -dp/2 + t/2]} castShadow receiveShadow>
          <boxGeometry args={[len, ht - 2*t, t]} />
          <meshStandardMaterial color="#b8c2c8" emissive={em} emissiveIntensity={ei} {...MAT.aluminum} />
        </mesh>

        {/* ── Top flange holes ── */}
        {xs.map((x, i) => (
          <group key={`tfl-${i}`} position={[x, ht/2 + 0.001, 0]}>
            <mesh rotation={[-Math.PI/2, 0, 0]}>
              <circleGeometry args={[hR * 1.28, 14]} />
              <meshStandardMaterial color={rimCol} roughness={0.08} metalness={0.92} />
            </mesh>
            <mesh rotation={[-Math.PI/2, 0, 0]} position={[0, 0, 0.001]}>
              <circleGeometry args={[hR, 14]} />
              <meshStandardMaterial color={holeCol} roughness={0.95} metalness={0.0} />
            </mesh>
          </group>
        ))}
        {/* ── Top flange bottom face (through-hole exit) ── */}
        {xs.map((x, i) => (
          <group key={`tfl2-${i}`} position={[x, ht/2 - t - 0.001, 0]}>
            <mesh rotation={[Math.PI/2, 0, 0]}>
              <circleGeometry args={[hR * 1.12, 14]} />
              <meshStandardMaterial color={rimCol} roughness={0.1} metalness={0.88} />
            </mesh>
            <mesh rotation={[Math.PI/2, 0, 0]} position={[0, 0, 0.001]}>
              <circleGeometry args={[hR, 14]} />
              <meshStandardMaterial color={holeCol} roughness={0.95} metalness={0.0} />
            </mesh>
          </group>
        ))}
        {/* ── Web front-face holes ── */}
        {xs.map((x, i) => (
          <group key={`web-${i}`} position={[x, 0, -dp/2 + t + 0.001]}>
            <mesh>
              <circleGeometry args={[hR * 1.22, 14]} />
              <meshStandardMaterial color={rimCol} roughness={0.08} metalness={0.92} />
            </mesh>
            <mesh position={[0, 0, 0.001]}>
              <circleGeometry args={[hR, 14]} />
              <meshStandardMaterial color={holeCol} roughness={0.95} metalness={0.0} />
            </mesh>
          </group>
        ))}
      </group>
    );
  }

  // ── Angle Bar (L-profile) ──────────────────────────────
  if (partDef.id === "anglebar") {
    const [len, ht, dp] = partDef.scale;
    const t    = ht * 0.45;
    const hR   = 0.068;
    const hN   = Math.max(2, Math.round(len / 0.5));
    const hSp  = len / hN;
    const xs   = Array.from({ length: hN }, (_, i) => -len/2 + (i + 0.5) * hSp);
    const bodyCol = "#c0c8ce";
    const holeCol = "#06080e";
    const rimCol  = "#dce6f0";
    return (
      <group>
        <mesh position={[0, -ht/2 + t/2, 0]} castShadow receiveShadow>
          <boxGeometry args={[len, t, dp]} />
          <meshStandardMaterial color={bodyCol} emissive={em} emissiveIntensity={ei} {...MAT.aluminum} />
        </mesh>
        <mesh position={[0, t/2, -dp/2 + t/2]} castShadow receiveShadow>
          <boxGeometry args={[len, ht - t, t]} />
          <meshStandardMaterial color="#b8c2c8" emissive={em} emissiveIntensity={ei} {...MAT.aluminum} />
        </mesh>
        {/* Holes on top face of horizontal flange */}
        {xs.map((x, i) => (
          <group key={`ah-${i}`} position={[x, -ht/2 + t + 0.001, 0]}>
            <mesh rotation={[-Math.PI/2, 0, 0]}>
              <circleGeometry args={[hR * 1.25, 14]} />
              <meshStandardMaterial color={rimCol} roughness={0.08} metalness={0.92} />
            </mesh>
            <mesh rotation={[-Math.PI/2, 0, 0]} position={[0, 0, 0.001]}>
              <circleGeometry args={[hR, 14]} />
              <meshStandardMaterial color={holeCol} roughness={0.95} metalness={0.0} />
            </mesh>
          </group>
        ))}
        {/* Holes on front face of vertical leg */}
        {xs.map((x, i) => (
          <group key={`av-${i}`} position={[x, t/2 + (ht-t)/2, -dp/2 + t + 0.001]}>
            <mesh>
              <circleGeometry args={[hR * 1.22, 14]} />
              <meshStandardMaterial color={rimCol} roughness={0.08} metalness={0.92} />
            </mesh>
            <mesh position={[0, 0, 0.001]}>
              <circleGeometry args={[hR, 14]} />
              <meshStandardMaterial color={holeCol} roughness={0.95} metalness={0.0} />
            </mesh>
          </group>
        ))}
      </group>
    );
  }

  // ── Standoff (hex rod) — all three sizes ───────────────
  if (partDef.id === "standoff" || partDef.id === "standoff-s" || partDef.id === "standoff-l") {
    const [rT, rB, h] = partDef.scale;
    return (
      <group>
        <mesh castShadow receiveShadow>
          <cylinderGeometry args={[rT * 1.5, rB * 1.5, h * 0.92, 6]} />
          <meshStandardMaterial color="#d0d8e0" emissive={em} emissiveIntensity={ei} {...MAT.aluminum} />
        </mesh>
        <mesh position={[0,  h * 0.46, 0]}>
          <cylinderGeometry args={[rT * 0.55, rT * 0.55, 0.04, 12]} />
          <meshStandardMaterial color="#c0c8d0" {...MAT.hub} />
        </mesh>
        <mesh position={[0, -h * 0.46, 0]}>
          <cylinderGeometry args={[rB * 0.55, rB * 0.55, 0.04, 12]} />
          <meshStandardMaterial color="#c0c8d0" {...MAT.hub} />
        </mesh>
      </group>
    );
  }

  // ── HS Axle (square cross-section) ────────────────────
  if (partDef.id === "axle") {
    const [rT, rB, h] = partDef.scale;
    return (
      <mesh castShadow receiveShadow>
        <cylinderGeometry args={[rT * 1.6, rB * 1.6, h, 4]} />
        <meshStandardMaterial color="#c8d0d8" emissive={em} emissiveIntensity={ei} {...MAT.steel} />
      </mesh>
    );
  }

  // ── Wheels (torus tyre + hub + spokes) ────────────────
  if (partDef.id === "wheel-325" || partDef.id === "omni") {
    const r = partDef.scale[0];
    const h = partDef.scale[2];
    const isOmni = partDef.id === "omni";
    const hubR   = r * 0.3;
    const spokeN = 6;
    return (
      <group>
        {/* Outer tyre – torus laid flat, black rubber */}
        <mesh castShadow rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[r * 0.79, r * 0.19, 14, 36]} />
          <meshStandardMaterial color={isOmni ? "#2a2a2a" : "#0d0d0d"} emissive={em} emissiveIntensity={ei} {...MAT.rubber} />
        </mesh>
        {/* Inner disc – anodized grey plastic */}
        <mesh castShadow>
          <cylinderGeometry args={[r * 0.62, r * 0.62, h * 0.45, 24]} />
          <meshStandardMaterial color={isOmni ? "#3a3a3a" : "#1e1e1e"} emissive={em} emissiveIntensity={ei} roughness={0.5} metalness={0.1} />
        </mesh>
        {/* Hub – machined aluminium */}
        <mesh castShadow>
          <cylinderGeometry args={[hubR, hubR, h, 12]} />
          <meshStandardMaterial color="#c0c8d4" emissive={em} emissiveIntensity={ei} {...MAT.hub} />
        </mesh>
        {/* Spokes */}
        {Array.from({ length: spokeN }, (_, i) => {
          const ang = (i / spokeN) * Math.PI * 2;
          const sl  = r * 0.62 - hubR - 0.02;
          return (
            <mesh key={i} position={[Math.cos(ang)*(hubR+sl/2), 0, Math.sin(ang)*(hubR+sl/2)]} rotation={[0, -ang, 0]} castShadow>
              <boxGeometry args={[sl, h * 0.28, 0.032]} />
              <meshStandardMaterial color="#1a1a1a" emissive={em} emissiveIntensity={ei} roughness={0.55} metalness={0.05} />
            </mesh>
          );
        })}
        {/* Omni rollers – grey rubber barrels */}
        {isOmni && Array.from({ length: 14 }, (_, i) => {
          const ang = (i / 14) * Math.PI * 2;
          return (
            <mesh key={i} position={[Math.cos(ang)*r*0.84, 0, Math.sin(ang)*r*0.84]} rotation={[0, -ang + Math.PI/2, 0]} castShadow>
              <cylinderGeometry args={[h * 0.13, h * 0.13, h * 0.88, 8]} />
              <meshStandardMaterial color="#555" emissive={em} emissiveIntensity={ei} roughness={0.78} metalness={0.0} />
            </mesh>
          );
        })}
      </group>
    );
  }

  // ── Gears (disc + teeth + hub + bore) ─────────────────
  if (partDef.id === "gear-36" || partDef.id === "gear-84") {
    const r     = partDef.scale[0];
    const h     = partDef.scale[2];
    const teeth = partDef.id === "gear-84" ? 28 : 14;
    const tl    = r * 0.13;
    const gearCol = partDef.id === "gear-84" ? "#8090a0" : "#90a0b0";
    return (
      <group>
        {/* Disc body */}
        <mesh castShadow receiveShadow>
          <cylinderGeometry args={[r * 0.86, r * 0.86, h, 48]} />
          <meshStandardMaterial color={gearCol} emissive={em} emissiveIntensity={ei} {...MAT.aluminum} />
        </mesh>
        {/* Raised hub */}
        <mesh castShadow>
          <cylinderGeometry args={[r * 0.3, r * 0.3, h * 1.12, 20]} />
          <meshStandardMaterial color="#b0bec8" emissive={em} emissiveIntensity={ei} {...MAT.hub} />
        </mesh>
        {/* Square bore (4-sided = VEX square insert) */}
        <mesh>
          <cylinderGeometry args={[r * 0.1, r * 0.1, h * 1.3, 4]} />
          <meshStandardMaterial color="#111" roughness={0.9} metalness={0.05} />
        </mesh>
        {/* Teeth */}
        {Array.from({ length: teeth }, (_, i) => {
          const ang = (i / teeth) * Math.PI * 2;
          return (
            <mesh key={i} position={[Math.cos(ang)*(r*0.86+tl/2), 0, Math.sin(ang)*(r*0.86+tl/2)]} rotation={[0, -ang, 0]} castShadow>
              <boxGeometry args={[tl, h * 0.84, r * 0.09]} />
              <meshStandardMaterial color={gearCol} emissive={em} emissiveIntensity={ei} {...MAT.aluminum} />
            </mesh>
          );
        })}
      </group>
    );
  }

  // ── V5 Smart Motor ────────────────────────────────────
  if (partDef.id === "motor") {
    const [w, h, d] = partDef.scale;
    return (
      <group>
        {/* Main ABS housing with rounded edges */}
        <RoundedBox args={[w, h, d]} radius={0.04} smoothness={4} castShadow receiveShadow>
          <meshStandardMaterial color="#0c1826" emissive={em} emissiveIntensity={ei} roughness={0.42} metalness={0.18} />
        </RoundedBox>
        {/* Circular face plate – front Z+ */}
        <mesh position={[0, 0, d/2 + 0.004]} rotation={[Math.PI/2, 0, 0]}>
          <cylinderGeometry args={[h*0.44, h*0.44, 0.008, 32]} />
          <meshStandardMaterial color="#182a40" roughness={0.28} metalness={0.35} />
        </mesh>
        {/* Inner concentric ring on face */}
        <mesh position={[0, 0, d/2 + 0.009]} rotation={[Math.PI/2, 0, 0]}>
          <cylinderGeometry args={[h*0.28, h*0.28, 0.004, 24]} />
          <meshStandardMaterial color="#22364e" roughness={0.22} metalness={0.48} />
        </mesh>
        {/* Central hub nub on face */}
        <mesh position={[0, 0, d/2 + 0.014]} rotation={[Math.PI/2, 0, 0]}>
          <cylinderGeometry args={[h*0.12, h*0.12, 0.008, 16]} />
          <meshStandardMaterial color="#c4ccd8" {...MAT.hub} />
        </mesh>
        {/* Output shaft – square cross-section steel */}
        <mesh position={[0, 0, d/2 + 0.22]} rotation={[Math.PI/2, 0, 0]} castShadow>
          <cylinderGeometry args={[0.04, 0.04, 0.44, 4]} />
          <meshStandardMaterial color="#c0c8d4" {...MAT.steel} />
        </mesh>
        {/* Green speed-cartridge stripe on top */}
        <mesh position={[0, h/2 + 0.003, -d*0.06]}>
          <boxGeometry args={[w*0.52, 0.006, d*0.42]} />
          <meshStandardMaterial color="#0b6212" roughness={0.4} metalness={0.05} emissive="#009a1e" emissiveIntensity={0.22} />
        </mesh>
        {/* Green accent stripe on right side */}
        <mesh position={[w/2 + 0.003, 0, d*0.06]}>
          <boxGeometry args={[0.005, h*0.54, d*0.36]} />
          <meshStandardMaterial color="#0e7a1c" roughness={0.38} metalness={0.0} />
        </mesh>
        {/* Smart cable port – bottom-back */}
        <mesh position={[0, -h/2 - 0.022, -d*0.14]}>
          <boxGeometry args={[w*0.52, 0.044, 0.2]} />
          <meshStandardMaterial color="#040408" roughness={0.65} metalness={0.1} />
        </mesh>
        {/* Cable port slot indent */}
        <mesh position={[0, -h/2 - 0.018, -d*0.14]}>
          <boxGeometry args={[w*0.38, 0.015, 0.13]} />
          <meshStandardMaterial color="#020204" roughness={0.9} metalness={0.0} />
        </mesh>
        {/* Mounting screw holes (4 corners, back plate) */}
        {[[-w*0.31, h*0.31], [w*0.31, h*0.31], [-w*0.31, -h*0.31], [w*0.31, -h*0.31]].map(([x, y], i) => (
          <mesh key={`mh-${i}`} position={[x, y, -d/2 - 0.003]} rotation={[Math.PI/2, 0, 0]}>
            <cylinderGeometry args={[0.03, 0.03, 0.006, 10]} />
            <meshStandardMaterial color="#030306" roughness={0.9} />
          </mesh>
        ))}
        {/* White V5 label panel */}
        <mesh position={[-w/2 - 0.003, 0, d*0.05]}>
          <boxGeometry args={[0.006, h*0.36, d*0.48]} />
          <meshStandardMaterial color="#d8e8f5" roughness={0.38} metalness={0.0} />
        </mesh>
      </group>
    );
  }

  // ── V5 Brain ──────────────────────────────────────────
  if (partDef.id === "brain") {
    const [w, h, d] = partDef.scale; // [2.2, 0.7, 1.6]
    const bodyColor  = "#18181e";
    const accentRed  = "#bf2808";
    const scrW = w * 0.52, scrD = d * 0.58;
    return (
      <group>
        {/* ── Main body with chamfered edges ── */}
        <RoundedBox args={[w, h, d]} radius={0.045} smoothness={4} castShadow receiveShadow>
          <meshStandardMaterial color={bodyColor} emissive={em} emissiveIntensity={ei} roughness={0.36} metalness={0.14} />
        </RoundedBox>

        {/* ── Top face: screen bezel ── */}
        <mesh position={[-w*0.09, h/2 + 0.002, d*0.04]}>
          <boxGeometry args={[scrW + 0.06, 0.004, scrD + 0.05]} />
          <meshStandardMaterial color="#0a0a10" roughness={0.2} metalness={0.28} />
        </mesh>
        {/* ── Touchscreen LCD – glowing blue ── */}
        <mesh position={[-w*0.09, h/2 + 0.006, d*0.04]}>
          <boxGeometry args={[scrW, 0.008, scrD]} />
          <meshStandardMaterial color="#020914" roughness={0.03} metalness={0.0}
            emissive="#061aa8" emissiveIntensity={0.88} />
        </mesh>
        {/* Screen content hint – subtle cyan lines */}
        {[-scrD*0.32, 0, scrD*0.32].map((z, i) => (
          <mesh key={`sl-${i}`} position={[-w*0.09, h/2 + 0.012, d*0.04 + z]}>
            <boxGeometry args={[scrW*0.84, 0.002, 0.018]} />
            <meshStandardMaterial color="#00ccff" emissive="#00aaff" emissiveIntensity={0.6} roughness={0.1} metalness={0.0} />
          </mesh>
        ))}

        {/* ── Top face: VEX logo / red stripe (right of screen) ── */}
        <mesh position={[w*0.38, h/2 + 0.003, d*0.04]}>
          <boxGeometry args={[w*0.17, 0.006, d*0.24]} />
          <meshStandardMaterial color={accentRed} roughness={0.34} metalness={0.05}
            emissive={accentRed} emissiveIntensity={0.22} />
        </mesh>

        {/* ── 21 Smart port slots – front face Z+ ── */}
        {Array.from({ length: 21 }, (_, i) => {
          const spacing = (w * 0.88) / 21;
          const x = -w * 0.44 + (i + 0.5) * spacing;
          return (
            <mesh key={`sp-${i}`} position={[x, -h * 0.1, d / 2 + 0.004]}>
              <boxGeometry args={[spacing * 0.58, h * 0.56, 0.008]} />
              <meshStandardMaterial color="#07070e" roughness={0.55} metalness={0.14} />
            </mesh>
          );
        })}
        {/* Port strip backing plate */}
        <mesh position={[0, -h*0.1, d/2 + 0.002]}>
          <boxGeometry args={[w*0.9, h*0.6, 0.004]} />
          <meshStandardMaterial color="#0d0d16" roughness={0.6} metalness={0.08} />
        </mesh>

        {/* ── Power button – top face ── */}
        <mesh position={[w*0.41, h/2 + 0.006, -d*0.36]}>
          <cylinderGeometry args={[0.052, 0.052, 0.012, 16]} />
          <meshStandardMaterial color="#dde8f2" roughness={0.28} metalness={0.0}
            emissive="#ffffff" emissiveIntensity={0.28} />
        </mesh>
        {/* Power button ring */}
        <mesh position={[w*0.41, h/2 + 0.003, -d*0.36]}>
          <cylinderGeometry args={[0.065, 0.065, 0.004, 16]} />
          <meshStandardMaterial color="#2a2a34" roughness={0.35} metalness={0.3} />
        </mesh>

        {/* ── Status LED ── */}
        <mesh position={[w*0.41, h/2 + 0.006, -d*0.18]}>
          <cylinderGeometry args={[0.028, 0.028, 0.012, 10]} />
          <meshStandardMaterial color="#22ee44" roughness={0.18} metalness={0.0}
            emissive="#00ff44" emissiveIntensity={1.4} />
        </mesh>

        {/* ── USB-A port – top face left ── */}
        <mesh position={[-w*0.32, h/2 + 0.005, -d*0.38]}>
          <boxGeometry args={[0.13, 0.01, 0.065]} />
          <meshStandardMaterial color="#060608" roughness={0.65} metalness={0.2} />
        </mesh>

        {/* ── Red accent stripe – front top edge ── */}
        <mesh position={[0, h/2 + 0.006, d/2 - 0.04]}>
          <boxGeometry args={[w*0.9, 0.012, 0.055]} />
          <meshStandardMaterial color={accentRed} roughness={0.33} metalness={0.06}
            emissive={accentRed} emissiveIntensity={0.18} />
        </mesh>

        {/* ── Side vent slots (left side) ── */}
        {[-d*0.38, -d*0.18, d*0.02, d*0.22, d*0.42].map((z, i) => (
          <mesh key={`vl-${i}`} position={[-w/2 - 0.003, 0, z]}>
            <boxGeometry args={[0.004, h*0.52, 0.038]} />
            <meshStandardMaterial color="#060606" roughness={0.9} />
          </mesh>
        ))}

        {/* ── Antenna bump – back face Z- ── */}
        <mesh position={[w*0.32, h*0.2, -d/2 - 0.022]} castShadow>
          <boxGeometry args={[0.24, h*0.14, 0.044]} />
          <meshStandardMaterial color="#22222c" roughness={0.42} metalness={0.1} />
        </mesh>

        {/* ── ADI 3-wire ports – right side X+ (3 clusters) ── */}
        {[0, 1, 2].map(i => (
          <mesh key={`adi-${i}`} position={[w/2 + 0.004, h*0.12 - i*h*0.22, d*0.26]}>
            <boxGeometry args={[0.008, h*0.16, 0.12]} />
            <meshStandardMaterial color="#0a0a14" roughness={0.6} metalness={0.08} />
          </mesh>
        ))}

        {/* ── Battery connector slot – bottom face ── */}
        <mesh position={[0, -h/2 - 0.008, 0]}>
          <boxGeometry args={[w*0.36, 0.016, d*0.52]} />
          <meshStandardMaterial color="#1c1c26" roughness={0.5} metalness={0.22} />
        </mesh>
      </group>
    );
  }

  // ── V5 Battery ────────────────────────────────────────
  if (partDef.id === "battery") {
    const [w, h, d] = partDef.scale;
    return (
      <group>
        {/* ABS shell – dark charcoal with rounded corners */}
        <RoundedBox args={[w, h, d]} radius={0.042} smoothness={4} castShadow receiveShadow>
          <meshStandardMaterial color="#1a1a22" emissive={em} emissiveIntensity={ei} roughness={0.44} metalness={0.08} />
        </RoundedBox>
        {/* VEX orange label stripe across top */}
        <mesh position={[0, h/2 + 0.003, 0]}>
          <boxGeometry args={[w*0.68, 0.006, d*0.52]} />
          <meshStandardMaterial color="#b83200" roughness={0.34} metalness={0.05}
            emissive="#8c2200" emissiveIntensity={0.14} />
        </mesh>
        {/* Connector terminal housing */}
        <mesh position={[w*0.32, h/2 + 0.046, 0]} castShadow>
          <boxGeometry args={[w*0.22, 0.092, d*0.38]} />
          <meshStandardMaterial color="#111116" roughness={0.5} metalness={0.22} />
        </mesh>
        {/* Connector socket indent */}
        <mesh position={[w*0.32, h/2 + 0.065, 0]}>
          <boxGeometry args={[w*0.13, 0.016, d*0.22]} />
          <meshStandardMaterial color="#04040a" roughness={0.9} metalness={0.0} />
        </mesh>
        {/* 4 LED charge indicators */}
        {[0, 1, 2, 3].map(i => (
          <mesh key={`led-${i}`} position={[-w*0.26 + i*(w*0.135), h/2 + 0.005, d*0.34]}>
            <cylinderGeometry args={[0.034, 0.034, 0.01, 10]} />
            <meshStandardMaterial
              color={i < 3 ? "#12cc33" : "#0e0e0e"}
              emissive={i < 3 ? "#00ff44" : "#000000"}
              emissiveIntensity={i < 3 ? 0.95 : 0}
              roughness={0.24} metalness={0.0} />
          </mesh>
        ))}
        {/* LED label strip */}
        <mesh position={[-w*0.26 + 1.5*(w*0.135), h/2 + 0.002, d*0.34]}>
          <boxGeometry args={[w*0.52, 0.004, 0.055]} />
          <meshStandardMaterial color="#0e0e18" roughness={0.65} metalness={0.05} />
        </mesh>
        {/* Charging micro-USB port */}
        <mesh position={[-w*0.38, h/2 + 0.004, -d*0.28]}>
          <boxGeometry args={[0.088, 0.008, 0.048]} />
          <meshStandardMaterial color="#050508" roughness={0.7} metalness={0.12} />
        </mesh>
        {/* Side grip ribs */}
        {[-d*0.22, 0, d*0.22].map((z, i) => (
          <mesh key={`rib-${i}`} position={[-w/2 - 0.005, 0, z]}>
            <boxGeometry args={[0.01, h*0.62, 0.038]} />
            <meshStandardMaterial color="#242430" roughness={0.8} metalness={0.0} />
          </mesh>
        ))}
        {/* VEX logo rectangle */}
        <mesh position={[-w*0.2, h/2 + 0.007, d*0.34]}>
          <boxGeometry args={[w*0.14, 0.008, d*0.1]} />
          <meshStandardMaterial color="#b83200" roughness={0.34} metalness={0.0} emissive="#8c2200" emissiveIntensity={0.12} />
        </mesh>
      </group>
    );
  }

  // ── V5 Controller ─────────────────────────────────────
  if (partDef.id === "controller") {
    const [w, h, d] = partDef.scale; // [1.9, 0.7, 1.15]
    return (
      <group>
        {/* ── Central face plate ── */}
        <RoundedBox args={[w, h, d*0.6]} radius={0.05} smoothness={4} castShadow receiveShadow
          position={[0, 0, -d*0.2]}>
          <meshStandardMaterial color="#1e2028" emissive={em} emissiveIntensity={ei} roughness={0.38} metalness={0.1} />
        </RoundedBox>
        {/* ── Left grip handle ── */}
        <RoundedBox args={[w*0.23, h, d*0.56]} radius={0.04} smoothness={3} castShadow
          position={[-w*0.38, -h*0.06, d*0.16]}>
          <meshStandardMaterial color="#16181e" roughness={0.46} metalness={0.08} />
        </RoundedBox>
        {/* ── Right grip handle ── */}
        <RoundedBox args={[w*0.23, h, d*0.56]} radius={0.04} smoothness={3} castShadow
          position={[w*0.38, -h*0.06, d*0.16]}>
          <meshStandardMaterial color="#16181e" roughness={0.46} metalness={0.08} />
        </RoundedBox>

        {/* ── LCD screen bezel ── */}
        <mesh position={[0, h/2 + 0.002, -d*0.3]}>
          <boxGeometry args={[w*0.3, 0.004, d*0.26]} />
          <meshStandardMaterial color="#0a0c12" roughness={0.25} metalness={0.22} />
        </mesh>
        {/* ── LCD screen panel ── */}
        <mesh position={[0, h/2 + 0.005, -d*0.3]}>
          <boxGeometry args={[w*0.27, 0.008, d*0.23]} />
          <meshStandardMaterial color="#020c02" roughness={0.05} metalness={0.0}
            emissive="#081808" emissiveIntensity={0.55} />
        </mesh>

        {/* ── Left joystick base ring ── */}
        <mesh position={[-w*0.27, h/2 + 0.004, -d*0.05]}>
          <cylinderGeometry args={[0.095, 0.1, 0.008, 22]} />
          <meshStandardMaterial color="#111318" roughness={0.5} metalness={0.18} />
        </mesh>
        {/* ── Left joystick cap ── */}
        <mesh position={[-w*0.27, h/2 + 0.092, -d*0.05]}>
          <cylinderGeometry args={[0.076, 0.07, 0.162, 22]} />
          <meshStandardMaterial color="#0e0f16" roughness={0.62} metalness={0.0} emissive={em} emissiveIntensity={ei} />
        </mesh>

        {/* ── Right joystick base ring ── */}
        <mesh position={[w*0.12, h/2 + 0.004, -d*0.05]}>
          <cylinderGeometry args={[0.095, 0.1, 0.008, 22]} />
          <meshStandardMaterial color="#111318" roughness={0.5} metalness={0.18} />
        </mesh>
        {/* ── Right joystick cap ── */}
        <mesh position={[w*0.12, h/2 + 0.092, -d*0.05]}>
          <cylinderGeometry args={[0.076, 0.07, 0.162, 22]} />
          <meshStandardMaterial color="#0e0f16" roughness={0.62} metalness={0.0} emissive={em} emissiveIntensity={ei} />
        </mesh>

        {/* ── ABXY face buttons ── */}
        {[
          { p: [w*0.37,  h/2+0.012, -d*0.2],  col: "#cc1111" }, // A red
          { p: [w*0.44,  h/2+0.012, -d*0.08], col: "#22bb22" }, // B green
          { p: [w*0.3,   h/2+0.012, -d*0.08], col: "#1133dd" }, // X blue
          { p: [w*0.37,  h/2+0.012,  d*0.04], col: "#cccc11" }, // Y yellow
        ].map(({ p, col }, i) => (
          <mesh key={`btn-${i}`} position={p}>
            <cylinderGeometry args={[0.033, 0.033, 0.022, 14]} />
            <meshStandardMaterial color={col} roughness={0.33} metalness={0.0} emissive={col} emissiveIntensity={0.38} />
          </mesh>
        ))}

        {/* ── D-pad ── */}
        <mesh position={[-w*0.12, h/2 + 0.008, -d*0.22]}>
          <boxGeometry args={[0.068, 0.018, 0.22]} />
          <meshStandardMaterial color="#18181e" roughness={0.38} metalness={0.12} />
        </mesh>
        <mesh position={[-w*0.12, h/2 + 0.008, -d*0.22]}>
          <boxGeometry args={[0.22, 0.018, 0.068]} />
          <meshStandardMaterial color="#18181e" roughness={0.38} metalness={0.12} />
        </mesh>

        {/* ── L1 shoulder bumper ── */}
        <mesh position={[-w*0.37, h/2 + 0.006, -d*0.49]}>
          <boxGeometry args={[w*0.18, 0.048, d*0.13]} />
          <meshStandardMaterial color="#131520" roughness={0.42} metalness={0.12} />
        </mesh>
        {/* ── R1 shoulder bumper ── */}
        <mesh position={[w*0.37, h/2 + 0.006, -d*0.49]}>
          <boxGeometry args={[w*0.18, 0.048, d*0.13]} />
          <meshStandardMaterial color="#131520" roughness={0.42} metalness={0.12} />
        </mesh>

        {/* ── L2 trigger (thin strip behind L1) ── */}
        <mesh position={[-w*0.38, h/2 - 0.02, -d*0.53]}>
          <boxGeometry args={[w*0.16, h*0.22, d*0.08]} />
          <meshStandardMaterial color="#10121a" roughness={0.45} metalness={0.1} />
        </mesh>
        {/* ── R2 trigger ── */}
        <mesh position={[w*0.38, h/2 - 0.02, -d*0.53]}>
          <boxGeometry args={[w*0.16, h*0.22, d*0.08]} />
          <meshStandardMaterial color="#10121a" roughness={0.45} metalness={0.1} />
        </mesh>

        {/* ── VEX logo stripe ── */}
        <mesh position={[0, h/2 + 0.006, -d*0.46]}>
          <boxGeometry args={[w*0.16, 0.012, d*0.06]} />
          <meshStandardMaterial color="#cc2200" roughness={0.34} metalness={0.0} emissive="#aa1600" emissiveIntensity={0.16} />
        </mesh>
      </group>
    );
  }

  // ── Inertial Sensor (IMU) ──────────────────────────────
  if (partDef.id === "imu") {
    const [w, h, d] = partDef.scale;
    return (
      <group>
        {/* Main teal body */}
        <RoundedBox args={[w, h, d]} radius={0.02} smoothness={3} castShadow receiveShadow>
          <meshStandardMaterial color="#0d3a4a" emissive={em} emissiveIntensity={ei} roughness={0.36} metalness={0.18} />
        </RoundedBox>
        {/* Teal top face accent plate */}
        <mesh position={[0, h/2+0.003, 0]}>
          <boxGeometry args={[w*0.82, 0.006, d*0.82]} />
          <meshStandardMaterial color="#0e7490" roughness={0.22} metalness={0.28} />
        </mesh>
        {/* Gyroscope / accelerometer chip symbol — front face */}
        <mesh position={[0, 0, d/2+0.004]}>
          <boxGeometry args={[w*0.48, h*0.48, 0.006]} />
          <meshStandardMaterial color="#082838" roughness={0.2} metalness={0.3} />
        </mesh>
        {/* Crosshair lines on chip face */}
        <mesh position={[0, 0, d/2+0.007]}><boxGeometry args={[w*0.38, 0.012, 0.004]} /><meshStandardMaterial color="#22d3ee" roughness={0.1} emissive="#22d3ee" emissiveIntensity={0.4}/></mesh>
        <mesh position={[0, 0, d/2+0.007]}><boxGeometry args={[0.012, h*0.38, 0.004]} /><meshStandardMaterial color="#22d3ee" roughness={0.1} emissive="#22d3ee" emissiveIntensity={0.4}/></mesh>
        {/* Blue status LED — top */}
        <mesh position={[w*0.34, h/2+0.006, d*0.3]}>
          <cylinderGeometry args={[0.022, 0.022, 0.012, 8]} />
          <meshStandardMaterial color="#00aaff" emissive="#00aaff" emissiveIntensity={1.4} roughness={0.1} metalness={0.0} />
        </mesh>
        {/* Corner mounting holes — front face */}
        {[[-w*0.35,-h*0.3],[w*0.35,-h*0.3],[-w*0.35,h*0.3],[w*0.35,h*0.3]].map(([x,y],i)=>(
          <mesh key={i} position={[x,y,d/2+0.001]}><circleGeometry args={[0.024,10]}/><meshStandardMaterial color="#050508" roughness={0.9}/></mesh>
        ))}
        {/* Smart port — red housing */}
        <group position={[0, -h/2-0.022, 0]}>
          <mesh><boxGeometry args={[w*0.56, 0.044, 0.18]}/><meshStandardMaterial color="#8b1010" roughness={0.42} metalness={0.15}/></mesh>
          <mesh position={[0,0.012,0]}><boxGeometry args={[w*0.36, 0.018, 0.1]}/><meshStandardMaterial color="#020204" roughness={0.9}/></mesh>
        </group>
      </group>
    );
  }

  // ── Distance Sensor ────────────────────────────────────
  if (partDef.id === "distance") {
    const [w, h, d] = partDef.scale;
    return (
      <group>
        {/* Dark green body */}
        <RoundedBox args={[w, h, d]} radius={0.02} smoothness={3} castShadow receiveShadow>
          <meshStandardMaterial color="#052a18" emissive={em} emissiveIntensity={ei} roughness={0.36} metalness={0.14} />
        </RoundedBox>
        {/* Front face sensor plate */}
        <mesh position={[0, 0, d/2+0.004]}>
          <boxGeometry args={[w*0.9, h*0.88, 0.006]} />
          <meshStandardMaterial color="#04200e" roughness={0.22} metalness={0.2} />
        </mesh>
        {/* Emitter aperture (left) — silver ring */}
        <mesh position={[-w*0.18, 0, d/2+0.008]} rotation={[Math.PI/2,0,0]}>
          <torusGeometry args={[h*0.22, h*0.044, 8, 20]} />
          <meshStandardMaterial color="#3a4a3a" roughness={0.28} metalness={0.42} />
        </mesh>
        <mesh position={[-w*0.18, 0, d/2+0.01]} rotation={[Math.PI/2,0,0]}>
          <cylinderGeometry args={[h*0.13, h*0.13, 0.004, 12]} />
          <meshStandardMaterial color="#ffd700" emissive="#ffaa00" emissiveIntensity={0.9} roughness={0.08} />
        </mesh>
        {/* Receiver aperture (right) — red dot */}
        <mesh position={[w*0.18, 0, d/2+0.008]} rotation={[Math.PI/2,0,0]}>
          <torusGeometry args={[h*0.22, h*0.044, 8, 20]} />
          <meshStandardMaterial color="#3a2020" roughness={0.28} metalness={0.3} />
        </mesh>
        <mesh position={[w*0.18, 0, d/2+0.01]} rotation={[Math.PI/2,0,0]}>
          <cylinderGeometry args={[h*0.13, h*0.13, 0.004, 12]} />
          <meshStandardMaterial color="#dd0000" emissive="#ff0000" emissiveIntensity={1.9} roughness={0.06} metalness={0.0} />
        </mesh>
        {/* Green LED indicator — top */}
        <mesh position={[w*0.34, h/2+0.006, 0]}>
          <cylinderGeometry args={[0.022,0.022,0.012,8]} />
          <meshStandardMaterial color="#00ff44" emissive="#00ff44" emissiveIntensity={1.3} roughness={0.1} />
        </mesh>
        {/* Corner mounting holes */}
        {[[-w*0.4,-h*0.3],[w*0.4,-h*0.3],[-w*0.4,h*0.3],[w*0.4,h*0.3]].map(([x,y],i)=>(
          <mesh key={i} position={[x,y,d/2+0.001]}><circleGeometry args={[0.022,10]}/><meshStandardMaterial color="#050508" roughness={0.9}/></mesh>
        ))}
        {/* Smart port — red housing */}
        <group position={[0, -h/2-0.022, 0]}>
          <mesh><boxGeometry args={[w*0.56, 0.044, 0.18]}/><meshStandardMaterial color="#8b1010" roughness={0.42} metalness={0.15}/></mesh>
          <mesh position={[0,0.012,0]}><boxGeometry args={[w*0.36, 0.018, 0.1]}/><meshStandardMaterial color="#020204" roughness={0.9}/></mesh>
        </group>
      </group>
    );
  }

  // ── Optical Sensor ─────────────────────────────────────
  if (partDef.id === "optical") {
    const [w, h, d] = partDef.scale;
    const rgbCols = ["#ff2200", "#00ff44", "#0055ff", "#ff8800"];
    return (
      <group>
        {/* Purple body */}
        <RoundedBox args={[w, h, d]} radius={0.02} smoothness={3} castShadow receiveShadow>
          <meshStandardMaterial color="#2e0a52" emissive={em} emissiveIntensity={ei} roughness={0.36} metalness={0.12} />
        </RoundedBox>
        {/* Front face sensor plate */}
        <mesh position={[0, 0, d/2+0.004]}>
          <boxGeometry args={[w*0.9, h*0.88, 0.006]} />
          <meshStandardMaterial color="#1e0638" roughness={0.22} metalness={0.15} />
        </mesh>
        {/* Central lens on FRONT face (Z+) */}
        <mesh position={[0, h*0.08, d/2+0.008]} rotation={[Math.PI/2,0,0]}>
          <cylinderGeometry args={[h*0.22, h*0.22, 0.012, 20]} />
          <meshStandardMaterial color="#060010" roughness={0.03} metalness={0.0} emissive="#300060" emissiveIntensity={0.45} />
        </mesh>
        {/* RGB LED ring around lens — FRONT face */}
        {rgbCols.map((col, i) => {
          const ang = (i / 4) * Math.PI * 2;
          return (
            <mesh key={`rgb-${i}`} position={[Math.cos(ang)*h*0.28, h*0.08+Math.sin(ang)*h*0.28, d/2+0.007]}>
              <cylinderGeometry args={[0.022, 0.022, 0.01, 8]} />
              <meshStandardMaterial color={col} emissive={col} emissiveIntensity={1.2} roughness={0.15} metalness={0.0} />
            </mesh>
          );
        })}
        {/* Proximity detector below lens */}
        <mesh position={[0, -h*0.22, d/2+0.007]}>
          <cylinderGeometry args={[h*0.1, h*0.1, 0.008, 12]} />
          <meshStandardMaterial color="#1a001a" roughness={0.08} emissive="#6600aa" emissiveIntensity={0.5} />
        </mesh>
        {/* Corner mounting holes */}
        {[[-w*0.35,-h*0.3],[w*0.35,-h*0.3],[-w*0.35,h*0.3],[w*0.35,h*0.3]].map(([x,y],i)=>(
          <mesh key={i} position={[x,y,d/2+0.001]}><circleGeometry args={[0.024,10]}/><meshStandardMaterial color="#050508" roughness={0.9}/></mesh>
        ))}
        {/* Smart port — red housing */}
        <group position={[0, -h/2-0.022, 0]}>
          <mesh><boxGeometry args={[w*0.56, 0.044, 0.18]}/><meshStandardMaterial color="#8b1010" roughness={0.42} metalness={0.15}/></mesh>
          <mesh position={[0,0.012,0]}><boxGeometry args={[w*0.36, 0.018, 0.1]}/><meshStandardMaterial color="#020204" roughness={0.9}/></mesh>
        </group>
      </group>
    );
  }

  // ── Bumper Switch ──────────────────────────────────────
  if (partDef.id === "bumper") {
    const [w, h, d] = partDef.scale;
    return (
      <group>
        {/* Dark red ABS body */}
        <RoundedBox args={[w, h, d]} radius={0.02} smoothness={3} castShadow receiveShadow>
          <meshStandardMaterial color="#3a0a0a" emissive={em} emissiveIntensity={ei} roughness={0.48} metalness={0.05} />
        </RoundedBox>
        {/* Button guide plate on top */}
        <mesh position={[0, h/2+0.003, 0]}>
          <boxGeometry args={[w*0.65, 0.005, d*0.65]} />
          <meshStandardMaterial color="#222" roughness={0.4} metalness={0.35} />
        </mesh>
        {/* Chrome ring */}
        <mesh position={[0, h/2+0.006, 0]}>
          <cylinderGeometry args={[0.1, 0.1, 0.006, 18]} />
          <meshStandardMaterial color="#909098" roughness={0.22} metalness={0.48} />
        </mesh>
        {/* Large vivid red button cap */}
        <mesh position={[0, h/2+0.044, 0]} castShadow>
          <cylinderGeometry args={[0.085, 0.092, 0.08, 18]} />
          <meshStandardMaterial color="#e01111" roughness={0.28} metalness={0.0} emissive="#cc0000" emissiveIntensity={0.22} />
        </mesh>
        {/* Mounting holes — front face */}
        {[[-w*0.36,-h*0.25],[w*0.36,-h*0.25]].map(([x,y],i)=>(
          <mesh key={i} position={[x,y,d/2+0.001]}><circleGeometry args={[0.026,10]}/><meshStandardMaterial color="#050508" roughness={0.9}/></mesh>
        ))}
        {/* Smart port — red housing */}
        <group position={[0, -h/2-0.022, 0]}>
          <mesh><boxGeometry args={[w*0.56, 0.044, 0.18]}/><meshStandardMaterial color="#8b1010" roughness={0.42} metalness={0.15}/></mesh>
          <mesh position={[0,0.012,0]}><boxGeometry args={[w*0.36, 0.018, 0.1]}/><meshStandardMaterial color="#020204" roughness={0.9}/></mesh>
        </group>
      </group>
    );
  }

  // ── Flat Plate (with hole pattern) ────────────────────
  if (partDef.id === "flatplate") {
    const [w, h, d] = partDef.scale;
    const cols = 9, rows = 4;
    const hR = 0.068;
    const holeCol = "#06080e";
    const rimCol  = "#dce6f0";
    return (
      <group>
        <mesh castShadow receiveShadow>
          <boxGeometry args={[w, h, d]} />
          <meshStandardMaterial color="#bec8d0" emissive={em} emissiveIntensity={ei} {...MAT.aluminum} />
        </mesh>
        {/* 0.5″-spaced through-hole grid — top face */}
        {Array.from({ length: rows * cols }, (_, idx) => {
          const row = Math.floor(idx / cols);
          const col = idx % cols;
          const px  = -w * 0.42 + col * (w * 0.84 / (cols - 1));
          const pz  = -d * 0.38 + row * (d * 0.76 / (rows - 1));
          return (
            <group key={`hole-${idx}`} position={[px, h/2 + 0.001, pz]}>
              <mesh rotation={[-Math.PI/2, 0, 0]}>
                <circleGeometry args={[hR * 1.28, 14]} />
                <meshStandardMaterial color={rimCol} roughness={0.08} metalness={0.92} />
              </mesh>
              <mesh rotation={[-Math.PI/2, 0, 0]} position={[0, 0, 0.001]}>
                <circleGeometry args={[hR, 14]} />
                <meshStandardMaterial color={holeCol} roughness={0.95} metalness={0.0} />
              </mesh>
            </group>
          );
        })}
        {/* Bottom face exit holes */}
        {Array.from({ length: rows * cols }, (_, idx) => {
          const row = Math.floor(idx / cols);
          const col = idx % cols;
          const px  = -w * 0.42 + col * (w * 0.84 / (cols - 1));
          const pz  = -d * 0.38 + row * (d * 0.76 / (rows - 1));
          return (
            <group key={`holeB-${idx}`} position={[px, -h/2 - 0.001, pz]}>
              <mesh rotation={[Math.PI/2, 0, 0]}>
                <circleGeometry args={[hR * 1.12, 14]} />
                <meshStandardMaterial color={rimCol} roughness={0.1} metalness={0.88} />
              </mesh>
              <mesh rotation={[Math.PI/2, 0, 0]} position={[0, 0, 0.001]}>
                <circleGeometry args={[hR, 14]} />
                <meshStandardMaterial color={holeCol} roughness={0.95} metalness={0.0} />
              </mesh>
            </group>
          );
        })}
      </group>
    );
  }

  // ── C-Channel 2×2 variant (same renderer, wider flange) ──────────────────
  if (partDef.id === "cchannel-m" || partDef.id === "cchannel-2x2") {
    // Reuse the existing cchannel renderer by treating it like cchannel-s/l
    const [len, ht, dp] = partDef.scale;
    const t  = ht * 0.38;
    const hR = 0.072;
    const hN  = Math.max(2, Math.round(len / 0.5));
    const hSp = len / hN;
    const xs  = Array.from({ length: hN }, (_, i) => -len/2 + (i + 0.5) * hSp);
    const bodyCol = "#c0c8ce"; const holeCol = "#06080e"; const rimCol = "#dce6f0";
    return (
      <group>
        <mesh position={[0, -ht/2 + t/2, 0]} castShadow receiveShadow>
          <boxGeometry args={[len, t, dp]} />
          <meshStandardMaterial color={bodyCol} emissive={em} emissiveIntensity={ei} {...MAT.aluminum} />
        </mesh>
        <mesh position={[0,  ht/2 - t/2, 0]} castShadow receiveShadow>
          <boxGeometry args={[len, t, dp]} />
          <meshStandardMaterial color={bodyCol} emissive={em} emissiveIntensity={ei} {...MAT.aluminum} />
        </mesh>
        <mesh position={[0, 0, -dp/2 + t/2]} castShadow receiveShadow>
          <boxGeometry args={[len, ht - 2*t, t]} />
          <meshStandardMaterial color="#b8c2c8" emissive={em} emissiveIntensity={ei} {...MAT.aluminum} />
        </mesh>
        {xs.map((x, i) => (
          <group key={`h-${i}`} position={[x, ht/2 + 0.001, 0]}>
            <mesh rotation={[-Math.PI/2, 0, 0]}><circleGeometry args={[hR*1.28, 14]} /><meshStandardMaterial color={rimCol} roughness={0.08} metalness={0.92} /></mesh>
            <mesh rotation={[-Math.PI/2, 0, 0]} position={[0,0,0.001]}><circleGeometry args={[hR, 14]} /><meshStandardMaterial color={holeCol} roughness={0.95} metalness={0.0} /></mesh>
          </group>
        ))}
      </group>
    );
  }

  // ── Angle Bar Long (same renderer as anglebar, auto-scaled) ──────────────
  if (partDef.id === "anglebar-l") {
    const [len, ht, dp] = partDef.scale;
    const t = ht * 0.45; const hR = 0.068;
    const hN = Math.max(2, Math.round(len / 0.5)); const hSp = len / hN;
    const xs = Array.from({ length: hN }, (_, i) => -len/2 + (i+0.5)*hSp);
    const bodyCol = "#c0c8ce"; const holeCol = "#06080e"; const rimCol = "#dce6f0";
    return (
      <group>
        <mesh position={[0, -ht/2 + t/2, 0]} castShadow receiveShadow>
          <boxGeometry args={[len, t, dp]} />
          <meshStandardMaterial color={bodyCol} emissive={em} emissiveIntensity={ei} {...MAT.aluminum} />
        </mesh>
        <mesh position={[0, t/2, -dp/2 + t/2]} castShadow receiveShadow>
          <boxGeometry args={[len, ht-t, t]} />
          <meshStandardMaterial color="#b8c2c8" emissive={em} emissiveIntensity={ei} {...MAT.aluminum} />
        </mesh>
        {xs.map((x,i) => (
          <group key={`al-${i}`} position={[x, -ht/2+t+0.001, 0]}>
            <mesh rotation={[-Math.PI/2,0,0]}><circleGeometry args={[hR*1.25,14]}/><meshStandardMaterial color={rimCol} roughness={0.08} metalness={0.92}/></mesh>
            <mesh rotation={[-Math.PI/2,0,0]} position={[0,0,0.001]}><circleGeometry args={[hR,14]}/><meshStandardMaterial color={holeCol} roughness={0.95} metalness={0.0}/></mesh>
          </group>
        ))}
      </group>
    );
  }

  // ── Square Bar ─────────────────────────────────────────────────────────────
  if (partDef.id === "squarebar") {
    const [len, ht, dp] = partDef.scale;
    const hN = Math.max(2, Math.round(len / 0.5));
    const hSp = len / hN;
    const xs = Array.from({ length: hN }, (_, i) => -len/2 + (i+0.5)*hSp);
    const hR = 0.04; const rimCol = "#dce6f0"; const holeCol = "#06080e";
    return (
      <group>
        <mesh castShadow receiveShadow>
          <boxGeometry args={[len, ht, dp]} />
          <meshStandardMaterial color="#b8c4cc" emissive={em} emissiveIntensity={ei} {...MAT.aluminum} />
        </mesh>
        {xs.map((x,i) => (
          <group key={`sb-${i}`} position={[x, ht/2+0.001, 0]}>
            <mesh rotation={[-Math.PI/2,0,0]}><circleGeometry args={[hR*1.3,12]}/><meshStandardMaterial color={rimCol} roughness={0.08} metalness={0.92}/></mesh>
            <mesh rotation={[-Math.PI/2,0,0]} position={[0,0,0.001]}><circleGeometry args={[hR,12]}/><meshStandardMaterial color={holeCol} roughness={0.95}/></mesh>
          </group>
        ))}
      </group>
    );
  }

  // ── Spacers ────────────────────────────────────────────────────────────────
  if (partDef.id === "spacer-1" || partDef.id === "spacer-2") {
    const [rT,,h] = partDef.scale;
    return (
      <group>
        <mesh castShadow>
          <cylinderGeometry args={[rT*1.8, rT*1.8, h, 16]} />
          <meshStandardMaterial color="#d8e0e8" emissive={em} emissiveIntensity={ei} {...MAT.aluminum} />
        </mesh>
        <mesh>
          <cylinderGeometry args={[rT*0.8, rT*0.8, h*1.05, 12]} />
          <meshStandardMaterial color="#222" roughness={0.9} metalness={0.05} />
        </mesh>
      </group>
    );
  }

  // ── Shaft Collar ──────────────────────────────────────────────────────────
  if (partDef.id === "collar") {
    const [r,,h] = partDef.scale;
    return (
      <group>
        <mesh castShadow>
          <cylinderGeometry args={[r*2.0, r*2.0, h, 16]} />
          <meshStandardMaterial color="#c8d4dc" emissive={em} emissiveIntensity={ei} {...MAT.aluminum} />
        </mesh>
        {/* Set screw on side */}
        <mesh position={[r*2.2, 0, 0]} rotation={[0, 0, Math.PI/2]}>
          <cylinderGeometry args={[0.022, 0.022, 0.08, 6]} />
          <meshStandardMaterial color="#8898a8" {...MAT.steel} />
        </mesh>
        {/* Bore */}
        <mesh>
          <cylinderGeometry args={[r*0.85, r*0.85, h*1.05, 8]} />
          <meshStandardMaterial color="#111" roughness={0.9} />
        </mesh>
      </group>
    );
  }

  // ── Screw ─────────────────────────────────────────────────────────────────
  if (partDef.id === "screw") {
    const [r,,h] = partDef.scale;
    return (
      <group>
        <mesh position={[0, h*0.25, 0]} castShadow>
          <cylinderGeometry args={[r*2.6, r*2.6, h*0.18, 6]} />
          <meshStandardMaterial color="#c0c8d0" {...MAT.steel} />
        </mesh>
        <mesh position={[0, -h*0.08, 0]} castShadow>
          <cylinderGeometry args={[r, r, h*0.82, 10]} />
          <meshStandardMaterial color="#d0d8e0" emissive={em} emissiveIntensity={ei} {...MAT.steel} />
        </mesh>
      </group>
    );
  }

  // ── Wheel 2.75" and 4" (same renderer as 3.25", scaled) ──────────────────
  if (partDef.id === "wheel-275" || partDef.id === "wheel-4") {
    const r = partDef.scale[0]; const h = partDef.scale[2];
    const hubR = r*0.3; const spokeN = 6;
    return (
      <group>
        <mesh castShadow rotation={[Math.PI/2,0,0]}>
          <torusGeometry args={[r*0.79, r*0.19, 14, 36]} />
          <meshStandardMaterial color="#0d0d0d" emissive={em} emissiveIntensity={ei} {...MAT.rubber} />
        </mesh>
        <mesh castShadow>
          <cylinderGeometry args={[r*0.62, r*0.62, h*0.45, 24]} />
          <meshStandardMaterial color="#1e1e1e" emissive={em} emissiveIntensity={ei} roughness={0.5} metalness={0.1} />
        </mesh>
        <mesh castShadow>
          <cylinderGeometry args={[hubR, hubR, h, 12]} />
          <meshStandardMaterial color="#c0c8d4" emissive={em} emissiveIntensity={ei} {...MAT.hub} />
        </mesh>
        {Array.from({length:spokeN},(_,i)=>{
          const ang=(i/spokeN)*Math.PI*2; const sl=r*0.62-hubR-0.02;
          return <mesh key={i} position={[Math.cos(ang)*(hubR+sl/2),0,Math.sin(ang)*(hubR+sl/2)]} rotation={[0,-ang,0]} castShadow>
            <boxGeometry args={[sl, h*0.28, 0.032]}/>
            <meshStandardMaterial color="#1a1a1a" emissive={em} emissiveIntensity={ei} roughness={0.55} metalness={0.05}/>
          </mesh>;
        })}
      </group>
    );
  }

  // ── Omni 2.75" (same renderer as omni, scaled) ───────────────────────────
  if (partDef.id === "omni-275") {
    const r = partDef.scale[0]; const h = partDef.scale[2];
    const hubR = r*0.3; const spokeN = 6;
    return (
      <group>
        <mesh castShadow rotation={[Math.PI/2,0,0]}>
          <torusGeometry args={[r*0.79, r*0.19, 14, 36]} />
          <meshStandardMaterial color="#2a2a2a" emissive={em} emissiveIntensity={ei} {...MAT.rubber} />
        </mesh>
        <mesh castShadow>
          <cylinderGeometry args={[r*0.62, r*0.62, h*0.45, 24]} />
          <meshStandardMaterial color="#3a3a3a" emissive={em} emissiveIntensity={ei} roughness={0.5} metalness={0.1} />
        </mesh>
        <mesh castShadow>
          <cylinderGeometry args={[hubR, hubR, h, 12]} />
          <meshStandardMaterial color="#c0c8d4" {...MAT.hub} />
        </mesh>
        {Array.from({length:spokeN},(_,i)=>{
          const ang=(i/spokeN)*Math.PI*2; const sl=r*0.62-hubR-0.02;
          return <mesh key={i} position={[Math.cos(ang)*(hubR+sl/2),0,Math.sin(ang)*(hubR+sl/2)]} rotation={[0,-ang,0]} castShadow>
            <boxGeometry args={[sl, h*0.28, 0.032]}/><meshStandardMaterial color="#1a1a1a" roughness={0.55}/></mesh>;
        })}
        {Array.from({length:14},(_,i)=>{
          const ang=(i/14)*Math.PI*2;
          return <mesh key={i} position={[Math.cos(ang)*r*0.84,0,Math.sin(ang)*r*0.84]} rotation={[0,-ang+Math.PI/2,0]} castShadow>
            <cylinderGeometry args={[h*0.13,h*0.13,h*0.88,8]}/><meshStandardMaterial color="#555" roughness={0.78}/></mesh>;
        })}
      </group>
    );
  }

  // ── HS Axles (short / long variants, same renderer) ───────────────────────
  if (partDef.id === "axle-s" || partDef.id === "axle-l") {
    const [rT, rB, h] = partDef.scale;
    return (
      <mesh castShadow receiveShadow>
        <cylinderGeometry args={[rT*1.6, rB*1.6, h, 4]} />
        <meshStandardMaterial color="#c8d0d8" emissive={em} emissiveIntensity={ei} {...MAT.steel} />
      </mesh>
    );
  }

  // ── 12T and 60T Gears ─────────────────────────────────────────────────────
  if (partDef.id === "gear-12" || partDef.id === "gear-60") {
    const r = partDef.scale[0]; const h = partDef.scale[2];
    const teeth = partDef.id === "gear-12" ? 8 : 20;
    const tl = r*0.14; const gearCol = "#8898a8";
    return (
      <group>
        <mesh castShadow receiveShadow>
          <cylinderGeometry args={[r*0.86, r*0.86, h, 48]} />
          <meshStandardMaterial color={gearCol} emissive={em} emissiveIntensity={ei} {...MAT.aluminum} />
        </mesh>
        <mesh castShadow>
          <cylinderGeometry args={[r*0.3, r*0.3, h*1.12, 20]} />
          <meshStandardMaterial color="#b0bec8" {...MAT.hub} />
        </mesh>
        <mesh>
          <cylinderGeometry args={[r*0.1, r*0.1, h*1.3, 4]} />
          <meshStandardMaterial color="#111" roughness={0.9} />
        </mesh>
        {Array.from({length:teeth},(_,i)=>{
          const ang=(i/teeth)*Math.PI*2;
          return <mesh key={i} position={[Math.cos(ang)*(r*0.86+tl/2),0,Math.sin(ang)*(r*0.86+tl/2)]} rotation={[0,-ang,0]} castShadow>
            <boxGeometry args={[tl, h*0.84, r*0.10]}/>
            <meshStandardMaterial color={gearCol} emissive={em} emissiveIntensity={ei} {...MAT.aluminum}/>
          </mesh>;
        })}
      </group>
    );
  }

  // ── Sprockets ─────────────────────────────────────────────────────────────
  if (partDef.id === "sprocket-18" || partDef.id === "sprocket-24") {
    const r = partDef.scale[0]; const h = partDef.scale[2];
    const teeth = partDef.id === "sprocket-18" ? 9 : 12;
    const tl = r * 0.18;
    return (
      <group>
        <mesh castShadow>
          <cylinderGeometry args={[r*0.82, r*0.82, h, 32]} />
          <meshStandardMaterial color="#808890" emissive={em} emissiveIntensity={ei} {...MAT.aluminum} />
        </mesh>
        <mesh>
          <cylinderGeometry args={[r*0.28, r*0.28, h*1.1, 20]} />
          <meshStandardMaterial color="#b0bec8" {...MAT.hub} />
        </mesh>
        <mesh>
          <cylinderGeometry args={[r*0.1, r*0.1, h*1.2, 4]} />
          <meshStandardMaterial color="#111" roughness={0.9} />
        </mesh>
        {/* Teeth (rounded pegs) */}
        {Array.from({length:teeth},(_,i)=>{
          const ang=(i/teeth)*Math.PI*2;
          return <mesh key={i} position={[Math.cos(ang)*(r*0.9),0,Math.sin(ang)*(r*0.9)]} castShadow>
            <cylinderGeometry args={[r*0.07, r*0.07, h*1.5, 8]}/>
            <meshStandardMaterial color="#707880" {...MAT.steel}/>
          </mesh>;
        })}
      </group>
    );
  }

  // ── Chain section ─────────────────────────────────────────────────────────
  if (partDef.id === "chain") {
    const [w, h, d] = partDef.scale;
    const links = 8;
    return (
      <group>
        {Array.from({length:links},(_,i)=>{
          const x = -w/2 + (i+0.5)*(w/links);
          const isEven = i%2===0;
          return <mesh key={i} position={[x,0,0]} castShadow>
            <boxGeometry args={[w/links*0.82, h*(isEven?1.6:1.0), d*(isEven?0.7:1.0)]}/>
            <meshStandardMaterial color="#484852" emissive={em} emissiveIntensity={ei} roughness={0.35} metalness={0.7}/>
          </mesh>;
        })}
      </group>
    );
  }

  // ── Motor Cartridges ──────────────────────────────────────────────────────
  if (partDef.id === "motor-cart-r" || partDef.id === "motor-cart-g" || partDef.id === "motor-cart-b") {
    const [w, h, d] = partDef.scale;
    const isRed = partDef.id === "motor-cart-r", isBlue = partDef.id === "motor-cart-b";
    const col     = isRed ? "#cc1a1a" : isBlue ? "#1a46cc" : "#158034";
    const colDark = isRed ? "#7a0808" : isBlue ? "#0a2070" : "#0a4a1a";
    const colGlow = isRed ? "#ff2020" : isBlue ? "#2060ff" : "#20cc44";
    const rpm     = isRed ? "100" : isBlue ? "600" : "200";
    const gearN   = isRed ? 10 : isBlue ? 16 : 12;
    return (
      <group>
        {/* Main colored body */}
        <RoundedBox args={[w, h, d]} radius={0.028} smoothness={4} castShadow receiveShadow>
          <meshStandardMaterial color={col} emissive={em} emissiveIntensity={ei} roughness={0.38} metalness={0.1} />
        </RoundedBox>
        {/* Darker rear portion — clip-in tab detail */}
        <mesh position={[0, 0, -d*0.3]}>
          <boxGeometry args={[w*0.88, h*0.88, d*0.4]} />
          <meshStandardMaterial color={colDark} roughness={0.42} metalness={0.12} />
        </mesh>
        {/* White label panel on top */}
        <mesh position={[0, h/2+0.004, -d*0.05]}>
          <boxGeometry args={[w*0.76, 0.008, d*0.58]} />
          <meshStandardMaterial color="#e8ecf0" roughness={0.45} metalness={0.0} />
        </mesh>
        {/* RPM stripe — thick colored bar on label */}
        <mesh position={[0, h/2+0.009, d*0.12]}>
          <boxGeometry args={[w*0.56, 0.004, d*0.14]} />
          <meshStandardMaterial color={colGlow} emissive={colGlow} emissiveIntensity={0.5} roughness={0.3} metalness={0.0} />
        </mesh>
        {/* Gear view window on front (Z+) — circular opening */}
        <mesh position={[0, -h*0.06, d/2+0.005]} rotation={[Math.PI/2,0,0]}>
          <torusGeometry args={[h*0.28, h*0.042, 8, 24]} />
          <meshStandardMaterial color={colDark} roughness={0.3} metalness={0.35} />
        </mesh>
        {/* Gear teeth inside window */}
        {Array.from({length:gearN},(_,i)=>{
          const ang=(i/gearN)*Math.PI*2;
          return <mesh key={i} position={[Math.cos(ang)*h*0.21, -h*0.06+Math.sin(ang)*h*0.21, d/2+0.007]} rotation={[0,0,-ang]}>
            <boxGeometry args={[h*0.065, h*0.028, 0.006]}/>
            <meshStandardMaterial color="#888" roughness={0.2} metalness={0.7}/>
          </mesh>;
        })}
        {/* Central gear hub */}
        <mesh position={[0, -h*0.06, d/2+0.008]} rotation={[Math.PI/2,0,0]}>
          <cylinderGeometry args={[h*0.09, h*0.09, 0.006, 10]} />
          <meshStandardMaterial color="#aab4c0" {...MAT.hub} />
        </mesh>
        {/* Side clip ridges */}
        {[-w*0.44, w*0.44].map((x,i)=>(
          <mesh key={i} position={[x, 0, d*0.1]}>
            <boxGeometry args={[0.01, h*0.7, d*0.48]}/>
            <meshStandardMaterial color={colDark} roughness={0.5}/>
          </mesh>
        ))}
      </group>
    );
  }

  // ── V5 Radio ──────────────────────────────────────────────────────────────
  if (partDef.id === "radio") {
    const [w, h, d] = partDef.scale;
    return (
      <group>
        {/* Main body — very dark navy */}
        <RoundedBox args={[w, h, d]} radius={0.022} smoothness={4} castShadow receiveShadow>
          <meshStandardMaterial color="#080810" emissive={em} emissiveIntensity={ei} roughness={0.35} metalness={0.18} />
        </RoundedBox>
        {/* Front face plate */}
        <mesh position={[0, 0, d/2+0.004]}>
          <boxGeometry args={[w*0.88, h*0.82, 0.006]} />
          <meshStandardMaterial color="#0d0d18" roughness={0.22} metalness={0.25} />
        </mesh>
        {/* Signal strength bars (front face, Z+) — 3 rising bars */}
        {[0,1,2].map(i => (
          <mesh key={i} position={[-w*0.12 + i*w*0.12, -h*0.05 + i*h*0.04, d/2+0.008]}>
            <boxGeometry args={[0.028, 0.02 + i*0.03, 0.005]}/>
            <meshStandardMaterial color="#00ccff" emissive="#00aaff" emissiveIntensity={0.55 + i*0.1} roughness={0.1}/>
          </mesh>
        ))}
        {/* Status LED — green, front face */}
        <mesh position={[w*0.3, h*0.3, d/2+0.008]}>
          <cylinderGeometry args={[0.016, 0.016, 0.007, 10]} />
          <meshStandardMaterial color="#00ff55" emissive="#00ff44" emissiveIntensity={1.1} roughness={0.1}/>
        </mesh>
        {/* Antenna — top corner, chrome rod */}
        <mesh position={[w*0.36, h/2+0.09, d*0.1]} rotation={[0.15, 0, 0.06]}>
          <cylinderGeometry args={[0.009, 0.006, 0.18, 8]}/>
          <meshStandardMaterial color="#c0c8d0" {...MAT.steel}/>
        </mesh>
        {/* Antenna base */}
        <mesh position={[w*0.36, h/2+0.012, d*0.1]}>
          <cylinderGeometry args={[0.017, 0.017, 0.022, 8]}/>
          <meshStandardMaterial color="#222230" roughness={0.5}/>
        </mesh>
        {/* Side ventilation slots */}
        {[-1,1].map(s => [0,1,2].map(i => (
          <mesh key={`${s}-${i}`} position={[s*(w/2+0.002), -h*0.1 + i*h*0.12, 0]}>
            <boxGeometry args={[0.004, h*0.07, d*0.12]}/>
            <meshStandardMaterial color="#020208" roughness={0.9}/>
          </mesh>
        )))}
        {/* Smart port — red housing */}
        <group position={[0, -h/2-0.022, 0]}>
          <mesh><boxGeometry args={[w*0.54, 0.044, 0.18]}/><meshStandardMaterial color="#8b1010" roughness={0.42} metalness={0.15}/></mesh>
          <mesh position={[0,0.012,0]}><boxGeometry args={[w*0.36, 0.018, 0.1]}/><meshStandardMaterial color="#020204" roughness={0.9}/></mesh>
        </group>
      </group>
    );
  }

  // ── 3-Wire Expander ───────────────────────────────────────────────────────
  if (partDef.id === "expander") {
    const [w, h, d] = partDef.scale;
    // 8 ADI port colors (A–H)
    const portColors = ["#e74c3c","#e67e22","#f1c40f","#2ecc71","#3498db","#9b59b6","#1abc9c","#e74c3c"];
    return (
      <group>
        {/* Main body — dark charcoal */}
        <RoundedBox args={[w, h, d]} radius={0.025} smoothness={4} castShadow receiveShadow>
          <meshStandardMaterial color="#18191f" emissive={em} emissiveIntensity={ei} roughness={0.38} metalness={0.14} />
        </RoundedBox>
        {/* Front face plate */}
        <mesh position={[0, 0, d/2+0.003]}>
          <boxGeometry args={[w*0.92, h*0.88, 0.005]}/>
          <meshStandardMaterial color="#0e0f15" roughness={0.25} metalness={0.2}/>
        </mesh>
        {/* 8 ADI 3-wire ports on FRONT face — 2 rows of 4 */}
        {Array.from({length:8},(_,i)=>{
          const col = i % 4;
          const row = Math.floor(i / 4);
          const x = -w*0.32 + col*(w*0.64/3);
          const y = h*0.12 - row*h*0.35;
          return (
            <group key={i} position={[x, y, d/2+0.007]}>
              {/* Port slot */}
              <mesh>
                <boxGeometry args={[0.055, h*0.22, 0.005]}/>
                <meshStandardMaterial color="#080808" roughness={0.8}/>
              </mesh>
              {/* Colored port indicator dot */}
              <mesh position={[0, h*0.14, 0]}>
                <cylinderGeometry args={[0.012, 0.012, 0.005, 8]}/>
                <meshStandardMaterial color={portColors[i]} emissive={portColors[i]} emissiveIntensity={0.35} roughness={0.2}/>
              </mesh>
            </group>
          );
        })}
        {/* Status LED */}
        <mesh position={[w*0.38, h*0.38, d/2+0.008]}>
          <cylinderGeometry args={[0.013, 0.013, 0.007, 8]}/>
          <meshStandardMaterial color="#00ff55" emissive="#00ff44" emissiveIntensity={0.9} roughness={0.1}/>
        </mesh>
        {/* Corner mounting holes on front */}
        {[[-w*0.42,-h*0.38],[w*0.42,-h*0.38]].map(([x,y],i)=>(
          <mesh key={i} position={[x,y,d/2+0.001]}>
            <circleGeometry args={[0.022,10]}/>
            <meshStandardMaterial color="#050508" roughness={0.9}/>
          </mesh>
        ))}
        {/* Smart port — red housing */}
        <group position={[0, -h/2-0.022, 0]}>
          <mesh><boxGeometry args={[w*0.54, 0.044, 0.18]}/><meshStandardMaterial color="#8b1010" roughness={0.42} metalness={0.15}/></mesh>
          <mesh position={[0,0.012,0]}><boxGeometry args={[w*0.36, 0.018, 0.1]}/><meshStandardMaterial color="#020204" roughness={0.9}/></mesh>
        </group>
      </group>
    );
  }

  // ── Smart Cables ──────────────────────────────────────────────────────────
  if (partDef.id === "cable-s" || partDef.id === "cable-l") {
    const [r,,h] = partDef.scale;
    return (
      <group>
        <mesh castShadow>
          <cylinderGeometry args={[r, r, h*0.85, 8]} />
          <meshStandardMaterial color="#cc2222" emissive={em} emissiveIntensity={ei} roughness={0.62} metalness={0.0} />
        </mesh>
        {/* Connector plugs at each end */}
        {[-1, 1].map(s => (
          <mesh key={s} position={[0, s*h*0.46, 0]} castShadow>
            <boxGeometry args={[r*5.5, h*0.08, r*3.5]} />
            <meshStandardMaterial color="#181820" roughness={0.5} metalness={0.15} />
          </mesh>
        ))}
      </group>
    );
  }

  // ── Rotation Sensor ───────────────────────────────────────────────────────
  if (partDef.id === "rotation") {
    const [w, h, d] = partDef.scale;
    const spokeN = 8;
    return (
      <group>
        {/* Blue body */}
        <RoundedBox args={[w, h, d]} radius={0.022} smoothness={3} castShadow receiveShadow>
          <meshStandardMaterial color="#0d1e3a" emissive={em} emissiveIntensity={ei} roughness={0.38} metalness={0.16} />
        </RoundedBox>
        {/* Blue accent stripe on top */}
        <mesh position={[0, h/2+0.003, 0]}>
          <boxGeometry args={[w*0.78, 0.005, d*0.78]} />
          <meshStandardMaterial color="#1d4ed8" roughness={0.3} metalness={0.2} emissive="#1d4ed8" emissiveIntensity={0.15} />
        </mesh>
        {/* Front face label */}
        <mesh position={[0, 0, d/2+0.004]}>
          <boxGeometry args={[w*0.8, h*0.7, 0.005]} />
          <meshStandardMaterial color="#0a1628" roughness={0.25} metalness={0.2} />
        </mesh>
        {/* Encoder disc on side (X+) — large visible disc */}
        <mesh position={[w/2+0.005, 0, 0]} rotation={[0, Math.PI/2, 0]}>
          <cylinderGeometry args={[h*0.44, h*0.44, 0.01, 32]} />
          <meshStandardMaterial color="#1a2a3a" roughness={0.2} metalness={0.42} />
        </mesh>
        {/* Encoder marks on disc */}
        {Array.from({length:spokeN},(_,i)=>{
          const ang=(i/spokeN)*Math.PI*2;
          return <mesh key={i} position={[w/2+0.012, Math.sin(ang)*h*0.3, Math.cos(ang)*h*0.3]} rotation={[0,Math.PI/2,ang]}>
            <boxGeometry args={[0.006, 0.055, 0.012]}/>
            <meshStandardMaterial color="#c8d4e0" roughness={0.15} metalness={0.8}/>
          </mesh>;
        })}
        {/* Central shaft — protruding square axle */}
        <mesh position={[w/2+0.038, 0, 0]} rotation={[0, Math.PI/2, 0]}>
          <cylinderGeometry args={[0.042, 0.042, 0.065, 4]} />
          <meshStandardMaterial color="#aab4c0" {...MAT.steel} />
        </mesh>
        {/* Smart port — red housing */}
        <group position={[0, -h/2-0.022, 0]}>
          <mesh><boxGeometry args={[w*0.56, 0.044, 0.18]}/><meshStandardMaterial color="#8b1010" roughness={0.42} metalness={0.15}/></mesh>
          <mesh position={[0,0.012,0]}><boxGeometry args={[w*0.36, 0.018, 0.1]}/><meshStandardMaterial color="#020204" roughness={0.9}/></mesh>
        </group>
      </group>
    );
  }

  // ── Vision Sensor ─────────────────────────────────────────────────────────
  if (partDef.id === "vision") {
    const [w, h, d] = partDef.scale;
    return (
      <group>
        {/* Wide dark body */}
        <RoundedBox args={[w, h, d]} radius={0.03} smoothness={4} castShadow receiveShadow>
          <meshStandardMaterial color="#0a1222" emissive={em} emissiveIntensity={ei} roughness={0.36} metalness={0.18} />
        </RoundedBox>
        {/* Front camera face plate */}
        <mesh position={[0, 0, d/2+0.004]}>
          <boxGeometry args={[w*0.94, h*0.9, 0.006]} />
          <meshStandardMaterial color="#060e1a" roughness={0.18} metalness={0.28} />
        </mesh>
        {/* Dual camera lenses with bezel ring */}
        {[-w*0.2, w*0.2].map((x,i) => (
          <group key={i} position={[x, h*0.06, d/2+0.006]}>
            {/* Outer bezel */}
            <mesh rotation={[Math.PI/2,0,0]}>
              <torusGeometry args={[0.075, 0.018, 8, 22]} />
              <meshStandardMaterial color="#151f2e" roughness={0.22} metalness={0.45} />
            </mesh>
            {/* Lens glass */}
            <mesh position={[0,0,0.006]}>
              <cylinderGeometry args={[0.055, 0.055, 0.007, 22]} rotation={[Math.PI/2,0,0]}/>
              <meshStandardMaterial color="#020810" roughness={0.02} metalness={0.0} emissive="#040c28" emissiveIntensity={0.55} />
            </mesh>
            {/* Lens highlight */}
            <mesh position={[0.015,-0.015,0.01]}>
              <circleGeometry args={[0.016, 8]}/>
              <meshStandardMaterial color="#3060a0" roughness={0.0} metalness={0.0} emissive="#3060a0" emissiveIntensity={0.8} transparent opacity={0.6}/>
            </mesh>
          </group>
        ))}
        {/* Status LED bar — top */}
        <mesh position={[0, h/2+0.004, d*0.1]}>
          <boxGeometry args={[w*0.5, 0.008, 0.04]} />
          <meshStandardMaterial color="#00aaff" emissive="#0088cc" emissiveIntensity={0.6} roughness={0.1}/>
        </mesh>
        {/* Corner mounting holes */}
        {[[-w*0.4,-h*0.32],[w*0.4,-h*0.32],[-w*0.4,h*0.32],[w*0.4,h*0.32]].map(([x,y],i)=>(
          <mesh key={i} position={[x,y,d/2+0.001]}><circleGeometry args={[0.024,10]}/><meshStandardMaterial color="#050508" roughness={0.9}/></mesh>
        ))}
        {/* Smart port — red housing */}
        <group position={[0, -h/2-0.022, 0]}>
          <mesh><boxGeometry args={[w*0.56, 0.044, 0.18]}/><meshStandardMaterial color="#8b1010" roughness={0.42} metalness={0.15}/></mesh>
          <mesh position={[0,0.012,0]}><boxGeometry args={[w*0.36, 0.018, 0.1]}/><meshStandardMaterial color="#020204" roughness={0.9}/></mesh>
        </group>
      </group>
    );
  }

  // ── Limit Switch ──────────────────────────────────────────────────────────
  if (partDef.id === "limit") {
    const [w, h, d] = partDef.scale;
    return (
      <group>
        {/* Body — deep red like actual VEX limit switch */}
        <RoundedBox args={[w, h, d]} radius={0.014} smoothness={3} castShadow receiveShadow>
          <meshStandardMaterial color="#7f1010" emissive={em} emissiveIntensity={ei} roughness={0.45} metalness={0.08} />
        </RoundedBox>
        {/* Front face panel */}
        <mesh position={[0, 0, d/2+0.003]}>
          <boxGeometry args={[w*0.86, h*0.82, 0.005]}/>
          <meshStandardMaterial color="#6a0c0c" roughness={0.4} metalness={0.05}/>
        </mesh>
        {/* Button actuator on front face — raised dome */}
        <mesh position={[0, h*0.1, d/2+0.012]}>
          <sphereGeometry args={[0.045, 14, 10, 0, Math.PI*2, 0, Math.PI*0.55]}/>
          <meshStandardMaterial color="#c0c0c8" roughness={0.28} metalness={0.35}/>
        </mesh>
        {/* Button rim */}
        <mesh position={[0, h*0.1, d/2+0.007]} rotation={[Math.PI/2,0,0]}>
          <torusGeometry args={[0.042, 0.009, 8, 18]}/>
          <meshStandardMaterial color="#888898" roughness={0.35} metalness={0.4}/>
        </mesh>
        {/* Lever arm — chrome steel */}
        <mesh position={[0, h/2+0.06, d*0.12]} rotation={[0.35, 0, 0]}>
          <boxGeometry args={[w*0.65, 0.015, 0.18]}/>
          <meshStandardMaterial color="#a0a8b0" {...MAT.steel}/>
        </mesh>
        {/* Roller at tip of lever */}
        <mesh position={[0, h/2+0.1, d*0.3]} rotation={[Math.PI/2,0,0]}>
          <cylinderGeometry args={[0.024, 0.024, w*0.55, 14]}/>
          <meshStandardMaterial color="#606068" roughness={0.55} metalness={0.5}/>
        </mesh>
        {/* Corner mounting holes */}
        {[[-w*0.38,-h*0.3],[w*0.38,-h*0.3]].map(([x,y],i)=>(
          <mesh key={i} position={[x,y,d/2+0.001]}>
            <circleGeometry args={[0.02,10]}/>
            <meshStandardMaterial color="#3a0808" roughness={0.8}/>
          </mesh>
        ))}
        {/* 3-wire ADI port — yellow housing */}
        <group position={[0, -h/2-0.018, 0]}>
          <mesh><boxGeometry args={[0.10, 0.036, 0.15]}/><meshStandardMaterial color="#c8a000" roughness={0.45} metalness={0.1}/></mesh>
          <mesh position={[0,0.01,0]}><boxGeometry args={[0.072, 0.016, 0.09]}/><meshStandardMaterial color="#020204" roughness={0.9}/></mesh>
        </group>
      </group>
    );
  }

  // ── GPS Sensor ────────────────────────────────────────────────────────────
  if (partDef.id === "gps") {
    const [w, h, d] = partDef.scale;
    return (
      <group>
        {/* Body — teal-navy */}
        <RoundedBox args={[w, h, d]} radius={0.026} smoothness={4} castShadow receiveShadow>
          <meshStandardMaterial color="#0a1c2e" emissive={em} emissiveIntensity={ei} roughness={0.36} metalness={0.16} />
        </RoundedBox>
        {/* Front face plate */}
        <mesh position={[0, 0, d/2+0.004]}>
          <boxGeometry args={[w*0.9, h*0.88, 0.006]}/>
          <meshStandardMaterial color="#0c1e30" roughness={0.22} metalness={0.2}/>
        </mesh>
        {/* Camera / sensor window — frosted blue glass */}
        <mesh position={[0, h*0.08, d/2+0.009]}>
          <boxGeometry args={[w*0.58, h*0.48, 0.006]}/>
          <meshStandardMaterial color="#1a4a6a" roughness={0.06} metalness={0.0} transparent opacity={0.72} emissive="#0a2a40" emissiveIntensity={0.2}/>
        </mesh>
        {/* Grid lines across sensor window — horizontal */}
        {[-1,0,1].map(r=>(
          <mesh key={r} position={[0, h*0.08 + r*h*0.13, d/2+0.012]}>
            <boxGeometry args={[w*0.56, 0.005, 0.003]}/>
            <meshStandardMaterial color="#2090c0" roughness={0.1} emissive="#1070a0" emissiveIntensity={0.3}/>
          </mesh>
        ))}
        {/* Grid lines — vertical */}
        {[-1,0,1].map(c=>(
          <mesh key={c} position={[c*w*0.16, h*0.08, d/2+0.012]}>
            <boxGeometry args={[0.004, h*0.46, 0.003]}/>
            <meshStandardMaterial color="#2090c0" roughness={0.1} emissive="#1070a0" emissiveIntensity={0.3}/>
          </mesh>
        ))}
        {/* Crosshair center dot */}
        <mesh position={[0, h*0.08, d/2+0.013]}>
          <cylinderGeometry args={[0.018, 0.018, 0.005, 10]}/>
          <meshStandardMaterial color="#40d0ff" emissive="#20b0e0" emissiveIntensity={0.7} roughness={0.1}/>
        </mesh>
        {/* Status LEDs — front face bottom strip */}
        {[-1,0,1].map(i=>(
          <mesh key={i} position={[i*w*0.22, -h*0.35, d/2+0.009]}>
            <cylinderGeometry args={[0.013,0.013,0.006,8]}/>
            <meshStandardMaterial
              color={i===0?"#00ff88":i===-1?"#0088ff":"#ff8800"}
              emissive={i===0?"#00cc66":i===-1?"#0055cc":"#cc6600"}
              emissiveIntensity={0.75} roughness={0.1}/>
          </mesh>
        ))}
        {/* Corner mounting holes */}
        {[[-w*0.4,-h*0.38],[w*0.4,-h*0.38],[-w*0.4,h*0.38],[w*0.4,h*0.38]].map(([x,y],i)=>(
          <mesh key={i} position={[x,y,d/2+0.001]}>
            <circleGeometry args={[0.022,10]}/>
            <meshStandardMaterial color="#050810" roughness={0.9}/>
          </mesh>
        ))}
        {/* Smart port — red housing */}
        <group position={[0, -h/2-0.022, 0]}>
          <mesh><boxGeometry args={[w*0.56, 0.044, 0.18]}/><meshStandardMaterial color="#8b1010" roughness={0.42} metalness={0.15}/></mesh>
          <mesh position={[0,0.012,0]}><boxGeometry args={[w*0.36, 0.018, 0.1]}/><meshStandardMaterial color="#020204" roughness={0.9}/></mesh>
        </group>
      </group>
    );
  }

  // ── Air Reservoir (pneumatic tank) ────────────────────────────────────────
  if (partDef.id === "pneu-tank") {
    const [r,,h] = partDef.scale;
    return (
      <group>
        <mesh castShadow receiveShadow>
          <cylinderGeometry args={[r, r, h*0.88, 20]} />
          <meshStandardMaterial color="#3a4a5a" emissive={em} emissiveIntensity={ei} roughness={0.22} metalness={0.88} />
        </mesh>
        {/* End caps */}
        {[-1,1].map(s=>(
          <mesh key={s} position={[0, s*h*0.46, 0]} castShadow>
            <cylinderGeometry args={[r*0.88, r*0.88, h*0.06, 20]}/>
            <meshStandardMaterial color="#2a3848" roughness={0.18} metalness={0.92}/>
          </mesh>
        ))}
        {/* Pressure fitting */}
        <mesh position={[0, h*0.49, 0]}>
          <cylinderGeometry args={[r*0.28, r*0.22, h*0.06, 10]}/>
          <meshStandardMaterial color="#b0b8c0" {...MAT.steel}/>
        </mesh>
      </group>
    );
  }

  // ── Solenoid Valve ────────────────────────────────────────────────────────
  if (partDef.id === "solenoid") {
    const [w, h, d] = partDef.scale;
    const coilRings = 6;
    return (
      <group>
        {/* Main valve body — dark machined aluminum */}
        <mesh castShadow receiveShadow>
          <boxGeometry args={[w, h*0.62, d]}/>
          <meshStandardMaterial color="#1c2430" emissive={em} emissiveIntensity={ei} roughness={0.22} metalness={0.82}/>
        </mesh>
        {/* Solenoid coil housing — black cylinder on top */}
        <mesh position={[0, h*0.22, 0]} castShadow>
          <cylinderGeometry args={[w*0.34, w*0.34, h*0.48, 20]}/>
          <meshStandardMaterial color="#0d0d0d" roughness={0.42} metalness={0.35}/>
        </mesh>
        {/* Coil winding rings — visible copper coil detail */}
        {Array.from({length:coilRings},(_,i)=>{
          const y = -h*0.08 + i*(h*0.38/coilRings);
          return (
            <mesh key={i} position={[0, y, 0]} rotation={[Math.PI/2,0,0]}>
              <torusGeometry args={[w*0.34, 0.008, 6, 22]}/>
              <meshStandardMaterial color="#b87333" roughness={0.28} metalness={0.55} emissive="#8b5a20" emissiveIntensity={0.12}/>
            </mesh>
          );
        })}
        {/* Coil top cap */}
        <mesh position={[0, h*0.45, 0]}>
          <cylinderGeometry args={[w*0.3, w*0.3, 0.022, 16]}/>
          <meshStandardMaterial color="#181818" roughness={0.55}/>
        </mesh>
        {/* Port fittings — front face (Z+) barbed fittings */}
        {[-1,1].map(s=>(
          <group key={s} position={[s*w*0.28, -h*0.14, d/2]}>
            <mesh rotation={[Math.PI/2,0,0]}>
              <cylinderGeometry args={[0.026, 0.032, 0.065, 10]}/>
              <meshStandardMaterial color="#c8d0d8" {...MAT.steel}/>
            </mesh>
            {/* Barb rings */}
            {[0,1].map(r=>(
              <mesh key={r} position={[0, 0, 0.015+r*0.022]} rotation={[Math.PI/2,0,0]}>
                <torusGeometry args={[0.028, 0.007, 6, 12]}/>
                <meshStandardMaterial color="#a0a8b0" {...MAT.steel}/>
              </mesh>
            ))}
          </group>
        ))}
        {/* Exhaust port — center back face small fitting */}
        <mesh position={[0, -h*0.14, -d/2-0.028]} rotation={[Math.PI/2,0,0]}>
          <cylinderGeometry args={[0.018, 0.018, 0.055, 8]}/>
          <meshStandardMaterial color="#909090" {...MAT.steel}/>
        </mesh>
        {/* Mounting bolt holes — bottom face sides */}
        {[-1,1].map(s=>(
          <mesh key={s} position={[s*w*0.34, -h*0.35, 0]} rotation={[0,0,0]}>
            <cylinderGeometry args={[0.018, 0.018, h*0.08, 8]}/>
            <meshStandardMaterial color="#080810" roughness={0.9}/>
          </mesh>
        ))}
        {/* 3-wire ADI port — yellow housing, bottom */}
        <group position={[0, -h/2-0.018, 0]}>
          <mesh><boxGeometry args={[0.10, 0.036, 0.15]}/><meshStandardMaterial color="#c8a000" roughness={0.45} metalness={0.1}/></mesh>
          <mesh position={[0,0.010,0]}><boxGeometry args={[0.072, 0.016, 0.09]}/><meshStandardMaterial color="#020204" roughness={0.9}/></mesh>
        </group>
      </group>
    );
  }

  // ── Pneumatic Cylinder ────────────────────────────────────────────────────
  if (partDef.id === "pneu-cyl") {
    const [r,,h] = partDef.scale;
    return (
      <group>
        {/* Body */}
        <mesh position={[0, -h*0.12, 0]} castShadow>
          <cylinderGeometry args={[r, r, h*0.75, 16]}/>
          <meshStandardMaterial color="#3c4a5a" emissive={em} emissiveIntensity={ei} roughness={0.24} metalness={0.82}/>
        </mesh>
        {/* Piston rod */}
        <mesh position={[0, h*0.32, 0]} castShadow>
          <cylinderGeometry args={[r*0.4, r*0.4, h*0.5, 12]}/>
          <meshStandardMaterial color="#d0d8e0" roughness={0.08} metalness={0.95}/>
        </mesh>
        {/* End cap */}
        <mesh position={[0, -h*0.5, 0]}>
          <cylinderGeometry args={[r*0.9, r*0.9, h*0.06, 16]}/>
          <meshStandardMaterial color="#2a3848" roughness={0.2} metalness={0.9}/>
        </mesh>
        {/* Clevis mount */}
        <mesh position={[0, h*0.55, 0]}>
          <boxGeometry args={[r*1.5, h*0.06, r*1.5]}/>
          <meshStandardMaterial color="#b0b8c0" {...MAT.steel}/>
        </mesh>
      </group>
    );
  }

  // ── Pneumatic Tubing ──────────────────────────────────────────────────────
  if (partDef.id === "tubing") {
    const [r,,h] = partDef.scale;
    return (
      <mesh castShadow>
        <cylinderGeometry args={[r, r, h, 8]}/>
        <meshStandardMaterial color="#e8eef4" emissive={em} emissiveIntensity={ei} roughness={0.5} metalness={0.0} transparent opacity={0.85}/>
      </mesh>
    );
  }

  // ── Flat Plate (small variant) ────────────────────────────────────────────
  if (partDef.id === "flatplate-s") {
    const [w, h, d] = partDef.scale;
    const cols = 5, rows = 2; const hR = 0.068;
    const holeCol = "#06080e"; const rimCol = "#dce6f0";
    return (
      <group>
        <mesh castShadow receiveShadow>
          <boxGeometry args={[w, h, d]} />
          <meshStandardMaterial color="#bec8d0" emissive={em} emissiveIntensity={ei} {...MAT.aluminum} />
        </mesh>
        {Array.from({length:rows*cols},(_,idx)=>{
          const row=Math.floor(idx/cols), col=idx%cols;
          const px=-w*0.42+col*(w*0.84/(cols-1));
          const pz=-d*0.38+row*(d*0.76/(rows-1));
          return (
            <group key={idx} position={[px, h/2+0.001, pz]}>
              <mesh rotation={[-Math.PI/2,0,0]}><circleGeometry args={[hR*1.28,14]}/><meshStandardMaterial color={rimCol} roughness={0.08} metalness={0.92}/></mesh>
              <mesh rotation={[-Math.PI/2,0,0]} position={[0,0,0.001]}><circleGeometry args={[hR,14]}/><meshStandardMaterial color={holeCol} roughness={0.95}/></mesh>
            </group>
          );
        })}
      </group>
    );
  }

  // ── Default: remaining box parts ──────────────────────────────────────────
  if (partDef.geo === "box") {
    return (
      <mesh castShadow receiveShadow>
        <boxGeometry args={partDef.scale} />
        <meshStandardMaterial color={c || "#a0b0c0"} emissive={em} emissiveIntensity={ei} {...MAT.aluminum} />
      </mesh>
    );
  }
  return (
    <mesh castShadow receiveShadow>
      <cylinderGeometry args={[partDef.scale[0], partDef.scale[1], partDef.scale[2], 32]} />
      <meshStandardMaterial color={c} emissive={em} emissiveIntensity={ei} roughness={0.35} metalness={0.6} />
    </mesh>
  );
}

// Snap increment — matches the 0.5" VEX hole grid
const SNAP = 0.5;

// 3D part mesh — click to select, drag to reposition (snaps to 0.5" grid)
function VexPart({ partDef, position, rotation, isSelected, onSelect, onMove, snapGridRef }) {
  const [hovered, setHovered] = React.useState(false);
  const dragRef   = useRef(false);  // true while a drag is in progress
  const { controls, gl, camera } = useThree();

  // For cylinders rotated onto their side (rx or rz near ±90°), radius becomes the Y extent
  const [_rx, , _rz] = rotation || [0, 0, 0];
  const _tipped = partDef.geo === "cylinder" && (Math.abs(Math.sin(_rz)) > 0.7 || Math.abs(Math.sin(_rx)) > 0.7);
  const groundY = _tipped ? partDef.scale[0]
    : (partDef.geo === "box" ? partDef.scale[1] : partDef.scale[2]) / 2;
  const rc      = React.useMemo(() => new THREE.Raycaster(), []);

  const em  = isSelected ? "#1a6fff" : hovered ? "#4a6888" : "#000000";
  const ei  = isSelected ? 0.28      : hovered ? 0.10      : 0;
  const lbY = groundY + 0.38;

  const handlePointerDown = (e) => {
    // Allow drag even on first click — select immediately then start drag
    e.stopPropagation();
    if (!isSelected) onSelect();       // select on first touch
    if (controls) controls.enabled = false;  // freeze orbit while dragging

    const canvas   = gl.domElement;
    const isYDrag  = e.shiftKey;
    const startPos = [...position];    // capture position snapshot at drag start

    const handleUp = (moveHandler) => () => {
      if (controls) controls.enabled = true;
      document.body.style.cursor = "auto";
      canvas.removeEventListener("pointermove", moveHandler);
      canvas.removeEventListener("pointerup",   handleUp(moveHandler));
      setTimeout(() => { dragRef.current = false; }, 0);
    };

    if (isYDrag) {
      // ── Shift+drag: move vertically (Y-axis only) ──────────
      const startMouseY = e.clientY;
      const onMove_ = (evt) => {
        dragRef.current = true;
        const dy   = (startMouseY - evt.clientY) * 0.015;   // px → world units
        const newY = Math.max(groundY, startPos[1] + dy);
        onMove([startPos[0], newY, startPos[2]]);            // keep X/Z fixed
        document.body.style.cursor = "ns-resize";
      };
      const onUp_ = () => {
        if (controls) controls.enabled = true;
        document.body.style.cursor = "auto";
        canvas.removeEventListener("pointermove", onMove_);
        canvas.removeEventListener("pointerup",   onUp_);
        setTimeout(() => { dragRef.current = false; }, 0);
      };
      canvas.addEventListener("pointermove", onMove_);
      canvas.addEventListener("pointerup",   onUp_);
    } else {
      // ── Normal drag: move on a horizontal plane at part's current height ──
      // Cast rays against a plane at startPos[1] so elevated parts stay elevated.
      const elevPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -startPos[1]);
      const elevHit   = new THREE.Vector3();
      const onMove_ = (evt) => {
        dragRef.current = true;
        const rect = canvas.getBoundingClientRect();
        const nx   = ((evt.clientX - rect.left) / rect.width)  * 2 - 1;
        const ny   = -((evt.clientY - rect.top)  / rect.height) * 2 + 1;
        rc.setFromCamera({ x: nx, y: ny }, camera);
        if (rc.ray.intersectPlane(elevPlane, elevHit)) {
          const useSnap = snapGridRef ? snapGridRef.current : true;
          const sx = useSnap ? Math.round(elevHit.x / SNAP) * SNAP : elevHit.x;
          const sz = useSnap ? Math.round(elevHit.z / SNAP) * SNAP : elevHit.z;
          onMove([sx, startPos[1], sz]);                     // keep Y from drag start
        }
        document.body.style.cursor = "grabbing";
      };
      const onUp_ = () => {
        if (controls) controls.enabled = true;
        document.body.style.cursor = "auto";
        canvas.removeEventListener("pointermove", onMove_);
        canvas.removeEventListener("pointerup",   onUp_);
        setTimeout(() => { dragRef.current = false; }, 0);
      };
      canvas.addEventListener("pointermove", onMove_);
      canvas.addEventListener("pointerup",   onUp_);
    }
  };

  return (
    <group
      position={position}
      rotation={rotation || [0, 0, 0]}
      onClick={(e) => { e.stopPropagation(); if (!dragRef.current) onSelect(); }}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHovered(true);
        document.body.style.cursor = isSelected ? "grab" : "pointer";
      }}
      onPointerOut={() => {
        setHovered(false);
        if (!dragRef.current) document.body.style.cursor = "auto";
      }}
      onPointerDown={handlePointerDown}
    >
      <SmartPart partDef={partDef} emissiveColor={em} emissiveIntensity={ei} />
      {/* Label only visible on hover or when selected — prevents scene clutter */}
      {(hovered || isSelected) && (
        <Text
          position={[0, lbY, 0]}
          fontSize={0.17}
          color={isSelected ? "#2563eb" : "#1e293b"}
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.014}
          outlineColor="#ffffff"
          outlineOpacity={0.92}
        >
          {partDef.label}
        </Text>
      )}
    </group>
  );
}

// Stable shader-based floor — single opaque mesh, no z-fighting possible
// Grid lines baked into the shader alongside the floor colour
function StableFloor({ onDeselect }) {
  const mat = React.useMemo(() => new THREE.ShaderMaterial({
    side: THREE.DoubleSide,   // visible from both above and below
    uniforms: { uFade: { value: 88.0 } },
    vertexShader: `
      varying vec3 vW;
      void main() {
        vW = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uFade;
      varying vec3 vW;
      float gLine(vec2 p, float s) {
        vec2 c = p / s;
        vec2 g = abs(fract(c - 0.5) - 0.5) / fwidth(c);
        return 1.0 - clamp(min(g.x, g.y), 0.0, 1.0);
      }
      void main() {
        float dist = length(vW.xz);
        float fade = 1.0 - smoothstep(uFade * 0.38, uFade, dist);
        float minor = gLine(vW.xz, 0.5);
        float major = gLine(vW.xz, 2.5);
        // Dark studio floor
        vec3 col = vec3(0.058, 0.078, 0.110);
        // Minor grid lines — visible steel blue
        col = mix(col, vec3(0.18, 0.26, 0.42), minor * 0.85 * fade);
        // Major grid lines — bright blue accent
        col = mix(col, vec3(0.28, 0.52, 0.92), major * 1.0 * fade);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  }), []);

  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, 0, 0]}
      onClick={onDeselect}
      receiveShadow
    >
      <planeGeometry args={[600, 600]} />
      <primitive object={mat} attach="material" />
    </mesh>
  );
}

// Lives inside the Canvas — resets camera position when `trigger` increments
function CameraReset({ trigger }) {
  const { camera, controls } = useThree();
  React.useEffect(() => {
    if (!trigger) return;  // skip the initial mount (trigger = 0)
    camera.position.set(7, 5, 9);
    if (controls) { controls.target.set(0, 0, 0); controls.update(); }
  }, [trigger, camera, controls]);
  return null;
}

function CAD() {
  const { update: storeUpdate } = useStore();
  const categories = ["Structure", "Drive", "Electronics", "Sensors", "Pneumatics"];
  const [activeCategory, setActiveCategory] = useState("Structure");
  const [placedParts, setPlacedParts] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [panelTab, setPanelTab] = useState("scene");
  const [snapGrid, setSnapGrid] = useState(true);   // snap drag to 0.5" grid
  const [snapFace, setSnapFace] = useState(false);  // snap to adjacent part faces
  const [camReset, setCamReset] = useState(0);      // increment to trigger camera reset
  const counterRef = useRef(0);

  // Track CAD session on mount
  React.useEffect(() => {
    storeUpdate(s => {
      let next = { ...s, cadSessions: (s.cadSessions||0) + 1 };
      next = pushActivity(next, "Opened", "CAD Design Studio", "#3b82f6");
      return next;
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredParts = VEX_PARTS.filter(p => p.category === activeCategory);
  const selectedPart = placedParts.find(p => p.uid === selectedId);

  const addPart = (partDef) => {
    const uid = `${partDef.id}-${counterRef.current++}`;
    const spread = 3;
    const x = Math.round(((Math.random() - 0.5) * spread) / SNAP) * SNAP;
    const z = Math.round(((Math.random() - 0.5) * spread) / SNAP) * SNAP;
    const sr = partDef.spawnRot;
    const y = (sr && partDef.geo === "cylinder")
      ? partDef.scale[0]
      : (partDef.geo === "box" ? partDef.scale[1] : partDef.scale[2]) / 2;
    const rotation = sr ? [...sr] : [0, 0, 0];
    setPlacedParts(prev => [...prev, { uid, partDef, position: [x, y, z], rotation }]);
    setSelectedId(uid);
    // Track in store
    storeUpdate(s => {
      let next = { ...s, cadPartsPlaced: (s.cadPartsPlaced||0) + 1 };
      // Only log activity every 5th part to avoid spam
      if (next.cadPartsPlaced % 5 === 0 || next.cadPartsPlaced === 1) {
        next = pushActivity(next, "Added", `${partDef.label} in CAD (${next.cadPartsPlaced} total)`, "#3b82f6");
      }
      return next;
    });
  };

  const deleteSelected = useCallback(() => {
    setPlacedParts(prev => prev.filter(p => p.uid !== selectedId));
    setSelectedId(null);
  }, [selectedId]);

  const resetScene = () => {
    setPlacedParts([]);
    setSelectedId(null);
  };

  // Keep a live ref so the drag closure can read latest positions without stale state
  const placedPartsRef = useRef([]);
  React.useEffect(() => { placedPartsRef.current = placedParts; }, [placedParts]);

  // Snap dragged part to the face of any nearby part (≤ FACE_THRESH world units gap).
  // Returns the snapped position, or the original if nothing is close enough.
  const FACE_THRESH = 0.45;
  const snapToFace = useCallback((uid, proposed) => {
    const all = placedPartsRef.current;
    const dragged = all.find(p => p.uid === uid);
    if (!dragged) return proposed;

    // Half-extents of the dragged part (ignoring rotation for simplicity)
    const ds  = dragged.partDef.scale;
    const dg  = dragged.partDef.geo;
    const dhx = dg === "box" ? ds[0] / 2 : ds[0];
    const dhy = dg === "box" ? ds[1] / 2 : ds[2] / 2;
    const dhz = dg === "box" ? ds[2] / 2 : ds[0];

    let best = null, bestD = FACE_THRESH;

    for (const other of all) {
      if (other.uid === uid) continue;
      const os  = other.partDef.scale;
      const og  = other.partDef.geo;
      const ohx = og === "box" ? os[0] / 2 : os[0];
      const ohy = og === "box" ? os[1] / 2 : os[2] / 2;
      const ohz = og === "box" ? os[2] / 2 : os[0];
      const [ox, oy, oz] = other.position;
      const [px, py, pz] = proposed;

      // Alignment guards — the two parts must overlap or nearly overlap on
      // the two axes perpendicular to the face being checked.
      const xOvlp = Math.abs(px - ox) < (dhx + ohx) * 1.5;
      const yOvlp = Math.abs(py - oy) < (dhy + ohy) * 1.5;
      const zOvlp = Math.abs(pz - oz) < (dhz + ohz) * 1.5;

      const candidates = [
        // ── X faces ──
        { gap: Math.abs((px + dhx) - (ox - ohx)), snapped: [ox - ohx - dhx, py, pz], ok: yOvlp && zOvlp },
        { gap: Math.abs((px - dhx) - (ox + ohx)), snapped: [ox + ohx + dhx, py, pz], ok: yOvlp && zOvlp },
        // ── Z faces ──
        { gap: Math.abs((pz + dhz) - (oz - ohz)), snapped: [px, py, oz - ohz - dhz], ok: xOvlp && yOvlp },
        { gap: Math.abs((pz - dhz) - (oz + ohz)), snapped: [px, py, oz + ohz + dhz], ok: xOvlp && yOvlp },
        // ── Y face (stack on top) ──
        { gap: Math.abs((py - dhy) - (oy + ohy)), snapped: [px, oy + ohy + dhy, pz], ok: xOvlp && zOvlp },
      ];

      for (const c of candidates) {
        if (c.ok && c.gap < bestD) { bestD = c.gap; best = c.snapped; }
      }
    }
    return best ?? proposed;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // snapGridRef / snapFaceRef so drag closures always see latest toggle state
  const snapGridRef = useRef(true);
  const snapFaceRef = useRef(false);
  React.useEffect(() => { snapGridRef.current = snapGrid; }, [snapGrid]);
  React.useEffect(() => { snapFaceRef.current = snapFace; }, [snapFace]);

  const movePartTo = useCallback((uid, newPos) => {
    const pos = snapFaceRef.current ? snapToFace(uid, newPos) : newPos;
    setPlacedParts(prev => prev.map(p => p.uid === uid ? { ...p, position: pos } : p));
  }, [snapToFace]);

  // Rotate selected part on a given axis by delta radians
  const rotateAxis = useCallback((axis, delta) => {
    setPlacedParts(prev => prev.map(p => {
      if (p.uid !== selectedId) return p;
      const rot = p.rotation ? [...p.rotation] : [0, 0, 0];
      rot[axis] = rot[axis] + delta;
      return { ...p, rotation: rot };
    }));
  }, [selectedId]);

  // Move selected part by a grid step on a given axis
  const nudgePart = useCallback((axis, dir) => {
    setPlacedParts(prev => prev.map(p => {
      if (p.uid !== selectedId) return p;
      const pos = [...p.position];
      if (axis === 1) {
        // Y axis — small increments, clamp to ground
        const [nrx, , nrz] = p.rotation || [0, 0, 0];
        const ntipped = p.partDef.geo === "cylinder" && (Math.abs(Math.sin(nrz)) > 0.7 || Math.abs(Math.sin(nrx)) > 0.7);
        const groundY = ntipped ? p.partDef.scale[0]
          : (p.partDef.geo === "box" ? p.partDef.scale[1] : p.partDef.scale[2]) / 2;
        pos[1] = Math.max(groundY, pos[1] + dir * 0.1);
      } else {
        const step = snapGridRef.current ? SNAP : 0.05;
        pos[axis] = snapGridRef.current
          ? Math.round((pos[axis] + dir * step) / step) * step
          : pos[axis] + dir * step;
      }
      return { ...p, position: pos };
    }));
  }, [selectedId]);

  // Keyboard shortcuts
  React.useEffect(() => {
    const handleKey = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (!selectedId) return;

      // Rotation — R/X/Z keys
      if (e.key === "r" || e.key === "R") { e.preventDefault(); rotateAxis(1, e.shiftKey ? -Math.PI/2 : Math.PI/2); return; }
      if (e.key === "x" || e.key === "X") { e.preventDefault(); rotateAxis(0, e.shiftKey ? -Math.PI/2 : Math.PI/2); return; }
      if (e.key === "z" || e.key === "Z") { e.preventDefault(); rotateAxis(2, e.shiftKey ? -Math.PI/2 : Math.PI/2); return; }

      // Delete
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        setPlacedParts(prev => prev.filter(p => p.uid !== selectedId));
        setSelectedId(null);
        return;
      }

      // Arrow keys — XZ movement; Shift+Arrow = Y movement
      if (e.key === "ArrowLeft")  { e.preventDefault(); e.shiftKey ? nudgePart(1, -1) : nudgePart(0, -1); }
      if (e.key === "ArrowRight") { e.preventDefault(); e.shiftKey ? nudgePart(1,  1) : nudgePart(0,  1); }
      if (e.key === "ArrowUp")    { e.preventDefault(); e.shiftKey ? nudgePart(1,  1) : nudgePart(2, -1); }
      if (e.key === "ArrowDown")  { e.preventDefault(); e.shiftKey ? nudgePart(1, -1) : nudgePart(2,  1); }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [selectedId, rotateAxis, nudgePart]);

  return (
    /* Full-viewport canvas with floating overlay panels.
       top offset clears the Apple nav (~66px mobile / ~72px desktop — the nav is
       VoltLogo 38px + py-3.5/4, taller than the old 57/65 assumption, which is
       why the toolbar was hidden under it) — set via classes (style must omit
       `top` so the classes can apply). */
    <div className="top-[66px] lg:top-[72px]"
      style={{ position: "fixed", left: 0, right: 0, bottom: 0, overflow: "hidden", zIndex: 1 }}>

      {/* ══ FULL-SCREEN CANVAS — back layer ══ */}
      <Canvas
        shadows
        camera={{ position: [7, 5, 9], fov: 55 }}
        style={{
          position: "absolute", inset: 0,
          background: "linear-gradient(180deg, #000000 0%, #101012 60%, #1d1d1f 100%)", // theme: Apple graphite ramp
        }}
        gl={{ antialias: true, toneMapping: 2, toneMappingExposure: 1.05 }}
      >
        <Environment preset="apartment" background={false} />

        {/* ── Lighting: dark studio, parts stay bright ── */}
        <ambientLight intensity={1.2} color="#c8d8ff" />
        <directionalLight
          position={[8, 18, 10]} intensity={2.0} color="#ffffff"
          castShadow
          shadow-mapSize={[4096, 4096]}
          shadow-camera-near={0.5} shadow-camera-far={120}
          shadow-camera-left={-30} shadow-camera-right={30}
          shadow-camera-top={30}  shadow-camera-bottom={-30}
          shadow-bias={-0.0002}   shadow-radius={6}
        />
        <directionalLight position={[-8, 8, -4]}  intensity={0.7} color="#c0d4ff" />
        <directionalLight position={[0,  -4, 3]}   intensity={0.28} color="#fff0e0" />

        {/* ── Stable shader grid floor ── */}
        <StableFloor onDeselect={() => setSelectedId(null)} />

        {placedParts.map(p => (
          <VexPart
            key={p.uid}
            partDef={p.partDef}
            position={p.position}
            rotation={p.rotation || [0, 0, 0]}
            isSelected={p.uid === selectedId}
            onSelect={() => setSelectedId(p.uid === selectedId ? null : p.uid)}
            onMove={(pos) => movePartTo(p.uid, pos)}
            snapGridRef={snapGridRef}
          />
        ))}

        {placedParts.length === 0 && (
          <Text
            position={[0, 0.4, 0]} fontSize={0.40} color="#4a90d9"
            anchorX="center" anchorY="middle"
            outlineWidth={0.014} outlineColor="#0a1a2e"
            outlineOpacity={0.9}
          >
            {"← Click a part to add it to the scene"}
          </Text>
        )}

        <CameraReset trigger={camReset} />

        {/* Clamp polar angle so the camera can never go below the floor */}
        <OrbitControls
          makeDefault
          enableDamping
          dampingFactor={0.08}
          minPolarAngle={0.05}
          maxPolarAngle={Math.PI * 0.48}
          minDistance={1.5}
          maxDistance={60}
        />
      </Canvas>

      {/* ══ FLOATING LEFT PANEL ══ */}
      <aside
        className="absolute left-0 top-0 bottom-0 w-52 flex flex-col z-10"
        style={{ background: "rgba(18,18,20,0.90)", backdropFilter: "blur(18px)", borderRight: "1px solid rgba(255,255,255,0.08)" }}
      >
        <div className="px-3 py-3" style={{ borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
          <p className="text-[10px] uppercase tracking-widest text-gray-400 font-bold">VEX Parts</p>
          <p className="text-[10px] text-gray-600 mt-0.5">Click to add to scene</p>
        </div>

        {/* Category list — vertical so every name fits cleanly */}
        <div className="py-1" style={{ borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
          {categories.map(cat => {
            const icons = { Structure: "🔩", Drive: "⚙️", Electronics: "🔌", Sensors: "📡", Pneumatics: "💨" };
            const active = activeCategory === cat;
            return (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className={`w-full text-left flex items-center gap-2 px-3 py-1.5 transition ${
                  active ? "text-white bg-white/8" : "text-gray-500 hover:text-gray-300 hover:bg-white/5"
                }`}
              >
                <span className="text-[11px]">{icons[cat]}</span>
                <span className="text-[11px] font-semibold">{cat}</span>
                {active && <span className="ml-auto w-1 h-4 rounded-full bg-red-500 shrink-0" />}
              </button>
            );
          })}
        </div>

        {/* Part list */}
        <div className="flex-1 overflow-y-auto py-1">
          {filteredParts.map(part => (
            <button
              key={part.id}
              onClick={() => addPart(part)}
              className="w-full text-left px-3 py-2.5 flex items-center gap-2.5 hover:bg-white/6 transition group"
            >
              <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: part.color }} />
              <span className="text-[11px] text-gray-400 group-hover:text-white transition truncate">{part.label}</span>
            </button>
          ))}
        </div>

        <div className="px-3 py-2.5 text-center" style={{ borderTop: "1px solid rgba(255,255,255,0.07)" }}>
          <p className="text-[10px] text-gray-600">{placedParts.length} part{placedParts.length !== 1 ? "s" : ""} in scene</p>
        </div>
      </aside>

      {/* ══ FLOATING TOP BAR ══ (sits a touch below the top edge with a taller
           bar so the title isn't cramped against the nav) */}
      <div
        className="absolute top-3 flex items-center gap-3 px-4 z-10"
        style={{
          left: "13rem", right: "14rem", height: "3.1rem",
          background: "rgba(8,10,16,0.82)", backdropFilter: "blur(14px)",
          borderBottom: "1px solid rgba(255,255,255,0.07)",
        }}
      >
        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-900/60 text-blue-300 shrink-0">3D</span>
        <span className="text-[12px] font-bold text-white shrink-0">VEX Design Studio</span>
        {selectedPart && <span className="text-[11px] text-gray-500 truncate">· {selectedPart.partDef.label}</span>}
        <div className="flex-1" />
        {/* ── Snap toggles ── */}
        <button
          onClick={() => setSnapGrid(v => !v)}
          title="Toggle grid snap (0.5&quot; VEX holes)"
          className={`text-[10px] px-2 py-0.5 rounded border transition shrink-0 ${
            snapGrid
              ? "text-blue-300 border-blue-700 bg-blue-950/60"
              : "text-gray-500 border-white/10 hover:text-gray-300"
          }`}
        >
          Grid {snapGrid ? "ON" : "OFF"}
        </button>
        <button
          onClick={() => setSnapFace(v => !v)}
          title="Toggle face-to-face snapping"
          className={`text-[10px] px-2 py-0.5 rounded border transition shrink-0 ${
            snapFace
              ? "text-emerald-300 border-emerald-700 bg-emerald-950/60"
              : "text-gray-500 border-white/10 hover:text-gray-300"
          }`}
        >
          Face snap {snapFace ? "ON" : "OFF"}
        </button>
        {selectedId && (
          <button onClick={deleteSelected}
            className="text-[11px] text-red-400 hover:text-red-300 px-2.5 py-1 rounded border border-red-900/60 hover:border-red-700 transition shrink-0">
            Del
          </button>
        )}
        <button onClick={() => setCamReset(n => n + 1)}
          className="text-[11px] text-gray-500 hover:text-white px-2.5 py-1 rounded border border-white/10 hover:border-white/30 transition shrink-0"
          title="Reset camera to default view">
          ⌖ View
        </button>
        <button onClick={resetScene}
          className="text-[11px] text-gray-500 hover:text-white px-2.5 py-1 rounded border border-white/10 hover:border-white/30 transition shrink-0">
          Reset
        </button>
      </div>

      {/* ══ FLOATING RIGHT PANEL ══ */}
      <div
        className="absolute right-0 top-0 bottom-0 w-56 flex flex-col z-10"
        style={{ background: "rgba(8,10,16,0.90)", backdropFilter: "blur(18px)", borderLeft: "1px solid rgba(255,255,255,0.07)" }}
      >
        <div className="flex shrink-0" style={{ borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
          {["scene", "help"].map(tab => (
            <button key={tab} onClick={() => setPanelTab(tab)}
              className={`flex-1 py-2.5 text-[11px] font-semibold capitalize transition ${
                panelTab === tab ? "text-white border-b-2 border-red-500" : "text-gray-500 hover:text-gray-300"
              }`}>
              {tab === "scene" ? "Scene" : "Help"}
            </button>
          ))}
        </div>

        {/* ── Transform controls (shown when part selected) ── */}
        {selectedPart && panelTab === "scene" && (() => {
          const rot = selectedPart.rotation || [0,0,0];
          const toDeg = (r) => (((Math.round(r * 180 / Math.PI) % 360) + 360) % 360);
          const btnCls = "flex-1 py-1 text-[11px] rounded transition font-mono hover:bg-white/10 text-gray-300 active:scale-95";
          return (
            <div className="shrink-0 px-3 py-2.5 space-y-2" style={{ borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
              <p className="text-[9px] uppercase tracking-widest text-gray-500 font-bold">Transform · {selectedPart.partDef.label}</p>

              {/* Position nudge */}
              <div>
                <p className="text-[9px] text-gray-600 mb-1">Position (click or arrow keys)</p>
                <div className="grid grid-cols-3 gap-0.5">
                  <div />
                  <button className={btnCls} onClick={() => nudgePart(2, -1)} title="Forward (↑)">▲</button>
                  <div />
                  <button className={btnCls} onClick={() => nudgePart(0, -1)} title="Left (←)">◀</button>
                  <button className={`${btnCls} text-gray-600 text-[9px]`}>XZ</button>
                  <button className={btnCls} onClick={() => nudgePart(0,  1)} title="Right (→)">▶</button>
                  <div />
                  <button className={btnCls} onClick={() => nudgePart(2,  1)} title="Back (↓)">▼</button>
                  <div />
                </div>
                <div className="flex gap-0.5 mt-0.5">
                  <button className={`${btnCls} flex-1`} onClick={() => nudgePart(1, -1)} title="Down (Shift+↓)">↓ Y</button>
                  <button className={`${btnCls} flex-1`} onClick={() => nudgePart(1,  1)} title="Up (Shift+↑)">↑ Y</button>
                </div>
              </div>

              {/* Rotation */}
              <div>
                <p className="text-[9px] text-gray-600 mb-1">Rotation (R/X/Z keys)</p>
                {[["Y (spin)", 1], ["X (tilt)", 0], ["Z (roll)", 2]].map(([label, axis]) => (
                  <div key={axis} className="flex items-center gap-1 mb-0.5">
                    <span className="text-[9px] text-gray-500 w-12 shrink-0">{label}</span>
                    <button className={btnCls} onClick={() => rotateAxis(axis, -Math.PI/2)}>−90°</button>
                    <span className="text-[9px] text-gray-400 w-8 text-center shrink-0">{toDeg(rot[axis])}°</span>
                    <button className={btnCls} onClick={() => rotateAxis(axis,  Math.PI/2)}>+90°</button>
                  </div>
                ))}
              </div>

              {/* Position display */}
              <div className="text-[9px] text-gray-600 font-mono">
                X:{selectedPart.position[0].toFixed(1)} Y:{selectedPart.position[1].toFixed(1)} Z:{selectedPart.position[2].toFixed(1)}
              </div>
            </div>
          );
        })()}

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {panelTab === "scene" ? (
            placedParts.length === 0 ? (
              <p className="text-[11px] text-gray-600 text-center mt-8">No parts added yet.</p>
            ) : (
              placedParts.map(p => (
                <button key={p.uid}
                  onClick={() => setSelectedId(p.uid === selectedId ? null : p.uid)}
                  className={`w-full text-left flex items-center gap-2 px-2.5 py-2 rounded-lg transition text-[11px] ${
                    p.uid === selectedId ? "bg-blue-900/40 text-white" : "hover:bg-white/5 text-gray-400"
                  }`}>
                  <span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: p.partDef.color }} />
                  <span className="flex-1 truncate">{p.partDef.label}</span>
                </button>
              ))
            )
          ) : (
            <div className="space-y-2.5 text-[11px] text-gray-400 leading-relaxed p-1">
              {[
                { t: "Add parts",    b: "Click any part in the sidebar to place it." },
                { t: "Move XZ",      b: "Click a part to select → drag OR use ←↑↓→ arrow keys (0.5\" steps)." },
                { t: "Move Y",       b: "Shift+drag  OR  Shift+↑↓  OR  ↑Y / ↓Y buttons." },
                { t: "Rotate Y",     b: "R = +90°  ·  Shift+R = −90°  ·  (use Y row buttons)" },
                { t: "Rotate X/Z",   b: "X key (tilt)  ·  Z key (roll)  ·  use X/Z row buttons" },
                { t: "Delete",       b: "Delete / Backspace key, or the Delete button above." },
                { t: "Camera",       b: "Drag=orbit  ·  Right-drag=pan  ·  Scroll=zoom." },
                { t: "Motor limit",  b: "VEX V5: 88W power budget (up to 8× 11W motors). Plan wisely!" },
              ].map(({ t, b }, i) => (
                <div key={i} className="pl-2" style={{ borderLeft: "2px solid rgba(185,28,28,0.55)" }}>
                  <p className="text-white font-semibold">{t}</p>
                  <p>{b}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

    </div>
  );
}

// ---------- DASHBOARD ----------

// ── Dashboard config constants ────────────────────────────────────────────
const COMP_TYPES = {
  scrimmage: { label: "Scrimmage", color: "#6b7280" },
  regional:  { label: "Regional",  color: "#3b82f6" },
  state:     { label: "State",     color: "#8b5cf6" },
  worlds:    { label: "Worlds",    color: "#f59e0b" },
};
const PRACTICE_TYPES = {
  driver:   { label: "Driving Skills", color: "#3b82f6" },
  auto:     { label: "Autonomous",     color: "#8b5cf6" },
  build:    { label: "Build Session",  color: "#f59e0b" },
  strategy: { label: "Strategy",       color: "#10b981" },
  full:     { label: "Full Practice",  color: "#ef4444" },
  meeting:  { label: "Team Meeting",   color: "#6b7280" },
};
const GOAL_CATS = {
  competition: { label: "Competition", color: "#3b82f6" },
  skills:      { label: "Skills Run",  color: "#8b5cf6" },
  build:       { label: "Build",       color: "#f59e0b" },
  code:        { label: "Code",        color: "#10b981" },
  team:        { label: "Team",        color: "#06b6d4" },
  other:       { label: "Other",       color: "#6b7280" },
};

// ─────────────────────────────────────────────────────────────────
//  TEAM CHAT — Supabase-backed Discord-style server
// ─────────────────────────────────────────────────────────────────
const CHAT_CHANNELS = [
  { id:"general",     label:"general",     desc:"Team announcements and general chat" },
  { id:"competition", label:"competition", desc:"Tournaments, match results, rankings" },
  { id:"calendar",    label:"calendar",    desc:"Practice schedule and session updates" },
  { id:"build-log",   label:"build-log",   desc:"Robot build progress and CAD work" },
  { id:"notebook",    label:"notebook",    desc:"Engineering notebook and progress tracking" },
];
const CHAT_COLORS = ["#ef4444","#f59e0b","#10b981","#3b82f6","#8b5cf6","#ec4899","#06b6d4","#84cc16"];
// ── Upload & rate limits ──────────────────────────────────────────────────
// MAX_FILE_BYTES, DAILY_UPLOAD_BYTES, SEND_COOLDOWN_MS now live in lib/chatGuards.js
// (pure + unit-tested) and are imported at the top of this file.
// ── Supabase config (hardcoded — publishable key is safe to expose) ──────────
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY;
const OWNER_PIN_HASH = import.meta.env.VITE_OWNER_PIN_HASH;
// Public Google OAuth client id — safe in the client bundle (it's an identifier,
// not a secret). Enables Google One Tap (the inline account-picker popup).
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;

async function checkPin(input) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  return hex === OWNER_PIN_HASH;
}

// ── LiveKit Cloud ─────────────────────────────────────────────────────────
// Replace this with your LiveKit Cloud WebSocket URL after setup
// Get it from: https://cloud.livekit.io → your project → Settings
const LIVEKIT_URL = import.meta.env.VITE_LIVEKIT_URL;

// Module-level Supabase singleton
const sbLog = createLogger("supabase");
let _sbInst = null;
let _sbInitFailed = false;
function getSB() {
  if (_sbInst) return _sbInst;
  if (_sbInitFailed) return null; // don't retry-and-throw on every call
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    _sbInitFailed = true;
    sbLog.error("Supabase not configured — VITE_SUPABASE_URL / VITE_SUPABASE_KEY missing. Chat & dashboard cloud features will be disabled.");
    return null;
  }
  try {
    _sbInst = createSupabaseClient(SUPABASE_URL, SUPABASE_KEY);
    sbLog.info("Supabase client initialized");
  } catch (e) {
    _sbInitFailed = true;
    sbLog.error("Failed to initialize Supabase client", e?.message || e);
  }
  return _sbInst;
}
const isChatReady = () => !!(localStorage.getItem("chat_name") && localStorage.getItem("chat_server_id"));

// ── Visitor analytics ────────────────────────────────────────────────────────
// Records ONE row per browser session into the shared `site_events` table
// (kind:"visit" — visitor UUID + signed-in user id + page, NO IP — see
// lib/analytics.js + SECURITY.md). site_events also holds feedback rows
// (kind:"feedback", see submitFeedback below) — one combined table instead of
// two, split only by the `kind` column and the two read-side RPCs. All guarded:
// if Supabase or the table isn't set up, it logs and no-ops so the app never
// breaks. Owner reads aggregate counts via the get_site_stats() RPC, which
// returns counts only (no raw rows/PII).
const analyticsLog = createLogger("analytics");
async function recordVisit(userId, { force = false } = {}) {
  const sb = getSB();
  if (!sb) return;
  if (!force && !isNewSession()) return; // one visit row per tab-session, unless forced
  try {
    const { error } = await sb.from("site_events").insert({
      kind: "visit",
      visitor_id: getVisitorId(),
      user_id: userId || null,
      path: (typeof location !== "undefined" ? location.pathname : "/") || "/",
    });
    if (error) analyticsLog.warn("visit insert failed (table not set up?)", { msg: error.message });
    else analyticsLog.debug("visit recorded");
  } catch (e) { analyticsLog.warn("visit insert threw", { msg: e?.message }); }
}
async function fetchSiteStats() {
  const sb = getSB();
  if (!sb) return null;
  try {
    const { data, error } = await sb.rpc("get_site_stats");
    if (error) { analyticsLog.warn("get_site_stats failed", { msg: error.message }); return null; }
    // RPC returns a single row of counts.
    return Array.isArray(data) ? data[0] : data;
  } catch (e) { analyticsLog.warn("get_site_stats threw", { msg: e?.message }); return null; }
}

// ── Feedback ────────────────────────────────────────────────────────────────
// Insert a feedback row into the shared site_events table (kind:"feedback";
// see 20260825_site_events.sql). Anyone may submit. Returns true on success.
// Fire-and-forget-safe — never throws to the caller.
async function submitFeedback({ type, message, rating, userId }) {
  const sb = getSB();
  if (!sb) return false;
  try {
    const { error } = await sb.from("site_events").insert({
      kind: "feedback",
      type: type || "other",
      message: String(message || "").slice(0, 2000),
      rating: rating || null,
      user_id: userId || null,
      path: (typeof location !== "undefined" ? location.pathname : "/") || "/",
    });
    if (error) { analyticsLog.warn("feedback insert failed (table not set up?)", { msg: error.message }); return false; }
    return true;
  } catch (e) { analyticsLog.warn("feedback insert threw", { msg: e?.message }); return false; }
}
// Owner-only: fetch recent feedback (content, no PII) via the get_feedback() RPC.
async function fetchFeedback() {
  const sb = getSB();
  if (!sb) return null;
  try {
    const { data, error } = await sb.rpc("get_feedback", { lim: 100 });
    if (error) { analyticsLog.warn("get_feedback failed", { msg: error.message }); return null; }
    return Array.isArray(data) ? data : [];
  } catch (e) { analyticsLog.warn("get_feedback threw", { msg: e?.message }); return null; }
}

async function shareToChat(channel, shareType, shareData) {
  const sb = getSB();
  const username  = localStorage.getItem("chat_name");
  const color     = localStorage.getItem("chat_color") || CHAT_COLORS[3];
  const serverId  = localStorage.getItem("chat_server_id");
  if (!sb || !username || !serverId) return false;
  const channelKey = `${serverId}_${channel}`;
  const { error } = await sb.from("messages").insert({ channel: channelKey, username, color, content: null, share_type: shareType, share_data: shareData });
  return !error;
}

const ALL_BADGES = [
  { id: "first-lesson",   icon: "📖", label: "First Lesson"    },
  { id: "five-lessons",   icon: "🔥", label: "5 Lessons"       },
  { id: "ten-lessons",    icon: "🎓", label: "10 Lessons"       },
  { id: "first-build",    icon: "🔩", label: "First Build"      },
  { id: "50-parts",       icon: "⚙️",  label: "50 Parts"        },
  { id: "100-parts",      icon: "🏆", label: "100 Parts"        },
  { id: "serial-builder", icon: "🤖", label: "Serial Builder"   },
  { id: "worlds-bound",   icon: "🌐", label: "Worlds Bound"     },
];

function timeAgo(ts) {
  const d = Date.now() - ts;
  if (d < 60000) return "just now";
  if (d < 3600000) return `${Math.round(d/60000)}m ago`;
  if (d < 86400000) return `${Math.round(d/3600000)}h ago`;
  return `${Math.round(d/86400000)}d ago`;
}

// ── ShareBtn — reusable "Share to channel" button with toast ─────────────
function ShareBtn({ channel, shareType, shareData }) {
  const [state, setState] = React.useState("idle"); // idle | sharing | done | err
  const share = async () => {
    if (state !== "idle") return;
    setState("sharing");
    const ok = await shareToChat(channel, shareType, shareData);
    setState(ok ? "done" : "err");
    setTimeout(() => setState("idle"), 2000);
  };
  return (
    <button onClick={share}
      className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg transition font-medium shrink-0"
      style={{
        background: state==="done" ? "#dcfce7" : state==="err" ? "#fee2e2" : "#f1f5f9",
        color:      state==="done" ? "#16a34a"  : state==="err" ? "#dc2626"  : "#64748b",
        border:     "1px solid " + (state==="done" ? "#bbf7d0" : state==="err" ? "#fecaca" : "#e2e8f0"),
      }}>
      {state==="sharing" ? "..." : state==="done" ? "Shared!" : state==="err" ? "Failed" : (
        <>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
          </svg>
          Share
        </>
      )}
    </button>
  );
}

// ── CompetitionHub ────────────────────────────────────────────────────────
// ── Dashboard data-viz — inline SVG, per the dataviz method: thin 2px marks,
//    recessive grid, hover tooltips with ≥14px hit targets, text in ink tokens
//    (never series color), one series = no legend, reduced-motion-safe. ──

// Donut progress ring for a single measure (goals %, auton win %). Animates the
// arc in on mount via a CSS transition; skips straight to the value if the OS
// asks for reduced motion.
function ProgressRing({ pct, size = 96, stroke = 10, color = "#dc2626", track = "#ececf1", children }) {
  const r = (size - stroke) / 2;
  const C = 2 * Math.PI * r;
  const [shown, setShown] = React.useState(prefersReducedMotion() ? pct : 0);
  React.useEffect(() => {
    if (prefersReducedMotion()) { setShown(pct); return; }
    const raf = requestAnimationFrame(() => setShown(pct));
    return () => cancelAnimationFrame(raf);
  }, [pct]);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={C}
          strokeDashoffset={C * (1 - Math.min(100, Math.max(0, shown)) / 100)}
          transform={`rotate(-90 ${size/2} ${size/2})`}
          style={{ transition: "stroke-dashoffset 0.9s cubic-bezier(0.22,1,0.36,1)" }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">{children}</div>
    </div>
  );
}

// Points-per-match trend — one red series over match order. Draw-in line
// animation (pathLength trick), per-point hover with a crosshair + tooltip,
// selective direct label on the last point only.
function ScoreTrend({ matches }) {
  const [hov, setHov] = React.useState(null);
  const gid = React.useId().replace(/[^a-zA-Z0-9]/g, "");
  if (matches.length < 2) return null;
  const W = 600, H = 190, P = { t: 18, r: 20, b: 28, l: 38 };
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const top = Math.max(10, Math.ceil(Math.max(...matches.map((m) => m.ourScore)) / 10) * 10);
  const x = (i) => P.l + (iw * i) / (matches.length - 1);
  const y = (v) => P.t + ih * (1 - v / top);
  const pts = matches.map((m, i) => [x(i), y(m.ourScore)]);
  const line = pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)} ${(P.t + ih).toFixed(1)} L${pts[0][0].toFixed(1)} ${(P.t + ih).toFixed(1)} Z`;
  const last = pts[pts.length - 1];
  const hM = hov != null ? matches[hov] : null;
  const tipText = hM ? `${hM.ourScore > hM.theirScore ? "W" : hM.ourScore < hM.theirScore ? "L" : "T"} ${hM.ourScore}–${hM.theirScore} vs ${hM.opponent}` : "";
  const tipW = tipText.length * 6.4 + 18;
  const tipX = hov != null ? Math.min(Math.max(pts[hov][0] - tipW / 2, P.l), W - P.r - tipW) : 0;
  const tipY = hov != null ? Math.max(pts[hov][1] - 40, 2) : 0;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block" role="img"
      aria-label={`Points scored across ${matches.length} matches`}>
      <defs>
        <linearGradient id={`st-${gid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#dc2626" stopOpacity="0.14" />
          <stop offset="1" stopColor="#dc2626" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* recessive grid + scale labels */}
      {[0, top / 2, top].map((v) => (
        <g key={v}>
          <line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} stroke="#ececf1" strokeWidth="1" />
          <text x={P.l - 8} y={y(v) + 3.5} textAnchor="end" fontSize="10" fill="#6e6e73">{v}</text>
        </g>
      ))}
      <text x={P.l} y={H - 8} fontSize="10" fill="#6e6e73">Match 1</text>
      <text x={W - P.r} y={H - 8} textAnchor="end" fontSize="10" fill="#6e6e73">Match {matches.length}</text>
      {/* series */}
      <path d={area} fill={`url(#st-${gid})`} className="dv-fade" />
      <path d={line} fill="none" stroke="#dc2626" strokeWidth="2" strokeLinecap="round"
        strokeLinejoin="round" pathLength="1" className="dv-draw" />
      {/* crosshair for the hovered match */}
      {hov != null && (
        <line x1={pts[hov][0]} x2={pts[hov][0]} y1={P.t} y2={P.t + ih} stroke="#d2d2d7" strokeWidth="1" strokeDasharray="3 3" />
      )}
      {/* dots + generous hit targets */}
      <g className="dv-fade">
        {pts.map(([px, py], i) => (
          <g key={i}>
            <circle cx={px} cy={py} r={hov === i ? 5 : 3.5} fill="#ffffff" stroke="#dc2626" strokeWidth="2" />
            <circle cx={px} cy={py} r="14" fill="transparent" style={{ cursor: "pointer" }}
              onMouseEnter={() => setHov(i)} onMouseLeave={() => setHov(null)} />
          </g>
        ))}
      </g>
      {/* selective direct label: last point only (hidden while hovering it) */}
      {hov !== pts.length - 1 && (
        <text x={last[0]} y={last[1] - 10} textAnchor="middle" fontSize="11" fontWeight="600" fill="#1d1d1f" className="dv-fade">
          {matches[matches.length - 1].ourScore}
        </text>
      )}
      {/* tooltip */}
      {hov != null && (
        <g pointerEvents="none">
          <rect x={tipX} y={tipY} width={tipW} height="24" rx="7" fill="#1d1d1f" />
          <text x={tipX + tipW / 2} y={tipY + 16} textAnchor="middle" fontSize="11" fontWeight="600" fill="#ffffff">{tipText}</text>
        </g>
      )}
    </svg>
  );
}

function CompetitionHub({ store, update }) {
  const comps = store.competitions || [];
  const [showAdd, setShowAdd]           = React.useState(false);
  const [expanded, setExpanded]         = React.useState(null);
  const [showMatchFor, setShowMatchFor] = React.useState(null);
  const [compForm, setCompForm]         = React.useState({ name:"", date:"", location:"", type:"regional" });
  const [matchForm, setMatchForm]       = React.useState({ opponent:"", ourScore:"", theirScore:"", autoWon:false, notes:"" });

  const card  = { background:"#ffffff", border:"1px solid #e5e7eb", boxShadow:"0 1px 6px rgba(0,0,0,0.06)" };
  const input = { background:"#f9fafb", border:"1px solid #e5e7eb", color:"#111827" };
  const sel   = { background:"#f9fafb", border:"1px solid #e5e7eb", color:"#111827" };

  const addComp = () => {
    if (!compForm.name || !compForm.date) return;
    update(s => ({ ...s, competitions: [...(s.competitions||[]), {
      id:uid(), name:compForm.name, date:compForm.date, location:compForm.location,
      type:compForm.type, matches:[], finalRank:null, qualified:false,
      skills:{ driver:null, programming:null },
    }]}));
    setCompForm({ name:"", date:"", location:"", type:"regional" });
    setShowAdd(false);
  };

  const addMatch = (compId) => {
    if (!matchForm.opponent) return;
    update(s => ({ ...s, competitions: (s.competitions||[]).map(c => c.id!==compId ? c : {
      ...c, matches: [...c.matches, {
        id:uid(), opponent:matchForm.opponent,
        ourScore:Number(matchForm.ourScore)||0, theirScore:Number(matchForm.theirScore)||0,
        autoWon:matchForm.autoWon, notes:matchForm.notes,
      }],
    })}));
    setMatchForm({ opponent:"", ourScore:"", theirScore:"", autoWon:false, notes:"" });
    setShowMatchFor(null);
  };

  const deleteComp   = id => update(s=>({...s,competitions:(s.competitions||[]).filter(c=>c.id!==id)}));
  const deleteMatch  = (compId,matchId) => update(s=>({...s,competitions:(s.competitions||[]).map(c=>c.id!==compId?c:{...c,matches:c.matches.filter(m=>m.id!==matchId)})}));
  const setQualified = (id,v) => update(s=>({...s,competitions:(s.competitions||[]).map(c=>c.id!==id?c:{...c,qualified:v})}));
  const setFinalRank = (id,v) => update(s=>({...s,competitions:(s.competitions||[]).map(c=>c.id!==id?c:{...c,finalRank:v?Number(v):null})}));
  const setSkill     = (id,k,v) => update(s=>({...s,competitions:(s.competitions||[]).map(c=>c.id!==id?c:{...c,skills:{...c.skills,[k]:v?Number(v):null}})}));

  const allMatches = comps.flatMap(c=>c.matches);
  const W = allMatches.filter(m=>m.ourScore>m.theirScore).length;
  const L = allMatches.filter(m=>m.ourScore<m.theirScore).length;
  const T = allMatches.filter(m=>m.ourScore===m.theirScore&&m.ourScore>0).length;
  const autoW = allMatches.filter(m=>m.autoWon).length;
  const avgScore = allMatches.length ? Math.round(allMatches.reduce((a,m)=>a+m.ourScore,0)/allMatches.length) : 0;

  // One quiet typographic strip — the season record itself lives in the
  // pit-wall hero above, so this row carries the working numbers only.
  const autoPct = allMatches.length ? Math.round(autoW/allMatches.length*100) : null;
  const statStrip = [
    { val: allMatches.length || "0", sub: "Matches played" },
    { val: `${W}–${L}${T?`–${T}`:""}`, sub: "Win–loss" },
    { val: avgScore || "—", sub: "Avg score" },
    { val: autoPct != null ? `${autoPct}%` : "—", sub: "Auton won", ring: autoPct },
  ];

  // Chronological match list (comps sorted by date) feeds the trend chart.
  const orderedMatches = [...comps].sort((a,b)=>a.date>b.date?1:-1).flatMap(c=>c.matches);

  return (
    <div>
      {/* Season stats — single strip, plain type, thin dividers */}
      <div className="rounded-2xl mb-4 px-2 py-4 grid grid-cols-2 sm:grid-cols-4" style={card}>
        {statStrip.map((s, i)=>(
          <div key={s.sub} className="px-5 py-1 flex items-center gap-3"
            style={{ borderLeft: i > 0 ? "1px solid #ececf1" : "none" }}>
            {s.ring != null && (
              <ProgressRing pct={s.ring} size={40} stroke={5}>
                <span className="text-[9px] font-bold" style={{ color:"#dc2626" }}>{s.ring}</span>
              </ProgressRing>
            )}
            <div>
              <p className="text-[26px] font-semibold tracking-tight leading-none tabular-nums" style={{ color:"#1d1d1f" }}>{s.val}</p>
              <p className="text-xs mt-1.5" style={{ color:"#6e6e73" }}>{s.sub}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Points-per-match trend — appears once there are 2+ matches to connect */}
      {orderedMatches.length >= 2 && (
        <div className="rounded-2xl mb-6 p-5 sm:p-6" style={card}>
          <div className="flex items-baseline justify-between mb-2">
            <p className="text-sm font-semibold" style={{ color:"#1d1d1f" }}>Points per match</p>
            <p className="text-xs hidden sm:block" style={{ color:"#6e6e73" }}>Hover a dot for the matchup</p>
          </div>
          <ScoreTrend matches={orderedMatches} />
        </div>
      )}

      {/* Tournament cards */}
      <div className="space-y-3 mb-4">
        {comps.length===0 && (
          <div style={card} className="rounded-2xl p-10 text-center">
            <div className="w-16 h-16 rounded-full overflow-hidden mx-auto mb-4"
              style={{ background:"radial-gradient(circle at 50% 32%, #2b2e35, #141519)" }}>
              <VoltLogo size={64} />
            </div>
            <p className="text-sm font-semibold mb-1" style={{ color:"#1d1d1f" }}>The season's wide open</p>
            <p className="text-xs" style={{ color:"#6e6e73" }}>Add your first tournament and the scoreboard up top starts tracking itself.</p>
          </div>
        )}
        {[...comps].sort((a,b)=>a.date>b.date?1:-1).map(comp=>{
          const cW=comp.matches.filter(m=>m.ourScore>m.theirScore).length;
          const cL=comp.matches.filter(m=>m.ourScore<m.theirScore).length;
          const cT=comp.matches.filter(m=>m.ourScore===m.theirScore&&m.ourScore>0).length;
          const isOpen=expanded===comp.id;
          const ti=COMP_TYPES[comp.type]||COMP_TYPES.regional;
          return (
            <div key={comp.id} style={card} className="rounded-2xl overflow-hidden">
              <div className="px-5 py-4 flex items-center gap-3 cursor-pointer transition"
                   style={{}} onClick={()=>setExpanded(isOpen?null:comp.id)}>
                <div className="w-1 h-10 rounded-full shrink-0" style={{background:ti.color}}/>
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 mb-0.5">
                    <span className="text-gray-900 font-bold text-sm">{comp.name}</span>
                    <span className="text-xs px-2 py-0.5 rounded-full font-semibold shrink-0"
                      style={{background:`${ti.color}20`,color:ti.color}}>{ti.label}</span>
                    {comp.qualified&&<span className="text-xs px-2 py-0.5 rounded-full font-semibold shrink-0"
                      style={{background:"rgba(234,179,8,0.15)",color:"#eab308"}}>✓ Qualified</span>}
                  </div>
                  <p className="text-gray-400 text-xs">{comp.date}{comp.location&&` · ${comp.location}`}</p>
                </div>
                <div className="text-right shrink-0 mr-2">
                  <p className="text-gray-900 text-sm font-black">{comp.matches.length?`${cW}W–${cL}L${cT?`–${cT}T`:""}` : "—"}</p>
                  <p className="text-gray-400 text-xs">{comp.matches.length} match{comp.matches.length!==1?"es":""}</p>
                </div>
                <span className="text-gray-400 text-xs">{isOpen?"▲":"▼"}</span>
              </div>

              {isOpen&&(
                <div style={{borderTop:"1px solid #f3f4f6",background:"#f9fafb"}} className="px-5 pb-5 pt-4">
                  {/* Match list */}
                  {comp.matches.length>0&&(
                    <div className="space-y-1.5 mb-5">
                      <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Match Results</p>
                      {comp.matches.map((m,mi)=>{
                        const res=m.ourScore>m.theirScore?"W":m.ourScore<m.theirScore?"L":"T";
                        const rc=res==="W"?"#4ade80":res==="L"?"#f87171":"#facc15";
                        const rb=res==="W"?"rgba(74,222,128,0.12)":res==="L"?"rgba(248,113,113,0.12)":"rgba(250,204,21,0.12)";
                        return (
                          <div key={m.id||mi} className="flex items-center gap-3 rounded-xl px-3 py-2.5 bg-white"
                            style={{border:"1px solid #e5e7eb"}}>
                            <span className="text-xs font-black w-6 text-center px-1.5 py-0.5 rounded-md"
                              style={{background:rb,color:rc}}>{res}</span>
                            <span className="text-gray-500 text-xs flex-1">vs {m.opponent}</span>
                            <span className="text-gray-900 text-xs font-bold tabular-nums">{m.ourScore}–{m.theirScore}</span>
                            {m.autoWon&&<span className="text-xs px-2 py-0.5 rounded-full font-semibold"
                              style={{background:"rgba(139,92,246,0.15)",color:"#a78bfa"}}>Auto Win</span>}
                            <button onClick={()=>deleteMatch(comp.id,m.id)}
                              className="text-slate-700 hover:text-red-400 text-sm ml-1 transition">✕</button>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Meta inputs */}
                  <div className="grid grid-cols-3 gap-3 mb-4">
                    {[
                      {label:"Final Rank",     key:"finalRank",        val:comp.finalRank||"",     ph:"e.g. 8",  fn:v=>setFinalRank(comp.id,v)},
                      {label:"Driving Skills", key:"skills.driver",    val:comp.skills?.driver||"",ph:"pts",     fn:v=>setSkill(comp.id,"driver",v)},
                      {label:"Prog. Skills",   key:"skills.prog",      val:comp.skills?.programming||"",ph:"pts",fn:v=>setSkill(comp.id,"programming",v)},
                    ].map(f=>(
                      <div key={f.key}>
                        <label className="text-gray-500 text-xs font-semibold block mb-1 uppercase tracking-wide">{f.label}</label>
                        <input type="number" value={f.val} onChange={e=>f.fn(e.target.value)}
                          placeholder={f.ph} className="w-full rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-200"
                          style={input}/>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-4 mb-4 flex-wrap">
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input type="checkbox" checked={comp.qualified} onChange={e=>setQualified(comp.id,e.target.checked)} className="accent-yellow-500 w-4 h-4"/>
                      <span className="text-slate-500 text-xs">Qualified for next event</span>
                    </label>
                    {isChatReady() && (
                      <ShareBtn channel="competition" shareType="tournament" shareData={{
                        name:comp.name, date:comp.date, location:comp.location, type:ti.label,
                        record:comp.matches.length?`${cW}W–${cL}L${cT?`–${cT}T`:""}`:null,
                      }}/>
                    )}
                    <button onClick={()=>deleteComp(comp.id)} className="text-slate-700 hover:text-red-400 text-xs ml-auto transition">Delete tournament</button>
                  </div>

                  {/* Add match */}
                  {showMatchFor===comp.id ? (
                    <div className="rounded-xl p-4 space-y-3 bg-white" style={{border:"1px solid #e5e7eb"}}>
                      <p className="text-gray-700 text-xs font-bold uppercase tracking-wider">Log Match Result</p>
                      <div className="grid grid-cols-3 gap-2">
                        {[{key:"opponent",ph:"Opponent (e.g. 2345B)"},{key:"ourScore",ph:"Our Score",type:"number"},{key:"theirScore",ph:"Their Score",type:"number"}].map(f=>(
                          <input key={f.key} type={f.type||"text"} value={matchForm[f.key]}
                            onChange={e=>setMatchForm(p=>({...p,[f.key]:e.target.value}))} placeholder={f.ph}
                            className="rounded-lg px-3 py-2 text-slate-800 text-xs outline-none focus:ring-2 focus:ring-blue-200"
                            style={input}/>
                        ))}
                      </div>
                      <label className="flex items-center gap-2 cursor-pointer select-none">
                        <input type="checkbox" checked={matchForm.autoWon} onChange={e=>setMatchForm(p=>({...p,autoWon:e.target.checked}))} className="accent-purple-500 w-4 h-4"/>
                        <span className="text-gray-500 text-xs">Won Autonomous Period</span>
                      </label>
                      <div className="flex gap-2">
                        <button onClick={()=>addMatch(comp.id)}
                          className="px-4 py-1.5 rounded-lg text-white text-xs font-bold" style={{background:"#dc2626"}}>Save Match</button>
                        <button onClick={()=>setShowMatchFor(null)}
                          className="px-4 py-1.5 rounded-lg text-slate-600 text-xs hover:text-slate-400 transition">Cancel</button>
                      </div>
                    </div>
                  ):(
                    <button onClick={()=>setShowMatchFor(comp.id)}
                      className="text-red-500 hover:text-red-400 text-xs font-semibold transition">+ Add Match Result</button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {showAdd ? (
        <div style={card} className="rounded-2xl p-5">
          <p className="text-gray-800 font-bold text-sm mb-4">Add Tournament</p>
          <div className="grid sm:grid-cols-2 gap-3 mb-4">
            {[{key:"name",label:"Tournament Name",ph:"e.g. Northwest Regional",full:true},{key:"date",label:"Date",type:"date"},{key:"location",label:"Location",ph:"e.g. Portland, OR"}].map(f=>(
              <div key={f.key} className={f.full?"sm:col-span-2":""}>
                <label className="text-gray-500 text-xs font-semibold block mb-1">{f.label}</label>
                <input type={f.type||"text"} value={compForm[f.key]} onChange={e=>setCompForm(p=>({...p,[f.key]:e.target.value}))}
                  placeholder={f.ph||""} className="w-full rounded-xl px-3 py-2.5 text-gray-900 text-sm outline-none"
                  style={input}/>
              </div>
            ))}
            <div>
              <label className="text-slate-600 text-xs font-semibold block mb-1 uppercase tracking-wide">Type</label>
              <select value={compForm.type} onChange={e=>setCompForm(p=>({...p,type:e.target.value}))}
                className="w-full rounded-xl px-3 py-2.5 text-sm outline-none" style={sel}>
                {Object.entries(COMP_TYPES).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
              </select>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={addComp} className="px-5 py-2 rounded-xl text-white text-sm font-bold transition hover:opacity-90" style={{background:"#dc2626"}}>Add Tournament</button>
            <button onClick={()=>setShowAdd(false)} className="px-5 py-2 rounded-xl text-slate-600 text-sm hover:text-slate-400 transition">Cancel</button>
          </div>
        </div>
      ):(
        <button onClick={()=>setShowAdd(true)}
          className="w-full rounded-2xl py-4 text-sm font-semibold transition"
          style={{border:"1.5px dashed rgba(220,38,38,0.3)",color:"#dc2626",background:"rgba(220,38,38,0.04)"}}>
          + Add Tournament
        </button>
      )}
    </div>
  );
}

// ── SeasonGoals ───────────────────────────────────────────────────────────
function SeasonGoals({ store, update }) {
  const goals = store.goals || [];
  const [showAdd, setShowAdd] = React.useState(false);
  const [form, setForm] = React.useState({ text:"", category:"competition", priority:"high" });

  const card  = { background:"#ffffff", border:"1px solid #e5e7eb", boxShadow:"0 1px 6px rgba(0,0,0,0.06)" };
  const input = { background:"#f9fafb", border:"1px solid #e5e7eb", color:"#111827" };
  const sel   = { background:"#f9fafb", border:"1px solid #e5e7eb", color:"#111827" };
  const prioColor = { high:"#dc2626", medium:"#f59e0b", low:"#9ca3af" };
  const prioBg    = { high:"#fef2f2", medium:"#fffbeb", low:"#f9fafb" };

  const addGoal = () => {
    if (!form.text.trim()) return;
    update(s=>({...s,goals:[...(s.goals||[]),{id:uid(),text:form.text.trim(),category:form.category,priority:form.priority,done:false,createdAt:Date.now(),completedAt:null}]}));
    setForm({text:"",category:"competition",priority:"high"});
    setShowAdd(false);
  };
  const toggleGoal = id => update(s=>({...s,goals:(s.goals||[]).map(g=>g.id!==id?g:{...g,done:!g.done,completedAt:!g.done?Date.now():null})}));
  const deleteGoal = id => update(s=>({...s,goals:(s.goals||[]).filter(g=>g.id!==id)}));

  const active = goals.filter(g=>!g.done).sort((a,b)=>["high","medium","low"].indexOf(a.priority)-["high","medium","low"].indexOf(b.priority));
  const done   = goals.filter(g=>g.done);
  const pct    = goals.length ? Math.round(done.length/goals.length*100) : 0;

  return (
    <div>
      {/* Progress card — donut ring instead of a % headline + bar */}
      <div style={card} className="rounded-2xl p-6 mb-6 flex items-center gap-6 sm:gap-8">
        <ProgressRing pct={pct} size={104} stroke={11} color={pct===100?"#16a34a":"#dc2626"}>
          <span className="text-2xl font-semibold tracking-tight tabular-nums" style={{ color:"#1d1d1f" }}>{pct}<span className="text-sm" style={{ color:"#6e6e73" }}>%</span></span>
        </ProgressRing>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-[15px]" style={{ color:"#1d1d1f" }}>Season progress</p>
          <p className="text-xs mt-0.5 mb-3" style={{ color:"#6e6e73" }}>
            {goals.length === 0 ? "No goals yet — set the first one below." :
             pct === 100 ? "Everything done. Set the next target!" :
             `${done.length} of ${goals.length} goals completed`}
          </p>
          <div className="flex gap-7">
            {[{label:"Total",v:goals.length},{label:"Active",v:active.length},{label:"Done",v:done.length}].map(x=>(
              <div key={x.label}>
                <p className="text-lg font-semibold tabular-nums" style={{ color:"#1d1d1f" }}>{x.v}</p>
                <p className="text-xs" style={{ color:"#6e6e73" }}>{x.label}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Active goals */}
      {active.length===0 && done.length===0 && (
        <div style={card} className="rounded-2xl p-10 text-center mb-4">
          <div className="w-14 h-14 rounded-full overflow-hidden mx-auto mb-3"
            style={{ background:"radial-gradient(circle at 50% 32%, #2b2e35, #141519)" }}>
            <VoltLogo size={56} />
          </div>
          <p className="text-sm font-semibold mb-1" style={{ color:"#1d1d1f" }}>What are you chasing this season?</p>
          <p className="text-xs" style={{ color:"#6e6e73" }}>Qualify for regionals? A working auton by October? Set it below.</p>
        </div>
      )}
      <div className="space-y-2 mb-4">
        {active.map(g=>{
          const cat=GOAL_CATS[g.category]||GOAL_CATS.other;
          return (
            <div key={g.id} style={card} className="rounded-2xl px-4 py-3.5 flex items-center gap-3 transition">
              <button onClick={()=>toggleGoal(g.id)}
                className="w-5 h-5 rounded-full shrink-0 border-2 transition hover:scale-110"
                style={{borderColor:prioColor[g.priority]||"#64748b",background:"transparent"}}/>
              <div className="flex-1 min-w-0">
                <p className="text-gray-900 text-sm font-medium">{g.text}</p>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-xs px-2 py-0.5 rounded-full font-medium"
                    style={{background:`${cat.color}18`,color:cat.color}}>{cat.label}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full font-medium"
                    style={{background:prioBg[g.priority],color:prioColor[g.priority]||"#94a3b8"}}>
                    {g.priority.charAt(0).toUpperCase()+g.priority.slice(1)}
                  </span>
                </div>
              </div>
              {isChatReady() && (
                <ShareBtn channel="general" shareType="goal" shareData={{
                  text:g.text, category:cat.label, priority:g.priority,
                }}/>
              )}
              <button onClick={()=>deleteGoal(g.id)} className="text-gray-400 hover:text-red-500 text-sm transition">✕</button>
            </div>
          );
        })}
      </div>

      {showAdd ? (
        <div style={card} className="rounded-2xl p-5 mb-6">
          <p className="text-gray-900 font-bold text-sm mb-3 uppercase tracking-wider">New Goal</p>
          <textarea value={form.text} onChange={e=>setForm(p=>({...p,text:e.target.value}))}
            placeholder="e.g. Qualify for State Championship" rows={2}
            className="w-full rounded-xl px-3 py-2.5 text-gray-900 text-sm outline-none resize-none mb-3"
            style={input}/>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label className="text-gray-400 text-xs font-semibold block mb-1 uppercase tracking-wide">Category</label>
              <select value={form.category} onChange={e=>setForm(p=>({...p,category:e.target.value}))}
                className="w-full rounded-xl px-3 py-2.5 text-sm outline-none" style={sel}>
                {Object.entries(GOAL_CATS).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-gray-400 text-xs font-semibold block mb-1 uppercase tracking-wide">Priority</label>
              <select value={form.priority} onChange={e=>setForm(p=>({...p,priority:e.target.value}))}
                className="w-full rounded-xl px-3 py-2.5 text-sm outline-none" style={sel}>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={addGoal} className="px-5 py-2 rounded-xl text-white text-sm font-bold transition hover:opacity-90" style={{background:"#dc2626"}}>Add Goal</button>
            <button onClick={()=>setShowAdd(false)} className="px-5 py-2 rounded-xl text-gray-500 text-sm hover:text-gray-700 transition">Cancel</button>
          </div>
        </div>
      ):(
        <button onClick={()=>setShowAdd(true)}
          className="w-full rounded-2xl py-4 text-sm font-semibold transition mb-6"
          style={{border:"1.5px dashed rgba(220,38,38,0.3)",color:"#dc2626",background:"rgba(220,38,38,0.04)"}}>
          + Add Goal
        </button>
      )}

      {done.length>0&&(
        <div>
          <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">Completed · {done.length}</p>
          <div className="space-y-2">
            {done.map(g=>{
              const cat=GOAL_CATS[g.category]||GOAL_CATS.other;
              return (
                <div key={g.id} className="rounded-2xl px-4 py-3 flex items-center gap-3"
                  style={{background:"#f9fafb",border:"1px solid #e5e7eb",opacity:0.8}}>
                  <div className="w-5 h-5 rounded-full shrink-0 flex items-center justify-center" style={{background:"#16a34a"}}>
                    <svg width="10" height="8" viewBox="0 0 10 8" fill="none"><path d="M1 4l3 3 5-6" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </div>
                  <p className="text-gray-400 text-sm flex-1 line-through truncate">{g.text}</p>
                  <span className="text-xs px-2 py-0.5 rounded-full font-medium"
                    style={{background:`${cat.color}18`,color:cat.color}}>{cat.label}</span>
                  <button onClick={()=>deleteGoal(g.id)} className="text-gray-300 hover:text-red-500 text-sm transition">✕</button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── PracticeCalendar ──────────────────────────────────────────────────────
function PracticeCalendar({ store, update }) {
  const practices = store.practices || [];
  const today     = new Date();
  const [viewDate, setViewDate]       = React.useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const [selectedDay, setSelectedDay] = React.useState(null);
  const [showAdd, setShowAdd]         = React.useState(false);
  const [form, setForm]               = React.useState({ title:"", type:"driver", duration:"90", notes:"" });

  const padDate = (y,m,d) => `${y}-${String(m+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
  const todayStr = padDate(today.getFullYear(), today.getMonth(), today.getDate());

  const yr   = viewDate.getFullYear();
  const mo   = viewDate.getMonth();
  const firstDay    = new Date(yr, mo, 1).getDay();
  const daysInMonth = new Date(yr, mo+1, 0).getDate();
  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

  const practicesOn = d => practices.filter(p=>p.date===d);

  const addPractice = () => {
    if (!form.title.trim()||!selectedDay) return;
    update(s=>({...s,practices:[...(s.practices||[]),{id:uid(),date:selectedDay,title:form.title.trim(),type:form.type,duration:Number(form.duration)||60,notes:form.notes,done:false}]}));
    setForm({title:"",type:"driver",duration:"90",notes:""});
    setShowAdd(false);
  };
  const togglePractice = id => update(s=>({...s,practices:(s.practices||[]).map(p=>p.id!==id?p:{...p,done:!p.done})}));
  const deletePractice = id => update(s=>({...s,practices:(s.practices||[]).filter(p=>p.id!==id)}));

  const upcoming   = practices.filter(p=>p.date>=todayStr&&!p.done).sort((a,b)=>a.date>b.date?1:-1).slice(0,6);
  const selPractices = selectedDay ? practicesOn(selectedDay) : [];
  const card  = { background:"#ffffff", border:"1px solid #e5e7eb", boxShadow:"0 1px 6px rgba(0,0,0,0.06)" };
  const input = { background:"#f9fafb", border:"1px solid #e5e7eb", color:"#111827" };
  const sel   = { background:"#f9fafb", border:"1px solid #e5e7eb", color:"#111827" };

  return (
    <div className="grid md:grid-cols-5 gap-6">

      {/* ── Calendar ── */}
      <div className="md:col-span-3 space-y-4">
        <div style={card} className="rounded-2xl p-5">
          {/* Nav */}
          <div className="flex items-center justify-between mb-5">
            <button onClick={()=>setViewDate(new Date(yr,mo-1,1))}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-900 transition text-lg font-medium" style={{background:"#f3f4f6"}}>‹</button>
            <p className="text-gray-900 font-bold text-sm">{MONTHS[mo]} {yr}</p>
            <button onClick={()=>setViewDate(new Date(yr,mo+1,1))}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-900 transition text-lg font-medium" style={{background:"#f3f4f6"}}>›</button>
          </div>
          {/* Day headers */}
          <div className="grid grid-cols-7 mb-2">
            {["Su","Mo","Tu","We","Th","Fr","Sa"].map(d=>(
              <div key={d} className="text-center text-xs py-1 font-bold tracking-wide" style={{color:"#374151"}}>{d}</div>
            ))}
          </div>
          {/* Day cells */}
          <div className="grid grid-cols-7 gap-1">
            {Array.from({length:firstDay}).map((_,i)=><div key={`e${i}`}/>)}
            {Array.from({length:daysInMonth}).map((_,i)=>{
              const d=i+1;
              const ds=padDate(yr,mo,d);
              const dayPs=practicesOn(ds);
              const isToday=ds===todayStr;
              const isSel=ds===selectedDay;
              const isPast=ds<todayStr;
              return (
                <button key={d} onClick={()=>setSelectedDay(isSel?null:ds)}
                  className="rounded-xl p-1.5 flex flex-col items-center min-h-[44px] transition"
                  style={{
                    background: isSel?"#dc2626":isToday?"rgba(220,38,38,0.1)":"transparent",
                    border: isSel?"1px solid #dc2626":isToday?"1px solid rgba(220,38,38,0.3)":"1px solid transparent",
                  }}>
                  <span className={`text-xs font-semibold leading-tight ${
                    isSel?"text-white":isToday?"text-red-500":isPast?"text-gray-300":"text-gray-700"
                  }`}>{d}</span>
                  {dayPs.length>0&&(
                    <div className="flex gap-0.5 mt-1 flex-wrap justify-center">
                      {dayPs.slice(0,3).map((p,pi)=>(
                        <div key={pi} className="w-1.5 h-1.5 rounded-full"
                          style={{background:isSel?"rgba(255,255,255,0.7)":(PRACTICE_TYPES[p.type]||PRACTICE_TYPES.driver).color,opacity:p.done?0.4:1}}/>
                      ))}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Upcoming list */}
        <div style={card} className="rounded-2xl p-5">
          <p className="text-gray-900 font-bold text-sm mb-4">Upcoming Sessions</p>
          {upcoming.length===0?(
            <p className="text-gray-400 text-xs">No upcoming sessions — click a day to schedule one.</p>
          ):(
            <div className="space-y-3">
              {upcoming.map(p=>{
                const pt=PRACTICE_TYPES[p.type]||PRACTICE_TYPES.driver;
                const isToday=p.date===todayStr;
                return (
                  <div key={p.id} className="flex items-center gap-3 py-1">
                    <div className="w-1 h-9 rounded-full shrink-0" style={{background:pt.color}}/>
                    <div className="flex-1 min-w-0">
                      <p className="text-gray-900 text-sm font-medium truncate">{p.title}</p>
                      <p className="text-gray-400 text-xs">{isToday?"Today":p.date} · {p.duration}min · {pt.label}</p>
                    </div>
                    {isToday&&<span className="text-xs px-2 py-0.5 rounded-full font-semibold shrink-0"
                      style={{background:"#fef2f2",color:"#dc2626"}}>Today</span>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Day panel ── */}
      <div className="md:col-span-2">
        <div style={card} className="rounded-2xl p-5 sticky top-28">
          {selectedDay?(
            <>
              <div className="flex items-start justify-between mb-4">
                <div>
                  <p className="text-gray-900 font-bold">
                    {new Date(selectedDay+"T00:00").toLocaleDateString("en-US",{weekday:"long"})}
                  </p>
                  <p className="text-gray-400 text-xs mt-0.5">
                    {new Date(selectedDay+"T00:00").toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"})}
                  </p>
                </div>
                <button onClick={()=>setSelectedDay(null)}
                  className="w-6 h-6 rounded-md flex items-center justify-center text-gray-400 hover:text-gray-900 transition text-sm">✕</button>
              </div>

              {selPractices.length===0&&!showAdd&&(
                <p className="text-gray-400 text-xs mb-4">No sessions scheduled for this day.</p>
              )}

              <div className="space-y-2 mb-4">
                {selPractices.map(p=>{
                  const pt=PRACTICE_TYPES[p.type]||PRACTICE_TYPES.driver;
                  return (
                    <div key={p.id} className="rounded-xl p-3 flex items-start gap-3"
                      style={{background:"#f9fafb",border:"1px solid #e5e7eb",opacity:p.done?0.5:1}}>
                      <button onClick={()=>togglePractice(p.id)}
                        className="w-4 h-4 rounded-full shrink-0 mt-0.5 flex items-center justify-center transition border-2"
                        style={{borderColor:pt.color,background:p.done?pt.color:"transparent"}}>
                        {p.done&&<svg width="8" height="6" viewBox="0 0 8 6" fill="none"><path d="M1 3l2 2 4-4" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                      </button>
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm font-medium ${p.done?"text-gray-400 line-through":"text-gray-900"}`}>{p.title}</p>
                        <p className="text-xs mt-0.5 font-medium" style={{color:pt.color}}>{pt.label} · {p.duration}min</p>
                        {p.notes&&<p className="text-gray-400 text-xs mt-1 leading-snug">{p.notes}</p>}
                      </div>
                      {isChatReady() && (
                        <ShareBtn channel="calendar" shareType="practice" shareData={{
                          title:p.title, date:p.date, duration:p.duration,
                          label:pt.label, notes:p.notes||"",
                        }}/>
                      )}
                      <button onClick={()=>deletePractice(p.id)} className="text-gray-400 hover:text-red-500 text-sm shrink-0 transition">✕</button>
                    </div>
                  );
                })}
              </div>

              {showAdd?(
                <div className="space-y-2">
                  <input value={form.title} onChange={e=>setForm(p=>({...p,title:e.target.value}))}
                    placeholder="Session title (e.g. Driver skills run)"
                    className="w-full rounded-xl px-3 py-2.5 text-gray-900 text-sm outline-none"
                    style={input}/>
                  <div className="grid grid-cols-2 gap-2">
                    <select value={form.type} onChange={e=>setForm(p=>({...p,type:e.target.value}))}
                      className="rounded-xl px-3 py-2.5 text-sm outline-none" style={sel}>
                      {Object.entries(PRACTICE_TYPES).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
                    </select>
                    <input type="number" value={form.duration} onChange={e=>setForm(p=>({...p,duration:e.target.value}))}
                      placeholder="Minutes" className="rounded-xl px-3 py-2.5 text-gray-900 text-sm outline-none"
                      style={input}/>
                  </div>
                  <textarea value={form.notes} onChange={e=>setForm(p=>({...p,notes:e.target.value}))}
                    placeholder="Notes (optional)" rows={2}
                    className="w-full rounded-xl px-3 py-2.5 text-gray-900 text-sm outline-none resize-none"
                    style={input}/>
                  <div className="flex gap-2">
                    <button onClick={addPractice} className="flex-1 py-2.5 rounded-xl text-white text-sm font-bold transition hover:opacity-90" style={{background:"#dc2626"}}>Add Session</button>
                    <button onClick={()=>setShowAdd(false)} className="px-4 py-2.5 rounded-xl text-gray-500 text-sm hover:text-gray-700 transition">Cancel</button>
                  </div>
                </div>
              ):(
                <button onClick={()=>setShowAdd(true)}
                  className="w-full py-3 rounded-xl text-sm font-semibold transition"
                  style={{border:"1.5px dashed rgba(220,38,38,0.3)",color:"#dc2626",background:"rgba(220,38,38,0.04)"}}>
                  + Add Session
                </button>
              )}
            </>
          ):(
            <div className="text-center py-12">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center mx-auto mb-3" style={{background:"rgba(220,38,38,0.1)",border:"1px solid rgba(220,38,38,0.2)"}}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
                </svg>
              </div>
              <p className="text-gray-900 text-sm font-bold">Select a day</p>
              <p className="text-gray-400 text-xs mt-1">Click any date to view or add sessions.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const PUBLIC_SERVER_ID = "VEXHUB";

// A private team server is identified by a long, unguessable token (not a short
// typeable code), so the only way in is an invite link someone shares with you —
// nobody can guess a code and wander in. ~18 base-36 chars ≈ 36^18 possibilities.
function genServerToken() {
  const a = new Uint32Array(4);
  (globalThis.crypto || window.crypto).getRandomValues(a);
  const raw = Array.from(a, n => n.toString(36)).join("").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return ("T" + raw).slice(0, 18).padEnd(18, "0"); // leading T marks a link-invite server
}
// Build the shareable invite URL for a server token (origin + ?invite=TOKEN).
function inviteLink(serverId) {
  const origin = (typeof window !== "undefined" && window.location?.origin) || "";
  return `${origin}/?invite=${serverId}`;
}
// Pull a server token out of whatever the user pasted — a full invite URL or a
// bare token. Uppercased; non-alphanumerics stripped.
function parseInvite(text) {
  if (!text) return "";
  const m = String(text).match(/[?&]invite=([^&\s]+)/i);
  const raw = m ? m[1] : text;
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// ── NotebookView ──────────────────────────────────────────────────────────
const NB_SECTIONS = [
  { id:"design",      label:"Design",      color:"#3b82f6" },
  { id:"build",       label:"Build",       color:"#10b981" },
  { id:"test",        label:"Test",        color:"#f59e0b" },
  { id:"competition", label:"Competition", color:"#8b5cf6" },
  { id:"reflection",  label:"Reflection",  color:"#ec4899" },
  { id:"other",       label:"Other",       color:"#64748b" },
];

const NB_PAGE_H   = 1056;   // px — letter paper at 96 dpi (11 in)
const NB_PAGE_GAP = 24;    // px — grey gap between pages
const NB_MARG_V   = 72;    // px — top/bottom page margin
const NB_MARG_H   = 96;    // px — left/right page margin

const nbLog = createLogger("notebook"); // refinement: notebook events were console.warn/silent
function NotebookView({ serverId, myName, myColor, isAdmin }) {
  const chKey    = `${serverId}_notebook`;
  const newMeta  = () => ({ section:"design", status:"in-progress",
    date: new Date().toISOString().split("T")[0], attachments:[] });

  /* ─── all the new-entry colours ─────────────────────── */
  const PALETTE = [
    "#202124","#5f6368","#9aa0a6","#ffffff",
    "#d93025","#e8710a","#f9ab00","#188038",
    "#1a73e8","#8430ce","#d93025","#c5221f",
    "#f28b82","#fbbc04","#34a853","#4285f4",
    "#fa903e","#fdd663","#81c995","#74b9ff",
    "#a142f4","#fd79a8","#00b894","#0984e3",
  ];

  const [entries,     setEntries]     = React.useState([]);
  const [selId,       setSelId]       = React.useState(null);
  const [meta,        setMeta]        = React.useState(newMeta());
  const [isNew,       setIsNew]       = React.useState(false);
  const [saving,      setSaving]      = React.useState(false);
  const [sidebarOpen, setSidebarOpen] = React.useState(true);
  const [lightbox,    setLightbox]    = React.useState(null);
  const [pdfModal,    setPdfModal]    = React.useState(null);
  const [uploading,   setUploading]   = React.useState(false);
  const [wordCount,   setWordCount]   = React.useState(0);
  const [blockFmt,    setBlockFmt]    = React.useState("p");
  const [newKey,      setNewKey]      = React.useState(0);   // fix new-entry re-trigger
  const [selImg,      setSelImg]      = React.useState(null);// selected image element
  const [nbFullscreen,setNbFullscreen]= React.useState(false);
  const [colorOpen,   setColorOpen]   = React.useState(false);
  const [fontFamily,  setFontFamily]  = React.useState("Arial");
  const [activeAlign, setActiveAlign] = React.useState("left");
  const [numPages,    setNumPages]    = React.useState(1);

  const [exportOpen,  setExportOpen]  = React.useState(false);

  const editorRef   = React.useRef(null);
  const titleRef    = React.useRef(null);
  const fileRef     = React.useRef(null);
  const imgFileRef  = React.useRef(null);
  const importRef   = React.useRef(null);
  const savedSelRef = React.useRef(null);
  const canvasRef   = React.useRef(null);
  const imgDragRef    = React.useRef(null); // drag state for image resize/rotate
  const imgOverlayRef  = React.useRef(null); // DOM ref to the overlay container
  const selImgRef      = React.useRef(null); // always-current selImg for imperative use
  const nbContainerRef = React.useRef(null); // outer div — used for native fullscreen

  // sorted for page nav (newest → oldest)
  const sortedEntries = React.useMemo(
    () => [...entries].sort((a,b) => a.date < b.date ? 1 : -1), [entries]
  );
  const pageIdx = sortedEntries.findIndex(e => e.id === selId);
  const totalPgs = sortedEntries.length;

  // Load + subscribe
  React.useEffect(() => {
    if (!serverId) return;
    const sb = getSB();
    if (!sb) return;
    sb.from("messages").select("*").eq("channel", chKey).eq("share_type","nb_entry")
      .order("created_at",{ascending:true}).then(({ data }) => {
        if (!data) return;
        const map = {};
        data.forEach(r => {
          const d = r.share_data;
          if (d?.id && (!map[d.id] || r.created_at > map[d.id]._ts)) map[d.id] = {...d, _ts: r.created_at};
        });
        setEntries(Object.values(map).sort((a,b)=> a.date < b.date ? 1 : -1));
      });
    const sub = sb.channel(`nb:${serverId}`)
      .on("postgres_changes",{event:"INSERT",schema:"public",table:"messages",filter:`channel=eq.${chKey}`},
        ({new:r}) => {
          if (r.share_type==="nb_entry" && r.share_data?.id) {
            const d = {...r.share_data, _ts: r.created_at};
            setEntries(prev => {
              const next = prev.filter(e=>e.id!==d.id);
              return [...next, d].sort((a,b)=> a.date < b.date ? 1 : -1);
            });
          }
        }).subscribe();
    return () => sub.unsubscribe();
  }, [serverId]);

  // ── Sync editor when entry changes (newKey forces re-run even if already isNew) ──
  React.useEffect(() => {
    if (!editorRef.current) return;
    const entry = isNew ? null : entries.find(e => e.id === selId);
    editorRef.current.innerHTML = entry?.content || "";
    if (titleRef.current) titleRef.current.value = entry?.title || "";
    setMeta(entry
      ? { section:entry.section||"design", status:entry.status||"in-progress",
          date:entry.date||"", attachments:entry.attachments||[] }
      : newMeta());
    setWordCount((editorRef.current.innerText||"").trim().split(/\s+/).filter(Boolean).length);
    setSelImg(null);
    setTimeout(()=>editorRef.current?.focus(), 50);
  }, [selId, isNew, newKey]); // eslint-disable-line

  // ── Track block-format, font, alignment for toolbar active states ──
  React.useEffect(() => {
    const onSel = () => {
      if (!editorRef.current) return;
      const sel = window.getSelection();
      if (!sel?.anchorNode || !editorRef.current.contains(sel.anchorNode)) return;
      // block style
      const tag = document.queryCommandValue("formatBlock");
      setBlockFmt(tag ? tag.toLowerCase() : "p");
      // font family
      const fn = document.queryCommandValue("fontName");
      if (fn) setFontFamily(fn.replace(/['"]/g, ""));
      // alignment — use computed style (queryCommandState("justifyCenter") has false-positives in Chrome)
      let alignNode = sel.getRangeAt(0).commonAncestorContainer;
      if (alignNode.nodeType === 3) alignNode = alignNode.parentElement;
      let detectedAlign = "left";
      while (alignNode && alignNode !== editorRef.current) {
        const ta = window.getComputedStyle(alignNode).textAlign;
        if (ta === "center")  { detectedAlign = "center"; break; }
        if (ta === "right")   { detectedAlign = "right";  break; }
        if (ta === "justify") { detectedAlign = "full";   break; }
        if (ta === "left" || ta === "start") break;
        alignNode = alignNode.parentElement;
      }
      setActiveAlign(detectedAlign);
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, []);

  // ── Count pages from editor height ──
  React.useEffect(() => {
    const el = editorRef.current; if (!el) return;
    const obs = new ResizeObserver(([entry]) => {
      const totalH = entry.contentRect.height + NB_MARG_V * 2;
      setNumPages(Math.max(1, Math.ceil(totalH / NB_PAGE_H)));
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []); // eslint-disable-line

  // ── openNew always clears editor (increment newKey) ──
  // Refinement: window.confirm blocked the JS thread and looked native — now an
  // async styled dialog; the function became async to await the user's choice.
  const openNew = async () => {
    const hasContent = (editorRef.current?.innerText || "").trim().length > 0;
    if (hasContent && (isNew || selId)) {
      const ok = await confirmDialog({
        title: "Discard unsaved changes?",
        message: "Any unsaved changes in the current entry will be lost.",
        confirmLabel: "Discard & continue", danger: true,
      });
      if (!ok) return;
    }
    setNewKey(k=>k+1); setIsNew(true); setSelId(null);
  };
  const openEntry = (e) => { setIsNew(false); setSelId(e.id); };
  const goPage    = (idx) => { if (idx>=0 && idx<sortedEntries.length) openEntry(sortedEntries[idx]); };

  // ── execCommand helpers ──
  const execFmt = (cmd, val) => {
    editorRef.current?.focus();
    document.execCommand(cmd, false, val ?? null);
  };
  const applyBlock = (tag) => {
    editorRef.current?.focus();
    document.execCommand("formatBlock", false, tag);
    setBlockFmt(tag);
  };

  // ── Selection save/restore (keeps cursor for image insert after toolbar click) ──
  const saveSelection = () => {
    const sel = window.getSelection();
    if (sel?.rangeCount > 0 && editorRef.current?.contains(sel.anchorNode))
      savedSelRef.current = sel.getRangeAt(0).cloneRange();
  };
  const restoreSelection = () => {
    const sel = window.getSelection();
    sel?.removeAllRanges();
    if (savedSelRef.current) { sel?.addRange(savedSelRef.current); return; }
    const r = document.createRange();
    r.selectNodeContents(editorRef.current);
    r.collapse(false);
    sel?.addRange(r);
  };

  // ── Image insert inline ──
  const handleImageInsert = (e) => {
    const file = e.target.files[0]; if (!file) return;
    // Refinement: alert() → toast (non-blocking) + log so oversize picks are traceable
    if (file.size > 15*1024*1024) { notify(`"${file.name}" exceeds 15 MB.`, { level: "error" }); nbLog.warn("image insert rejected: oversize", { name: file.name, size: file.size }); return; }
    const reader = new FileReader();
    reader.onload = (ev) => {
      editorRef.current?.focus();
      restoreSelection();
      document.execCommand("insertImage", false, ev.target.result);
      setWordCount((editorRef.current?.innerText||"").trim().split(/\s+/).filter(Boolean).length);
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  // ── PDF attach ──
  const handlePdfAttach = (e) => {
    const files = Array.from(e.target.files); if (!files.length) return;
    setUploading(true); let done = 0;
    files.forEach(file => {
      // Refinement: alert() → toast; loop continues for the remaining valid files
      if (file.size > 15*1024*1024) { notify(`"${file.name}" exceeds 15 MB.`, { level: "error" }); done++; if(done===files.length)setUploading(false); return; }
      const reader = new FileReader();
      reader.onload = (ev) => {
        const att = { id:crypto.randomUUID(), type:"pdf", name:file.name, size:file.size, data:ev.target.result };
        setMeta(m => ({ ...m, attachments:[...(m.attachments||[]), att] }));
        done++; if(done===files.length)setUploading(false);
      };
      reader.readAsDataURL(file);
    });
    e.target.value = "";
  };

  const removeAtt = (id) => setMeta(m => ({ ...m, attachments:(m.attachments||[]).filter(a=>a.id!==id) }));

  // ── Insert page break ──
  const insertPageBreak = () => {
    editorRef.current?.focus();
    restoreSelection();
    document.execCommand("insertHTML", false,
      `<div class="nb-page-break" contenteditable="false"> </div><p><br></p>`);
  };

  // ── Imperative overlay positioner — zero React re-renders, stays smooth at 60fps ──
  const positionOverlay = () => {
    const c   = imgOverlayRef.current;
    const img = selImgRef.current;
    if (!c || !img) return;
    const r  = img.getBoundingClientRect();
    if (!r.width) return;
    const HS = 4, RD = 36;
    const cx = r.left + r.width / 2;
    const rotY = r.top - RD;
    // clip overlay to canvas visible rect so it never bleeds into app chrome
    const cr = canvasRef.current?.getBoundingClientRect();
    if (cr) c.style.clipPath = `inset(${cr.top}px ${Math.max(0,window.innerWidth-cr.right)}px ${Math.max(0,window.innerHeight-cr.bottom)}px ${cr.left}px)`;
    const q = s => c.querySelector(`[data-oi="${s}"]`);
    const set = (el, styles) => { if (el) Object.assign(el.style, styles); };
    set(q("border"),{left:(r.left-1)+"px",top:(r.top-1)+"px",width:(r.width+2)+"px",height:(r.height+2)+"px"});
    set(q("rotline"),{left:(cx-.5)+"px",top:(rotY+13)+"px",height:Math.max(0,r.top-rotY-13)+"px"});
    set(q("rothandle"),{left:(cx-8)+"px",top:(rotY-8)+"px"});
    const hPos = {nw:[r.left,r.top],n:[cx,r.top],ne:[r.right,r.top],e:[r.right,r.top+r.height/2],se:[r.right,r.bottom],s:[cx,r.bottom],sw:[r.left,r.bottom],w:[r.left,r.top+r.height/2]};
    c.querySelectorAll("[data-handle]").forEach(el => {
      const [hx,hy] = hPos[el.dataset.handle] || [0,0];
      el.style.left = (hx-HS)+"px"; el.style.top = (hy-HS)+"px";
    });
    set(q("del"),{left:(r.right+4)+"px",top:(r.top-1)+"px"});
  };

  // ── Sync selImgRef + run positionOverlay whenever selection changes ──
  React.useEffect(() => {
    selImgRef.current = selImg;
    if (selImg) requestAnimationFrame(positionOverlay);
  }); // run every render is fine — cheap

  // ── Native fullscreen toggle (browser handles Esc automatically) ──
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      nbContainerRef.current?.requestFullscreen().catch(console.warn);
    } else {
      document.exitFullscreen().catch(console.warn);
    }
  };
  React.useEffect(() => {
    const onFSChange = () => setNbFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFSChange);
    return () => document.removeEventListener("fullscreenchange", onFSChange);
  }, []);

  // ── Drag: resize handle ──
  const startResize = (e, handleId) => {
    e.preventDefault(); e.stopPropagation();
    const img = selImg;
    if (!img) return;
    imgDragRef.current = {
      type:"resize", handleId,
      startX: e.clientX, startY: e.clientY,
      startW: img.getBoundingClientRect().width,
      img,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  // ── Drag: rotation handle ──
  const startRotate = (e) => {
    e.preventDefault(); e.stopPropagation();
    const img = selImg;
    if (!img) return;
    const r = img.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    imgDragRef.current = {
      type:"rotate", cx, cy, img,
      startAngle: Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI,
      startRot:   parseFloat(img.dataset.rot || "0"),
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  // ── Drag: pointer move (resize or rotate) ──
  const onImgPointerMove = (e) => {
    const d = imgDragRef.current; if (!d) return;
    if (d.type === "resize") {
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      const h = d.handleId;
      let newW = d.startW;
      if (h==="e"||h==="ne"||h==="se")      newW = d.startW + dx;
      else if (h==="w"||h==="nw"||h==="sw") newW = d.startW - dx;
      else if (h==="s")                      newW = d.startW + dy;
      else if (h==="n")                      newW = d.startW - dy;
      d.img.style.width    = Math.max(40, newW) + "px";
      d.img.style.maxWidth = "100%";
    } else if (d.type === "rotate") {
      const angle  = Math.atan2(e.clientY - d.cy, e.clientX - d.cx) * 180 / Math.PI;
      let newRot   = (d.startRot + (angle - d.startAngle) + 360) % 360;
      // snap to 0 / 90 / 180 / 270 within 5°
      [0, 90, 180, 270, 360].forEach(snap => { if (Math.abs(newRot - snap) < 5) newRot = snap % 360; });
      d.img.dataset.rot       = newRot;
      d.img.style.transform   = `rotate(${newRot}deg)`;
      d.img.style.margin      = newRot % 180 !== 0 ? "24px auto" : "8px auto";
    }
    positionOverlay(); // pure DOM update — no React re-render
  };

  const onImgPointerUp = () => { imgDragRef.current = null; positionOverlay(); };

  // ── Editor click: select image or deselect ──
  const onEditorClick = (e) => {
    if (e.target.tagName === "IMG") {
      editorRef.current?.querySelectorAll("img").forEach(i => i.style.outline = "");
      setSelImg(e.target);
    } else {
      editorRef.current?.querySelectorAll("img").forEach(i => i.style.outline = "");
      setSelImg(null);
    }
  };

  // ── Save ──
  const save = async () => {
    const title = titleRef.current?.value?.trim() || "";
    // Refinement: alert() → toast
    if (!title) { notify("Please add a title before saving.", { level: "error" }); return; }
    setSaving(true);
    nbLog.debug("save:enter", { entryId: selId || "(new)" }); // entry trace for save flow
    const content = editorRef.current?.innerHTML || "";
    const entryId = selId || crypto.randomUUID();
    const entry = { id:entryId, title,
      section:meta.section, content, status:meta.status,
      date:meta.date, author:myName, attachments:meta.attachments||[] };
    try {
      await getSB()?.from("messages").insert({ channel:chKey, username:myName, color:myColor,
        content:null, share_type:"nb_entry", share_data:entry });
    } catch(err) { nbLog.warn("Notebook cloud save failed (kept locally)", err?.message || err); } // refinement: scoped logger over bare console.warn
    // Always update local state regardless of cloud success
    setEntries(prev=>[...prev.filter(e=>e.id!==entry.id),
      {...entry,_ts:new Date().toISOString()}].sort((a,b)=>a.date<b.date?1:-1));
    setSelId(entry.id); setIsNew(false); setSaving(false);
    nbLog.debug("save:exit", { entryId, title }); // exit trace for save flow
  };

  const toggleStatus = async () => {
    const entry = entries.find(e=>e.id===selId); if (!entry) return;
    const updated = {...entry, status:entry.status==="complete"?"in-progress":"complete"};
    await getSB()?.from("messages").insert({ channel:chKey, username:myName, color:myColor,
      content:null, share_type:"nb_entry", share_data:updated });
    setEntries(prev=>prev.map(e=>e.id===entry.id?{...updated,_ts:new Date().toISOString()}:e));
    setMeta(m=>({...m,status:updated.status}));
  };

  const sec = s => NB_SECTIONS.find(x=>x.id===s) || NB_SECTIONS[0];
  const fmtSize = b => b<1024*1024?`${(b/1024).toFixed(0)} KB`:`${(b/(1024*1024)).toFixed(1)} MB`;

  // ── Export current entry as PDF (opens print dialog in new tab) ──
  const exportPDF = () => {
    const title = (titleRef.current?.value || "Entry").trim();
    const content = editorRef.current?.innerHTML || "<p>No content</p>";
    const sectionLabel = sec(meta.section).label;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
      <style>
        @page { size: letter; margin: 72px 96px; }
        body { font-family: Arial,sans-serif; font-size: 11pt; color: #202124; line-height: 1.75; margin: 0; }
        h1 { font-size: 22pt; font-weight: 700; margin: 18px 0 8px; }
        h2 { font-size: 16pt; font-weight: 700; margin: 14px 0 6px; }
        h3 { font-size: 13pt; font-weight: 700; margin: 12px 0 4px; }
        ul { list-style-type: disc; padding-left: 32px; margin: 4px 0; }
        ol { list-style-type: decimal; padding-left: 32px; margin: 4px 0; }
        img { max-width: 100%; border-radius: 4px; page-break-inside: avoid; }
        blockquote { border-left: 3px solid #dadce0; margin: 8px 0 8px 16px; padding-left: 16px; color: #5f6368; }
        pre { background: #f8f9fa; padding: 12px; border-radius: 4px; font-size: 10pt; font-family: monospace; }
        .hdr { margin-bottom: 24px; padding-bottom: 12px; border-bottom: 2px solid #e8eaed; }
        .hdr h1 { margin: 0 0 4px; font-size: 20pt; }
        .meta { color: #9aa0a6; font-size: 9pt; }
        @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
      </style>
    </head><body>
      <div class="hdr">
        <h1>${title}</h1>
        <p class="meta">${sectionLabel} &nbsp;·&nbsp; ${meta.date}${meta.status==="complete"?" &nbsp;·&nbsp; ✓ Complete":""}</p>
      </div>
      ${content}
    </body></html>`;
    const w = window.open("", "_blank");
    // Refinement: alert() → toast; sticky (duration 0 would persist, but 8s gives time to act)
    if (!w) { notify("Pop-up blocked — allow pop-ups for this site to export as PDF.", { level: "error", duration: 8000 }); nbLog.warn("PDF export blocked by popup blocker"); return; }
    w.document.write(html); w.document.close();
    setTimeout(() => w.print(), 400);
  };

  // ── Export all entries as JSON backup ──
  const exportJSON = () => {
    // Refinement: alert() → toast
    if (!entries.length) { notify("No entries to export.", { level: "info" }); return; }
    const blob = new Blob([JSON.stringify(entries, null, 2)], {type:"application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `vexhub-notebook-${new Date().toISOString().split("T")[0]}.json`;
    a.click(); URL.revokeObjectURL(url);
  };

  // ── Import entries from JSON backup ──
  const importJSON = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const raw = JSON.parse(ev.target.result);
        const list = Array.isArray(raw) ? raw : [];
        const valid = list.filter(x => x?.id && x?.title);
        // Refinement: all three import outcomes were alert() — now toasts with levels + logs
        if (!valid.length) { notify("No valid entries found in this file.", { level: "error" }); nbLog.warn("import rejected: no valid entries"); return; }
        setEntries(prev => {
          const map = {};
          [...prev, ...valid].forEach(x => { map[x.id] = x; });
          return Object.values(map).sort((a,b) => a.date < b.date ? 1 : -1);
        });
        notify(`Imported ${valid.length} entr${valid.length===1?"y":"ies"} successfully.`, { level: "success" });
        nbLog.info("import succeeded", { count: valid.length });
      } catch (err) { notify("Could not read file — use a .json file exported from VexHub Notebook.", { level: "error" }); nbLog.warn("import failed: unparseable file", err?.message || err); }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  // ── Toolbar button + divider helpers ──
  const TBtn = ({onClick,title,active,children,danger}) => (
    <button onMouseDown={e=>{e.preventDefault();saveSelection();onClick();}} title={title}
      style={{background:active?"rgba(26,115,232,0.15)":danger?"rgba(217,48,37,0.07)":"transparent",
        border:active?"1px solid rgba(26,115,232,0.35)":danger?"1px solid rgba(217,48,37,0.2)":"1px solid transparent",
        color:active?"#1a73e8":danger?"#d93025":"#5f6368",borderRadius:4,padding:"3px 7px",
        fontSize:13,fontWeight:600,cursor:"pointer",minWidth:28,height:28,
        display:"flex",alignItems:"center",justifyContent:"center",gap:3,transition:"background 0.1s"}}
      onMouseEnter={e=>{if(!active)e.currentTarget.style.background="rgba(0,0,0,0.06)";}}
      onMouseLeave={e=>{if(!active)e.currentTarget.style.background=danger?"rgba(217,48,37,0.07)":"transparent";}}>
      {children}
    </button>
  );
  const TDiv = () => <div style={{width:1,height:20,background:"#dadce0",margin:"0 4px",flexShrink:0}}/>;

  return (
    <div ref={nbContainerRef} className="nb-outer"
      style={{display:"flex",height:"100%",overflow:"hidden",position:"relative",background:"#f0f4f8"}}>

      {/* ═══ CSS ═══ */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&family=Open+Sans:wght@400;700&family=Lato:wght@400;700&family=Merriweather:wght@400;700&family=Playfair+Display:wght@400;700&display=swap');
        .nb-outer:fullscreen         { display:flex!important; width:100vw!important; height:100vh!important; overflow:hidden!important; }
        .nb-outer:-webkit-full-screen { display:flex!important; width:100vw!important; height:100vh!important; overflow:hidden!important; }
        .nb-doc { outline:none; font-family:Arial,sans-serif; font-size:11pt; color:#202124; line-height:1.75; }
        .nb-doc h1 { font-size:22pt; font-weight:700; margin:18px 0 8px; color:#202124; line-height:1.25; }
        .nb-doc h2 { font-size:16pt; font-weight:700; margin:14px 0 6px; color:#202124; line-height:1.35; }
        .nb-doc h3 { font-size:13pt; font-weight:700; margin:12px 0 4px; color:#444746; }
        .nb-doc p  { margin:3px 0; min-height:1.2em; }
        .nb-doc ul { list-style-type:disc   !important; padding-left:32px; margin:4px 0; }
        .nb-doc ol { list-style-type:decimal!important; padding-left:32px; margin:4px 0; }
        .nb-doc li { display:list-item!important; margin:3px 0; }
        .nb-doc img { max-width:100%; border-radius:6px; margin:8px auto; cursor:pointer; display:block; box-shadow:0 1px 6px rgba(0,0,0,0.18); transition:box-shadow 0.15s; }
        .nb-doc img:hover { box-shadow:0 2px 12px rgba(0,0,0,0.25); }
        .nb-doc:empty:before { content:attr(data-placeholder); color:#9aa0a6; pointer-events:none; }
        .nb-doc a { color:#1a73e8; }
        .nb-page-break { width:calc(100% + 192px); margin:48px -96px; border:none; border-top:2px dashed #dadce0; display:block; position:relative; }
        .nb-page-break:after { content:'— page break —'; position:absolute; top:-9px; left:50%; transform:translateX(-50%); background:#fff; color:#bdc1c6; font-size:9px; padding:0 10px; letter-spacing:0.08em; pointer-events:none; }
        .nb-sidebar-item:hover { background:rgba(0,0,0,0.04)!important; }
        .nb-sidebar-item.active { background:rgba(26,115,232,0.1)!important; }
        .nb-tb-btn:hover { background:rgba(0,0,0,0.06)!important; }
      `}</style>

      {/* ═══ Sidebar ═══ */}
      {sidebarOpen && (
        <div style={{width:256,flexShrink:0,background:"#fff",borderRight:"1px solid #e0e0e0",
          display:"flex",flexDirection:"column",overflow:"hidden",boxShadow:"1px 0 4px rgba(0,0,0,0.06)"}}>

          {/* Sidebar header */}
          <div style={{padding:"12px 14px 10px",borderBottom:"1px solid #e8eaed",flexShrink:0}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
              <p style={{color:"#202124",fontWeight:700,fontSize:13,fontFamily:"'Google Sans',sans-serif"}}>
                📓 Notebook
              </p>
              <div style={{display:"flex",gap:4}}>
                <button onClick={exportJSON} title="Download all entries as JSON backup"
                  style={{background:"transparent",border:"1px solid #dadce0",color:"#5f6368",
                    borderRadius:4,padding:"2px 7px",fontSize:10,cursor:"pointer",fontWeight:500}}>
                  💾 Backup
                </button>
                <button onClick={toggleFullscreen}
                  title={nbFullscreen?"Exit full screen (Esc)":"Full screen"}
                  style={{background:nbFullscreen?"#e8f0fe":"transparent",
                    border:`1px solid ${nbFullscreen?"#1a73e8":"#dadce0"}`,
                    color:nbFullscreen?"#1a73e8":"#5f6368",
                    borderRadius:4,padding:"2px 6px",fontSize:12,cursor:"pointer",fontWeight:500,lineHeight:1}}>
                  {nbFullscreen ? "⊡" : "⛶"}
                </button>
              </div>
            </div>
            <p style={{color:"#9aa0a6",fontSize:10}}>{entries.length} entr{entries.length===1?"y":"ies"}</p>
          </div>

          {/* hidden import input */}
          <input ref={importRef} type="file" accept=".json" onChange={importJSON} style={{display:"none"}}/>

          {/* New entry button */}
          <div style={{padding:"10px 12px",borderBottom:"1px solid #e8eaed",flexShrink:0}}>
            <button onClick={openNew}
              style={{width:"100%",background:"#fff",border:"1px solid #dadce0",color:"#444746",
                borderRadius:24,padding:"8px 16px",fontSize:13,fontWeight:500,cursor:"pointer",
                display:"flex",alignItems:"center",gap:8,boxShadow:"0 1px 2px rgba(0,0,0,0.1)",
                transition:"box-shadow 0.15s"}}
              onMouseEnter={e=>e.currentTarget.style.boxShadow="0 1px 6px rgba(0,0,0,0.2)"}
              onMouseLeave={e=>e.currentTarget.style.boxShadow="0 1px 2px rgba(0,0,0,0.1)"}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#444746" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>
              </svg>
              New Entry
            </button>
          </div>

          {/* Entry list */}
          <div style={{flex:1,overflowY:"auto",padding:"6px 0"}}>
            {NB_SECTIONS.map(s => {
              const group = entries.filter(e=>(e.section||"design")===s.id);
              if (!group.length) return null;
              return (
                <div key={s.id} style={{marginBottom:4}}>
                  <p style={{color:s.color,fontSize:10,fontWeight:700,letterSpacing:"0.06em",
                    padding:"8px 16px 4px",textTransform:"uppercase",opacity:0.85}}>
                    {s.label}
                  </p>
                  {group.map(e => (
                    <button key={e.id} onClick={()=>openEntry(e)}
                      className={`nb-sidebar-item${selId===e.id?" active":""}`}
                      style={{width:"100%",textAlign:"left",padding:"7px 16px",border:"none",
                        cursor:"pointer",display:"flex",alignItems:"center",gap:10,
                        background:selId===e.id?"rgba(26,115,232,0.1)":"transparent",
                        borderLeft:`3px solid ${selId===e.id?s.color:"transparent"}`}}>
                      <div style={{width:8,height:8,borderRadius:"50%",flexShrink:0,
                        background:e.status==="complete"?"#34a853":"#dadce0",
                        border:`1.5px solid ${e.status==="complete"?"#34a853":"#bdc1c6"}`}}/>
                      <div style={{flex:1,minWidth:0}}>
                        <p style={{color:selId===e.id?"#1a73e8":"#202124",fontSize:12,
                          fontWeight:selId===e.id?600:400,
                          overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                          {e.title || "Untitled"}
                        </p>
                        <p style={{color:"#9aa0a6",fontSize:10,display:"flex",alignItems:"center",gap:4}}>
                          {e.date}
                          {(e.attachments||[]).length>0 &&
                            <span>· 📎{e.attachments.length}</span>}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              );
            })}
            {entries.length===0 &&
              <p style={{color:"#9aa0a6",fontSize:12,textAlign:"center",padding:"32px 16px",lineHeight:1.7}}>
                No entries yet.<br/>Click New Entry to get started.
              </p>}
          </div>
        </div>
      )}

      {/* ═══ Main document area ═══ */}
      <div style={{flex:1,display:"flex",flexDirection:"column",minWidth:0,overflow:"hidden"}}>

        {(isNew || selId) ? (<>

          {/* ── Google-Docs-style menu bar ── */}
          <div style={{background:"#fff",borderBottom:"1px solid #e0e0e0",flexShrink:0,
            boxShadow:"0 1px 3px rgba(0,0,0,0.08)"}}>

            {/* Top meta row */}
            <div style={{display:"flex",alignItems:"center",gap:8,padding:"8px 16px 0",flexWrap:"wrap"}}>
              <button onClick={()=>setSidebarOpen(o=>!o)}
                style={{background:"transparent",border:"none",cursor:"pointer",padding:4,
                  color:"#5f6368",borderRadius:4,display:"flex",alignItems:"center"}}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
                </svg>
              </button>

              <input ref={titleRef} defaultValue="" placeholder="Untitled entry"
                style={{flex:1,border:"none",outline:"none",fontSize:16,fontWeight:600,
                  color:"#202124",background:"transparent",fontFamily:"'Google Sans',Arial,sans-serif",
                  minWidth:120}}/>

              {/* Section pill */}
              <select value={meta.section} onChange={e=>setMeta(m=>({...m,section:e.target.value}))}
                style={{background:"transparent",border:`1.5px solid ${sec(meta.section).color}`,
                  color:sec(meta.section).color,borderRadius:20,padding:"2px 10px",
                  fontSize:11,fontWeight:700,cursor:"pointer",outline:"none"}}>
                {NB_SECTIONS.map(s=><option key={s.id} value={s.id}>{s.label}</option>)}
              </select>

              <input value={meta.date} onChange={e=>setMeta(m=>({...m,date:e.target.value}))} type="date"
                style={{border:"1px solid #dadce0",color:"#5f6368",borderRadius:6,
                  padding:"2px 8px",fontSize:11,outline:"none",background:"transparent"}}/>

              <button onClick={toggleStatus}
                style={{background:meta.status==="complete"?"#e6f4ea":"#fff",
                  border:`1px solid ${meta.status==="complete"?"#34a853":"#dadce0"}`,
                  color:meta.status==="complete"?"#34a853":"#5f6368",
                  borderRadius:20,padding:"3px 12px",fontSize:11,fontWeight:600,cursor:"pointer"}}>
                {meta.status==="complete"?"✓ Complete":"In Progress"}
              </button>

              {/* Export PDF button (only when content exists) */}
              {(selId || isNew) && (
                <button onClick={exportPDF} title="Export this entry as PDF"
                  style={{background:"#fff",border:"1px solid #dadce0",color:"#5f6368",
                    borderRadius:6,padding:"5px 10px",fontSize:12,fontWeight:500,cursor:"pointer",
                    display:"flex",alignItems:"center",gap:4}}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                  PDF
                </button>
              )}

              <button onClick={save} disabled={saving}
                style={{background:"#1a73e8",border:"none",color:"#fff",borderRadius:6,
                  padding:"5px 16px",fontSize:12,fontWeight:600,cursor:"pointer",
                  opacity:saving?0.7:1,fontFamily:"'Google Sans',Arial,sans-serif"}}>
                {saving?"Saving…":"Save"}
              </button>
            </div>

            {/* ── Formatting toolbar ── */}
            <div style={{display:"flex",alignItems:"center",gap:1,padding:"4px 14px 7px",flexWrap:"wrap",borderTop:"1px solid #f1f3f4"}}>

              {/* Undo / Redo */}
              <TBtn onClick={()=>execFmt("undo")} title="Undo"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg></TBtn>
              <TBtn onClick={()=>execFmt("redo")} title="Redo"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 14 20 9 15 4"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/></svg></TBtn>
              <TDiv/>

              {/* Font family */}
              <select value={fontFamily} onMouseDown={saveSelection}
                onChange={e=>{ const f=e.target.value; setFontFamily(f); execFmt("fontName",f); }}
                style={{border:"1px solid #dadce0",color:"#202124",background:"#fff",
                  borderRadius:4,padding:"2px 6px",fontSize:12,cursor:"pointer",outline:"none",
                  height:28,minWidth:140,fontFamily:fontFamily}}>
                <option value="Arial"            style={{fontFamily:"Arial"}}>Arial</option>
                <option value="Calibri"          style={{fontFamily:"Calibri"}}>Calibri</option>
                <option value="Times New Roman"  style={{fontFamily:"'Times New Roman'"}}>Times New Roman</option>
                <option value="Georgia"          style={{fontFamily:"Georgia"}}>Georgia</option>
                <option value="Courier New"      style={{fontFamily:"'Courier New'"}}>Courier New</option>
                <option value="Verdana"          style={{fontFamily:"Verdana"}}>Verdana</option>
                <option value="Trebuchet MS"     style={{fontFamily:"'Trebuchet MS'"}}>Trebuchet MS</option>
                <option value="Garamond"         style={{fontFamily:"Garamond"}}>Garamond</option>
                <option value="Roboto"           style={{fontFamily:"Roboto"}}>Roboto</option>
                <option value="Open Sans"        style={{fontFamily:"'Open Sans'"}}>Open Sans</option>
                <option value="Lato"             style={{fontFamily:"Lato"}}>Lato</option>
                <option value="Merriweather"     style={{fontFamily:"Merriweather"}}>Merriweather</option>
                <option value="Playfair Display" style={{fontFamily:"'Playfair Display'"}}>Playfair Display</option>
              </select>
              <TDiv/>

              {/* Text style dropdown */}
              <select value={blockFmt} onChange={e=>applyBlock(e.target.value)}
                style={{border:"1px solid #dadce0",color:"#202124",background:"#fff",
                  borderRadius:4,padding:"2px 6px",fontSize:12,cursor:"pointer",outline:"none",height:28,minWidth:110}}>
                <option value="p">Normal text</option>
                <option value="h1">Heading 1</option>
                <option value="h2">Heading 2</option>
                <option value="h3">Heading 3</option>
                <option value="pre">Monospace</option>
                <option value="blockquote">Quote</option>
              </select>
              <TDiv/>

              {/* Bold / Italic / Underline / Strike */}
              <TBtn onClick={()=>execFmt("bold")} title="Bold (Ctrl+B)"><b style={{fontSize:14,fontFamily:"Georgia,serif"}}>B</b></TBtn>
              <TBtn onClick={()=>execFmt("italic")} title="Italic (Ctrl+I)"><i style={{fontSize:14,fontFamily:"Georgia,serif"}}>I</i></TBtn>
              <TBtn onClick={()=>execFmt("underline")} title="Underline (Ctrl+U)"><u style={{fontSize:13}}>U</u></TBtn>
              <TBtn onClick={()=>execFmt("strikeThrough")} title="Strikethrough"><s style={{fontSize:13}}>S</s></TBtn>
              <TDiv/>

              {/* Colour picker */}
              <div style={{position:"relative"}}>
                <TBtn onClick={()=>setColorOpen(o=>!o)} title="Text colour">
                  <span style={{fontSize:13,fontWeight:700,color:"#202124"}}>A</span>
                  <span style={{width:16,height:3,borderRadius:2,background:"linear-gradient(90deg,#1a73e8,#d93025,#34a853,#8430ce)",display:"block"}}/>
                </TBtn>
                {colorOpen && (
                  <div onMouseDown={e=>e.preventDefault()}
                    style={{position:"absolute",top:"100%",left:0,zIndex:200,background:"#fff",
                      border:"1px solid #dadce0",borderRadius:8,padding:10,
                      boxShadow:"0 4px 16px rgba(0,0,0,0.15)",display:"grid",
                      gridTemplateColumns:"repeat(6,22px)",gap:4,width:164,marginTop:4}}>
                    {PALETTE.map(c=>(
                      <button key={c} onMouseDown={e=>{e.preventDefault();execFmt("foreColor",c);setColorOpen(false);}}
                        title={c} style={{width:22,height:22,borderRadius:4,background:c,border:"1.5px solid rgba(0,0,0,0.1)",cursor:"pointer",padding:0}}/>
                    ))}
                    <button onMouseDown={e=>{e.preventDefault();execFmt("removeFormat");setColorOpen(false);}}
                      style={{gridColumn:"span 2",fontSize:9,color:"#5f6368",border:"1px solid #dadce0",borderRadius:4,cursor:"pointer",padding:"2px 4px",background:"transparent"}}>
                      Clear
                    </button>
                  </div>
                )}
              </div>
              <TDiv/>

              {/* Highlight */}
              <TBtn onClick={()=>execFmt("hiliteColor","#fff176")} title="Highlight yellow"><span style={{background:"#fff176",fontSize:11,padding:"1px 4px",borderRadius:2,fontWeight:700}}>H</span></TBtn>
              <TBtn onClick={()=>execFmt("hiliteColor","#a8f0c6")} title="Highlight green"><span style={{background:"#a8f0c6",fontSize:11,padding:"1px 4px",borderRadius:2,fontWeight:700}}>H</span></TBtn>
              <TBtn onClick={()=>execFmt("hiliteColor","transparent")} title="Remove highlight"><span style={{fontSize:11,fontWeight:700,textDecoration:"line-through",color:"#9aa0a6"}}>H</span></TBtn>
              <TDiv/>

              {/* Lists */}
              <TBtn onClick={()=>execFmt("insertUnorderedList")} title="Bullet list">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4.5" cy="6" r="1.5" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="1.5" fill="currentColor" stroke="none"/></svg>
              </TBtn>
              <TBtn onClick={()=>execFmt("insertOrderedList")} title="Numbered list">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4M4 10h2" strokeWidth="1.8"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" strokeWidth="1.8"/></svg>
              </TBtn>
              <TBtn onClick={()=>execFmt("outdent")} title="Decrease indent"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="12" x2="9" y2="12"/><line x1="21" y1="18" x2="3" y2="18"/><polyline points="7 9 3 12 7 15"/></svg></TBtn>
              <TBtn onClick={()=>execFmt("indent")} title="Increase indent"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/><polyline points="11 9 15 12 11 15"/></svg></TBtn>
              <TDiv/>

              {/* Alignment — all 4 with active state */}
              <TBtn onClick={()=>execFmt("justifyLeft")}   active={activeAlign==="left"}   title="Align left">   <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="18" x2="18" y2="18"/></svg></TBtn>
              <TBtn onClick={()=>execFmt("justifyCenter")} active={activeAlign==="center"} title="Centre">       <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="6" y1="12" x2="18" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg></TBtn>
              <TBtn onClick={()=>execFmt("justifyRight")}  active={activeAlign==="right"}  title="Align right">  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="6" y1="18" x2="21" y2="18"/></svg></TBtn>
              <TBtn onClick={()=>execFmt("justifyFull")}   active={activeAlign==="full"}   title="Justify">      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg></TBtn>
              <TDiv/>

              {/* Insert image inline */}
              <TBtn onClick={()=>{saveSelection();imgFileRef.current?.click();}} title="Insert image">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                <span style={{fontSize:11}}>Image</span>
              </TBtn>
              <input ref={imgFileRef} type="file" accept="image/*" onChange={handleImageInsert} style={{display:"none"}}/>

              {/* Attach PDF */}
              <TBtn onClick={()=>fileRef.current?.click()} title="Attach PDF">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                <span style={{fontSize:11}}>PDF</span>
              </TBtn>
              <input ref={fileRef} type="file" accept="application/pdf" multiple onChange={handlePdfAttach} style={{display:"none"}}/>

              {/* Page break */}
              <TBtn onClick={()=>{saveSelection();insertPageBreak();}} title="Insert page break">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="12" x2="21" y2="12" strokeDasharray="3 2"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
                <span style={{fontSize:11}}>Break</span>
              </TBtn>

            </div>
          </div>

          {/* ── Document canvas ── */}
          <div ref={canvasRef}
            onClick={()=>{if(colorOpen)setColorOpen(false);}}
            onScroll={positionOverlay}
            style={{flex:1,overflowY:"auto",background:"#e8eaed",padding:"32px 0 60px",
              display:"flex",flexDirection:"column",alignItems:"center"}}>

            {/* Pages stack — N white cards with grey gaps between them */}
            <div style={{width:"100%",maxWidth:850,position:"relative"}}>

              {/* Absolute page-card backgrounds */}
              {Array.from({length:numPages}).map((_,i)=>(
                <div key={i} style={{
                  position:"absolute",
                  top:  i*(NB_PAGE_H+NB_PAGE_GAP),
                  left: 0, right: 0,
                  height: NB_PAGE_H,
                  background:"#fff",
                  borderRadius:2,
                  boxShadow:"0 1px 4px rgba(60,64,67,0.22),0 4px 16px rgba(60,64,67,0.12)",
                  pointerEvents:"none",
                }}/>
              ))}

              {/* Content overlay (flows over the page cards) */}
              <div style={{
                position:"relative", zIndex:1,
                minHeight: numPages*(NB_PAGE_H+NB_PAGE_GAP)-NB_PAGE_GAP,
                padding:`${NB_MARG_V}px ${NB_MARG_H}px`,
              }}>

                {/* Rich-text editor */}
                <div ref={editorRef} className="nb-doc" contentEditable suppressContentEditableWarning
                  data-placeholder="Start writing your notebook entry here…"
                  onInput={()=>setWordCount((editorRef.current?.innerText||"").trim().split(/\s+/).filter(Boolean).length)}
                  onBlur={saveSelection}
                  onClick={onEditorClick}/>

                {/* PDF attachments section */}
                {(meta.attachments||[]).filter(a=>a.type==="pdf").length > 0 && (
                  <div style={{marginTop:48,paddingTop:20,borderTop:"1px solid #e8eaed"}}>
                    <p style={{fontSize:10,fontWeight:700,color:"#9aa0a6",letterSpacing:"0.07em",textTransform:"uppercase",marginBottom:10}}>Attachments</p>
                    <div style={{display:"flex",flexWrap:"wrap",gap:10}}>
                      {(meta.attachments||[]).filter(a=>a.type==="pdf").map(att => (
                        <div key={att.id} style={{position:"relative",display:"flex",alignItems:"center",gap:10,
                          padding:"10px 14px",borderRadius:8,border:"1px solid #e8eaed",background:"#fafafa",
                          cursor:"pointer",minWidth:200,maxWidth:280}} onClick={()=>setPdfModal(att)}>
                          <div style={{width:36,height:36,borderRadius:8,background:"#fce8e6",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d93025" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="15" x2="15" y2="15"/><line x1="9" y1="11" x2="11" y2="11"/></svg>
                          </div>
                          <div style={{flex:1,minWidth:0}}>
                            <p style={{color:"#202124",fontSize:12,fontWeight:500,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{att.name}</p>
                            <p style={{color:"#9aa0a6",fontSize:10}}>{fmtSize(att.size)} · Click to open</p>
                          </div>
                          <button onClick={e=>{e.stopPropagation();removeAtt(att.id);}} style={{position:"absolute",top:4,right:4,background:"none",border:"none",color:"#9aa0a6",fontSize:14,cursor:"pointer",padding:2,lineHeight:1}}>×</button>
                        </div>
                      ))}
                      <button onClick={()=>fileRef.current?.click()} style={{display:"flex",alignItems:"center",gap:6,padding:"10px 14px",borderRadius:8,border:"1.5px dashed #dadce0",background:"transparent",color:"#9aa0a6",fontSize:12,cursor:"pointer"}}>+ Attach PDF</button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Word count + page nav */}
            <div style={{width:"100%",maxWidth:850,display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 4px",marginTop:6}}>
              <p style={{color:"#9aa0a6",fontSize:11}}>{wordCount} word{wordCount!==1?"s":""}</p>
              {totalPgs > 0 && !isNew && (
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <button onClick={()=>goPage(pageIdx+1)} disabled={pageIdx>=totalPgs-1}
                    style={{background:"#fff",border:"1px solid #dadce0",borderRadius:6,padding:"4px 12px",fontSize:11,fontWeight:500,
                      cursor:pageIdx>=totalPgs-1?"default":"pointer",color:pageIdx>=totalPgs-1?"#bdc1c6":"#1a73e8",
                      display:"flex",alignItems:"center",gap:4}}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>Older
                  </button>
                  <span style={{color:"#5f6368",fontSize:11,fontWeight:500}}>{pageIdx+1} / {totalPgs}</span>
                  <button onClick={()=>goPage(pageIdx-1)} disabled={pageIdx<=0}
                    style={{background:"#fff",border:"1px solid #dadce0",borderRadius:6,padding:"4px 12px",fontSize:11,fontWeight:500,
                      cursor:pageIdx<=0?"default":"pointer",color:pageIdx<=0?"#bdc1c6":"#1a73e8",
                      display:"flex",alignItems:"center",gap:4}}>
                    Newer<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* ── Google Docs-style image selection overlay (positions set imperatively) ── */}
          {selImg && (
            <div ref={imgOverlayRef} style={{position:"fixed",inset:0,zIndex:4999,pointerEvents:"none"}}>
              {/* Selection border */}
              <div data-oi="border" style={{position:"fixed",border:"2px solid #1a73e8",pointerEvents:"none",boxSizing:"border-box"}}/>
              {/* Rotation line */}
              <div data-oi="rotline" style={{position:"fixed",width:1,background:"#1a73e8",pointerEvents:"none"}}/>
              {/* Rotation handle */}
              <div data-oi="rothandle"
                onPointerDown={startRotate} onPointerMove={onImgPointerMove} onPointerUp={onImgPointerUp}
                style={{position:"fixed",width:16,height:16,borderRadius:"50%",background:"#fff",
                  border:"2px solid #1a73e8",cursor:"grab",pointerEvents:"all",
                  display:"flex",alignItems:"center",justifyContent:"center",
                  fontSize:11,color:"#1a73e8",fontWeight:700,
                  boxShadow:"0 1px 4px rgba(0,0,0,0.25)",userSelect:"none"}}>↻</div>
              {/* 8 resize handles — cursors baked in, positions set by positionOverlay */}
              {[["nw","nw-resize"],["n","n-resize"],["ne","ne-resize"],["e","e-resize"],
                ["se","se-resize"],["s","s-resize"],["sw","sw-resize"],["w","w-resize"]].map(([id,cur])=>(
                <div key={id} data-handle={id}
                  onPointerDown={e=>startResize(e,id)}
                  onPointerMove={onImgPointerMove}
                  onPointerUp={onImgPointerUp}
                  style={{position:"fixed",width:8,height:8,background:"#fff",
                    border:"2px solid #1a73e8",borderRadius:2,cursor:cur,
                    pointerEvents:"all",boxShadow:"0 1px 3px rgba(0,0,0,0.2)"}}/>
              ))}
              {/* Delete badge */}
              <div data-oi="del" onClick={()=>{selImg.remove();setSelImg(null);}}
                style={{position:"fixed",background:"#d93025",color:"#fff",borderRadius:4,
                  padding:"1px 6px",fontSize:12,fontWeight:700,cursor:"pointer",
                  pointerEvents:"all",boxShadow:"0 1px 4px rgba(0,0,0,0.25)",
                  lineHeight:"18px",userSelect:"none"}}>✕</div>
            </div>
          )}

        </>) : (
          /* ── Splash ── */
          <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",background:"#f8f9fa",padding:40,textAlign:"center"}}>
            <div style={{width:80,height:80,borderRadius:16,background:"#e8f0fe",display:"flex",alignItems:"center",justifyContent:"center",marginBottom:20}}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#1a73e8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
            </div>
            <p style={{color:"#202124",fontWeight:700,fontSize:22,marginBottom:8,fontFamily:"Arial,sans-serif"}}>Engineering Notebook</p>
            <p style={{color:"#5f6368",fontSize:14,marginBottom:28,maxWidth:340,lineHeight:1.7}}>Document design decisions, build logs, test results, and competition prep. Attach photos and PDFs directly into your entries.</p>
            <button onClick={openNew} style={{background:"#1a73e8",border:"none",color:"#fff",borderRadius:6,padding:"10px 28px",fontSize:14,fontWeight:600,cursor:"pointer",boxShadow:"0 1px 3px rgba(0,0,0,0.2)"}}>+ New Entry</button>
          </div>
        )}
      </div>

      {/* ═══ Image lightbox ═══ */}
      {lightbox && (
        <div onClick={()=>setLightbox(null)} style={{position:"fixed",inset:0,zIndex:10001,background:"rgba(0,0,0,0.92)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:12}}>
          <button onClick={()=>setLightbox(null)} style={{position:"absolute",top:20,right:24,background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",borderRadius:"50%",width:38,height:38,fontSize:22,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>×</button>
          <img src={lightbox.data} alt="attachment" style={{maxWidth:"90vw",maxHeight:"85vh",borderRadius:8,objectFit:"contain",boxShadow:"0 24px 80px rgba(0,0,0,0.6)"}}/>
        </div>
      )}

      {/* ═══ PDF viewer modal ═══ */}
      {pdfModal && (
        <div style={{position:"fixed",inset:0,zIndex:10001,background:"rgba(0,0,0,0.95)",display:"flex",flexDirection:"column"}}>
          <div style={{height:52,background:"#202124",display:"flex",alignItems:"center",padding:"0 20px",gap:12,flexShrink:0}}>
            <div style={{width:30,height:30,borderRadius:6,background:"#fce8e6",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#d93025" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            </div>
            <div style={{flex:1}}><p style={{color:"#e8eaed",fontSize:13,fontWeight:600}}>{pdfModal.name}</p><p style={{color:"#9aa0a6",fontSize:10}}>{fmtSize(pdfModal.size)} · scroll or use keyboard to navigate pages</p></div>
            <a href={pdfModal.data} download={pdfModal.name} style={{background:"rgba(255,255,255,0.1)",border:"1px solid rgba(255,255,255,0.2)",color:"#e8eaed",borderRadius:6,padding:"5px 14px",fontSize:12,fontWeight:500,textDecoration:"none",display:"flex",alignItems:"center",gap:5}}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Download
            </a>
            <button onClick={()=>setPdfModal(null)} style={{background:"rgba(217,48,37,0.15)",border:"1px solid rgba(217,48,37,0.3)",color:"#f28b82",borderRadius:6,padding:"5px 14px",fontSize:12,fontWeight:600,cursor:"pointer"}}>Close</button>
          </div>
          <embed src={pdfModal.data} type="application/pdf" style={{flex:1,width:"100%",border:"none"}}/>
        </div>
      )}
    </div>
  );
}

// ── Chat theme context + token factory ───────────────────────────────────
const ChatThemeCtx = React.createContext(false);
function chatColors(dark) {
  return {
    // Backgrounds — graphite ramp in dark (Voltz brand), light slate ramp in light
    outerBg:            dark ? '#141416' : '#ffffff',
    sidebarBg:          dark ? '#1c1c20' : '#f1f5f9',
    headerBg:           dark ? '#141416' : '#ffffff',
    msgAreaBg:          dark ? '#141416' : '#ffffff',
    membersBg:          dark ? '#171719' : '#f8fafc',
    inputBg:            dark ? '#1c1c20' : '#f1f5f9',
    cardBg:             dark ? '#1c1c20' : '#ffffff',
    inviteCodeBg:       dark ? '#141416' : '#ffffff',
    userPanelBg:        dark ? 'rgba(0,0,0,0.25)' : 'rgba(0,0,0,0.03)',
    hoverBg:            dark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.025)',
    deleteBtnBg:        dark ? '#2b2b30' : '#f3f4f6',
    shareCardBg:        dark ? '#232327' : '#f8fafc',
    addChInputBg:       dark ? '#141416' : '#ffffff',
    // Borders
    border:             dark ? 'rgba(255,255,255,0.07)' : '#e2e8f0',
    accentBorder:       dark ? 'rgba(220,38,38,0.28)' : 'rgba(220,38,38,0.18)',
    imgBorder:          dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.07)',
    membersBorder:      dark ? 'rgba(255,255,255,0.05)' : '#e2e8f0',
    // Text
    textPrimary:        dark ? '#f4f4f5' : '#111827',
    textSecond:         dark ? '#e4e4e7' : '#374151',
    textMuted:          dark ? '#a1a1aa' : '#6b7280',
    textDim:            dark ? '#52525b' : '#9ca3af',
    textChannel:        dark ? '#71717a' : '#6b7280',
    textTime:           dark ? '#71717a' : '#9ca3af',
    textLabel:          dark ? '#3f3f46' : '#9ca3af',
    // Accent (Voltz red in both)
    accentText:         dark ? '#ff6b6b' : '#dc2626',
    accentBg:           dark ? 'rgba(220,38,38,0.12)' : 'rgba(220,38,38,0.08)',
    accentActive:       dark ? 'rgba(220,38,38,0.18)' : 'rgba(220,38,38,0.1)',
    // Specific
    statusBorder:       dark ? '#1c1c20' : '#f1f5f9',
    memberStatusBorder: dark ? '#171719' : '#f8fafc',
    onlineText:         dark ? '#4ade80' : '#16a34a',
    dndText:            dark ? '#f87171' : '#dc2626',
    inviteCode:         dark ? '#ff6b6b' : '#dc2626',
    inviteCopyBg:       dark ? 'rgba(220,38,38,0.1)' : 'rgba(220,38,38,0.07)',
    inviteCopyBd:       dark ? 'rgba(220,38,38,0.22)' : 'rgba(220,38,38,0.2)',
    callBtnBg:          dark ? 'rgba(220,38,38,0.1)' : 'rgba(220,38,38,0.06)',
    callBtnBd:          dark ? 'rgba(220,38,38,0.24)' : '#e2e8f0',
    callBtnColor:       dark ? '#ff6b6b' : '#9ca3af',
    sendBtnInactive:    dark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)',
    meetingBg:          dark ? 'rgba(34,197,94,0.05)' : 'rgba(34,197,94,0.05)',
    meetingBorder:      'rgba(34,197,94,0.25)',
    meetingIcon:        dark ? '#4ade80' : '#16a34a',
    meetingText:        dark ? '#f4f4f5' : '#111827',
    meetingSubtext:     dark ? '#4ade80' : '#16a34a',
    meetingJoinBg:      dark ? 'rgba(34,197,94,0.15)' : 'rgba(34,197,94,0.12)',
    meetingJoinBd:      'rgba(34,197,94,0.28)',
    meetingJoinColor:   dark ? '#4ade80' : '#16a34a',
    addChBtnBg:         dark ? 'rgba(220,38,38,0.1)'  : 'rgba(220,38,38,0.07)',
    addChBtnBd:         dark ? 'rgba(220,38,38,0.26)' : 'rgba(220,38,38,0.2)',
    addChBtnColor:      dark ? '#ff6b6b' : '#dc2626',
    addChAddbg:         dark ? 'rgba(220,38,38,0.16)' : 'rgba(220,38,38,0.1)',
    addChAddbBd:        dark ? 'rgba(220,38,38,0.3)'  : 'rgba(220,38,38,0.25)',
    addChAddColor:      dark ? '#ff6b6b' : '#dc2626',
    chActiveBg:         dark ? 'rgba(220,38,38,0.16)' : 'rgba(220,38,38,0.1)',
    chActiveText:       dark ? '#f4f4f5' : '#111827',
    chActiveIcon:       dark ? '#ff6b6b' : '#dc2626',
    chInactiveIcon:     dark ? '#52525b' : '#9ca3af',
    membersAddmin:      dark ? '#ff6b6b' : '#dc2626',
    filePreviewText:    dark ? '#a1a1aa' : '#374151',
    uploadTrackBg:      dark ? '#3f3f46' : '#e5e7eb',
    errorText:          dark ? '#f87171' : '#dc2626',
  };
}

// ── NameColorFields (module-level so it has a stable identity) ────────────
function NameColorFields({ name, setName, col, setCol, onSubmit }) {
  const T = chatColors(React.useContext(ChatThemeCtx));
  const inp = {
    background:T.inputBg, border:`1px solid ${T.border}`, color:T.textPrimary,
    borderRadius:10, padding:"12px 14px", width:"100%", fontSize:14, outline:"none",
  };
  return (
    <>
      <div>
        <label style={{ color:T.textMuted, fontSize:11, fontWeight:700, letterSpacing:"0.07em", display:"block", marginBottom:7 }}>YOUR DISPLAY NAME</label>
        <input value={name} onChange={e=>setName(e.target.value)}
          onKeyDown={e=>e.key==="Enter"&&onSubmit()}
          placeholder="" style={inp} autoFocus/>
      </div>
      <div>
        <label style={{ color:T.textMuted, fontSize:11, fontWeight:700, letterSpacing:"0.07em", display:"block", marginBottom:8 }}>AVATAR COLOR</label>
        <div className="flex gap-2 flex-wrap">
          {CHAT_COLORS.map(c=>(
            <button key={c} onClick={()=>setCol(c)}
              style={{ width:32, height:32, borderRadius:"50%", background:c, border:col===c?"3px solid #dc2626":"3px solid transparent", transition:"all 0.15s", flexShrink:0, boxShadow:col===c?"0 0 0 3px rgba(220,38,38,0.25)":"none" }}/>
          ))}
        </div>
      </div>
    </>
  );
}

// ── SetupScreen ───────────────────────────────────────────────────────────
function SetupScreen({ onSetup, error, darkMode, toggleTheme, defaultName }) {
  const [tab,        setTab]        = React.useState("community"); // "community" | "team"
  const [teamMode,   setTeamMode]   = React.useState("create");    // "create" | "join"
  const [newServerName, setNewServerName] = React.useState("");    // create: the server's name
  const [inviteText, setInviteText] = React.useState("");          // join: pasted invite link/token
  // Default the display name from the signed-in account (their saved chat name or
  // Google name / email), so identity is anchored to the account, not typed fresh.
  const [name,       setName]       = React.useState(localStorage.getItem("chat_name") || defaultName || "");
  const [col,        setCol]        = React.useState(localStorage.getItem("chat_color") || CHAT_COLORS[3]);
  const [localErr,   setLocalErr]   = React.useState("");

  const handleCommunity = () => {
    if (!name.trim()) { setLocalErr("Enter your display name."); return; }
    setLocalErr("");
    onSetup({ serverId: PUBLIC_SERVER_ID, serverName: "Voltz Community", name: name.trim(), color: col });
  };

  const handleTeam = () => {
    if (!name.trim()) { setLocalErr("Enter your display name."); return; }
    if (teamMode === "create") {
      const sname = newServerName.trim();
      if (!sname) { setLocalErr("Name your server."); return; }
      setLocalErr("");
      // Generate a private, unguessable token — the invite link is the only way in.
      onSetup({ serverId: genServerToken(), serverName: sname, name: name.trim(), color: col, isCreator: true });
    } else {
      const sid = parseInvite(inviteText);
      if (!sid) { setLocalErr("Paste the invite link you were given."); return; }
      setLocalErr("");
      onSetup({ serverId: sid, serverName: "", name: name.trim(), color: col, isCreator: false });
    }
  };

  const handleSubmit = tab === "community" ? handleCommunity : handleTeam;

  const ST = chatColors(darkMode);
  const inp = {
    background:ST.inputBg, border:`1px solid ${ST.border}`, color:ST.textPrimary,
    borderRadius:10, padding:"12px 14px", width:"100%", fontSize:14, outline:"none",
  };
  return (
    <div style={{ minHeight:"100vh", background: darkMode ? DARK_PAGE_BG : LIGHT_PAGE_BG, display:"flex", alignItems:"center", justifyContent:"center", padding:24 }} className="pt-20"> {/* theme: gradient-mesh */}
      <div style={{ width:"100%", maxWidth:440, background: darkMode ? "#1c1c20" : "#ffffff", borderRadius:20, padding:"34px 28px 28px", boxShadow: darkMode ? "0 40px 100px rgba(0,0,0,0.7)" : "0 20px 60px rgba(0,0,0,0.1)", border: darkMode ? "1px solid rgba(255,255,255,0.08)" : "1px solid rgba(0,0,0,0.07)", position:"relative" }}>

        {/* Theme toggle (top-right corner) */}
        {toggleTheme && (
          <button onClick={toggleTheme} title={darkMode?"Switch to light mode":"Switch to dark mode"}
            style={{ position:"absolute", top:16, right:16, background:ST.accentBg, border:`1px solid ${ST.accentBorder}`, borderRadius:8, padding:"5px 7px", cursor:"pointer", color:ST.accentText, display:"flex", alignItems:"center", gap:5, fontSize:11, fontWeight:600 }}>
            {darkMode
              ? <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>Light</>
              : <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>Dark</>
            }
          </button>
        )}

        {/* Header */}
        <div className="text-center mb-7">
          <div style={{ width:58, height:58, borderRadius:"50%", overflow:"hidden", background:"radial-gradient(circle at 50% 32%, #2b2e35, #141519)", display:"flex", alignItems:"center", justifyContent:"center", margin:"0 auto 14px", boxShadow:"0 8px 24px rgba(220,38,38,0.35)" }}>
            <VoltLogo size={58} />
          </div>
          <h2 style={{ color:ST.textPrimary, fontWeight:800, fontSize:22, marginBottom:4 }}>Voltz Community</h2>
          <p style={{ color:ST.textMuted, fontSize:13 }}>Chat with the Voltz community or your private team</p>
        </div>

        {/* Top-level tabs */}
        <div className="flex gap-1.5 mb-6 p-1 rounded-xl" style={{ background: darkMode ? "#141416" : "#f3f4f6" }}>
          {[["community","Community"],["team","Team Server"]].map(([id,lbl])=>(
            <button key={id} onClick={()=>{ setTab(id); setLocalErr(""); setServerCode(""); }}
              className="flex-1 py-2.5 rounded-lg text-sm font-semibold transition"
              style={{ background:tab===id?"linear-gradient(135deg,#ef4444,#dc2626)":"transparent", color:tab===id?"#fff":ST.textMuted }}>
              {lbl}
            </button>
          ))}
        </div>

        <div className="space-y-4">
          {tab === "community" ? (
            /* ── Community tab ── */
            <>
              <div style={{ background:ST.accentBg, border:`1px solid ${ST.accentBorder}`, borderRadius:10, padding:"10px 14px" }}>
                <p style={{ color:ST.accentText, fontSize:12, lineHeight:1.6 }}>
                  Join the <strong style={{color:ST.textPrimary}}>Voltz Community</strong> — open to everyone on the site. Chat, share results, and connect with other VEX teams.
                </p>
              </div>
              <NameColorFields name={name} setName={setName} col={col} setCol={setCol} onSubmit={handleSubmit}/>
            </>
          ) : (
            /* ── Team Server tab ── */
            <>
              {/* Create / Join sub-toggle */}
              <div className="flex gap-1 p-0.5 rounded-lg" style={{ background: darkMode ? "#141416" : "#f3f4f6" }}>
                {[["create","Create"],["join","Join"]].map(([id,lbl])=>(
                  <button key={id} onClick={()=>{ setTeamMode(id); setLocalErr(""); setNewServerName(""); setInviteText(""); }}
                    className="flex-1 py-1.5 rounded-md text-xs font-semibold transition"
                    style={{ background:teamMode===id?ST.accentBg:"transparent", color:teamMode===id?ST.accentText:ST.textMuted }}>
                    {lbl} a Server
                  </button>
                ))}
              </div>

              {teamMode === "create" ? (
                <div>
                  <label style={{ color:ST.textMuted, fontSize:11, fontWeight:700, letterSpacing:"0.07em", display:"block", marginBottom:7 }}>SERVER NAME</label>
                  <input value={newServerName}
                    onChange={e=>setNewServerName(e.target.value)}
                    onKeyDown={e=>e.key==="Enter"&&handleTeam()}
                    placeholder="e.g. Team 8059 Pit"
                    style={inp} maxLength={40}/>
                  <p style={{ color:ST.textDim, fontSize:11, marginTop:5 }}>
                    Private &amp; invite-only. You'll get a share link once it's created — only people with the link can join.
                  </p>
                </div>
              ) : (
                <div>
                  <label style={{ color:ST.textMuted, fontSize:11, fontWeight:700, letterSpacing:"0.07em", display:"block", marginBottom:7 }}>INVITE LINK</label>
                  <input value={inviteText}
                    onChange={e=>setInviteText(e.target.value)}
                    onKeyDown={e=>e.key==="Enter"&&handleTeam()}
                    placeholder="Paste the invite link…"
                    style={inp}/>
                  <p style={{ color:ST.textDim, fontSize:11, marginTop:5 }}>
                    Tip: clicking an invite link joins the server automatically — you only need this to paste one by hand.
                  </p>
                </div>
              )}

              <NameColorFields name={name} setName={setName} col={col} setCol={setCol} onSubmit={handleSubmit}/>
            </>
          )}

          {(localErr||error) && (
            <div style={{ background:"rgba(239,68,68,0.08)", border:"1px solid rgba(239,68,68,0.22)", borderRadius:8, padding:"8px 12px" }}>
              <p style={{ color: darkMode ? "#fca5a5" : "#dc2626", fontSize:12 }}>{localErr||error}</p>
            </div>
          )}

          <button onClick={handleSubmit}
            className="w-full py-3.5 rounded-xl text-white font-bold text-sm transition hover:opacity-90 active:scale-95"
            style={{ background:"linear-gradient(135deg,#ef4444,#dc2626)", marginTop:4, boxShadow:"0 4px 20px rgba(220,38,38,0.35)" }}>
            {tab==="community" ? "Join Community" : teamMode==="create" ? "Create Server" : "Join Server"}
          </button>
        </div>

        {/* Live preview */}
        {name.trim() && (
          <div className="flex items-center gap-3 mt-6 pt-5" style={{ borderTop:`1px solid ${ST.border}` }}>
            <div style={{ width:38, height:38, borderRadius:"50%", background:`radial-gradient(circle at 35% 28%, rgba(255,255,255,0.4), rgba(255,255,255,0) 58%), ${col}`, display:"flex", alignItems:"center", justifyContent:"center", boxShadow:`inset 0 0 0 1px rgba(255,255,255,0.14), 0 0 0 3px rgba(220,38,38,0.15)` }}>
              <span style={{ color:"#fff", fontWeight:800, fontSize:15, textShadow:"0 1px 2px rgba(0,0,0,0.25)" }}>{name.trim()[0].toUpperCase()}</span>
            </div>
            <div>
              <p style={{ color:ST.textPrimary, fontSize:13, fontWeight:700 }}>{name.trim()}</p>
              <p style={{ color:ST.onlineText, fontSize:11 }}>
                {tab==="community" ? "Joining Voltz Community" : teamMode==="create" ? (newServerName.trim() ? `Creating: ${newServerName.trim()}` : "New private server") : (inviteText.trim() ? "Joining via invite" : "Ready to join")}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── ShareCard ─────────────────────────────────────────────────────────────
function ShareCard({ shareType, shareData, onJoinCall }) {
  const T = chatColors(React.useContext(ChatThemeCtx));
  if (shareType === "meeting") {
    return (
      <div className="mt-1.5 rounded-xl overflow-hidden" style={{ border:`1px solid ${T.meetingBorder}`, background:T.meetingBg, maxWidth:360 }}>
        <div style={{ padding:"12px 14px", display:"flex", alignItems:"center", gap:12 }}>
          <div style={{ width:42, height:42, borderRadius:12, background:"rgba(34,197,94,0.1)", border:"1px solid rgba(34,197,94,0.2)", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={T.meetingIcon} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
          </div>
          <div style={{ flex:1, minWidth:0 }}>
            <p style={{ color:T.meetingText, fontWeight:700, fontSize:13 }}>{shareData.startedBy} started a video call</p>
            <p style={{ color:T.meetingSubtext, fontSize:11, marginTop:1 }}>Live · Click to join</p>
          </div>
          <button onClick={() => onJoinCall?.(shareData.room)}
            style={{ background:T.meetingJoinBg, border:`1px solid ${T.meetingJoinBd}`, color:T.meetingJoinColor, borderRadius:8, padding:"6px 14px", fontSize:12, fontWeight:700, cursor:"pointer", flexShrink:0, whiteSpace:"nowrap" }}>
            Join
          </button>
        </div>
      </div>
    );
  }

  const colors = { practice:"#6366f1", tournament:"#8b5cf6", goal:"#10b981" };
  const color  = colors[shareType] || "#6b7280";
  return (
    <div className="mt-1.5 rounded-lg overflow-hidden" style={{ border:`1px solid ${color}30`, background:T.shareCardBg, maxWidth:380 }}>
      <div style={{ borderLeft:`3px solid ${color}`, padding:"10px 14px" }}>
        {shareType==="practice" && (
          <>
            <p className="text-xs font-bold mb-0.5" style={{ color }}>{shareData.title}</p>
            <p style={{ color:T.textMuted, fontSize:11 }}>{shareData.date} · {shareData.duration}min · {shareData.label}</p>
            {shareData.notes && <p style={{ color:T.textDim, fontSize:11, marginTop:3 }}>{shareData.notes}</p>}
          </>
        )}
        {shareType==="tournament" && (
          <>
            <p className="text-xs font-bold mb-0.5" style={{ color:T.textPrimary }}>{shareData.name}</p>
            <p style={{ color, fontSize:11 }}>{shareData.type} · {shareData.date}{shareData.location?` · ${shareData.location}`:""}</p>
            {shareData.record && <p style={{ color:T.textPrimary, fontSize:12, fontWeight:700, marginTop:3 }}>{shareData.record}</p>}
          </>
        )}
        {shareType==="goal" && (
          <>
            <p className="text-xs font-bold mb-0.5" style={{ color:T.textPrimary }}>{shareData.text}</p>
            <p style={{ color, fontSize:11 }}>{shareData.category} · {shareData.priority} priority</p>
          </>
        )}
      </div>
    </div>
  );
}

// ── MediaAttachment ───────────────────────────────────────────────────────
function MediaAttachment({ data }) {
  const [lightbox, setLightbox] = React.useState(false);
  const T = chatColors(React.useContext(ChatThemeCtx));
  if (!data?.url) return null;
  if (data.mediaType === "image") {
    return (
      <>
        <img
          src={data.url} alt={data.fileName || "image"}
          onClick={()=>setLightbox(true)}
          style={{ maxWidth:320, maxHeight:240, borderRadius:10, cursor:"zoom-in", marginTop:4, display:"block", border:`1px solid ${T.imgBorder}` }}
          loading="lazy"
        />
        {lightbox && (
          <div onClick={()=>setLightbox(false)}
            style={{ position:"fixed", inset:0, zIndex:9999, background:"rgba(0,0,0,0.92)", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", cursor:"zoom-out" }}>
            <img src={data.url} alt="" style={{ maxWidth:"92vw", maxHeight:"88vh", borderRadius:10, boxShadow:"0 8px 60px rgba(0,0,0,0.7)" }}/>
            {data.fileName && <p style={{ color:"#64748b", fontSize:12, marginTop:10 }}>{data.fileName}</p>}
          </div>
        )}
      </>
    );
  }
  if (data.mediaType === "video") {
    return (
      <video src={data.url} controls
        style={{ maxWidth:360, borderRadius:10, marginTop:4, display:"block", background:"#000", border:`1px solid ${T.imgBorder}` }}
      />
    );
  }
  return null;
}

// ── Emoji picker ──────────────────────────────────────────────────────────
// Curated, self-contained emoji set (no external library — CSP-safe). The first
// six double as the quick-reaction bar shown on message hover.
const QUICK_EMOJI = ["👍","❤️","😂","🎉","🔥","😮"];
const EMOJI_SET = [
  "😀","😃","😄","😁","😆","😅","😂","🤣","😊","🙂","😉","😍",
  "😘","😎","🤩","🤔","😐","😴","😮","😯","😢","😭","😡","🥳",
  "🤯","😅","🙃","😇","🤗","🫡","😤","🥲","👍","👎","👏","🙌",
  "🙏","💪","🤝","👀","💯","🔥","⭐","✨","🎉","✅","❌","❤️",
  "🧡","💛","💚","💙","💜","🤖","⚡","🏆","🚀","💡","📌","⚙️",
];
// A compact popover grid of emoji. `onPick(emoji)` fires on selection.
function EmojiPicker({ onPick, onClose, dark, align = "left" }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    const away = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose?.(); };
    document.addEventListener("mousedown", away);
    const esc = (e) => e.key === "Escape" && onClose?.();
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [onClose]);
  return (
    <div ref={ref} style={{ position:"absolute", bottom:"calc(100% + 6px)", [align]:0, zIndex:60,
      width:264, maxHeight:210, overflowY:"auto", padding:8, borderRadius:14,
      background: dark ? "#1c1c20" : "#ffffff", border:`1px solid ${dark ? "rgba(255,255,255,0.1)" : "#e5e7eb"}`,
      boxShadow:"0 12px 40px rgba(0,0,0,0.28)", display:"grid", gridTemplateColumns:"repeat(8, 1fr)", gap:2 }}>
      {EMOJI_SET.map((e, i) => (
        <button key={e + i} onClick={() => onPick(e)} title={e}
          style={{ fontSize:19, lineHeight:1, padding:"5px 0", borderRadius:8, border:"none", background:"transparent", cursor:"pointer", transition:"background 0.12s" }}
          onMouseEnter={ev => ev.currentTarget.style.background = dark ? "rgba(255,255,255,0.08)" : "#f3f4f6"}
          onMouseLeave={ev => ev.currentTarget.style.background = "transparent"}>
          {e}
        </button>
      ))}
    </div>
  );
}

// ── MessageRow ────────────────────────────────────────────────────────────
function MessageRow({ msg, sameUser, isMine, onDelete, onJoinCall, reactions, myName, onToggleReaction }) {
  const [hov, setHov] = React.useState(false);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const dark = React.useContext(ChatThemeCtx);
  const T = chatColors(dark);
  const time = new Date(msg.created_at).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });
  const isMedia = msg.share_type === "media";
  // reactions = { "👍": [{username,rowId}], ... } for this message
  const reactionEntries = reactions ? Object.entries(reactions).filter(([, list]) => list.length) : [];
  return (
    <div onMouseEnter={()=>setHov(true)} onMouseLeave={()=>setHov(false)}
      className="relative flex gap-3 px-2 rounded"
      style={{ paddingTop:sameUser?2:16, paddingBottom:2, background:hov?T.hoverBg:"transparent" }}>
      {!sameUser ? (
        <div style={{ width:40, height:40, borderRadius:"50%", background:`radial-gradient(circle at 35% 28%, rgba(255,255,255,0.4), rgba(255,255,255,0) 58%), ${msg.color}`, flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center", marginTop:2, boxShadow:"inset 0 0 0 1px rgba(255,255,255,0.14), 0 1px 3px rgba(0,0,0,0.18)" }}>
          <span className="text-white font-bold text-sm" style={{ textShadow:"0 1px 2px rgba(0,0,0,0.25)" }}>{msg.username[0]?.toUpperCase()}</span>
        </div>
      ) : (
        <div style={{ width:40, flexShrink:0, display:"flex", justifyContent:"center", alignItems:"flex-start", paddingTop:1 }}>
          {hov && <span style={{ color:T.textTime, fontSize:9.5, lineHeight:"18px", fontVariantNumeric:"tabular-nums" }}>{time}</span>}
        </div>
      )}

      <div className="flex-1 min-w-0">
        {!sameUser && (
          <div className="flex items-baseline gap-2 mb-0.5">
            <span className="text-sm font-semibold" style={{ color:msg.color }}>{msg.username}</span>
            <span style={{ color:T.textTime, fontSize:11 }}>{time}</span>
          </div>
        )}
        {msg.content && <p style={{ color:T.textSecond, fontSize:14, lineHeight:1.5 }}>{msg.content}</p>}
        {isMedia && msg.share_data && (
          <MediaAttachment data={msg.share_data}/>
        )}
        {msg.share_type && !isMedia && msg.share_data && (
          <ShareCard shareType={msg.share_type} shareData={msg.share_data} onJoinCall={onJoinCall}/>
        )}

        {/* Reaction chips */}
        {reactionEntries.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {reactionEntries.map(([emoji, list]) => {
              const mine = list.some(r => r.username === myName);
              return (
                <button key={emoji} onClick={() => onToggleReaction(msg.id, emoji)}
                  title={list.map(r => r.username).join(", ")}
                  style={{ display:"flex", alignItems:"center", gap:4, padding:"1px 8px", height:24, borderRadius:12,
                    fontSize:12, cursor:"pointer", transition:"all 0.12s",
                    background: mine ? T.accentBg : (dark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.035)"),
                    border:`1px solid ${mine ? T.accentBorder : "transparent"}`,
                    color: mine ? T.accentText : T.textMuted }}>
                  <span style={{ fontSize:13 }}>{emoji}</span>
                  <span style={{ fontWeight:600, fontVariantNumeric:"tabular-nums" }}>{list.length}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Hover toolbar — quick react + add-reaction picker + delete */}
      {(hov || pickerOpen) && (
        <div className="absolute right-2 top-1 flex items-center gap-1" style={{ zIndex: pickerOpen ? 61 : 40 }}>
          {QUICK_EMOJI.slice(0, 3).map(e => (
            <button key={e} onClick={() => onToggleReaction(msg.id, e)} title={`React ${e}`}
              className="w-6 h-6 rounded flex items-center justify-center transition hover:scale-110"
              style={{ fontSize:13, background:T.deleteBtnBg }}>{e}</button>
          ))}
          <div className="relative">
            <button onClick={() => setPickerOpen(o => !o)} title="Add reaction"
              className="w-6 h-6 rounded flex items-center justify-center transition"
              style={{ color:T.textMuted, background:T.deleteBtnBg }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
            </button>
            {pickerOpen && (
              <EmojiPicker dark={dark} align="right"
                onPick={(e) => { onToggleReaction(msg.id, e); setPickerOpen(false); }}
                onClose={() => setPickerOpen(false)} />
            )}
          </div>
          {isMine && (
            <button onClick={()=>onDelete(msg.id)} title="Delete"
              className="w-6 h-6 rounded flex items-center justify-center text-xs transition hover:text-red-500"
              style={{ color:T.textMuted, background:T.deleteBtnBg }}>✕</button>
          )}
        </div>
      )}
    </div>
  );
}

// ── TeamChat ──────────────────────────────────────────────────────────────
const chatLog = createLogger("chat");
function TeamChat() {
  // Chat identity is now anchored to the signed-in account (Supabase Auth) — no
  // more free-for-all names where anyone could pick any identity. You must sign
  // in, and your display name + color live in your account (user_metadata),
  // synced to localStorage (which the rest of the chat reads) as the source of
  // truth. A returning user keeps the same identity on every device/login.
  const { user } = useAuth() || {};
  const accountName = userDisplayName(user); // same identity shown in the Nav
  React.useEffect(() => {
    if (!user) return;
    const m = user.user_metadata || {};
    const nm = m.username || m.chat_name;
    if (nm) {
      // Account is the source of truth — overwrite any locally-edited name.
      localStorage.setItem("chat_name", nm);
      if (m.chat_color) localStorage.setItem("chat_color", m.chat_color);
    }
  }, [user?.id]);

  const [error,      setError]      = React.useState("");
  const [ready,      setReady]      = React.useState(()=> !!(localStorage.getItem("chat_name") && localStorage.getItem("chat_server_id")));
  const [serverId,   setServerId]   = React.useState(()=> localStorage.getItem("chat_server_id") || "");
  const [serverName, setServerName] = React.useState(()=> localStorage.getItem("chat_server_name") || "Team Hub");
  const [channel,  setChannel]  = React.useState("general");
  const [messages, setMessages] = React.useState([]);
  const [input,    setInput]    = React.useState("");
  const [sending,  setSending]  = React.useState(false);
  const [mobileNav,    setMobileNav]    = React.useState(false);
  const [codeCopied,   setCodeCopied]   = React.useState(false);
  const [myStatus,     setMyStatus]     = React.useState("online"); // "online" | "dnd"
  const [members,      setMembers]      = React.useState([]);
  const [showMembers,  setShowMembers]  = React.useState(true);
  const [pendingFile,  setPendingFile]  = React.useState(null); // { file, previewUrl, mediaType }
  const [emojiOpen,    setEmojiOpen]    = React.useState(false); // compose emoji picker
  const [uploadPct,    setUploadPct]    = React.useState(0);
  const [inCall,       setInCall]       = React.useState(false);
  const [livekitToken, setLivekitToken] = React.useState(null);
  const [callLoading,  setCallLoading]  = React.useState(false);
  const [preJoinDone,  setPreJoinDone]  = React.useState(false);
  const [joinOptions,  setJoinOptions]  = React.useState({ videoEnabled: true, audioEnabled: true });
  const [whiteboardOpen, setWhiteboardOpen] = React.useState(false); // shared whiteboard shown inside the call
  const [whiteboardUrl,  setWhiteboardUrl]  = React.useState("");
  const wbChanRef = React.useRef(null); // realtime broadcast channel that syncs whiteboard open/close to everyone in the call
  const [customChannels, setCustomChannels] = React.useState([]);
  const [showAddCh,      setShowAddCh]      = React.useState(false);
  const [newChName,      setNewChName]      = React.useState("");
  const [adminUser,      setAdminUser]      = React.useState(""); // the OWNER (server creator) — immune, from server_config
  const [adminList,      setAdminList]      = React.useState([]); // names the owner granted the Admin (moderator) role
  const [recording,      setRecording]      = React.useState(false);
  const [darkMode,       setDarkMode]       = React.useState(() => localStorage.getItem("chat_theme") === "dark");
  const [automodRules,   setAutomodRules]   = React.useState([]);
  const [flaggedMsgs,    setFlaggedMsgs]    = React.useState([]);
  const [bannedIps,      setBannedIps]      = React.useState([]);
  const [userIp,         setUserIp]         = React.useState("");
  const [dailyUsedBytes, setDailyUsedBytes] = React.useState(0); // today's upload total (UX quota indicator)
  const [showAutomod,    setShowAutomod]    = React.useState(false);
  const [newPattern,     setNewPattern]     = React.useState("");
  const [newAction,      setNewAction]      = React.useState("block");
  const [ownerUnlocked,  setOwnerUnlocked]  = React.useState(false);
  const [showPinPrompt,  setShowPinPrompt]  = React.useState(false);
  const [pinInput,       setPinInput]       = React.useState("");
  const [pinError,       setPinError]       = React.useState("");
  const T = chatColors(darkMode);
  const toggleTheme = () => {
    const next = !darkMode;
    setDarkMode(next);
    localStorage.setItem("chat_theme", next ? "dark" : "light");
  };
  const recorderRef  = React.useRef(null);
  const recChunksRef = React.useRef([]);
  const presenceRef = React.useRef(null);
  const subRef  = React.useRef(null);
  const endRef  = React.useRef(null);
  const inpRef  = React.useRef(null);
  const fileRef = React.useRef(null);
  const lastSendRef = React.useRef(0);
  const typingChanRef   = React.useRef(null); // realtime broadcast channel for "X is typing…"
  const lastTypingRef   = React.useRef(0);    // throttle for outgoing typing pings
  const [typingMap, setTypingMap] = React.useState({}); // { name: lastSeenTs }

  // Must be called unconditionally (before any early return) — Rules of Hooks
  const uniqueMembers = React.useMemo(() => {
    const seen = new Set();
    return members.filter(m => {
      if (!m.name || seen.has(m.name)) return false;
      seen.add(m.name);
      return true;
    });
  }, [members]);

  // Refinement: now async — validates the team code against the server BEFORE
  // committing, so a typo'd Join code no longer silently creates an empty server
  // and Create can't hijack an existing code.
  const handleSetup = async ({ serverId: sid, serverName: sname, name, color, isCreator }) => {
    chatLog.debug("handleSetup:enter", { sid, isCreator: !!isCreator }); // entry trace
    if (!name.trim()) { setError("Enter your display name."); return; }
    const sb = getSB(); // warm up singleton
    let resolvedName = ""; // real server name pulled from server_config (for link-joiners)
    if (sid !== PUBLIC_SERVER_ID && sb) {
      // A team server "exists" iff its server_config record exists (written at creation).
      const { data, error: qErr } = await sb.from("messages")
        .select("id, share_data")
        .eq("channel", `${sid}_sys`)
        .eq("share_type", "server_config")
        .limit(1);
      if (qErr) {
        // Fail-open: if the lookup itself fails, chat is likely down anyway —
        // don't lock the user out of trying, but leave a diagnostic trail.
        chatLog.warn("Server existence check failed — proceeding without validation", qErr.message);
      } else {
        const check = validateServerChoice(!!isCreator, (data?.length ?? 0) > 0);
        if (!check.ok) {
          // For a join, this means the invite is invalid/expired — say so plainly.
          setError(isCreator ? check.error : "That invite link is invalid or the server no longer exists.");
          chatLog.info("handleSetup:rejected", { sid, isCreator: !!isCreator, reason: check.error }); // exit trace (rejection path)
          return;
        }
        resolvedName = data?.[0]?.share_data?.name || "";
      }
    }
    const sn = sname || resolvedName || "Team Server";
    localStorage.setItem("chat_server_id",   sid);
    localStorage.setItem("chat_server_name", sn);
    localStorage.setItem("chat_name",  name.trim());
    localStorage.setItem("chat_color", color);
    // Persist the identity to the signed-in account so it follows the user across
    // devices/logins and is the source of truth (fire-and-forget, guarded).
    getSB()?.auth.updateUser({ data: { chat_name: name.trim(), chat_color: color } })
      .catch((e) => chatLog.warn("could not save chat identity to account", { msg: e?.message }));
    setServerId(sid);
    setServerName(sn);
    setError("");
    // Record admin role when creating a new server
    if (isCreator && sid !== PUBLIC_SERVER_ID) {
      localStorage.setItem(`chat_admin_${sid}`, name.trim());
      setAdminUser(name.trim());
      getSB()?.from("messages").insert({
        channel:    `${sid}_sys`,
        username:   name.trim(),
        color,
        content:    null,
        share_type: "server_config",
        share_data: { admin: name.trim(), name: sn, createdAt: new Date().toISOString() },
      });
    }
    setReady(true);
    chatLog.debug("handleSetup:exit", { sid, ready: true }); // exit trace (success path)
  };

  // Init client on mount if already have credentials
  React.useEffect(() => {
    if (ready) getSB(); // warm up singleton
  }, [ready]);

  // Fetch user IP once on mount for automod logging
  React.useEffect(() => {
    fetch("https://api.ipify.org?format=json")
      .then(r => r.json())
      .then(d => setUserIp(d.ip))
      .catch((e) => chatLog.warn("IP lookup failed", e?.message || e));
  }, []);

  // Load today's upload usage so the quota indicator is accurate on load
  React.useEffect(() => {
    const sb = getSB();
    const name = localStorage.getItem("chat_name");
    if (!sb || !name) return;
    const today = new Date().toISOString().slice(0, 10);
    sb.from("upload_usage").select("bytes_used")
      .eq("username", name).eq("upload_date", today).maybeSingle()
      .then(({ data }) => { if (data?.bytes_used) setDailyUsedBytes(data.bytes_used); });
  }, [ready]);

  // Load global IP blacklist from Supabase ip_blacklist table
  React.useEffect(() => {
    const sb = getSB();
    if (!sb) return;
    sb.from("ip_blacklist").select("ip")
      .then(({ data }) => {
        if (data) setBannedIps(data.map(r => r.ip).filter(Boolean));
      });
    // Real-time: new bans and unbans propagate instantly to all sessions
    const banSub = sb.channel("ip_blacklist_changes")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "ip_blacklist" },
        ({ new: row }) => { if (row.ip) setBannedIps(prev => [...new Set([...prev, row.ip])]); })
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "ip_blacklist" },
        ({ old: row }) => { if (row.ip) setBannedIps(prev => prev.filter(ip => ip !== row.ip)); })
      .subscribe();
    return () => { banSub.unsubscribe(); };
  }, []);

  // Secret command: typing /automod in the chat input opens the owner PIN prompt
  React.useEffect(() => {
    if (input === "/automod") {
      setInput("");
      if (ownerUnlocked) setShowAutomod(true);
      else setShowPinPrompt(true);
    }
  }, [input]);

  // Load messages + real-time subscription
  React.useEffect(() => {
    if (!ready || !serverId) return;
    const sb = getSB();
    if (!sb) return;
    const chKey = `${serverId}_${channel}`;

    subRef.current?.unsubscribe();
    setMessages([]);

    // Refinement: fetch factored into loadMessages so both the initial load and
    // the browser-reconnect path below share one code path.
    // Review fix: `cancelled` guards against a stale in-flight response landing
    // after a channel switch and mixing the previous channel's rows into this one.
    let cancelled = false;
    const loadMessages = () => {
      sb.from("messages")
        .select("*")
        .eq("channel", chKey)
        .order("created_at", { ascending:true })
        .limit(200)
        .then(({ data, error:e }) => {
          if (cancelled) { chatLog.debug("Dropped stale message load", { channel: chKey }); return; }
          if (e) { setError(e.message); chatLog.error("Message load failed", e.message); return; }
          setMessages(data || []);
          setTimeout(()=> endRef.current?.scrollIntoView({ behavior:"smooth" }), 60);
        });
    };
    loadMessages();

    subRef.current = sb
      .channel(`room:${chKey}`)
      .on("postgres_changes", { event:"INSERT", schema:"public", table:"messages", filter:`channel=eq.${chKey}` },
        ({ new:msg }) => {
          setMessages(prev => [...prev, msg]);
          // Reactions arrive as rows too — don't yank the view to the bottom for them.
          if (msg.share_type !== "reaction")
            setTimeout(()=> endRef.current?.scrollIntoView({ behavior:"smooth" }), 60);
        })
      // Refinement: log the subscription lifecycle — dropped realtime channels
      // previously froze the feed with zero diagnostic trail.
      .subscribe((status) => {
        chatLog.debug("realtime status", { channel: chKey, status });
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT")
          chatLog.warn("Realtime subscription degraded — messages may be stale until reconnect", { channel: chKey, status });
      });

    // Refinement: when the browser regains connectivity, refetch to backfill
    // anything missed while the realtime channel was down.
    const onOnline = () => { chatLog.info("Browser back online — refetching messages", { channel: chKey }); loadMessages(); };
    window.addEventListener("online", onOnline);

    return () => { cancelled = true; window.removeEventListener("online", onOnline); subRef.current?.unsubscribe(); };
  }, [ready, channel, serverId]);

  // Presence — who's online
  React.useEffect(() => {
    if (!ready || !serverId) return;
    const sb = getSB();
    if (!sb) return;
    const mn = localStorage.getItem("chat_name");
    const mc = localStorage.getItem("chat_color") || CHAT_COLORS[3];

    presenceRef.current?.unsubscribe();

    const pCh = sb.channel(`presence:${serverId}`, {
      config: { presence: { key: mn } },
    });
    pCh
      .on("presence", { event: "sync" }, () => {
        const raw = pCh.presenceState();
        setMembers(Object.values(raw).flat());
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await pCh.track({ name: mn, color: mc, status: myStatus });
        }
      });
    presenceRef.current = pCh;
    return () => { pCh.untrack(); pCh.unsubscribe(); };
  }, [ready, serverId]);

  // Typing indicators — ephemeral realtime broadcast, scoped per channel. No DB.
  React.useEffect(() => {
    if (!ready || !serverId) return;
    const sb = getSB();
    if (!sb) return;
    setTypingMap({});
    const ch = sb.channel(`typing:${serverId}_${channel}`, { config: { broadcast: { self: false } } });
    ch.on("broadcast", { event: "typing" }, ({ payload }) => {
      const me = localStorage.getItem("chat_name");
      if (!payload?.name || payload.name === me) return;
      setTypingMap(prev => ({ ...prev, [payload.name]: Date.now() }));
    }).subscribe();
    typingChanRef.current = ch;
    // Prune stale typers (no ping in 3.5s → they stopped / sent).
    const iv = setInterval(() => {
      setTypingMap(prev => {
        const now = Date.now(); let changed = false; const next = {};
        for (const [n, t] of Object.entries(prev)) { if (now - t < 3500) next[n] = t; else changed = true; }
        return changed ? next : prev;
      });
    }, 1000);
    return () => { clearInterval(iv); ch.unsubscribe(); typingChanRef.current = null; };
  }, [ready, serverId, channel]);

  // Shared-whiteboard sync — when one person opens/closes the in-call whiteboard,
  // everyone in the call sees it (Meet/Teams style). Ephemeral broadcast, no DB.
  React.useEffect(() => {
    if (!ready || !serverId) return;
    const sb = getSB();
    if (!sb) return;
    const ch = sb.channel(`wb:${serverId}_${channel}`, { config: { broadcast: { self: false } } });
    ch.on("broadcast", { event: "whiteboard" }, ({ payload }) => {
      if (payload?.open) { if (payload.url) setWhiteboardUrl(payload.url); setWhiteboardOpen(true); }
      else setWhiteboardOpen(false);
    }).subscribe();
    wbChanRef.current = ch;
    return () => { ch.unsubscribe(); wbChanRef.current = null; };
  }, [ready, serverId, channel]);

  // Update tracked status when user toggles online/dnd
  React.useEffect(() => {
    if (!presenceRef.current || !ready) return;
    const mn = localStorage.getItem("chat_name");
    const mc = localStorage.getItem("chat_color") || CHAT_COLORS[3];
    presenceRef.current.track({ name: mn, color: mc, status: myStatus });
  }, [myStatus]);

  // Load & subscribe to custom channels for team servers
  React.useEffect(() => {
    if (!ready || !serverId || serverId === PUBLIC_SERVER_ID) return;
    const sb = getSB();
    if (!sb) return;
    const sysKey = `${serverId}_sys`;

    // Load the most-recent channel_config for this server
    sb.from("messages")
      .select("share_data")
      .eq("channel", sysKey)
      .eq("share_type", "channel_config")
      .order("created_at", { ascending: false })
      .limit(1)
      .then(({ data }) => {
        if (data?.[0]?.share_data?.channels) setCustomChannels(data[0].share_data.channels);
      });

    // Real-time: any teammate adding a channel updates everyone instantly
    const chSub = sb.channel(`ch_cfg:${serverId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `channel=eq.${sysKey}` },
        ({ new: msg }) => {
          if (msg.share_type === "channel_config" && msg.share_data?.channels)
            setCustomChannels(msg.share_data.channels);
        })
      .subscribe();

    return () => { chSub.unsubscribe(); };
  }, [ready, serverId]);

  // Resolve the server OWNER (creator) on rejoin — the first server_config wins.
  React.useEffect(() => {
    if (!ready || !serverId || serverId === PUBLIC_SERVER_ID) return;
    // Fast path: local cache
    const cached = localStorage.getItem(`chat_admin_${serverId}`);
    if (cached) { setAdminUser(cached); return; }
    // Slow path: fetch first server_config from Supabase
    const sb = getSB();
    if (!sb) return;
    sb.from("messages")
      .select("share_data")
      .eq("channel", `${serverId}_sys`)
      .eq("share_type", "server_config")
      .order("created_at", { ascending: true })
      .limit(1)
      .then(({ data }) => {
        const admin = data?.[0]?.share_data?.admin;
        if (admin) {
          setAdminUser(admin);
          localStorage.setItem(`chat_admin_${serverId}`, admin);
        }
      });
  }, [ready, serverId]);

  // Load + live-sync the granted Admin (moderator) list. Latest roles_config wins.
  React.useEffect(() => {
    if (!ready || !serverId || serverId === PUBLIC_SERVER_ID) { setAdminList([]); return; }
    const sb = getSB();
    if (!sb) return;
    const sysKey = `${serverId}_sys`;
    sb.from("messages")
      .select("share_data")
      .eq("channel", sysKey)
      .eq("share_type", "roles_config")
      .order("created_at", { ascending: false })
      .limit(1)
      .then(({ data }) => {
        const a = data?.[0]?.share_data?.admins;
        if (Array.isArray(a)) setAdminList(a);
      });
    const sub = sb.channel(`roles:${serverId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `channel=eq.${sysKey}` },
        ({ new: msg }) => {
          if (msg.share_type === "roles_config" && Array.isArray(msg.share_data?.admins))
            setAdminList(msg.share_data.admins);
        })
      .subscribe();
    return () => { sub.unsubscribe(); };
  }, [ready, serverId]);

  // Load automod rules and flagged messages for team servers
  React.useEffect(() => {
    if (!ready || !serverId || serverId === PUBLIC_SERVER_ID) return;
    const sb = getSB();
    if (!sb) return;
    const sysKey = `${serverId}_sys`;

    sb.from("messages").select("share_data")
      .eq("channel", sysKey).eq("share_type", "automod_config")
      .order("created_at", { ascending: false }).limit(1)
      .then(({ data }) => {
        if (data?.[0]?.share_data?.rules) setAutomodRules(data[0].share_data.rules);
      });

    sb.from("messages").select("*")
      .eq("channel", sysKey).eq("share_type", "flagged_msg")
      .order("created_at", { ascending: false }).limit(200)
      .then(({ data }) => {
        if (data) setFlaggedMsgs(data.map(d => ({ ...d.share_data, sysId: d.id })));
      });

    const flagSub = sb.channel(`automod:${serverId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `channel=eq.${sysKey}` },
        ({ new: msg }) => {
          if (msg.share_type === "flagged_msg")
            setFlaggedMsgs(prev => [{ ...msg.share_data, sysId: msg.id }, ...prev]);
          if (msg.share_type === "automod_config" && msg.share_data?.rules)
            setAutomodRules(msg.share_data.rules);
        })
      .subscribe();

    return () => { flagSub.unsubscribe(); };
  }, [ready, serverId]);

  const handleFilePick = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!isFileSizeOk(file.size)) {
      setError(`File too large (${formatBytes(file.size)}) — max ${formatBytes(MAX_FILE_BYTES)}.`);
      chatLog.warn("Rejected oversized file", { name: file.name, size: file.size });
      e.target.value = ""; return;
    }
    const mediaType = file.type.startsWith("video/") ? "video" : "image";
    const previewUrl = URL.createObjectURL(file);
    setPendingFile({ file, previewUrl, mediaType });
    setError("");
    e.target.value = "";
    inpRef.current?.focus();
  };

  const cancelFile = () => {
    if (pendingFile) URL.revokeObjectURL(pendingFile.previewUrl);
    setPendingFile(null);
    setUploadPct(0);
  };

  const sendMedia = async () => {
    if (!pendingFile || sending) return;
    const sb = getSB();
    if (!sb) return;

    // Rate limit: same cooldown as text messages
    const now = Date.now();
    if (isRateLimited(now, lastSendRef.current)) {
      setError("You're sending messages too fast — slow down a bit.");
      return;
    }

    // Built-in profanity/slur filter on the caption.
    if (containsBannedWord(input.trim())) {
      setError("That caption can't be sent — it contains language that isn't allowed here.");
      chatLog.info("Blocked media caption (built-in word filter)", { user: myName });
      return;
    }

    const { file, mediaType } = pendingFile;
    const today = new Date().toISOString().slice(0, 10);

    // Daily upload limit (40MB/day per user)
    const { data: usage } = await sb
      .from("upload_usage")
      .select("bytes_used")
      .eq("username", myName)
      .eq("upload_date", today)
      .maybeSingle();
    const usedBytes = usage?.bytes_used || 0;
    const quota = checkDailyUpload(usedBytes, file.size);
    if (!quota.allowed) {
      setError(`Daily upload limit reached (${formatBytes(DAILY_UPLOAD_BYTES)}/day). You have ${quota.remainingMb.toFixed(1)}MB left today.`);
      chatLog.warn("Daily upload quota exceeded", { user: myName, usedBytes, fileSize: file.size });
      return;
    }

    setSending(true);
    setUploadPct(5);
    const ext = file.name.split(".").pop() || (mediaType === "video" ? "mp4" : "jpg");
    const safeName = `${serverId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const { error: upErr } = await sb.storage
      .from("chat-media")
      .upload(safeName, file, { cacheControl: "31536000", upsert: false });
    if (upErr) {
      setError(upErr.message);
      chatLog.error("Media upload failed", upErr.message);
      setSending(false); setUploadPct(0); return;
    }
    setUploadPct(80);
    const { data: { publicUrl } } = sb.storage.from("chat-media").getPublicUrl(safeName);
    const caption = input.trim() || null;
    const { error: msgErr } = await sb.from("messages").insert({
      channel:    `${serverId}_${channel}`,
      username:   localStorage.getItem("chat_name"),
      color:      localStorage.getItem("chat_color") || CHAT_COLORS[3],
      content:    caption,
      share_type: "media",
      share_data: { url: publicUrl, mediaType, fileName: file.name },
    });
    if (msgErr) { setError(msgErr.message); chatLog.error("Media message insert failed", msgErr.message); }
    else {
      lastSendRef.current = now;
      const newTotal = usedBytes + file.size;
      await sb.from("upload_usage").upsert(
        { username: myName, upload_date: today, bytes_used: newTotal },
        { onConflict: "username,upload_date" }
      );
      setDailyUsedBytes(newTotal); // keep the usage indicator in sync
    }
    URL.revokeObjectURL(pendingFile.previewUrl);
    setPendingFile(null);
    setInput("");
    setUploadPct(0);
    setSending(false);
    inpRef.current?.focus();
  };

  // Broadcast a throttled "I'm typing" ping (called on keystrokes). Ephemeral.
  const pingTyping = () => {
    const now = Date.now();
    if (now - lastTypingRef.current < 1400) return;
    lastTypingRef.current = now;
    typingChanRef.current?.send({ type: "broadcast", event: "typing", payload: { name: localStorage.getItem("chat_name") } });
  };

  const send = async () => {
    if (pendingFile) { sendMedia(); return; }
    const text = input.trim();
    if (!text || sending) return;
    const sb = getSB();
    if (!sb) return;
    lastTypingRef.current = 0; // let the next keystroke re-broadcast immediately after sending

    // Rate limit: avoid message spam
    const now = Date.now();
    if (isRateLimited(now, lastSendRef.current)) {
      setError("You're sending messages too fast — slow down a bit.");
      return;
    }

    // IP ban check (global blacklist)
    if (isIpBanned(bannedIps, userIp)) {
      chatLog.warn("Blocked send from banned IP", { ip: userIp });
      setInput("");
      setSending(false);
      return;
    }

    // Always-on profanity / slur filter (mainstream-platform community standards),
    // applied before the owner's custom rules and to every server incl. the Community.
    if (containsBannedWord(text)) {
      setError("That message can't be sent — it contains language that isn't allowed here.");
      chatLog.info("Blocked message (built-in word filter)", { user: myName });
      return;
    }

    const matchedRule = matchAutomod(automodRules, text) || matchAutomod(automodRules, myName);

    if (matchedRule) {
      if (matchedRule.action === "block") {
        setError(`Message blocked by automod (rule: "${matchedRule.pattern}").`);
        chatLog.info("Automod blocked message", { rule: matchedRule.pattern, user: myName });
        return;
      }
      // action === "flag": log it and let the message through
      const flagData = {
        content: text, username: myName, ip: userIp,
        channel: `${serverId}_${channel}`,
        matchedPattern: matchedRule.pattern,
        timestamp: new Date().toISOString(),
      };
      sb.from("messages").insert({
        channel: `${serverId}_sys`, username: myName, color: myColor,
        content: null, share_type: "flagged_msg", share_data: flagData,
      });
    }

    setSending(true);
    setInput("");
    const { error:e } = await sb.from("messages").insert({
      channel:  `${serverId}_${channel}`,
      username: localStorage.getItem("chat_name"),
      color:    localStorage.getItem("chat_color") || CHAT_COLORS[3],
      content:  text,
    });
    if (e) setError(e.message);
    else lastSendRef.current = now;
    setSending(false);
    inpRef.current?.focus();
  };

  const deleteMsg = async (id) => {
    await getSB()?.from("messages").delete().eq("id", id);
    setMessages(prev => prev.filter(m => m.id !== id));
  };

  const saveAutomodRules = async (rules) => {
    const sb = getSB();
    if (!sb) return;
    await sb.from("messages").insert({
      channel: `${serverId}_sys`, username: myName, color: myColor,
      content: null, share_type: "automod_config", share_data: { rules },
    });
    setAutomodRules(rules);
  };

  const addAutomodRule = async () => {
    const pattern = newPattern.trim();
    if (!pattern) return;
    const rule = { id: uid(), pattern, action: newAction, createdAt: new Date().toISOString() };
    await saveAutomodRules([...automodRules, rule]);
    setNewPattern("");
  };

  const removeAutomodRule = async (ruleId) => {
    await saveAutomodRules(automodRules.filter(r => r.id !== ruleId));
  };

  const approveFlagged = async (sysId) => {
    await getSB()?.from("messages").delete().eq("id", sysId);
    setFlaggedMsgs(prev => prev.filter(m => m.sysId !== sysId));
  };

  const deleteFlagged = async (flag) => {
    const sb = getSB();
    if (!sb) return;
    const { data } = await sb.from("messages").select("id")
      .eq("channel", flag.channel).eq("content", flag.content).eq("username", flag.username)
      .order("created_at", { ascending: false }).limit(1);
    if (data?.[0]) await sb.from("messages").delete().eq("id", data[0].id);
    await sb.from("messages").delete().eq("id", flag.sysId);
    setMessages(prev => prev.filter(m => !(m.content === flag.content && m.username === flag.username)));
    setFlaggedMsgs(prev => prev.filter(m => m.sysId !== flag.sysId));
  };

  const banIp = async (ip, username) => {
    const sb = getSB();
    if (!sb || !ip || bannedIps.includes(ip)) return;
    const { error } = await sb.from("ip_blacklist").insert({ ip, username, banned_by: "OWNER" });
    if (!error) setBannedIps(prev => [...new Set([...prev, ip])]);
  };

  const unbanIp = async (ip) => {
    const sb = getSB();
    if (!sb) return;
    const { error } = await sb.from("ip_blacklist").delete().eq("ip", ip);
    if (!error) setBannedIps(prev => prev.filter(x => x !== ip));
  };

  const joinCall = async (roomName) => {
    const sb = getSB();
    if (!sb || callLoading) return;
    setCallLoading(true);
    setError("");
    try {
      const { data, error: fnErr } = await sb.functions.invoke("livekit-token", {
        body: { room: roomName, username: myName },
      });
      if (fnErr || !data?.token) throw new Error(fnErr?.message || "Could not get call token");
      setLivekitToken(data.token);
      setInCall(true);
    } catch (e) {
      setError("Could not start call: " + e.message);
    } finally {
      setCallLoading(false);
    }
  };

  const startCall = async () => {
    const sb = getSB();
    if (!sb) return;
    const roomName = `VexHubCall-${serverId}-${channel}`.replace(/[^a-zA-Z0-9-]/g, "");
    // Post a meeting card first so teammates can see and join
    await sb.from("messages").insert({
      channel:    `${serverId}_${channel}`,
      username:   myName,
      color:      myColor,
      content:    null,
      share_type: "meeting",
      share_data: { startedBy: myName, room: roomName },
    });
    await joinCall(roomName);
  };

  const disconnect = () => {
    presenceRef.current?.untrack();
    presenceRef.current?.unsubscribe();
    presenceRef.current = null;
    if (pendingFile) URL.revokeObjectURL(pendingFile.previewUrl);
    setPendingFile(null);
    localStorage.removeItem("chat_name");
    localStorage.removeItem("chat_color");
    localStorage.removeItem("chat_server_id");
    localStorage.removeItem("chat_server_name");
    setServerId("");
    setServerName("Team Hub");
    setMembers([]);
    setReady(false);
    setMessages([]);
  };

  // Clicking an invite link (?invite=TOKEN) is a deliberate "join THIS server"
  // action — like Discord — so it still auto-joins straight in, skipping the
  // picker. A plain visit to the Community tab is NOT auto-join: it shows the
  // picker below the FIRST time, same as any brand-new visitor; after that,
  // `ready`'s localStorage-backed initial state (set once handleSetup succeeds)
  // is what skips straight to chat on return visits, including navigating away
  // to another page and back — no special-casing needed for that, it's just
  // how `ready` already initializes from localStorage on every mount.
  const invite = parseInvite(new URLSearchParams(window.location.search).get("invite") || "");
  const pendingInvite = invite && invite !== PUBLIC_SERVER_ID ? invite : "";
  const inviteJoinedRef = React.useRef(false);
  React.useEffect(() => {
    if (!pendingInvite || ready || !user || inviteJoinedRef.current) return;
    inviteJoinedRef.current = true;
    try { window.history.replaceState({}, "", window.location.pathname); } catch { /* ignore */ }
    const m = user.user_metadata || {};
    const color = m.chat_color || localStorage.getItem("chat_color") || CHAT_COLORS[0];
    handleSetup({ serverId: pendingInvite, serverName: "", name: accountName.trim(), color, isCreator: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingInvite, ready, user]);

  // Gate: the Community requires a signed-in account (one account = one identity).
  if (!user) return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: LIGHT_PAGE_BG }}>
      <div className="w-full max-w-sm bg-white rounded-3xl p-8 text-center" style={{ boxShadow: "0 24px 60px rgba(0,0,0,0.10)", border: "1px solid #ececf1" }}>
        <div className="w-16 h-16 rounded-full overflow-hidden mx-auto mb-4" style={{ background: "radial-gradient(circle at 50% 32%, #2b2e35, #141519)" }}>
          <VoltLogo size={64} />
        </div>
        <h2 className="text-xl font-semibold tracking-tight mb-1.5" style={{ color: "#1d1d1f" }}>Join the Community</h2>
        <p className="text-sm leading-relaxed mb-6" style={{ color: "#6e6e73" }}>
          Sign in to chat with other VEX teams.
        </p>
        <GoogleButton onError={setError} />
        {error && <p className="text-red-500 text-xs mt-2 text-left">{error}</p>}
        <button onClick={() => window.dispatchEvent(new CustomEvent("voltz-open-auth"))}
          className="w-full mt-2.5 py-3 rounded-xl text-sm font-semibold transition hover:bg-gray-50"
          style={{ border: "1px solid #dcdce3", color: "#1d1d1f", background: "#fff" }}>
          Sign in with email
        </button>
      </div>
    </div>
  );

  if (!ready) {
    // Only a pending invite link auto-joins (see effect above) — show its veil
    // while that's in flight. Every other case shows the picker.
    if (pendingInvite) return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3" style={{ background: darkMode ? DARK_PAGE_BG : LIGHT_PAGE_BG }}>
        <div className="w-14 h-14 rounded-full overflow-hidden" style={{ background: "radial-gradient(circle at 50% 32%, #2b2e35, #141519)", animation: "floatIdleSpin 1.6s ease-in-out infinite" }}>
          <VoltLogo size={56} />
        </div>
        <p style={{ color: darkMode ? "#a1a1aa" : "#6e6e73", fontSize: 13 }}>Joining the server…</p>
      </div>
    );
    return (
      <ChatThemeCtx.Provider value={darkMode}>
        <SetupScreen onSetup={handleSetup} error={error} darkMode={darkMode} toggleTheme={toggleTheme} defaultName={accountName}/>
      </ChatThemeCtx.Provider>
    );
  }

  const myName    = localStorage.getItem("chat_name");
  const myColor   = localStorage.getItem("chat_color") || CHAT_COLORS[3];
  const chInfo    = CHAT_CHANNELS.find(c=>c.id===channel);
  const isCommunity = serverId === PUBLIC_SERVER_ID;

  // Roles (team servers only). Owner = the creator, immune and the only one who can
  // grant/revoke. Admin = owner OR anyone the owner granted → moderator powers.
  const isOwner = !isCommunity && !!adminUser && myName === adminUser;
  const isAdmin = isOwner || (!isCommunity && adminList.includes(myName));
  const roleOf  = (name) => name === adminUser ? "owner" : adminList.includes(name) ? "admin" : "member";

  // Owner-only: persist a new admin list (realtime roles_config; optimistic locally).
  const saveRoles = (nextAdmins) => {
    if (!isOwner) return;
    setAdminList(nextAdmins);
    getSB()?.from("messages").insert({
      channel: `${serverId}_sys`, username: myName, color: myColor, content: null,
      share_type: "roles_config",
      share_data: { admins: nextAdmins, updatedBy: myName, updatedAt: new Date().toISOString() },
    }).then(({ error }) => { if (error) chatLog.warn("saveRoles failed", { msg: error.message }); });
  };
  const grantAdmin  = (name) => { if (isOwner && name !== adminUser && !adminList.includes(name)) saveRoles([...adminList, name]); };
  const revokeAdmin = (name) => { if (isOwner) saveRoles(adminList.filter(n => n !== name)); };

  // Reactions ride the same channel as messages (share_type "reaction"): aggregate
  // them into a { msgId: { emoji: [{username,rowId}] } } map and keep them out of
  // the rendered bubble list. Plain derivations (not hooks) — we're past the gate
  // returns above, where a conditional hook would be illegal.
  const reactionMap = {};
  for (const m of messages) {
    if (m.share_type !== "reaction" || !m.share_data) continue;
    const { msgId, emoji } = m.share_data;
    if (!msgId || !emoji) continue;
    (reactionMap[msgId] ||= {});
    (reactionMap[msgId][emoji] ||= []);
    reactionMap[msgId][emoji].push({ username: m.username, rowId: m.id });
  }
  const renderedMessages = messages.filter(m => m.share_type !== "reaction");

  // Toggle my reaction on a message. Adding relies on the realtime INSERT echo to
  // appear (like a normal message); removing is optimistic since we don't subscribe
  // to DELETE events (filtered deletes need REPLICA IDENTITY FULL).
  const toggleReaction = async (msgId, emoji) => {
    const sb = getSB();
    if (!sb || !myName) return;
    const mine = messages.find(m => m.share_type === "reaction" && m.username === myName
      && m.share_data?.msgId === msgId && m.share_data?.emoji === emoji);
    if (mine) {
      setMessages(prev => prev.filter(m => m.id !== mine.id));
      await sb.from("messages").delete().eq("id", mine.id);
    } else {
      await sb.from("messages").insert({
        channel: `${serverId}_${channel}`, username: myName, color: myColor,
        content: null, share_type: "reaction", share_data: { msgId, emoji },
      });
    }
  };
  const visibleChannels = isCommunity
    ? CHAT_CHANNELS.filter(c => c.id === "general")
    : [...CHAT_CHANNELS, ...customChannels];

  const copyCode = () => {
    navigator.clipboard.writeText(inviteLink(serverId)).then(()=>{ setCodeCopied(true); setTimeout(()=>setCodeCopied(false), 2000); });
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, preferCurrentTab: true });
      recChunksRef.current = [];
      const rec = new MediaRecorder(stream, { mimeType: "video/webm" });
      rec.ondataavailable = e => { if (e.data.size > 0) recChunksRef.current.push(e.data); };
      rec.onstop = () => {
        const blob = new Blob(recChunksRef.current, { type:"video/webm" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `meeting-${new Date().toISOString().slice(0,19).replace(/:/g,"-")}.webm`;
        a.click();
        URL.revokeObjectURL(a.href);
        stream.getTracks().forEach(t => t.stop());
        setRecording(false);
      };
      rec.start();
      recorderRef.current = rec;
      setRecording(true);
    } catch {}
  };
  const stopRecording = () => { recorderRef.current?.stop(); };
  // Open a shared collaborative whiteboard for this server. Excalidraw rooms are
  // identified by `#room=<20-hex-id>,<128-bit base64url key>`; deriving both
  // deterministically from serverId means everyone in the server (with the invite)
  // lands in the same board — no backend, no account. (tldraw's old /r/ auto-rooms
  // were discontinued — that URL now 404s, which is why the button did nothing.)
  const deriveWhiteboardUrl = async () => {
    try {
      const enc = new TextEncoder();
      const idBuf  = await crypto.subtle.digest("SHA-256", enc.encode("voltz-wb-id:"  + serverId));
      const keyBuf = await crypto.subtle.digest("SHA-256", enc.encode("voltz-wb-key:" + serverId));
      const roomId = Array.from(new Uint8Array(idBuf).slice(0, 10), b => b.toString(16).padStart(2, "0")).join("");
      const keyB64 = btoa(String.fromCharCode(...new Uint8Array(keyBuf).slice(0, 16)))
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      return `https://excalidraw.com/#room=${roomId},${keyB64}`;
    } catch (e) {
      chatLog.warn("whiteboard room derivation failed — opening a blank board", { msg: e?.message });
      return "https://excalidraw.com";
    }
  };
  // Open the whiteboard INSIDE the call, and broadcast so it opens for everyone
  // (Google Meet / Teams style). Same derived room for all → one shared board.
  const openWhiteboard = async () => {
    const url = await deriveWhiteboardUrl();
    setWhiteboardUrl(url);
    setWhiteboardOpen(true);
    wbChanRef.current?.send({ type: "broadcast", event: "whiteboard", payload: { open: true, url } });
  };
  const closeWhiteboard = () => {
    setWhiteboardOpen(false);
    wbChanRef.current?.send({ type: "broadcast", event: "whiteboard", payload: { open: false } });
  };

  const addChannel = async () => {
    const label = newChName.trim();
    if (!label) return;
    const id = label.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    if (!id || visibleChannels.some(c => c.id === id)) return;
    const sb = getSB();
    if (!sb) return;
    const updated = [...customChannels, { id, label }];
    await sb.from("messages").insert({
      channel:    `${serverId}_sys`,
      username:   myName,
      color:      myColor,
      content:    null,
      share_type: "channel_config",
      share_data: { channels: updated },
    });
    setCustomChannels(updated);
    setNewChName("");
    setShowAddCh(false);
    setChannel(id);
  };

  const deleteChannel = async (chId) => {
    const sb = getSB();
    if (!sb) return;
    const updated = customChannels.filter(c => c.id !== chId);
    await sb.from("messages").insert({
      channel:    `${serverId}_sys`,
      username:   myName,
      color:      myColor,
      content:    null,
      share_type: "channel_config",
      share_data: { channels: updated },
    });
    setCustomChannels(updated);
    if (channel === chId) setChannel("general");
  };

  const CH_ICONS = {
    general:     <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>,
    competition: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2z"/></svg>,
    calendar:    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>,
    "build-log": <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>,
    notebook:    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>,
  };

  const Sidebar = () => (
    <div style={{ width:240, background:T.sidebarBg, flexShrink:0, display:"flex", flexDirection:"column", height:"100%", borderRight:`1px solid ${T.border}` }}>

      {/* Server header */}
      <div style={{ padding:"14px 16px 12px", borderBottom:`1px solid ${T.border}` }}>
        <div className="flex items-center gap-3">
          <div style={{ width:38, height:38, borderRadius:12, background:"linear-gradient(135deg,#ef4444,#dc2626)", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, fontWeight:800, fontSize:17, color:"#fff" }}>
            {serverName[0]?.toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p style={{ color:T.textPrimary, fontWeight:700, fontSize:14, lineHeight:1.2 }} className="truncate">{serverName}</p>
            <p style={{ color:T.accentText, fontSize:11 }}>VEX Team Server</p>
          </div>
          <button onClick={()=>setMobileNav(false)} className="lg:hidden" style={{ color:T.textDim, fontSize:18 }}>✕</button>
        </div>
      </div>

      {/* Channels */}
      <div className="flex-1 overflow-y-auto" style={{ padding:"12px 8px" }}>
        {/* Header row */}
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"0 8px 8px" }}>
          <p style={{ color:T.textLabel, fontSize:10, fontWeight:700, letterSpacing:"0.08em" }}>CHANNELS</p>
          {isAdmin && !isCommunity && (
            <button onClick={()=>{ setShowAddCh(v=>!v); setNewChName(""); }} title="Add channel"
              style={{ background:T.addChBtnBg, border:`1px solid ${T.addChBtnBd}`, color:T.addChBtnColor, borderRadius:6, width:22, height:22, display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", fontSize:16, fontWeight:700, lineHeight:1, flexShrink:0, transition:"all 0.15s" }}>
              +
            </button>
          )}
        </div>

        {/* Add-channel form */}
        {showAddCh && isAdmin && !isCommunity && (
          <div style={{ padding:"0 4px 8px" }}>
            <input
              value={newChName}
              onChange={e=>setNewChName(e.target.value)}
              onKeyDown={e=>{ if(e.key==="Enter") addChannel(); if(e.key==="Escape"){ setShowAddCh(false); setNewChName(""); }}}
              placeholder="channel-name"
              autoFocus
              style={{ background:T.addChInputBg, border:`1px solid ${T.accentBorder}`, color:T.textPrimary, borderRadius:6, padding:"6px 8px", width:"100%", fontSize:12, outline:"none", boxSizing:"border-box" }}
            />
            <div style={{ display:"flex", gap:4, marginTop:4 }}>
              <button onClick={addChannel}
                style={{ flex:1, background:T.addChAddbg, border:`1px solid ${T.addChAddbBd}`, color:T.addChAddColor, borderRadius:5, padding:"4px 0", fontSize:11, fontWeight:700, cursor:"pointer" }}>
                Add
              </button>
              <button onClick={()=>{ setShowAddCh(false); setNewChName(""); }}
                style={{ background:T.hoverBg, border:`1px solid ${T.border}`, color:T.textDim, borderRadius:5, padding:"4px 8px", fontSize:11, cursor:"pointer" }}>
                ✕
              </button>
            </div>
          </div>
        )}

        {/* Channel list */}
        {visibleChannels.map(ch => {
          const active = channel === ch.id;
          const isCustom = customChannels.some(c => c.id === ch.id);
          const defaultIcon = <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></svg>;
          return (
            <div key={ch.id} className="group" style={{ position:"relative", marginBottom:2 }}>
              <button onClick={()=>{ setChannel(ch.id); setMobileNav(false); }}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm transition text-left"
                style={{ color:active?T.chActiveText:T.textChannel, background:active?T.chActiveBg:"transparent", paddingRight: isCustom ? 28 : undefined }}>
                <span style={{ color:active?T.chActiveIcon:T.chInactiveIcon, flexShrink:0 }}>{CH_ICONS[ch.id] || defaultIcon}</span>
                <span style={{ fontWeight:active?700:400 }}>{ch.label}</span>
              </button>
              {isCustom && isAdmin && !isCommunity && (
                <button onClick={()=>deleteChannel(ch.id)} title="Delete channel"
                  className="opacity-0 group-hover:opacity-100"
                  style={{ position:"absolute", right:6, top:"50%", transform:"translateY(-50%)", background:"rgba(239,68,68,0.08)", border:"1px solid rgba(239,68,68,0.18)", color:"#ef4444", borderRadius:4, width:18, height:18, display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", fontSize:10, transition:"opacity 0.15s", flexShrink:0 }}>
                  ✕
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Invite link — team servers only */}
      {!isCommunity && (
        <div style={{ padding:"12px 14px", borderTop:`1px solid ${T.border}` }}>
          <p style={{ color:T.textLabel, fontSize:10, fontWeight:700, letterSpacing:"0.07em", marginBottom:8 }}>INVITE LINK</p>
          <div style={{ background:T.inviteCodeBg, borderRadius:10, padding:"9px 11px", marginBottom:8, border:`1px solid ${T.accentBorder}` }}>
            <p style={{ fontFamily:"monospace", fontSize:11, color:T.inviteCode, textAlign:"center", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{inviteLink(serverId)}</p>
          </div>
          <button onClick={copyCode}
            style={{ width:"100%", padding:"7px", background:codeCopied?"rgba(74,222,128,0.08)":T.inviteCopyBg, border:`1px solid ${codeCopied?"rgba(74,222,128,0.3)":T.inviteCopyBd}`, borderRadius:8, color:codeCopied?T.onlineText:T.accentText, fontSize:12, fontWeight:600, cursor:"pointer", transition:"all 0.2s", display:"flex", alignItems:"center", justifyContent:"center", gap:6 }}>
            {codeCopied ? (
              <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>Link copied!</>
            ) : (
              <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>Copy invite link</>
            )}
          </button>
          <p style={{ color:T.textDim, fontSize:10, marginTop:6, textAlign:"center" }}>Anyone with this link can join — only people you send it to.</p>
        </div>
      )}

      {/* User panel */}
      <div style={{ padding:"10px 12px", background:T.userPanelBg, borderTop:`1px solid ${T.border}`, display:"flex", alignItems:"center", gap:8 }}>
        {/* Avatar with status dot — click to cycle status */}
        <button onClick={()=>setMyStatus(s=>s==="online"?"dnd":"online")} title="Click to toggle status" style={{ position:"relative", flexShrink:0, background:"none", border:"none", padding:0, cursor:"pointer" }}>
          <div style={{ width:32, height:32, borderRadius:"50%", background:myColor, display:"flex", alignItems:"center", justifyContent:"center" }}>
            <span style={{ color:"#fff", fontWeight:700, fontSize:13 }}>{myName[0]?.toUpperCase()}</span>
          </div>
          <div style={{ position:"absolute", bottom:0, right:0, width:10, height:10, borderRadius:"50%", background:myStatus==="online"?"#4ade80":"#ef4444", border:`2px solid ${T.statusBorder}` }}/>
        </button>
        <div className="flex-1 min-w-0">
          <p style={{ color:T.textPrimary, fontSize:12, fontWeight:600, lineHeight:1.2 }} className="truncate">{myName}</p>
          <p style={{ color:myStatus==="online"?T.onlineText:T.dndText, fontSize:10 }}>
            {isAdmin && !isCommunity ? `${isOwner?"Owner":"Admin"} · ${myStatus==="online"?"Online":"DND"}` : myStatus==="online"?"Online":"Do Not Disturb"}
          </p>
        </div>
        {/* Theme toggle */}
        <button onClick={toggleTheme} title={darkMode?"Switch to light mode":"Switch to dark mode"}
          style={{ background:"none", border:"none", cursor:"pointer", color:T.textDim, padding:2, display:"flex", alignItems:"center", flexShrink:0, transition:"color 0.15s" }}>
          {darkMode
            ? <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
            : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
          }
        </button>
        <button onClick={disconnect} title="Leave server" style={{ color:T.textDim }} className="hover:text-red-500 transition">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        </button>
      </div>
    </div>
  );

  return (
    <ChatThemeCtx.Provider value={darkMode}>
    <div style={{ height:"calc(100vh - 72px)", display:"flex", background:T.outerBg, overflow:"hidden" }} className="mt-[72px]">
      {/* Desktop sidebar */}
      <div className="hidden lg:flex flex-col" style={{ width:240, flexShrink:0 }}>
        <Sidebar/>
      </div>

      {/* Mobile sidebar overlay */}
      {mobileNav && (
        <div className="fixed inset-0 z-40 flex lg:hidden" style={{ top:72 }}>
          <div className="flex flex-col" style={{ width:240 }}><Sidebar/></div>
          <div className="flex-1 bg-black/40" onClick={()=>setMobileNav(false)}/>
        </div>
      )}

      {/* Main */}
      <div style={{ flex:1, display:"flex", flexDirection:"column", minWidth:0 }}>
        {/* Channel header */}
        <div style={{ padding:"12px 20px", borderBottom:`1px solid ${T.border}`, background:T.headerBg, display:"flex", alignItems:"center", gap:12, flexShrink:0 }}>
          <button onClick={()=>setMobileNav(true)} className="lg:hidden" style={{ color:T.textDim, marginRight:4 }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          </button>
          <div style={{ width:34, height:34, borderRadius:9, background:T.accentBg, border:`1px solid ${T.accentBorder}`, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, color:T.accentText }}>
            {CH_ICONS[channel]}
          </div>
          <div className="flex-1 min-w-0">
            <p style={{ color:T.textPrimary, fontWeight:700, fontSize:15 }}>{channel}</p>
            <p style={{ color:T.textDim, fontSize:11 }} className="hidden sm:block">{chInfo?.desc}</p>
          </div>
          {/* Video call button */}
          <button onClick={startCall} disabled={callLoading} title="Start video call"
            style={{ display:"flex", alignItems:"center", gap:5, padding:"5px 10px", borderRadius:8, background:inCall?"rgba(34,197,94,0.1)":callLoading?T.callBtnBg:"transparent", border:"1px solid", borderColor:inCall?"rgba(34,197,94,0.3)":callLoading?T.callBtnBd:T.border, color:inCall?T.onlineText:callLoading?T.accentText:T.callBtnColor, transition:"all 0.2s", flexShrink:0, opacity:callLoading?0.7:1 }}>
            {callLoading
              ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10" strokeOpacity="0.3"/><path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite"/></path></svg>
              : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
            }
            <span style={{ fontSize:12, fontWeight:600 }} className="hidden sm:inline">{inCall?"In call":callLoading?"Joining…":"Call"}</span>
          </button>
          {/* Automod button — owner only, invisible to regular users */}
          {ownerUnlocked && (
            <button onClick={()=>setShowAutomod(true)} title="Automod (owner)"
              style={{ display:"flex", alignItems:"center", gap:5, padding:"5px 10px", borderRadius:8, background:flaggedMsgs.length>0?"rgba(239,68,68,0.1)":"transparent", border:"1px solid", borderColor:flaggedMsgs.length>0?"rgba(239,68,68,0.3)":T.border, color:flaggedMsgs.length>0?"#ef4444":T.callBtnColor, transition:"all 0.2s", flexShrink:0 }}
              className="hidden lg:flex transition">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
              <span style={{ fontSize:12, fontWeight:600 }}>
                Automod{flaggedMsgs.length>0 ? ` (${flaggedMsgs.length})` : ""}
              </span>
            </button>
          )}
          {/* Members toggle button */}
          <button onClick={()=>setShowMembers(v=>!v)} title="Toggle member list"
            style={{ display:"flex", alignItems:"center", gap:5, padding:"5px 10px", borderRadius:8, background:showMembers?T.accentBg:"transparent", border:"1px solid", borderColor:showMembers?T.accentBorder:T.border, color:showMembers?T.accentText:T.callBtnColor, transition:"all 0.2s", flexShrink:0 }}
            className="hidden lg:flex transition">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            <span style={{ fontSize:12, fontWeight:600 }}>{members.length}</span>
          </button>
        </div>

        {/* Messages + member list row */}
        <div style={{ flex:1, display:"flex", minHeight:0 }}>
          {/* Notebook view */}
          {channel === "notebook" && !isCommunity ? (
            <NotebookView serverId={serverId} myName={myName} myColor={myColor} isAdmin={isAdmin}/>
          ) : (
          <div className="flex-1 overflow-y-auto" style={{ padding:"8px 0 4px", background:T.msgAreaBg }}>
            {renderedMessages.length === 0 && (
              <div className="text-center py-16 px-6">
                <div style={{ width:64, height:64, borderRadius:18, background:T.accentBg, border:`1px solid ${T.accentBorder}`, display:"flex", alignItems:"center", justifyContent:"center", margin:"0 auto 14px", color:T.accentText }}>
                  {CH_ICONS[channel]}
                </div>
                <p style={{ color:T.textPrimary, fontWeight:700, fontSize:18, marginBottom:6 }}>Welcome to {channel}!</p>
                <p style={{ color:T.textDim, fontSize:14 }}>{chInfo?.desc}. Start the conversation.</p>
              </div>
            )}
            {renderedMessages.map((msg, i) => {
              const prev = renderedMessages[i-1];
              const sameUser = prev && prev.username===msg.username && (new Date(msg.created_at)-new Date(prev.created_at)) < 300000;
              return <MessageRow key={msg.id} msg={msg} sameUser={sameUser} isMine={msg.username===myName}
                onDelete={deleteMsg} onJoinCall={joinCall}
                reactions={reactionMap[msg.id]} myName={myName} onToggleReaction={toggleReaction}/>;
            })}
            <div ref={endRef}/>
          </div>
          )} {/* end notebook conditional */}

          {/* Member list panel — desktop only */}
          {showMembers && (
            <div className="hidden lg:flex flex-col" style={{ width:200, background:T.membersBg, borderLeft:`1px solid ${T.membersBorder}`, flexShrink:0 }}>
              <div style={{ padding:"12px 14px 8px", borderBottom:`1px solid ${T.membersBorder}` }}>
                <p style={{ color:T.textLabel, fontSize:10, fontWeight:700, letterSpacing:"0.08em" }}>
                  MEMBERS — {uniqueMembers.length}
                </p>
              </div>
              <div className="flex-1 overflow-y-auto" style={{ padding:"8px 6px" }}>
                {(() => {
                  const owners  = !isCommunity ? uniqueMembers.filter(m => m.name === adminUser) : [];
                  const admins  = !isCommunity ? uniqueMembers.filter(m => m.name !== adminUser && adminList.includes(m.name)) : [];
                  const members = uniqueMembers.filter(m => isCommunity || (m.name !== adminUser && !adminList.includes(m.name)));

                  const MemberRow = ({ m, dim, role }) => (
                    <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg group">
                      <div style={{ position:"relative", flexShrink:0 }}>
                        <div style={{ width:28, height:28, borderRadius:"50%", background:`radial-gradient(circle at 35% 28%, rgba(255,255,255,0.4), rgba(255,255,255,0) 58%), ${m.color}`, opacity:dim?0.55:1, display:"flex", alignItems:"center", justifyContent:"center", boxShadow:"inset 0 0 0 1px rgba(255,255,255,0.14)" }}>
                          <span style={{ color:"#fff", fontSize:11, fontWeight:700, textShadow:"0 1px 2px rgba(0,0,0,0.25)" }}>{m.name?.[0]?.toUpperCase()}</span>
                        </div>
                        <div style={{ position:"absolute", bottom:0, right:0, width:9, height:9, borderRadius:"50%", background:m.status==="dnd"?"#ef4444":"#4ade80", border:`2px solid ${T.memberStatusBorder}` }}/>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p style={{ color:m.name===myName?T.textPrimary:T.textMuted, fontSize:12, fontWeight:m.name===myName?600:400 }} className="truncate">{m.name}</p>
                        {m.name===myName && <p style={{ color:T.textDim, fontSize:9, lineHeight:1.2 }}>you</p>}
                      </div>
                      {role === "owner" && (
                        <span title="Server owner" style={{ flexShrink:0, color:"#f5b301" }}>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M5 16L3 6l5.5 4L12 4l3.5 6L21 6l-2 10H5zm0 2h14v2H5v-2z"/></svg>
                        </span>
                      )}
                      {/* Owner-only role controls — never shown on the owner's own row. */}
                      {isOwner && role !== "owner" && (
                        role === "admin"
                          ? <button onClick={()=>revokeAdmin(m.name)} title="Remove admin role"
                              className="opacity-0 group-hover:opacity-100 transition" style={{ flexShrink:0, fontSize:9, fontWeight:700, color:T.errorText, border:`1px solid ${T.border}`, borderRadius:6, padding:"2px 5px", background:"transparent", cursor:"pointer" }}>− Admin</button>
                          : <button onClick={()=>grantAdmin(m.name)} title="Make this member an admin"
                              className="opacity-0 group-hover:opacity-100 transition" style={{ flexShrink:0, fontSize:9, fontWeight:700, color:T.accentText, border:`1px solid ${T.accentBorder}`, borderRadius:6, padding:"2px 5px", background:"transparent", cursor:"pointer" }}>+ Admin</button>
                      )}
                    </div>
                  );

                  return (
                    <>
                      {owners.length > 0 && (
                        <>
                          <p style={{ color:"#f5b301", fontSize:10, fontWeight:700, letterSpacing:"0.08em", padding:"6px 8px 4px" }}>OWNER</p>
                          {owners.map((m,i) => <MemberRow key={i} m={m} dim={m.status==="dnd"} role="owner"/>)}
                        </>
                      )}
                      {admins.length > 0 && (
                        <>
                          <p style={{ color:T.membersAddmin, fontSize:10, fontWeight:700, letterSpacing:"0.08em", padding:"10px 8px 4px" }}>ADMIN — {admins.length}</p>
                          {admins.map((m,i) => <MemberRow key={i} m={m} dim={m.status==="dnd"} role="admin"/>)}
                        </>
                      )}
                      {members.length > 0 && (
                        <>
                          <p style={{ color:T.textLabel, fontSize:10, fontWeight:700, letterSpacing:"0.08em", padding:"10px 8px 4px" }}>MEMBER — {members.length}</p>
                          {members.map((m,i) => <MemberRow key={i} m={m} dim={m.status==="dnd"} role="member"/>)}
                        </>
                      )}
                      {uniqueMembers.length === 0 && (
                        <p style={{ color:T.textDim, fontSize:11, textAlign:"center", padding:"20px 8px" }}>Connecting…</p>
                      )}
                    </>
                  );
                })()}
              </div>
            </div>
          )}
        </div>

        {/* Input */}
        <div style={{ padding:"0 16px 20px", flexShrink:0, background:T.outerBg }}>
          {error && <p style={{ color:T.errorText, fontSize:11, marginBottom:6 }}>{error}</p>}

          {/* Typing indicator */}
          {(() => {
            const names = Object.keys(typingMap).filter(n => n && n !== myName);
            if (!names.length) return null;
            const label = names.length === 1 ? `${names[0]} is typing`
              : names.length === 2 ? `${names[0]} and ${names[1]} are typing`
              : "Several people are typing";
            return (
              <div style={{ display:"flex", alignItems:"center", gap:7, height:18, marginBottom:5, color:T.accentText }}>
                <span style={{ display:"inline-flex", gap:3 }} aria-hidden="true">
                  <span className="typing-dot"/><span className="typing-dot"/><span className="typing-dot"/>
                </span>
                <span style={{ color:T.textMuted, fontSize:11 }}>{label}…</span>
              </div>
            );
          })()}

          {/* File preview strip */}
          {pendingFile && (
            <div style={{ marginBottom:8 }}>
              <div style={{ display:"inline-flex", alignItems:"center", gap:10, background:T.cardBg, border:`1px solid ${T.accentBorder}`, borderRadius:12, padding:"8px 10px", maxWidth:320 }}>
                {pendingFile.mediaType === "image" ? (
                  <img src={pendingFile.previewUrl} alt="preview"
                    style={{ width:54, height:54, objectFit:"cover", borderRadius:7, flexShrink:0 }}/>
                ) : (
                  <video src={pendingFile.previewUrl}
                    style={{ width:54, height:54, objectFit:"cover", borderRadius:7, flexShrink:0 }}/>
                )}
                <div style={{ flex:1, minWidth:0 }}>
                  <p style={{ color:T.filePreviewText, fontSize:11, fontWeight:600, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{pendingFile.file.name}</p>
                  <p style={{ color:T.textDim, fontSize:10, marginTop:2 }}>
                    {formatBytes(pendingFile.file.size)} · {pendingFile.mediaType}
                    {" · "}
                    <span style={{ color: checkDailyUpload(dailyUsedBytes, pendingFile.file.size).allowed ? T.textDim : "#ef4444" }}>
                      {formatBytes(DAILY_UPLOAD_BYTES - dailyUsedBytes)} left today
                    </span>
                  </p>
                  {sending && uploadPct > 0 && (
                    <div style={{ height:3, background:T.uploadTrackBg, borderRadius:2, marginTop:5, overflow:"hidden" }}>
                      <div style={{ height:"100%", width:`${uploadPct}%`, background:"linear-gradient(90deg,#ef4444,#dc2626)", borderRadius:2, transition:"width 0.3s" }}/>
                    </div>
                  )}
                </div>
                <button onClick={cancelFile} title="Remove"
                  style={{ color:T.textDim, background:"none", border:"none", cursor:"pointer", fontSize:15, padding:"2px 4px", flexShrink:0, lineHeight:1 }}>✕</button>
              </div>
            </div>
          )}

          <div style={{ background:T.inputBg, borderRadius:14, padding:"10px 14px", display:"flex", alignItems:"center", gap:10, border:`1px solid ${T.border}` }}>
            {/* Hidden file input */}
            <input ref={fileRef} type="file" accept="image/*,video/*" style={{ display:"none" }} onChange={handleFilePick}/>
            {/* Attach button */}
            <button onClick={()=>fileRef.current?.click()} title="Attach image or video"
              style={{ color:pendingFile?T.accentText:T.textDim, background:"none", border:"none", cursor:"pointer", padding:2, display:"flex", alignItems:"center", flexShrink:0, transition:"color 0.15s" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
              </svg>
            </button>
            <input
              ref={inpRef}
              value={input}
              onChange={e=>{ setInput(e.target.value); if (e.target.value.trim()) pingTyping(); }}
              onKeyDown={e=>e.key==="Enter" && !e.shiftKey && send()}
              placeholder={pendingFile ? "Add a caption… (optional)" : `Message in ${channel}…`}
              className="flex-1 outline-none text-sm bg-transparent"
              style={{ color:T.textSecond }}
            />
            {/* Emoji button + picker */}
            <div className="relative" style={{ flexShrink:0 }}>
              <button onClick={()=>setEmojiOpen(o=>!o)} title="Emoji"
                style={{ color:emojiOpen?T.accentText:T.textDim, background:"none", border:"none", cursor:"pointer", padding:2, display:"flex", alignItems:"center", transition:"color 0.15s" }}>
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
              </button>
              {emojiOpen && (
                <EmojiPicker dark={darkMode} align="right"
                  onPick={(e)=>{ setInput(prev => prev + e); inpRef.current?.focus(); }}
                  onClose={()=>setEmojiOpen(false)} />
              )}
            </div>
            <button onClick={send} disabled={(!input.trim() && !pendingFile) || sending}
              style={{ width:34, height:34, borderRadius:10, background:(input.trim()||pendingFile)?"linear-gradient(135deg,#ef4444,#dc2626)":T.sendBtnInactive, border:"none", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, cursor:(input.trim()||pendingFile)?"pointer":"default", transition:"all 0.2s", opacity:sending?0.5:1 }}>
              {sending
                ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={(input.trim()||pendingFile)?"white":T.textDim} strokeWidth="2.5"><circle cx="12" cy="12" r="10" strokeOpacity="0.3"/><path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite"/></path></svg>
                : <svg width="16" height="16" viewBox="0 0 24 24" fill={(input.trim()||pendingFile)?"white":T.textDim}><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
              }
            </button>
          </div>
        </div>
      </div>

      {/* ── Video call overlay ─────────────────────────────────────────── */}
      {callLoading && (
        <div style={{ position:"fixed", inset:0, zIndex:9990, background: darkMode ? "rgba(20,20,22,0.92)" : "rgba(255,255,255,0.85)", backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center", top:72 }}>
          <div style={{ textAlign:"center" }}>
            <div style={{ width:48, height:48, borderRadius:"50%", border:"3px solid rgba(220,38,38,0.2)", borderTopColor:"#dc2626", animation:"spin 0.8s linear infinite", margin:"0 auto 14px" }}/>
            <p style={{ color:T.textMuted, fontSize:14 }}>Connecting to call…</p>
          </div>
        </div>
      )}
      {inCall && livekitToken && (
        <div style={{ position:"fixed", inset:0, zIndex:9990, background:"#0e0e10", display:"flex", flexDirection:"column", top:72 }}>
          {/* Toolbar */}
          <div style={{ height:52, background:"#141416", borderBottom:"1px solid rgba(34,197,94,0.15)", display:"flex", alignItems:"center", justifyContent:"space-between", padding:"0 20px", flexShrink:0, zIndex:1 }}>
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              <span style={{ width:8, height:8, borderRadius:"50%", background: preJoinDone?"#4ade80":"#facc15", display:"inline-block" }}/>
              <span style={{ color:"#f4f4f5", fontWeight:700, fontSize:14 }}>
                {preJoinDone ? `Live call · ${serverName} · #${channel}` : `Ready to join · ${serverName} · #${channel}`}
              </span>
            </div>
            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
              {preJoinDone && (<>
                <button onClick={whiteboardOpen ? closeWhiteboard : openWhiteboard} title={whiteboardOpen ? "Hide the shared whiteboard" : "Open a shared whiteboard for everyone"}
                  style={{ background:whiteboardOpen?"rgba(59,130,246,0.28)":"rgba(59,130,246,0.12)", border:`1px solid ${whiteboardOpen?"rgba(59,130,246,0.6)":"rgba(59,130,246,0.25)"}`, color:"#60a5fa", borderRadius:8, padding:"5px 12px", cursor:"pointer", fontSize:12, fontWeight:600, display:"flex", alignItems:"center", gap:5 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9l2 2 4-4"/><path d="M3 15h18"/></svg>
                  {whiteboardOpen ? "Hide board" : "Whiteboard"}
                </button>
                <button onClick={recording ? stopRecording : startRecording} title={recording ? "Stop recording" : "Record meeting"}
                  style={{ background:recording?"rgba(239,68,68,0.2)":"rgba(255,255,255,0.05)", border:`1px solid ${recording?"rgba(239,68,68,0.4)":"rgba(255,255,255,0.12)"}`, color:recording?"#f87171":"#94a3b8", borderRadius:8, padding:"5px 12px", cursor:"pointer", fontSize:12, fontWeight:600, display:"flex", alignItems:"center", gap:5 }}>
                  {recording
                    ? <><span style={{ width:8, height:8, borderRadius:"50%", background:"#ef4444", display:"inline-block", animation:"pulse 1s ease-in-out infinite" }}/>Stop Rec</>
                    : <><svg width="12" height="12" viewBox="0 0 24 24" fill="#94a3b8"><circle cx="12" cy="12" r="10"/></svg>Record</>
                  }
                </button>
              </>)}
              <button onClick={()=>{ setInCall(false); setLivekitToken(null); setPreJoinDone(false); setWhiteboardOpen(false); }}
                style={{ background:"rgba(239,68,68,0.12)", border:"1px solid rgba(239,68,68,0.25)", color:"#f87171", borderRadius:8, padding:"5px 14px", cursor:"pointer", fontSize:13, fontWeight:700 }}>
                {preJoinDone ? "Leave call" : "Cancel"}
              </button>
            </div>
          </div>

          {/* Pre-join lobby */}
          {!preJoinDone && (
            <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center", background:"#f1f5f9" }}>
              <div style={{ background:"#ffffff", borderRadius:24, padding:"40px 44px", maxWidth:420, width:"90%", textAlign:"center", border:"1px solid rgba(0,0,0,0.08)", boxShadow:"0 20px 60px rgba(0,0,0,0.1)" }}>
                {/* Avatar */}
                <div style={{ width:80, height:80, borderRadius:"50%", background:myColor, display:"flex", alignItems:"center", justifyContent:"center", margin:"0 auto 18px", boxShadow:`0 0 0 4px rgba(255,255,255,0.08)` }}>
                  <span style={{ color:"#fff", fontWeight:800, fontSize:32 }}>{myName?.[0]?.toUpperCase()}</span>
                </div>
                <p style={{ color:"#111827", fontWeight:800, fontSize:20, marginBottom:4 }}>{myName}</p>
                <p style={{ color:"#16a34a", fontSize:13, marginBottom:28 }}>Ready to join · <span style={{ color:"#dc2626" }}>#{channel}</span></p>

                {/* Mic / Camera toggles */}
                <div style={{ display:"flex", gap:14, justifyContent:"center", marginBottom:32 }}>
                  {/* Mic */}
                  <button onClick={() => setJoinOptions(o => ({ ...o, audioEnabled: !o.audioEnabled }))}
                    style={{ width:64, height:64, borderRadius:16, border:`2px solid ${joinOptions.audioEnabled?"rgba(34,197,94,0.4)":"rgba(239,68,68,0.4)"}`, background:joinOptions.audioEnabled?"rgba(34,197,94,0.1)":"rgba(239,68,68,0.1)", cursor:"pointer", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:4 }}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={joinOptions.audioEnabled?"#4ade80":"#f87171"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      {joinOptions.audioEnabled
                        ? <><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></>
                        : <><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></>
                      }
                    </svg>
                    <span style={{ color:joinOptions.audioEnabled?"#4ade80":"#f87171", fontSize:10, fontWeight:600 }}>{joinOptions.audioEnabled?"Mic on":"Mic off"}</span>
                  </button>
                  {/* Camera */}
                  <button onClick={() => setJoinOptions(o => ({ ...o, videoEnabled: !o.videoEnabled }))}
                    style={{ width:64, height:64, borderRadius:16, border:`2px solid ${joinOptions.videoEnabled?"rgba(34,197,94,0.4)":"rgba(239,68,68,0.4)"}`, background:joinOptions.videoEnabled?"rgba(34,197,94,0.1)":"rgba(239,68,68,0.1)", cursor:"pointer", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:4 }}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={joinOptions.videoEnabled?"#4ade80":"#f87171"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      {joinOptions.videoEnabled
                        ? <><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></>
                        : <><line x1="1" y1="1" x2="23" y2="23"/><path d="M21 21H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3m3-3h6l2 3h4a2 2 0 0 1 2 2v9.34m-7.72-2.06A4 4 0 0 1 8 12.94"/></>
                      }
                    </svg>
                    <span style={{ color:joinOptions.videoEnabled?"#4ade80":"#f87171", fontSize:10, fontWeight:600 }}>{joinOptions.videoEnabled?"Cam on":"Cam off"}</span>
                  </button>
                </div>

                {/* Join button */}
                <button onClick={() => setPreJoinDone(true)}
                  style={{ width:"100%", padding:"14px 0", borderRadius:14, background:"linear-gradient(135deg,#16a34a,#15803d)", border:"none", color:"#fff", fontWeight:800, fontSize:16, cursor:"pointer", letterSpacing:"0.02em", boxShadow:"0 4px 20px rgba(22,163,74,0.35)" }}>
                  Join call
                </button>
                <p style={{ color:"#9ca3af", fontSize:11, marginTop:12 }}>Others in this server can join from the chat</p>
              </div>
            </div>
          )}

          {/* Live room — whiteboard (when open) fills the stage, video docks beside it */}
          {preJoinDone && (
            <div style={{ flex:1, overflow:"hidden", display:"flex" }}>
              {whiteboardOpen && (
                <div style={{ flex:1, minWidth:0, position:"relative", background:"#ffffff", borderRight:"1px solid rgba(255,255,255,0.12)" }}>
                  <div style={{ height:34, background:"#141416", display:"flex", alignItems:"center", justifyContent:"space-between", padding:"0 12px" }}>
                    <span style={{ color:"#94a3b8", fontSize:11, fontWeight:600, display:"flex", alignItems:"center", gap:6 }}>
                      <span style={{ width:6, height:6, borderRadius:"50%", background:"#4ade80", display:"inline-block" }}/>
                      Shared whiteboard · everyone in the call can draw
                    </span>
                    <button onClick={closeWhiteboard} style={{ color:"#f87171", background:"none", border:"none", cursor:"pointer", fontSize:11, fontWeight:700 }}>Close ✕</button>
                  </div>
                  {whiteboardUrl && (
                    <iframe title="Shared whiteboard" src={whiteboardUrl}
                      style={{ width:"100%", height:"calc(100% - 34px)", border:"none", display:"block" }}
                      allow="clipboard-read; clipboard-write; fullscreen" />
                  )}
                </div>
              )}
              <div style={{ width: whiteboardOpen ? 340 : "100%", flexShrink:0, height:"100%", overflow:"hidden" }}>
              <LiveKitRoom
                token={livekitToken}
                serverUrl={LIVEKIT_URL}
                video={joinOptions.videoEnabled}
                audio={joinOptions.audioEnabled}
                data-lk-theme="default"
                style={{ height:"100%" }}
                onDisconnected={()=>{ setInCall(false); setLivekitToken(null); setPreJoinDone(false); }}
                options={{
                  videoCaptureDefaults: {
                    resolution: VideoPresets.h1080.resolution,
                  },
                  publishDefaults: {
                    videoEncoding: {
                      maxBitrate: 8_000_000,
                      maxFramerate: 60,
                    },
                    videoSimulcastLayers: [VideoPresets.h720, VideoPresets.h1080],
                    screenShareEncoding: {
                      maxBitrate: 15_000_000,
                      maxFramerate: 60,
                    },
                  },
                  dynacast: true,
                  adaptiveStream: true,
                }}
              >
                <VideoConference />
                <RoomAudioRenderer />
              </LiveKitRoom>
              </div>
            </div>
          )}
        </div>
      )}
      {/* ── Automod panel overlay ─────────────────────────────────── */}
      {showAutomod && (
        <div style={{ position:"fixed", inset:0, zIndex:9980, background:"rgba(0,0,0,0.55)", backdropFilter:"blur(3px)", display:"flex", alignItems:"center", justifyContent:"center", top:72 }}
          onClick={()=>setShowAutomod(false)}>
          <div style={{ background:T.cardBg, border:`1px solid ${T.border}`, borderRadius:18, padding:28, width:"min(680px,95vw)", maxHeight:"80vh", display:"flex", flexDirection:"column", boxShadow:"0 20px 60px rgba(0,0,0,0.35)", overflow:"hidden" }}
            onClick={e=>e.stopPropagation()}>

            {/* Header */}
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:20 }}>
              <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                <div style={{ width:36, height:36, borderRadius:10, background:"rgba(239,68,68,0.12)", border:"1px solid rgba(239,68,68,0.25)", display:"flex", alignItems:"center", justifyContent:"center", color:"#ef4444" }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                </div>
                <div>
                  <p style={{ color:T.textPrimary, fontWeight:700, fontSize:15 }}>Automod</p>
                  <p style={{ color:T.textDim, fontSize:11 }}>Text-match rules · {automodRules.length} rule{automodRules.length!==1?"s":""} · {flaggedMsgs.length} flagged</p>
                </div>
              </div>
              <button onClick={()=>setShowAutomod(false)} style={{ background:"none", border:"none", color:T.textDim, cursor:"pointer", fontSize:18, lineHeight:1, padding:4 }}>✕</button>
            </div>

            <div style={{ flex:1, overflowY:"auto", display:"flex", flexDirection:"column", gap:20 }}>
              {/* Add rule */}
              <div style={{ background:T.sidebarBg, borderRadius:12, padding:16, border:`1px solid ${T.border}` }}>
                <p style={{ color:T.textLabel, fontSize:10, fontWeight:700, letterSpacing:"0.08em", marginBottom:12 }}>ADD RULE</p>
                <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                  <input
                    value={newPattern} onChange={e=>setNewPattern(e.target.value)}
                    onKeyDown={e=>{ if(e.key==="Enter") addAutomodRule(); }}
                    placeholder="Word, phrase, or regex  (e.g. bad\s?word)"
                    style={{ flex:1, minWidth:160, background:T.inputBg, border:`1px solid ${T.border}`, borderRadius:8, padding:"7px 10px", color:T.textPrimary, fontSize:13, outline:"none" }}
                  />
                  <select value={newAction} onChange={e=>setNewAction(e.target.value)}
                    style={{ background:T.inputBg, border:`1px solid ${T.border}`, borderRadius:8, padding:"7px 10px", color:T.textPrimary, fontSize:13, cursor:"pointer" }}>
                    <option value="block">Block (silent drop)</option>
                    <option value="flag">Flag for review</option>
                  </select>
                  <button onClick={addAutomodRule}
                    style={{ background:"linear-gradient(135deg,#ef4444,#dc2626)", border:"none", borderRadius:8, padding:"7px 16px", color:"#fff", fontWeight:700, fontSize:13, cursor:"pointer" }}>
                    Add
                  </button>
                </div>
                <p style={{ color:T.textDim, fontSize:10, marginTop:8 }}>Patterns are matched case-insensitively against message content and usernames. Supports plain text and JavaScript regex.</p>
              </div>

              {/* Active rules */}
              {automodRules.length > 0 && (
                <div>
                  <p style={{ color:T.textLabel, fontSize:10, fontWeight:700, letterSpacing:"0.08em", marginBottom:8 }}>ACTIVE RULES</p>
                  <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                    {automodRules.map(rule => (
                      <div key={rule.id} style={{ display:"flex", alignItems:"center", gap:10, background:T.sidebarBg, border:`1px solid ${T.border}`, borderRadius:10, padding:"8px 12px" }}>
                        <span style={{ fontFamily:"monospace", fontSize:13, color:T.textPrimary, flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{rule.pattern}</span>
                        <span style={{ fontSize:10, fontWeight:700, padding:"2px 7px", borderRadius:5, background:rule.action==="block"?"rgba(239,68,68,0.12)":"rgba(251,191,36,0.12)", color:rule.action==="block"?"#ef4444":"#f59e0b", flexShrink:0 }}>
                          {rule.action.toUpperCase()}
                        </span>
                        <button onClick={()=>removeAutomodRule(rule.id)}
                          style={{ background:"none", border:"none", color:T.textDim, cursor:"pointer", fontSize:14, padding:"2px 4px", lineHeight:1, flexShrink:0 }} title="Remove rule">✕</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Flagged messages queue */}
              <div>
                <p style={{ color:T.textLabel, fontSize:10, fontWeight:700, letterSpacing:"0.08em", marginBottom:8 }}>
                  FLAGGED MESSAGES {flaggedMsgs.length>0 && <span style={{ color:"#ef4444" }}>· {flaggedMsgs.length} pending</span>}
                </p>
                {flaggedMsgs.length === 0 ? (
                  <p style={{ color:T.textDim, fontSize:12, textAlign:"center", padding:"20px 0" }}>No flagged messages.</p>
                ) : (
                  <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                    {flaggedMsgs.map((flag, i) => (
                      <div key={flag.sysId || i} style={{ background:T.sidebarBg, border:"1px solid rgba(239,68,68,0.2)", borderRadius:12, padding:"12px 14px" }}>
                        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:8, marginBottom:6 }}>
                          <div style={{ flex:1, minWidth:0 }}>
                            <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:4 }}>
                              <span style={{ fontWeight:700, fontSize:12, color:T.textPrimary }}>{flag.username}</span>
                              {flag.ip && <span style={{ fontFamily:"monospace", fontSize:10, color:T.textDim, background:T.msgAreaBg, padding:"1px 6px", borderRadius:4 }}>{flag.ip}</span>}
                              <span style={{ fontSize:10, color:T.textDim }}>{flag.channel?.split("_").slice(1).join("/")}</span>
                            </div>
                            <p style={{ fontSize:13, color:T.textSecond, wordBreak:"break-word" }}>{flag.content}</p>
                            {flag.matchedPattern && <p style={{ fontSize:10, color:"#f59e0b", marginTop:4 }}>Matched: <code style={{ fontFamily:"monospace" }}>{flag.matchedPattern}</code></p>}
                          </div>
                          <div style={{ display:"flex", gap:6, flexShrink:0, flexWrap:"wrap", justifyContent:"flex-end" }}>
                            <button onClick={()=>approveFlagged(flag.sysId)} title="Dismiss flag (keep message)"
                              style={{ background:"rgba(74,222,128,0.1)", border:"1px solid rgba(74,222,128,0.25)", color:"#4ade80", borderRadius:7, padding:"4px 10px", fontSize:11, fontWeight:600, cursor:"pointer" }}>
                              Allow
                            </button>
                            <button onClick={()=>deleteFlagged(flag)} title="Delete message + dismiss flag"
                              style={{ background:"rgba(239,68,68,0.1)", border:"1px solid rgba(239,68,68,0.25)", color:"#ef4444", borderRadius:7, padding:"4px 10px", fontSize:11, fontWeight:600, cursor:"pointer" }}>
                              Delete
                            </button>
                            {flag.ip && (
                              <button onClick={()=>banIp(flag.ip, flag.username)}
                                disabled={bannedIps.includes(flag.ip)}
                                title={bannedIps.includes(flag.ip) ? "IP already banned" : "Ban this IP globally"}
                                style={{ background:bannedIps.includes(flag.ip)?"rgba(100,100,100,0.1)":"rgba(239,68,68,0.15)", border:`1px solid ${bannedIps.includes(flag.ip)?"rgba(100,100,100,0.2)":"rgba(239,68,68,0.4)"}`, color:bannedIps.includes(flag.ip)?"#888":"#ef4444", borderRadius:7, padding:"4px 10px", fontSize:11, fontWeight:700, cursor:bannedIps.includes(flag.ip)?"default":"pointer" }}>
                                {bannedIps.includes(flag.ip) ? "Banned" : "Ban IP"}
                              </button>
                            )}
                          </div>
                        </div>
                        <p style={{ fontSize:9, color:T.textDim }}>{new Date(flag.timestamp).toLocaleString()}</p>
                      </div>
                    ))}
                  </div>
                )}
              {/* Banned IPs list */}
              {bannedIps.length > 0 && (
                <div>
                  <p style={{ color:T.textLabel, fontSize:10, fontWeight:700, letterSpacing:"0.08em", marginBottom:8 }}>BANNED IPs — {bannedIps.length}</p>
                  <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                    {bannedIps.map(ip => (
                      <div key={ip} style={{ display:"flex", alignItems:"center", gap:10, background:T.sidebarBg, border:"1px solid rgba(239,68,68,0.15)", borderRadius:8, padding:"6px 12px" }}>
                        <span style={{ fontFamily:"monospace", fontSize:12, color:"#ef4444", flex:1 }}>{ip}</span>
                        <button onClick={()=>unbanIp(ip)} title="Unban this IP"
                          style={{ background:"rgba(74,222,128,0.08)", border:"1px solid rgba(74,222,128,0.2)", color:"#4ade80", borderRadius:6, padding:"3px 10px", fontSize:11, fontWeight:600, cursor:"pointer" }}>
                          Unban
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Owner PIN prompt ──────────────────────────────────────── */}
      {showPinPrompt && (
        <div style={{ position:"fixed", inset:0, zIndex:9999, background:"rgba(0,0,0,0.7)", backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center", top:72 }}
          onClick={()=>{ setShowPinPrompt(false); setPinInput(""); setPinError(""); }}>
          <div style={{ background:T.cardBg, border:`1px solid ${T.border}`, borderRadius:16, padding:28, width:300, boxShadow:"0 20px 60px rgba(0,0,0,0.4)" }}
            onClick={e=>e.stopPropagation()}>
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:18 }}>
              <div style={{ width:34, height:34, borderRadius:10, background:"rgba(220,38,38,0.12)", border:"1px solid rgba(220,38,38,0.25)", display:"flex", alignItems:"center", justifyContent:"center", color:"#dc2626" }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              </div>
              <p style={{ color:T.textPrimary, fontWeight:700, fontSize:14 }}>Owner Access</p>
            </div>
            <input
              type="password"
              value={pinInput}
              onChange={e=>{ setPinInput(e.target.value); setPinError(""); }}
              onKeyDown={async e=>{
                if (e.key === "Enter") {
                  if (await checkPin(pinInput)) {
                    setOwnerUnlocked(true);
                    setShowPinPrompt(false);
                    setShowAutomod(true);
                    setPinInput("");
                    setPinError("");
                  } else {
                    setPinError("Incorrect PIN.");
                    setPinInput("");
                  }
                }
                if (e.key === "Escape") { setShowPinPrompt(false); setPinInput(""); setPinError(""); }
              }}
              placeholder="Enter owner PIN…"
              autoFocus
              style={{ width:"100%", boxSizing:"border-box", background:T.inputBg, border:`1px solid ${pinError?"#ef4444":T.border}`, borderRadius:8, padding:"9px 12px", color:T.textPrimary, fontSize:13, outline:"none", marginBottom:8 }}
            />
            {pinError && <p style={{ color:"#ef4444", fontSize:11, marginBottom:8 }}>{pinError}</p>}
            <button
              onClick={async ()=>{
                if (await checkPin(pinInput)) {
                  setOwnerUnlocked(true);
                  setShowPinPrompt(false);
                  setShowAutomod(true);
                  setPinInput(""); setPinError("");
                } else {
                  setPinError("Incorrect PIN.");
                  setPinInput("");
                }
              }}
              style={{ width:"100%", padding:"9px 0", borderRadius:9, background:"linear-gradient(135deg,#ef4444,#dc2626)", border:"none", color:"#fff", fontWeight:700, fontSize:13, cursor:"pointer" }}>
              Unlock
            </button>
          </div>
        </div>
      )}
    </div>
    </ChatThemeCtx.Provider>
  );
}

// Themed illustration for each Resources chapter — inline SVG (no external
// assets to break), gradient tinted with the chapter's accent. Used by the
// LearningTrack cards and as each chapter's banner.
// Guide card art: shows the real photo (`img`) when it loads, and falls back to
// the illustrated ChapterArt panel if no photo is set or the file is missing —
// so dropping a JPG into /public makes the photo appear with zero code changes.
// Module-level (not React state) so it survives the whole session, across page
// navigations — the Resources page fully remounts on every visit (PageTransition
// keys on pageKey), which used to force GuideArt to re-probe "is this loaded?"
// from zero every time, and that async re-check wasn't always instant — causing
// the illustrated SVG to flash again on revisits even though the photo was
// already shown seconds earlier. Once a photo has loaded successfully this
// session, it's remembered here and every later mount skips the placeholder
// entirely, no re-check needed.
const loadedGuidePhotos = new Set();

function GuideArt({ id, accent, img, imgPos = "center" }) {
  const [failed, setFailed] = React.useState(false);
  // Track "actually decoded and ready to paint" rather than just "started
  // loading" — otherwise the illustrated SVG and the photo both mount at once
  // and the SVG is visible underneath for a frame before the photo paints over
  // it (the "old image glitch" on open). Lazy-init from the session cache so a
  // photo that's already loaded once never flashes again on a later visit.
  const [loaded, setLoaded] = React.useState(() => !!img && loadedGuidePhotos.has(img));
  const showPhoto = img && !failed && loaded;
  const onLoad = () => { if (img) loadedGuidePhotos.add(img); setLoaded(true); };
  return (
    <>
      {/* Only one of these two is ever visible — never layered — so there is
          nothing for the photo to "pop in" over. If the photo genuinely can't
          load (offline, broken URL), this SVG is the intended fallback, not a
          bug — better than a broken-image icon. */}
      {!showPhoto && <ChapterArt id={id} accent={accent} />}
      {img && !failed && (
        <img src={img} alt="" draggable={false}
          onLoad={onLoad} onError={() => setFailed(true)}
          className="absolute inset-0 w-full h-full object-cover"
          style={{ objectPosition: imgPos, opacity: showPhoto ? 1 : 0 }} />
      )}
    </>
  );
}

function ChapterArt({ id, accent, className = "" }) {
  // Stylized VEX-themed illustrated scenes (inline SVG, no external images — so
  // nothing overlaps with the Lessons tab photos). Each panel: accent gradient +
  // soft glow, a detailed motif, and slow ambient animation (.ca-* in index.css).
  const gid = React.useId().replace(/:/g, "");
  const W = (o) => `rgba(255,255,255,${o})`;
  const INK = "#181a24";
  const frame = (motif) => (
    <svg viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" className={className}
      style={{ display: "block", width: "100%", height: "100%" }}>
      <defs>
        <linearGradient id={`bg${gid}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={accent} />
          <stop offset="1" stopColor="#12121c" />
        </linearGradient>
        <radialGradient id={`glow${gid}`} cx="0.25" cy="0.15" r="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.20" />
          <stop offset="0.55" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="320" height="180" fill={`url(#bg${gid})`} />
      <rect width="320" height="180" fill={`url(#glow${gid})`} />
      {motif}
    </svg>
  );
  switch (id) {
    case "game": // stylized field: tiles, corner zones, goals, a robot, stacked pins
      return frame(
        <g>
          <g stroke={W(0.10)} strokeWidth="1.2">
            {[45, 90, 135].map((y) => <line key={y} x1="0" y1={y} x2="320" y2={y} />)}
            {[64, 128, 192, 256].map((x) => <line key={x} x1={x} y1="0" x2={x} y2="180" />)}
          </g>
          <path d="M0 0 L74 0 L0 74 Z" fill={W(0.09)} />
          <path d="M320 180 L246 180 L320 106 Z" fill={W(0.09)} />
          <circle className="ca-pulse" cx="88" cy="72" r="27" fill={W(0.07)} stroke={W(0.55)} strokeWidth="5" />
          <circle className="ca-pulse" style={{ animationDelay: "1.6s" }} cx="242" cy="118" r="20" fill={W(0.07)} stroke={W(0.4)} strokeWidth="4" />
          <g className="ca-float">
            <rect x="150" y="54" width="46" height="30" rx="7" fill={W(0.92)} />
            <rect x="150" y="54" width="46" height="12" rx="6" fill={W(0.6)} />
            <rect x="170" y="40" width="3.5" height="15" rx="1.5" fill="#fde047" />
            <circle cx="161" cy="88" r="7.5" fill={INK} /><circle cx="185" cy="88" r="7.5" fill={INK} />
            <circle cx="161" cy="88" r="3" fill={W(0.55)} /><circle cx="185" cy="88" r="3" fill={W(0.55)} />
          </g>
          <g className="ca-float" style={{ animationDelay: "0.9s" }}>
            <rect x="79" y="54" width="9" height="21" rx="4" fill="#fde047" />
            <rect x="91" y="60" width="9" height="21" rx="4" fill={W(0.9)} />
          </g>
          <rect className="ca-float" style={{ animationDelay: "1.7s" }} x="237" y="100" width="9" height="21" rx="4" fill={W(0.85)} />
        </g>
      );
    case "cppref": // stylized IDE: title bar, file sidebar, colored tokens, caret
      return frame(
        <g>
          <rect x="30" y="24" width="260" height="132" rx="12" fill={INK} opacity="0.88" />
          <rect x="30" y="24" width="260" height="132" rx="12" fill="none" stroke={W(0.22)} />
          <path d="M30 36 a12 12 0 0 1 12-12 h236 a12 12 0 0 1 12 12 v10 h-260 Z" fill={W(0.08)} />
          <circle cx="46" cy="35" r="4" fill="#ff5f57" /><circle cx="60" cy="35" r="4" fill="#febc2e" /><circle cx="74" cy="35" r="4" fill="#28c840" />
          <rect x="196" y="30" width="84" height="11" rx="5.5" fill={W(0.10)} />
          <rect x="31" y="47" width="36" height="108" fill={W(0.05)} />
          {[0, 1, 2, 3, 4].map((i) => <rect key={i} x="39" y={58 + i * 15} width="20" height="5.5" rx="2.75" fill={W(i === 1 ? 0.45 : 0.2)} />)}
          {[0, 1, 2, 3, 4].map((i) => <rect key={i} x="76" y={60 + i * 18} width="9" height="5" rx="2.5" fill={W(0.16)} />)}
          <g>
            <rect x="94" y="60" width="34" height="6" rx="3" fill="#c4b5fd" /><rect x="132" y="60" width="52" height="6" rx="3" fill={W(0.85)} /><rect x="188" y="60" width="26" height="6" rx="3" fill="#7dd3fc" />
            <rect x="104" y="78" width="44" height="6" rx="3" fill="#7dd3fc" /><rect x="152" y="78" width="30" height="6" rx="3" fill="#fbbf24" /><rect x="186" y="78" width="40" height="6" rx="3" fill={W(0.6)} />
            <rect x="104" y="96" width="26" height="6" rx="3" fill="#f472b6" /><rect x="134" y="96" width="58" height="6" rx="3" fill={W(0.85)} />
            <rect x="104" y="114" width="38" height="6" rx="3" fill="#7dd3fc" /><rect x="146" y="114" width="22" height="6" rx="3" fill="#fbbf24" />
            <rect x="94" y="132" width="30" height="6" rx="3" fill="#c4b5fd" />
            <rect className="ca-blink" x="129" y="129" width="3.5" height="12" rx="1" fill="#ffffff" />
          </g>
        </g>
      );
    case "design": // stylized robot side view: chassis, wheels, lift arm + claw, meshing gears
      return frame(
        <g>
          <line x1="0" y1="152" x2="320" y2="152" stroke={W(0.18)} strokeWidth="2" />
          <rect x="56" y="106" width="136" height="28" rx="8" fill={W(0.92)} />
          {[0, 1, 2, 3, 4].map((i) => <circle key={i} cx={76 + i * 25} cy="120" r="4.5" fill={`${accent}66`} />)}
          <circle cx="84" cy="140" r="13" fill={INK} /><circle cx="84" cy="140" r="5.5" fill={W(0.5)} />
          <circle cx="164" cy="140" r="13" fill={INK} /><circle cx="164" cy="140" r="5.5" fill={W(0.5)} />
          <g transform="rotate(-24 100 108)">
            <rect x="95" y="46" width="11" height="62" rx="5.5" fill={W(0.75)} />
            <circle cx="100" cy="52" r="6" fill={W(0.9)} />
            <path d="M96 44 q-8 -10 -2 -18 M105 44 q9 -9 4 -18" stroke={W(0.85)} strokeWidth="4" fill="none" strokeLinecap="round" />
          </g>
          <g transform="translate(248,96)">
            <g className="ca-spin">
              <circle r="27" fill="none" stroke={W(0.6)} strokeWidth="6" />
              {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => <rect key={i} x="-3" y="-33" width="6" height="9" rx="2" fill={W(0.6)} transform={`rotate(${i * 36})`} />)}
              <circle r="7" fill={W(0.85)} />
            </g>
          </g>
          <g transform="translate(206,52)">
            <g className="ca-spin-rev">
              <circle r="14" fill="none" stroke={W(0.42)} strokeWidth="4" />
              {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => <rect key={i} x="-2.5" y="-19" width="5" height="7" rx="1.5" fill={W(0.42)} transform={`rotate(${i * 45})`} />)}
              <circle r="4" fill={W(0.65)} />
            </g>
          </g>
        </g>
      );
    case "strategy": // mini-map: field inset, marching route, pulsing waypoints, two bots
      return frame(
        <g>
          <rect x="34" y="26" width="252" height="128" rx="12" fill={W(0.07)} stroke={W(0.22)} />
          <g stroke={W(0.08)} strokeWidth="1">
            {[58, 90, 122].map((y) => <line key={y} x1="34" y1={y} x2="286" y2={y} />)}
            {[97, 160, 223].map((x) => <line key={x} x1={x} y1="26" x2={x} y2="154" />)}
          </g>
          <path className="ca-dash" d="M62 130 C112 132 86 62 152 60 S250 116 264 54" strokeDasharray="7 8" stroke="#fde047" strokeWidth="3" fill="none" />
          <g className="ca-float">
            <rect x="48" y="118" width="26" height="18" rx="5" fill={W(0.92)} />
            <circle cx="55" cy="138" r="4" fill={INK} /><circle cx="67" cy="138" r="4" fill={INK} />
          </g>
          <circle className="ca-pulse" cx="152" cy="60" r="9" fill={W(0.85)} />
          <circle className="ca-pulse" style={{ animationDelay: "0.8s" }} cx="222" cy="96" r="7" fill={W(0.6)} />
          <circle className="ca-pulse" style={{ animationDelay: "1.6s" }} cx="264" cy="54" r="10" fill="#fde047" />
          <rect x="242" y="120" width="24" height="16" rx="5" fill={W(0.35)} />
        </g>
      );
    case "notebook": // sketch page: margin, spiral, notes + a doodled robot, hovering pencil
      return frame(
        <g>
          <g transform="rotate(-3 160 92)">
            <rect x="58" y="32" width="204" height="122" rx="10" fill={W(0.94)} />
            <line x1="88" y1="32" x2="88" y2="154" stroke="#f87171" strokeWidth="2" opacity="0.7" />
            {[0, 1, 2, 3, 4, 5].map((i) => <circle key={i} cx={80 + i * 30} cy="30" r="4" fill="none" stroke={W(0.9)} strokeWidth="2.5" />)}
            {[0, 1, 2, 3, 4].map((i) => <rect key={i} x="98" y={52 + i * 19} width={i === 4 ? 42 : 66} height="5" rx="2.5" fill="#9aa0b4" opacity="0.75" />)}
            <g fill="none" stroke="#3a3f52" strokeWidth="2.5" strokeLinecap="round">
              <rect x="188" y="66" width="52" height="34" rx="6" />
              <circle cx="200" cy="108" r="7" /><circle cx="228" cy="108" r="7" />
              <line x1="212" y1="66" x2="212" y2="54" /><circle cx="212" cy="50" r="3.5" fill="#3a3f52" />
              <path d="M188 84 h52" opacity="0.5" />
            </g>
          </g>
          <g transform="rotate(38 252 118)">
            <g className="ca-float">
              <rect x="246" y="88" width="12" height="50" rx="3" fill="#fbbf24" />
              <rect x="246" y="88" width="12" height="8" rx="3" fill="#f472b6" />
              <path d="M246 138 L258 138 L252 152 Z" fill={W(0.92)} />
            </g>
          </g>
        </g>
      );
    default:
      return frame(null);
  }
}

// ── Resources ─────────────────────────────────────────────────────────────
// Guide body — instead of one flat white sheet, every top-level content block
// becomes its own bordered card (styled by `.guide-body` rules in index.css)
// and the set cascades in with a GSAP stagger. The stagger attribute is cloned
// onto the guide's single wrapper div so its children (the blocks) animate
// individually; if a guide ever has multiple roots we fall back to plain render.
function ChapterBody({ accent, children }) {
  let staggered = children;
  try {
    const kid = React.Children.only(children);
    staggered = React.cloneElement(kid, { "data-reveal": "stagger" });
  } catch { /* multiple roots — render as-is */ }
  return (
    <div className="guide-body" style={{ "--guide-accent": accent }}>
      {staggered}
    </div>
  );
}

function Resources() {
  // Guide typography — spec-sheet definition rows: an eyebrow section label, a
  // fixed uppercase-muted key column, and readable value text, all baseline-aligned.
  const SH  = "text-[11px] font-bold text-gray-400 uppercase tracking-[0.14em] mb-4";
  const row = "grid grid-cols-[6.5rem,1fr] gap-x-4 items-baseline border-b border-gray-100 last:border-0";
  const kw  = "text-[11px] font-semibold uppercase tracking-[0.05em] text-[#9a9aa2] leading-relaxed";
  const vw  = "text-[15px] text-[#3a3a3c] leading-relaxed";
  // Stacked eyebrow label sitting above its value (for narrow / phrase-label rows).
  const kwStack = "block text-[11px] font-semibold uppercase tracking-[0.06em] text-[#9a9aa2] mb-0.5";
  // Numbered-step rows (accent number in a narrow column, aligned to the text).
  const numRow = "grid grid-cols-[1.6rem,1fr] gap-x-2 items-baseline border-b border-gray-100 last:border-0";
  const secH = "text-base font-bold text-gray-900 mb-3 pb-2 border-b border-gray-100";

  // Library layout (bento hub + docs reader): the hub is a bento grid of the five
  // guides; opening one switches to a reader with a sticky guide rail showing ONE
  // guide at a time. `openGuide` null → hub. Voltz is woven in as an interactive
  // explainer — "Ask Voltz" buttons dispatch `voltz-ask` (handled by FloatingChat).
  const CHAPTERS = [
    { id:"game",    label:"Override 2026–27", num:"01", title:"Know the game.",       desc:"Rules, scoring, field elements, and penalties for the 2026–27 season — everything you need before your first match.", accent:"#dc2626", tag:"Game manual", img:"/guide-game.png", imgPos:"center 62%",
      stats:["18 rules & values","6 field elements"], tip:"Not sure how Pins score? I can walk through any rule in here with a worked example.", ask:"Explain how Pin scoring works in VEX Override with an example" },
    { id:"cppref",  label:"C++ Quick Ref",    num:"02", title:"Speak fluent C++.",    desc:"The VEXcode API and the core language constructs, condensed into one glanceable reference.", accent:"#2563eb", tag:"API & syntax", img:"/guide-cpp.jpg",
      stats:["40+ API calls","12 core patterns"], tip:"I can explain any function on this page — or write working example code for your robot.", ask:"Show me an example VEXcode C++ drive program using motor groups" },
    { id:"design",  label:"Robot Design",     num:"03", title:"Build it better.",     desc:"Override mechanism planning, official motor rules, and the drivetrain call that wins Midfield battles.", accent:"#ea580c", tag:"Mechanisms", img:"/guide-design.png",
      stats:["4 Override mechanisms","official rules"], tip:"Torn between drivetrains? Tell me your strategy and I'll help you pick the right one.", ask:"Help me choose a drivetrain for VEX Override" },
    { id:"strategy",label:"Match Strategy",   num:"04", title:"Outplay everyone.",    desc:"Autonomous planning, alliance play, and the decisions that swing close matches.", accent:"#0891b2", tag:"Tactics", img:"/guide-strategy.jpg",
      stats:["5 auton plays","alliance tactics"], tip:"I can help you plan a 15-second autonomous routine for your next match.", ask:"Help me plan a 15-second autonomous routine for VEX Override" },
    { id:"notebook",label:"Notebook Guide",   num:"05", title:"Document like a pro.", desc:"What judges actually look for in an engineering notebook, section by section.", accent:"#16a34a", tag:"Judging", img:"/guide-notebook.jpg",
      stats:["7 sections","judge rubric"], tip:"Writing an entry? I can review it against the judging rubric with you.", ask:"What makes a great VEX engineering notebook entry?" },
  ];
  const [openGuide, setOpenGuide] = React.useState(null);
  const hubRef = React.useRef(null);
  const readerRef = React.useRef(null);
  const guide = CHAPTERS.find((x) => x.id === openGuide) || null;
  const gIdx  = guide ? CHAPTERS.indexOf(guide) : -1;
  const goTo  = (id) => { setOpenGuide(id); window.scrollTo({ top: 0, behavior: "instant" }); };
  const askVoltz = (q) => window.dispatchEvent(new CustomEvent("voltz-ask", { detail: q }));

  // Hub ⇄ reader toggles don't change currentPage, so the app-level <ScrollFx>
  // never re-scans — scan whichever view just mounted ourselves. Layout effect:
  // reveals hide before first paint (no flash).
  React.useLayoutEffect(() => {
    const root = openGuide ? readerRef.current : hubRef.current;
    if (!root) return;
    return initScrollFx(root);
  }, [openGuide]);

  // Guide header — accent-tinted chip + display title.
  const ChapterHead = ({ c }) => (
    <div className="mb-7" data-reveal="up">
      <div className="flex items-center gap-2 mb-3">
        <span className="w-1.5 h-4 rounded-full" style={{ background: c.accent }} />
        <span className="text-[11px] font-bold uppercase tracking-[0.14em]" style={{ color: c.accent }}>{c.label}</span>
      </div>
      <h3 className="text-3xl sm:text-[2.6rem] font-semibold tracking-tight leading-[1.1]" style={{ color: "#1d1d1f" }}>{c.title}</h3>
      <p className="text-[15px] mt-3 max-w-xl leading-relaxed" style={{ color: "#48484a" }}>{c.desc}</p>
    </div>
  );

  // Voltz explainer — the mascot fronts each guide and hands the chat a ready-made
  // question, so dense reference text always has a living way in.
  const VoltzTip = ({ c }) => (
    <div data-reveal="up" className="flex items-start gap-4 rounded-3xl p-5 sm:p-6 mb-8"
      style={{ background: "#161619", boxShadow: "0 14px 40px rgba(0,0,0,0.18)" }}>
      <div className="w-11 h-11 rounded-full overflow-hidden shrink-0"
        style={{ background: "radial-gradient(circle at 50% 32%, #2b2e35, #141519)" }}>
        <VoltLogo size={44} />
      </div>
      <div className="min-w-0">
        <p className="text-[11px] font-bold uppercase tracking-[0.14em] mb-1" style={{ color: c.accent }}>Voltz · your AI coach</p>
        <p className="text-[15px] leading-relaxed" style={{ color: "rgba(255,255,255,0.88)" }}>{c.tip}</p>
        <button onClick={() => askVoltz(c.ask)}
          className="mt-3 inline-flex items-center gap-2 text-[13px] font-semibold px-4 py-2 rounded-full transition hover:opacity-85 active:scale-95"
          style={{ background: c.accent, color: "#fff" }}>
          Ask Voltz
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
      </div>
    </div>
  );

  /* ── Hub — bento library ── */
  if (!openGuide) {
    const Tile = ({ c, artH = "h-36", big = false, className = "" }) => (
      <button onClick={() => goTo(c.id)}
        className={`group text-left rounded-3xl overflow-hidden bg-white transition-all duration-300 hover:-translate-y-1.5 hover:shadow-2xl flex flex-col ${className}`}
        style={{ border: "1px solid #e6e6ec", boxShadow: "0 2px 10px rgba(0,0,0,0.04)" }}>
        {/* Featured tile spans 2 rows — let the art grow to fill so there's no
            empty strip above the photo; small tiles keep their fixed height. */}
        <div className={`relative overflow-hidden ${big ? "flex-1 min-h-[14rem] sm:min-h-[18rem]" : artH}`}>
          <div className="absolute inset-0 transition-transform duration-700 group-hover:scale-110">
            <GuideArt id={c.id} accent={c.accent} img={c.img} imgPos={c.imgPos} />
          </div>
          <span className="absolute top-3 left-3 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider"
            style={{ background: "rgba(255,255,255,0.92)", color: c.accent }}>{c.tag}</span>
        </div>
        <div className={big ? "p-6 sm:p-7" : "p-5"}>
          <div className="flex items-baseline gap-2.5 mb-1.5">
            <span className={`${big ? "text-2xl" : "text-lg"} font-bold tabular-nums`} style={{ color: `${c.accent}59` }}>{c.num}</span>
            <h3 className={`${big ? "text-2xl" : "text-[17px]"} font-semibold tracking-tight`} style={{ color: "#1d1d1f" }}>{c.title}</h3>
          </div>
          <p className={`${big ? "text-[15px]" : "text-sm"} leading-relaxed mb-3.5`} style={{ color: "#48484a" }}>{c.desc}</p>
          <div className="flex flex-wrap items-center gap-2">
            {c.stats.map((s) => (
              <span key={s} className="px-2.5 py-1 rounded-full text-[11px] font-semibold" style={{ background: "#f2f2f5", color: "#48484a" }}>{s}</span>
            ))}
          </div>
          <p className="mt-4 inline-flex items-center gap-1.5 text-[13px] font-semibold transition-all duration-300 group-hover:gap-3" style={{ color: c.accent }}>
            Open guide <span aria-hidden="true">→</span>
          </p>
        </div>
      </button>
    );
    return (
      <div className="min-h-screen pt-28 pb-20 px-4 sm:px-6" style={{ background: LIGHT_PAGE_BG }}>
        <div ref={hubRef} data-fx-scope className="max-w-5xl mx-auto">

          {/* Hero */}
          <div className="mb-10" data-reveal="up">
            <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-[11px] font-bold uppercase tracking-[0.14em] mb-5"
              style={{ background: "#dc262614", color: "#dc2626" }}>
              <VoltLogo size={16} className="shrink-0" /> The Voltz Library
            </span>
            <h2 className="text-[2.6rem] sm:text-6xl font-semibold tracking-tight leading-[1.02]" style={{ color: "#1d1d1f" }}>
              Read it. Build it.<br />Win with it.
            </h2>
            <p className="text-base sm:text-lg mt-4 max-w-2xl leading-relaxed" style={{ color: "#48484a" }}>
              Five deep guides — the game, the code, the machine, the match, the notebook.
              Written for builders, with Voltz on call to explain anything inside.
            </p>
            <div className="flex flex-wrap items-center gap-x-8 gap-y-3 mt-7" data-reveal="up" data-reveal-delay="0.1">
              {[["5","","expert guides"],["30","+","topics"],["100","%","free forever"]].map(([n,sfx,label]) => (
                <div key={label} className="flex items-baseline gap-2">
                  <span className="text-2xl font-bold tracking-tight tabular-nums" style={{ color: "#1d1d1f" }} data-count-to={n} data-count-suffix={sfx}>{n}{sfx}</span>
                  <span className="text-[13px]" style={{ color: "#6e6e73" }}>{label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Bento grid */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4" data-reveal="stagger">
            <Tile c={CHAPTERS[0]} big artH="h-56 sm:h-72" className="lg:col-span-2 lg:row-span-2" />
            <Tile c={CHAPTERS[1]} />
            <Tile c={CHAPTERS[2]} />
            <Tile c={CHAPTERS[3]} />
            <Tile c={CHAPTERS[4]} artH="h-40 sm:h-48" className="lg:col-span-2" />
          </div>

          {/* Voltz strip */}
          <div className="mt-10 rounded-3xl p-6 sm:p-8 flex flex-col sm:flex-row items-start sm:items-center gap-5" data-reveal="up"
            style={{ background: "#161619", boxShadow: "0 16px 44px rgba(0,0,0,0.18)" }}>
            <div className="w-14 h-14 rounded-full overflow-hidden shrink-0"
              style={{ background: "radial-gradient(circle at 50% 32%, #2b2e35, #141519)" }}>
              <VoltLogo size={56} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-lg font-semibold text-white tracking-tight">Not sure where to start?</p>
              <p className="text-[15px] mt-1 leading-relaxed" style={{ color: "rgba(255,255,255,0.72)" }}>
                Voltz has read every guide in here. Ask for a rule, a function, or a build idea — get a straight answer.
              </p>
            </div>
            <button onClick={() => askVoltz("What should I learn first as a new VEX team member?")}
              className="shrink-0 inline-flex items-center gap-2 text-sm font-semibold px-5 py-3 rounded-full transition hover:opacity-85 active:scale-95"
              style={{ background: "#dc2626", color: "#fff" }}>
              Ask Voltz <VoltzBolt size={13} />
            </button>
          </div>
        </div>
      </div>
    );
  }

  /* ── Reader — docs layout: sticky guide rail + one guide at a time ── */
  return (
    <div className="min-h-screen pt-24 lg:pt-28 pb-20 px-4 sm:px-6" style={{ background: LIGHT_PAGE_BG }}>
      <div className="max-w-6xl mx-auto lg:grid lg:grid-cols-[230px,1fr] lg:gap-10 lg:items-start">

        {/* Guide rail */}
        <aside className="lg:sticky lg:top-24 mb-6 lg:mb-0">
          <button onClick={() => { setOpenGuide(null); window.scrollTo({ top: 0, behavior: "instant" }); }}
            className="inline-flex items-center gap-2 text-[13px] font-medium text-gray-500 hover:text-red-600 transition-colors mb-4">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M10 12L6 8l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            Library
          </button>
          <nav className="flex lg:flex-col gap-1.5 overflow-x-auto pb-2 lg:pb-0" aria-label="Guides">
            {CHAPTERS.map((x) => {
              const on = x.id === openGuide;
              return (
                <button key={x.id} onClick={() => goTo(x.id)}
                  className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl text-[13px] font-medium whitespace-nowrap text-left transition"
                  style={{ background: on ? "#ffffff" : "transparent", color: on ? "#1d1d1f" : "#6e6e73", boxShadow: on ? "0 1px 6px rgba(0,0,0,0.08)" : "none" }}>
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: x.accent, opacity: on ? 1 : 0.4 }} />
                  {x.label}
                </button>
              );
            })}
          </nav>
        </aside>

        {/* Guide content */}
        <main ref={readerRef} data-fx-scope className="min-w-0">
          <ChapterHead c={guide} />
          <VoltzTip c={guide} />

        {/* ── Chapter 01 · Override Game ── */}
        {openGuide === "game" && (
        <section className="mb-10">
          <ChapterBody accent={CHAPTERS[0].accent}>
          <div className="space-y-10">
            <p className="text-[#3a3a3c] text-[15px] leading-relaxed">
              <strong className="text-gray-900">Override</strong> is the V5 Robotics Competition game for the 2026–27 season. Two alliances of two robots compete on a 12×12 ft field. Teams earn points by building stacks of Pins and Cups on Goals, flipping Toggles to their alliance colour, and getting both robots into the Midfield zone before time runs out.
            </p>

            <div>
              <p className={SH}>Point Values</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                {[
                  {val:"5",label:"Alliance Pin on Goal",sub:"per pin"},
                  {val:"10",label:"Owned Yellow Pin",sub:"per pin"},
                  {val:"8",label:"Robot in Midfield",sub:"per robot"},
                  {val:"12",label:"Autonomous Bonus",sub:"once per match"},
                ].map(s=>(
                  <div key={s.label} className="text-center py-5 rounded-2xl" style={LIGHT_CARD}>
                    <p className="text-4xl font-black text-gray-900 leading-none">{s.val}<span className="text-sm font-medium text-gray-400 ml-0.5">pts</span></p>
                    <p className="text-xs font-semibold text-[#3a3a3c] mt-2 px-2 leading-tight">{s.label}</p>
                    <p className="text-xs text-[#8a8a91] mt-0.5">{s.sub}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-10">
              <div>
                <p className={SH}>Field Elements</p>
                {[["Goals","9 total — 4 alliance-coloured (2 red, 2 blue) + 5 neutral (4 short, 1 tall)"],
                  ["Cups","56 total — 36 pre-loaded on field, 20 as match loads"],
                  ["Pins","63 total — red/yellow, blue/yellow, yellow/yellow, plus 4 red/blue"],
                  ["Toggles","4 total — controls yellow Pin ownership per quadrant"],
                  ["Loaders","4 total — 2 per alliance; feeds match loads during driver control"],
                  ["Midfield","Central zone contested for 8-pt endgame positioning"],
                ].map(([k,v])=>(
                  <div key={k} className={row}>
                    <span className={kw}>{k}</span>
                    <span className={vw}>{v}</span>
                  </div>
                ))}
              </div>
              <div>
                <p className={SH}>Match Format</p>
                {[["Autonomous","15 seconds — pre-programmed, no driver input"],
                  ["Driver Control","1 min 45 sec — human-operated"],
                  ["Endgame","Final 10 sec — Midfield contest; robots inside must stay near starting height (SG12)"],
                  ["Alliance","2 robots per side, red vs blue"],
                  ["Skills","Solo run, 1 robot, 60 seconds"],
                  ["Qualifications","Ranked WP → AP → SP"],
                  ["Eliminations","Bracket, mix of best-of-1 and best-of-3"],
                ].map(([k,v])=>(
                  <div key={k} className={row}>
                    <span className={kw}>{k}</span>
                    <span className={vw}>{v}</span>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <p className={SH}>How Pin Scoring Works</p>
              {[
                "A Pin scores when it sits inside (nested with) a Goal, or inside a Cup that is part of a valid scored stack.",
                "Each Pin has two colour halves — both halves score independently. A red/yellow Pin can score for both alliances simultaneously.",
                "Each Cup slot accepts only one Pin half — you cannot stack two Pins into the same Cup slot.",
                "Each robot may carry a maximum of one Pin and one Cup at a time.",
                "During driver control, your drive team may feed one Pin, Cup, or combined Cup+Pin through your alliance Loader.",
              ].map((t,i)=>(
                <div key={i} className={numRow}>
                  <span className="text-[13px] font-bold tabular-nums text-right pr-1" style={{ color: CHAPTERS[0].accent }}>{i+1}</span>
                  <p className={vw}>{t}</p>
                </div>
              ))}
            </div>

            <div className="grid sm:grid-cols-2 gap-10">
              <div>
                <p className={SH}>Autonomous Win Point — 3 Tasks</p>
                <p className="text-xs text-[#8a8a91] mb-3">All 3 must be met at auton end with zero violations.</p>
                {[
                  "Your alliance has scored a minimum of 7 Pins (on your side of the Autonomous Line)",
                  "At least 3 Goals on your side each hold 2 or more of your alliance's Pins",
                  "Neither robot is contacting the field perimeter",
                ].map((t,i)=>(
                  <div key={i} className="flex gap-3 mb-3">
                    <span className="w-5 h-5 rounded-full bg-red-600 text-white text-xs font-black flex items-center justify-center shrink-0">{i+1}</span>
                    <p className="text-[15px] text-[#2b2b30] leading-snug">{t}</p>
                  </div>
                ))}
              </div>
              <div>
                <p className={SH}>Toggles & Endgame</p>
                <div className="space-y-3 text-[15px] text-[#3a3a3c]">
                  <p><strong className="text-gray-900">Toggles</strong> control yellow Pin ownership per quadrant. Must be fully seated flat — and not touching any robot — to count (SC4).</p>
                  <p><strong className="text-gray-900">Yellow Pins in Midfield</strong> go to the alliance with more robots in Midfield at match end. Equal robots → nobody owns them.</p>
                  <p><strong className="text-gray-900">Endgame (final 10 sec)</strong> — rush to Midfield. Robots inside must drop to roughly starting height (soft limit, referee-enforced — SG12). Vigorous contact there is expected; incidental tipping is not a violation.</p>
                </div>
              </div>
            </div>

            <div>
              <p className={SH}>Robot Size Limits</p>
              <div className="grid grid-cols-3 gap-4">
                {[["Starting","18\" × 18\" × 18\""],["Max horizontal","24\" × 24\""],["Max height","50\" match / ~start height in Midfield endgame"]].map(([l,v])=>(
                  <div key={l} className="text-center py-4 rounded-xl" style={LIGHT_CARD}>
                    <p className="text-sm font-black text-gray-900">{v}</p>
                    <p className="text-xs text-[#8a8a91] mt-1">{l}</p>
                  </div>
                ))}
              </div>
            </div>

          </div>
          </ChapterBody>
        </section>
        )}

        {/* ── Chapter 02 · C++ Quick Reference ── */}
        {openGuide === "cppref" && (
        <section className="mb-10">
          <ChapterBody accent={CHAPTERS[1].accent}>
          <div className="space-y-8">
            {[
              { title:"Motor — Declare & Configure", snippets:[
                ["Basic","vex::motor M(vex::PORT1);"],
                ["With gearset","vex::motor M(vex::PORT1, vex::ratio18_1, false);  // ratio6_1=600rpm, ratio18_1=200rpm, ratio36_1=100rpm"],
                ["Reversed","vex::motor M(vex::PORT1, vex::ratio18_1, true);  // true = reversed"],
                ["Set velocity","M.setVelocity(75, vex::percent);  // sets default speed"],
                ["Set max torque","M.setMaxTorque(80, vex::percent);  // also: vex::nm, vex::in_lb"],
                ["Set stopping","M.setStopping(vex::brake);  // brake / coast / hold"],
                ["Reset position","M.resetPosition();  // zeros the encoder"],
              ]},
              { title:"Motor — Move", snippets:[
                ["Spin (continuous)","M.spin(vex::forward, 80, vex::percent);  // also: vex::reverse"],
                ["Spin no velocity","M.spin(vex::forward);  // uses setVelocity default"],
                ["SpinFor timed","M.spinFor(vex::forward, 1000, vex::msec);  // also: vex::seconds"],
                ["SpinFor rotations","M.spinFor(vex::forward, 2.5, vex::turns);  // also: vex::degrees"],
                ["SpinFor no-wait","M.spinFor(vex::forward, 500, vex::msec, false);  // false = don't block"],
                ["SpinToPosition","M.spinToPosition(90, vex::degrees);  // absolute position"],
                ["SpinToPosition w/vel","M.spinToPosition(180, vex::degrees, 50, vex::percent, true);"],
                ["Stop","M.stop();  // uses setStopping mode"],
                ["Stop with mode","M.stop(vex::brake);  // override stop mode"],
              ]},
              { title:"Motor — Read State", snippets:[
                ["Position","double p = M.position(vex::degrees);  // also: vex::turns"],
                ["Velocity","double v = M.velocity(vex::percent);  // also: vex::rpm"],
                ["Current","double a = M.current(vex::amp);  // also: vex::pct"],
                ["Power","double w = M.power(vex::watt);"],
                ["Torque","double t = M.torque(vex::nm);  // also: vex::in_lb"],
                ["Temperature","double t = M.temperature(vex::celsius);  // also: vex::fahrenheit, vex::pct"],
                ["Is spinning","bool b = M.isSpinning();"],
                ["Is done","bool b = M.isDone();  // true when spinFor/spinToPosition finishes"],
              ]},
              { title:"Motor Group", snippets:[
                ["Declare","vex::motor_group LeftDrive(LF, LM, LB);  // up to 4 motors"],
                ["Spin","LeftDrive.spin(vex::forward, 80, vex::percent);"],
                ["SpinFor","LeftDrive.spinFor(vex::forward, 1000, vex::msec, false);"],
                ["Stop","LeftDrive.stop(vex::brake);"],
                ["Set velocity","LeftDrive.setVelocity(60, vex::percent);"],
                ["Set stopping","LeftDrive.setStopping(vex::coast);"],
                ["Reset position","LeftDrive.resetPosition();"],
                ["Get position","double p = LeftDrive.position(vex::degrees);"],
                ["Get velocity","double v = LeftDrive.velocity(vex::rpm);"],
                ["Get temp","double t = LeftDrive.temperature(vex::celsius);"],
              ]},
              { title:"Controller", snippets:[
                ["Declare primary","vex::controller C1(vex::primary);"],
                ["Declare partner","vex::controller C2(vex::partner);"],
                ["Axis 1 (R stick X)","int v = C1.Axis1.value();  // -127 to 127, left/right"],
                ["Axis 2 (R stick Y)","int v = C1.Axis2.value();  // forward/back"],
                ["Axis 3 (L stick Y)","int v = C1.Axis3.value();  // forward/back"],
                ["Axis 4 (L stick X)","int v = C1.Axis4.value();  // left/right"],
                ["Button pressing","bool b = C1.ButtonA.pressing();  // true while held"],
                ["Button pressed CB","C1.ButtonA.pressed(myFunction);  // fires once on press"],
                ["Button released CB","C1.ButtonA.released(myFunction);  // fires once on release"],
                ["All buttons","A  B  X  Y  Up  Down  Left  Right  L1  L2  R1  R2"],
                ["Screen print","C1.Screen.print(\"Speed: %d\", speed);"],
                ["Screen clear line","C1.Screen.clearLine(1);  // line 1, 2, or 3"],
                ["Screen newline","C1.Screen.newLine();"],
                ["Rumble","C1.rumble(\".-.\");  // . = short, - = long, space = pause"],
                ["Is connected","bool b = C1.installed();"],
              ]},
              { title:"Brain", snippets:[
                ["Declare","vex::brain Brain;"],
                ["Screen print","Brain.Screen.print(\"Hello\");"],
                ["Print at xy","Brain.Screen.printAt(10, 50, \"text\");"],
                ["Clear screen","Brain.Screen.clearScreen();"],
                ["Clear line","Brain.Screen.clearLine();"],
                ["Set cursor","Brain.Screen.setCursor(row, col);"],
                ["Set pen color","Brain.Screen.setPenColor(vex::red);  // or hex: 0xFF0000"],
                ["Set fill color","Brain.Screen.setFillColor(vex::blue);"],
                ["Set pen width","Brain.Screen.setPenWidth(2);"],
                ["Draw circle","Brain.Screen.drawCircle(x, y, radius);"],
                ["Draw rect","Brain.Screen.drawRectangle(x, y, w, h);"],
                ["Draw line","Brain.Screen.drawLine(x1, y1, x2, y2);"],
                ["Set font","Brain.Screen.setFont(vex::mono20);"],
                ["Battery %","double b = Brain.Battery.capacity();"],
                ["Battery voltage","double v = Brain.Battery.voltage(vex::volt);"],
                ["Timer reset","Brain.Timer.reset();"],
                ["Timer value","double t = Brain.Timer.value();  // seconds"],
                ["Timer event","Brain.Timer.event(myFn, 1000);  // fires after 1000ms"],
              ]},
              { title:"Inertial Sensor (IMU)", snippets:[
                ["Declare","vex::inertial Imu(vex::PORT5);"],
                ["Calibrate","Imu.calibrate(); while(Imu.isCalibrating()){ wait(20,vex::msec); }"],
                ["Heading (0–360°)","double h = Imu.heading(vex::degrees);"],
                ["Rotation (continuous)","double r = Imu.rotation(vex::degrees);  // no wraparound"],
                ["Set heading","Imu.setHeading(0, vex::degrees);"],
                ["Reset heading","Imu.resetHeading();"],
                ["Reset rotation","Imu.resetRotation();"],
                ["Gyro rate","double g = Imu.gyroRate(vex::zaxis, vex::dps);  // xaxis/yaxis/zaxis"],
                ["Accel","double a = Imu.acceleration(vex::xaxis);  // in g-force"],
                ["Is calibrating","bool b = Imu.isCalibrating();"],
                ["Is installed","bool b = Imu.installed();"],
              ]},
              { title:"Distance Sensor", snippets:[
                ["Declare","vex::distance Dist(vex::PORT6);"],
                ["Distance mm","double d = Dist.objectDistance(vex::mm);"],
                ["Distance inches","double d = Dist.objectDistance(vex::inches);"],
                ["Is detected","bool b = Dist.isObjectDetected();"],
                ["Object size","int s = Dist.objectSize();  // small/medium/large enum"],
                ["Object velocity","double v = Dist.objectVelocity();  // m/s"],
                ["Is installed","bool b = Dist.installed();"],
              ]},
              { title:"Rotation Sensor", snippets:[
                ["Declare","vex::rotation Rot(vex::PORT7);"],
                ["Angle (0–360°)","double a = Rot.angle(vex::degrees);"],
                ["Position (continuous)","double p = Rot.position(vex::degrees);"],
                ["Velocity","double v = Rot.velocity(vex::rpm);"],
                ["Set reversed","Rot.setReversed(true);"],
                ["Reset position","Rot.resetPosition();"],
                ["Set position","Rot.setPosition(0, vex::degrees);"],
                ["Is installed","bool b = Rot.installed();"],
              ]},
              { title:"Optical Sensor", snippets:[
                ["Declare","vex::optical Opt(vex::PORT8);"],
                ["Set light on","Opt.setLight(vex::ledState::on);"],
                ["Set light off","Opt.setLight(vex::ledState::off);"],
                ["Hue (0–360)","double h = Opt.hue();"],
                ["Brightness (0–100)","double b = Opt.brightness();"],
                ["Saturation","double s = Opt.saturation();"],
                ["Near object","bool b = Opt.isNearObject();"],
                ["Gesture up","bool b = Opt.gestureUp();  // also Down/Left/Right"],
              ]},
              { title:"Vision Sensor", snippets:[
                ["Declare","vex::vision Vis(vex::PORT9, 50, SIGNATURE_1);"],
                ["Take snapshot","Vis.takeSnapshot(SIGNATURE_1);"],
                ["Object count","int n = Vis.objectCount;"],
                ["Largest center X","int x = Vis.largestObject.centerX;  // pixels"],
                ["Largest center Y","int y = Vis.largestObject.centerY;"],
                ["Largest width","int w = Vis.largestObject.width;"],
                ["Largest height","int h = Vis.largestObject.height;"],
                ["Nth object","vex::vision::object obj = Vis.objects[0];"],
              ]},
              { title:"3-Wire / ADI Devices", snippets:[
                ["Bumper switch","vex::bumper Bump(Brain.ThreeWirePort.A); bool b = Bump.pressing();"],
                ["Limit switch","vex::limit Lim(Brain.ThreeWirePort.B); bool b = Lim.pressing();"],
                ["ADI Encoder","vex::encoder Enc(Brain.ThreeWirePort.A); Enc.rotation(vex::degrees);"],
                ["ADI Encoder reset","Enc.resetRotation();"],
                ["Potentiometer","vex::pot Pot(Brain.ThreeWirePort.C); double v = Pot.angle(vex::degrees);"],
                ["Pneumatic solenoid","vex::pneumatics P(Brain.ThreeWirePort.H); P.open(); P.close();"],
                ["Solenoid value","bool b = P.value();  // true = open"],
                ["Analog in","vex::analog_in AI(Brain.ThreeWirePort.D); int v = AI.value();  // 0–4095"],
                ["Digital out","vex::digital_out DO(Brain.ThreeWirePort.E); DO.set(true);"],
              ]},
              { title:"Timing & Tasks", snippets:[
                ["Wait ms","wait(500, vex::msec);"],
                ["Wait sec","wait(1.5, vex::seconds);"],
                ["Task declare","int myTask() { while(true){ /*code*/ wait(20,vex::msec); } return 0; }"],
                ["Task start","vex::task t(myTask);"],
                ["Task stop","t.stop();"],
                ["Task priority","t.setPriority(vex::task::taskPriorityNormal);"],
                ["Task sleep","vex::task::sleep(20);  // inside a task"],
                ["This task stop","vex::this_thread::sleep_for(20);"],
              ]},
              { title:"Competition Template", snippets:[
                ["Include","#include \"vex.h\"\nusing namespace vex;"],
                ["Globals","vex::brain Brain;\nvex::motor M(PORT1, ratio18_1, false);"],
                ["Competition","vex::competition Competition;"],
                ["Pre-auton","void pre_auton() { vexcodeInit(); }"],
                ["Autonomous","void autonomous() { /* 15 sec */ }"],
                ["User control","void usercontrol() { while(true) { /* code */ wait(20, msec); } }"],
                ["Main","int main() {\n  Competition.autonomous(autonomous);\n  Competition.drivercontrol(usercontrol);\n  pre_auton();\n  while(true) { wait(100, msec); }\n}"],
              ]},
              { title:"Common Drive Patterns", snippets:[
                ["Tank drive","LeftDrive.spin(fwd, C1.Axis3.value(), pct);\nRightDrive.spin(fwd, C1.Axis2.value(), pct);"],
                ["Arcade drive","int pwr=C1.Axis3.value(), turn=C1.Axis1.value();\nLeftDrive.spin(fwd, pwr+turn, pct);\nRightDrive.spin(fwd, pwr-turn, pct);"],
                ["Deadband","int v = C1.Axis3.value();\nif(abs(v) < 10) v = 0;  // ignore small joystick drift"],
                ["IMU turn","Imu.resetRotation();\nLeftDrive.spin(fwd,30,pct); RightDrive.spin(reverse,30,pct);\nwhile(fabs(Imu.rotation()) < 90){ wait(5,msec); }\nLeftDrive.stop(brake); RightDrive.stop(brake);"],
                ["Timed move","LeftDrive.spinFor(fwd,1500,msec,false);\nRightDrive.spinFor(fwd,1500,msec);  // last true = wait"],
                ["Toggle mechanism","bool on = false;\nC1.ButtonA.pressed([]{ on=!on; on?Arm.spin(fwd,80,pct):Arm.stop(); });"],
              ]},
            ].map(sec=>(
              <div key={sec.title}>
                <h3 className="text-base font-bold text-gray-900 mb-3 pb-2 border-b border-gray-100">{sec.title}</h3>
                <div className="rounded-xl overflow-hidden" style={{background:"#1e1e2e"}}>
                  {sec.snippets.map(([label, code], i)=>(
                    <div key={label} className="flex items-start" style={{borderBottom: i < sec.snippets.length-1 ? "1px solid rgba(255,255,255,0.06)" : "none"}}>
                      <span className="text-xs font-mono px-4 py-2.5 shrink-0 w-44 text-right select-none" style={{color:"#6b7280",borderRight:"1px solid rgba(255,255,255,0.06)"}}>{label}</span>
                      <code className="text-xs font-mono px-4 py-2.5 flex-1 leading-relaxed whitespace-pre-wrap" style={{color:"#a5f3fc"}}>{code}</code>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          </ChapterBody>
        </section>
        )}

        {/* ── Chapter 03 · Robot Design ── */}
        {openGuide === "design" && (
        <section className="mb-10">
          <ChapterBody accent={CHAPTERS[2].accent}>
          <div className="space-y-10">

            <div>
              <div className="flex items-center gap-2 mb-1">
                <h3 className="text-lg font-bold text-gray-900">Override Mechanism Planning</h3>
                <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-semibold">Game rules analysis</span>
              </div>
              <p className="text-xs text-[#8a8a91] mb-4">No official design guides yet — derived from the official game manual rules.</p>
              <div className="grid sm:grid-cols-2 gap-3">
                {[
                  ["Pin Intake","Max 1 Pin at once (SG6). Must pick up and place onto a Goal or Cup stack."],
                  ["Cup Handler","Max 1 Cup at once (SG6). Position cups to accept Pins and form valid stacks."],
                  ["Toggle Setter","Toggles must be fully seated flat to count. Mechanism needs to flip them to your colour."],
                  ["Midfield Rush","8 pts per robot in Midfield at match end. Robots inside during the 10-sec Endgame must stay near starting height (SG12)."],
                ].map(([name, desc])=>(
                  <div key={name} className="p-3 rounded-xl" style={{background:"#fff7f7",border:"1px solid #fecaca"}}>
                    <p className="text-sm font-bold text-gray-900 mb-0.5">{name}</p>
                    <p className="text-sm text-[#48484a] leading-snug">{desc}</p>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="flex items-center gap-2 mb-4">
                <h3 className="text-lg font-bold text-gray-900">Motor Power Rules</h3>
                <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-semibold">Official</span>
              </div>
              {[
                ["Power limit","88W combined total — all motors on the robot, even unplugged ones (R10)."],
                ["Drivetrain limit","55W max for drivetrain (Subsystem 2) motors — e.g. 5× 11W, or 4× 11W + 2× 5.5W (R11)."],
                ["V5 Smart Motor (11W)","8 of these = exactly 88W. Cartridges: 100 RPM (red), 200 RPM (green), 600 RPM (blue)."],
                ["V5 Smart Motor (5.5W)","Half the power cost. Mix with 11W motors; combined total must stay ≤ 88W."],
                ["Power source","One V5 Robot Battery powering one V5 Brain — no other electrical power (R12)."],
              ].map(([k,v])=>(
                <div key={k} className={row}><span className={kw}>{k}</span><span className={vw}>{v}</span></div>
              ))}
            </div>

            <div>
              <h3 className="text-lg font-bold text-gray-900 mb-4">Which Drivetrain for Override?</h3>
              {[
                {name:"6-Wheel Drop Center Tank", tag:"Recommended", tagColor:"#16a34a", tagBg:"#f0fdf4", desc:"Middle pair dropped 1/16\" — only 4 wheels contact the ground, preventing rocking. Best push strength. Standard for Override's Midfield battles."},
                {name:"4-Wheel Tank", tag:"Lightweight", tagColor:"#0ea5e9", tagBg:"#eff6ff", desc:"Simpler and lighter. Slightly less stable on uneven surfaces. Good if weight matters more than pushing power."},
                {name:"X-Drive", tag:"Holonomic", tagColor:"#8b5cf6", tagBg:"#f5f3ff", desc:"4 omni wheels at 45°. Strafes in any direction. Weaker push — not ideal for Midfield endgame battles."},
                {name:"H-Drive", tag:"Hybrid", tagColor:"#f59e0b", tagBg:"#fffbeb", desc:"Tank base + 1 perpendicular omni wheel. Adds sideways movement at the cost of one motor."},
              ].map(d=>(
                <div key={d.name} className="flex items-start gap-3 py-3 border-b border-gray-100 last:border-0">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-0.5">
                      <p className="text-sm font-bold text-gray-900">{d.name}</p>
                      <span className="text-xs px-2 py-0.5 rounded-full font-semibold" style={{background:d.tagBg,color:d.tagColor}}>{d.tag}</span>
                    </div>
                    <p className="text-sm text-[#48484a] leading-snug">{d.desc}</p>
                  </div>
                </div>
              ))}
            </div>

            <div>
              <h3 className="text-lg font-bold text-gray-900 mb-2">Pneumatics</h3>
              <p className="text-[15px] text-[#48484a] mb-4">Compressed air actuates pistons in milliseconds — saves motor budget. Air is limited (max 100 PSI fill) — plan for roughly 10–20 actuations per match depending on piston size and reservoir count.</p>
              <div className="grid sm:grid-cols-2 gap-x-10 gap-y-3">
                {[
                  ["Use for","Fast one-shot actions: clamps, claws, Toggle setters. Anything needing only a few actuations per match."],
                  ["Avoid for","Sustained or continuous mechanisms — air runs out. Plan around the limited shot count."],
                  ["Components","Air tank, solenoid valve (ADI port), tubing, piston. Code: vex::pneumatics."],
                  ["Tips","Pre-charge before every match. Double-action pistons push and pull; single-action springs back."],
                ].map(([n,d])=>(
                  <div key={n} className="py-2 border-b border-gray-100 last:border-0">
                    <p className={kwStack}>{n}</p>
                    <p className="text-sm text-[#48484a] mt-0.5 leading-snug">{d}</p>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h3 className="text-base font-bold text-gray-900 mb-3 pb-2 border-b border-gray-100">Build Quality & Wiring — Event-Day Reliability</h3>
              <div className="grid sm:grid-cols-2 gap-x-10 gap-y-1">
                {[
                  ["Check screws","Loose screws cause most field failures. Check every joint before each match."],
                  ["Cable management","Route cables away from moving parts. Zip-tie both ends. Ripped cable = instant loss."],
                  ["Friction test","Every mechanism should spin freely 5+ revolutions by hand. Binding wastes motors."],
                  ["Label ports","Write Brain port number on every motor and sensor. Saves debugging time."],
                  ["Bring spares","Motors, 8-32 × ½\" screws, shaft collars, standoffs, smart cables to every event."],
                  ["Re-check after transport","Robots shift in transit. Check all connections before each event."],
                ].map(([n,d])=>(
                  <div key={n} className="py-2 border-b border-gray-100 last:border-0">
                    <p className={kwStack}>{n}</p>
                    <p className="text-sm text-[#48484a] mt-0.5 leading-snug">{d}</p>
                  </div>
                ))}
              </div>
            </div>

            <p className="text-[15px] text-[#48484a] leading-relaxed">
              <strong className="text-gray-900">Want the full engineering deep-dives?</strong> Gear-ratio math, wheel selection, lift mechanisms, and structural principles are taught step by step in the <strong className="text-gray-900">Drivetrain Design</strong> and <strong className="text-gray-900">Robot Design</strong> lessons (Lessons tab). This guide sticks to Override-specific planning and the official rules.
            </p>

          </div>
          </ChapterBody>
        </section>
        )}

        {/* ── Chapter 04 · Match Strategy ── */}
        {openGuide === "strategy" && (
        <section className="mb-10">
          <ChapterBody accent={CHAPTERS[3].accent}>
          <div className="space-y-10">

            <div>
              <div className="flex items-center gap-2 mb-1">
                <h3 className="text-lg font-bold text-gray-900">Ranking System — WP / AP / SP</h3>
                <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-semibold">Official</span>
              </div>
              <p className="text-xs text-[#8a8a91] mb-4">All three awarded per qualification match. Tiebreaker order: WP → AP → SP.</p>
              <div className="grid sm:grid-cols-3 gap-8">
                {[
                  {label:"WP — Win Points",color:"#dc2626",items:["Win → 2 WP","Tie → 1 WP each","Loss → 0 WP","AWP completed → +1 WP","DQ → 0 WP, 0 AP, 0 SP"]},
                  {label:"AP — Autonomous Points",color:"#0ea5e9",items:["1st tiebreaker when WP is tied","Win the auton bonus → 10 AP","Tied auton → 5 AP each","Ranked by average AP per match"]},
                  {label:"SP — Strength of Schedule",color:"#8b5cf6",items:["2nd tiebreaker when WP + AP tied","The losing alliance's score in each of your matches","Higher = tougher schedule","Cannot be directly controlled"]},
                ].map(s=>(
                  <div key={s.label}>
                    <p className="text-xs font-bold mb-3" style={{color:s.color}}>{s.label}</p>
                    <ul className="space-y-1.5">
                      {s.items.map(i=><li key={i} className="text-[15px] text-[#3a3a3c] flex gap-2"><span className="w-1.5 h-1.5 rounded-full shrink-0 mt-1.5" style={{background:s.color}}/>{i}</li>)}
                    </ul>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="flex items-center gap-2 mb-4">
                <h3 className="text-lg font-bold text-gray-900">Override Scoring Priority</h3>
                <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-semibold">Based on official point values</span>
              </div>
              {[
                {tier:"Tier 1 — Highest impact",color:"#dc2626",items:[
                  "AWP (+1 WP) — can be the difference between seeding 1st and 8th. Hit all 3 tasks every match.",
                  "Autonomous Bonus (12 pts) — free points plus AP. Consistent auton beats everything.",
                  "Yellow Pins (10 pts each) — highest-value object. Control Toggles to claim them.",
                ]},
                {tier:"Tier 2 — Strong value",color:"#f59e0b",items:[
                  "Midfield Endgame (8 pts per robot) — both in Midfield = 16 pts. Plan your final push around the 10-second Endgame.",
                  "Alliance Pins (5 pts each) — core scoring. Efficient, repeated placement wins matches.",
                ]},
                {tier:"Tier 3 — Don't ignore",color:"#9ca3af",items:[
                  "Toggle Control — 0 pts for the Toggle itself, but converts 10-pt yellow Pins. Flip every Toggle you pass.",
                  "Defence — legally disrupting opponent stacks is valid and forces them to rescore.",
                ]},
              ].map(t=>(
                <div key={t.tier} className="flex gap-4 py-3 border-b border-gray-100 last:border-0">
                  <div className="w-1 rounded-full shrink-0" style={{background:t.color}}/>
                  <div>
                    <p className="text-xs font-bold mb-1.5" style={{color:t.color}}>{t.tier}</p>
                    <ul className="space-y-1">
                      {t.items.map(i=><li key={i} className="text-[15px] text-[#3a3a3c]">{i}</li>)}
                    </ul>
                  </div>
                </div>
              ))}
            </div>

            <div className="grid sm:grid-cols-2 gap-10">
              {[
                {title:"Autonomous Strategy",items:[
                  ["AWP first","Know all 3 tasks before each event. Build your auton to complete them with zero violations."],
                  ["Consistency wins","A simple, reliable auton beats a complex one that fails 30% of the time."],
                  ["Use the IMU","Always use the Inertial sensor for turns. Calibrate before every match."],
                  ["Backup auton","Program a 1–2 action fallback. Switch to it if the main auton breaks at the event."],
                  ["No crossing the line","Crossing the Autonomous Line = violation, opponent gets the 12-pt bonus."],
                ]},
                {title:"Alliance Selection",items:[
                  ["Seed high","Top seed picks first — target top 3 seeding for maximum partner control."],
                  ["Pick for reliability","A consistent 12-Pin robot beats a flashy 20-Pin one that breaks down."],
                  ["Complement strengths","Pick a partner strong where you're weak — not another Pin scorer."],
                  ["Scout first","Know every team's auton, Midfield capability, and repair history."],
                  ["You can decline","Teams can decline an invite. Each team may only be invited once."],
                ]},
                {title:"Driver Control & Coordination",items:[
                  ["Assign roles","One robot scores Pins, the other handles Cups, Toggles, and match loads."],
                  ["Use match loads","Feed a Pin, Cup, or combined unit through your Loader every chance you get."],
                  ["Endgame warning","The Endgame is only the final 10 seconds — both robots should be arriving at Midfield before it starts."],
                  ["Protect stacks","Park in front of key Goals — don't leave scored stacks unattended."],
                  ["Communicate DQs","A DQ costs 0 WP, 0 AP, 0 SP for your whole alliance."],
                ]},
                {title:"Scouting",items:[
                  ["Track per match","Record: auton result, final score, Midfield result, DQs."],
                  ["Auton consistency","Consistent auton partner > high-scoring unreliable one — earns AP every match."],
                  ["Drive strength","Midfield is physical. Note which robots push well."],
                  ["OPR / DPR","Tournament Manager shows Offensive and Defensive Power Ratings — use them."],
                  ["Watch for improvement","Teams iterate between morning and afternoon. Don't dismiss early struggles."],
                ]},
                {title:"Skills Challenge",items:[
                  ["Format","1 robot, 60 sec. Driving Skills and Autonomous Coding Skills are separate runs; your best of each combine."],
                  ["Driving Skills","Run the same efficient path every attempt. Consistency beats exploring."],
                  ["Autonomous Coding Skills","Fully autonomous. Use IMU + rotation sensors for reliable pathing."],
                  ["AWP doesn't apply","Skills runs follow different rules — AWP tasks are not relevant."],
                  ["World qualification","Top skills at signature events can qualify directly to Worlds."],
                ]},
                {title:"Event Day Checklist",items:[
                  ["Arrive early","Get through inspection before the queue builds."],
                  ["Calibrate IMU","On actual competition field tiles — surface affects calibration."],
                  ["Full battery","50% battery noticeably loses drive power. Charge between every match."],
                  ["Talk to judges","Introduce your team, explain engineering decisions, bring your notebook."],
                  ["Gracious Professionalism","Help other teams. Judges watch pit and field behaviour."],
                  ["Bring spares","Motors, 8-32 × ½\" screws, shaft collars, smart cables, extra battery."],
                ]},
              ].map(sec=>(
                <div key={sec.title}>
                  <h3 className={secH}>{sec.title}</h3>
                  {sec.items.map(([k,v])=>(
                    <div key={k} className="py-2 border-b border-gray-100 last:border-0">
                      <span className={kwStack}>{k}</span><span className={vw}>{v}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>

          </div>
          </ChapterBody>
        </section>
        )}

        {/* ── Chapter 05 · Notebook Guide ── */}
        {openGuide === "notebook" && (
        <section className="mb-10">
          <ChapterBody accent={CHAPTERS[4].accent}>
          <div className="space-y-10">

            <div>
              <h3 className="text-lg font-bold text-gray-900 mb-2">What the Notebook Is For</h3>
              <p className="text-[15px] text-[#3a3a3c] leading-relaxed">An original, student-written record of your team's <strong className="text-gray-900">Engineering Design Process</strong> over the full season. Judges evaluate it for <strong className="text-gray-900">Excellence, Design, and Think</strong> awards. Official principle: judges prioritise <em>content and clarity</em> over presentation quality or length.</p>
            </div>

            <div>
              <h3 className="text-lg font-bold text-gray-900 mb-1">Rubric — Scoring Levels</h3>
              <p className="text-xs text-[#8a8a91] mb-4">Each category scored independently. Rubric sorts notebooks; judges make final decisions qualitatively.</p>
              <div className="grid grid-cols-3 gap-6">
                {[
                  {level:"Emerging — 1 pt",color:"#9ca3af",desc:"Steps missing or vague. Challenges aren't defined upfront, descriptions lack detail, little to no data or diagrams."},
                  {level:"Proficient — 2 pts",color:"#0ea5e9",desc:"Challenge stated at cycle start but missing depth — written explanation, visuals, or measurable goals need more detail."},
                  {level:"Expert — 3 pts",color:"#8b5cf6",desc:"Every cycle opens with a clearly defined challenge, words and diagrams. Detailed enough for someone else to reproduce the work."},
                ].map(s=>(
                  <div key={s.level}>
                    <p className="text-sm font-bold mb-2" style={{color:s.color}}>{s.level}</p>
                    <p className="text-[15px] text-[#48484a] leading-snug">{s.desc}</p>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h3 className="text-lg font-bold text-gray-900 mb-1">The 7-Step Engineering Design Process</h3>
              <p className="text-xs text-[#8a8a91] mb-5">Apply to every decision — not just major redesigns. A small fix still needs define → test → iterate.</p>
              {[
                ["Define the Problem","State what you're solving. Include objectives (what success looks like) and constraints (size limits, motor budget). Be specific: 'build a pin intake' is too vague. 'Pick up one Pin and place it on a Goal in under 3 seconds' is correct.","#dc2626"],
                ["Research","Look at how other teams or past seasons solved similar problems. Document what's relevant to your current cycle.","#f59e0b"],
                ["Identify Possible Solutions","Document 3+ design options with labeled sketches. Don't skip dismissed options — judges want to see you considered alternatives.","#f59e0b"],
                ["Choose the Best Solution","Decision matrix: options as rows, criteria (speed, torque, complexity, reliability) as columns. Score each and justify your choice in writing.","#10b981"],
                ["Prototype and Design","Sketches, CAD, or diagrams before building. Document build steps with measurements, gear ratios, motor ports, and photos.","#10b981"],
                ["Test and Refine","Both qualitative ('the Pin slipped on turns') and quantitative ('avg placement: 2.4 sec over 10 trials') data. Numbers required for Expert level.","#0ea5e9"],
                ["Repeat","Every time something breaks or underperforms — restart the cycle. Document why the previous design failed.","#8b5cf6"],
              ].map(([title, desc, color], i)=>(
                <div key={i} className="flex gap-4 py-4 border-b border-gray-100 last:border-0">
                  <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-black text-white shrink-0 mt-0.5" style={{background:color}}>{i+1}</div>
                  <div>
                    <p className="text-sm font-bold text-gray-900 mb-0.5">{title}</p>
                    <p className="text-[15px] text-[#48484a] leading-snug">{desc}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="grid sm:grid-cols-2 gap-10">
              <div>
                <h3 className={secH}>Rubric Categories</h3>
                {[
                  ["Identify the Challenge","Define the problem upfront — words AND diagrams."],
                  ["Brainstorm & Prototype","3+ options with labeled sketches. Show real exploration."],
                  ["Select Best Solution","Decision matrix + written justification."],
                  ["Build & Program","Build steps, measurements, code excerpts, photos."],
                  ["Test & Refine","Qualitative AND quantitative data. Specific numbers."],
                  ["Iterate","Design loop repeating — not just once at season start."],
                  ["Team Management","Meeting logs, role assignments, entry authorship."],
                  ["Professional Format","Dated and signed each page, page numbers, contents."],
                ].map(([k,v])=>(
                  <div key={k} className="py-2 border-b border-gray-100 last:border-0">
                    <span className={kwStack}>{k}</span>
                    <span className={vw}>{v}</span>
                  </div>
                ))}
              </div>
              <div className="space-y-8">
                <div>
                  <h3 className={secH}>Award Requirements</h3>
                  {[
                    {award:"Excellence",color:"#dc2626",reqs:["Top notebook + top qualification rank + strong interview","Full design process from start to execution"]},
                    {award:"Design",color:"#0ea5e9",reqs:["Strong notebook + interview on engineering decisions","Does not require top performance rank"]},
                    {award:"Think",color:"#8b5cf6",reqs:["Best programming documentation","Code excerpts, auton logic, testing evidence"]},
                  ].map(a=>(
                    <div key={a.award} className="py-2 border-b border-gray-100 last:border-0">
                      <p className="text-xs font-bold mb-1" style={{color:a.color}}>{a.award} Award</p>
                      {a.reqs.map(r=><p key={r} className="text-sm text-[#48484a]">{r}</p>)}
                    </div>
                  ))}
                </div>
                <div>
                  <h3 className={secH}>Interview Tips</h3>
                  {[
                    ["All members ready","Every member should explain the robot and decisions. Judges talk to everyone."],
                    ["Lead with process","Don't just say what you built — explain why you chose it over alternatives."],
                    ["Reference pages","Point to specific notebook pages. Shows it's genuinely yours."],
                    ["Describe failures","Judges value teams that learned from what didn't work."],
                  ].map(([k,v])=>(
                    <div key={k} className="py-2 border-b border-gray-100 last:border-0">
                      <span className={kwStack}>{k}</span>
                      <span className={vw}>{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div>
              <h3 className={secH}>Common Mistakes</h3>
              <div className="grid sm:grid-cols-2 gap-x-10 gap-y-3">
                {[
                  ["Apply the process to small changes too","Every decision needs define → test → iterate, not just major redesigns."],
                  ["Document failures, not just successes","Failed designs show real engineering. A wins-only notebook looks fabricated."],
                  ["Write specific entries","'We built the intake' is not an entry. State the problem, what you did, what happened, what's next."],
                  ["Include quantitative data","'It worked better' is not data. '8/10 at 80% speed' is data. Numbers = Expert level."],
                  ["No gaps in dates","Missing weeks signal backfilling. Sign and date every page in real time."],
                  ["Define the challenge first","Specific rubric criterion — judges check: did you state the problem before showing solutions?"],
                  ["Individual authorship","Each entry must be individually signed. Identical entries across members look fabricated."],
                  ["One matrix per major decision","Drivetrain, lift type, intake, auton — each needs its own decision matrix."],
                ].map(([k,v])=>(
                  <div key={k} className="py-2 border-b border-gray-100 last:border-0">
                    <p className="text-xs font-bold text-red-500">{k}</p>
                    <p className="text-sm text-[#48484a] mt-0.5 leading-snug">{v}</p>
                  </div>
                ))}
              </div>
            </div>

          </div>
          </ChapterBody>
        </section>
        )}

          {/* Previous / next guide */}
          <div className="grid sm:grid-cols-2 gap-3 mt-2">
            {gIdx > 0 ? (
              <button onClick={() => goTo(CHAPTERS[gIdx - 1].id)}
                className="group text-left rounded-2xl bg-white p-5 transition-all hover:-translate-y-0.5 hover:shadow-lg"
                style={{ border: "1px solid #e6e6ec" }}>
                <p className="text-[11px] font-bold uppercase tracking-widest mb-1.5" style={{ color: "#8a8a91" }}>← Previous</p>
                <p className="text-[15px] font-semibold tracking-tight" style={{ color: CHAPTERS[gIdx - 1].accent }}>{CHAPTERS[gIdx - 1].label}</p>
              </button>
            ) : <span className="hidden sm:block" />}
            {gIdx < CHAPTERS.length - 1 && (
              <button onClick={() => goTo(CHAPTERS[gIdx + 1].id)}
                className="group text-right rounded-2xl bg-white p-5 transition-all hover:-translate-y-0.5 hover:shadow-lg"
                style={{ border: "1px solid #e6e6ec" }}>
                <p className="text-[11px] font-bold uppercase tracking-widest mb-1.5" style={{ color: "#8a8a91" }}>Next →</p>
                <p className="text-[15px] font-semibold tracking-tight" style={{ color: CHAPTERS[gIdx + 1].accent }}>{CHAPTERS[gIdx + 1].label}</p>
              </button>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

// ── Dashboard shell ───────────────────────────────────────────────────────
function Dashboard() {
  const { store, update, mode, switchMode } = useStore();
  const [tab, setTab]             = React.useState("competition");
  // GSAP: cascade the new panel in whenever the dashboard tab changes
  const tabPanelRef = useSwapAnimation(tab);

  // The draft/live workspace UI was removed (user: unnecessary). The store still
  // supports draft mode, so if an older session left it on, quietly return to
  // live data rather than stranding the user in an invisible draft.
  React.useEffect(() => {
    if (mode === "draft") switchMode("prod");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [setupOpen, setSetupOpen] = React.useState(!store.setupDone);
  const [teamForm, setTeamForm]   = React.useState({
    number: store.team?.number || "",
    name:   store.team?.name   || "",
    region: store.team?.region || "",
  });

  const saveTeam = () => {
    update(s => ({ ...s, setupDone: true, team: {
      number: teamForm.number, name: teamForm.name, region: teamForm.region,
    }}));
    setSetupOpen(false);
  };

  const TABS = [
    { id:"competition", label:"Competition Hub" },
    { id:"goals",       label:"Season Goals"    },
    { id:"practice",    label:"Practice Planner"},
  ];

  // Theme: D now reads from the shared palette (lib/theme.js) — no drift.
  const D = {
    bg:         PALETTE.light.page,
    cardBg:     PALETTE.light.card,
    cardBorder: PALETTE.light.border,
    inputBg:    PALETTE.light.cardAlt,
    inputBorder:PALETTE.light.border,
    red:        PALETTE.brand[600],
    textPri:    PALETTE.slate[900],
    textMuted:  PALETTE.slate[500],
  };

  // Pit-wall hero data — record + next event, derived from the same store the
  // tabs edit, so the scoreboard always agrees with the Competition Hub.
  const heroComps   = store.competitions || [];
  const heroMatches = heroComps.flatMap((c) => c.matches || []);
  const heroW = heroMatches.filter((m) => m.ourScore > m.theirScore).length;
  const heroL = heroMatches.filter((m) => m.ourScore < m.theirScore).length;
  const todayStr  = new Date().toISOString().slice(0, 10);
  const nextComp  = [...heroComps].filter((c) => c.date && c.date >= todayStr).sort((a, b) => (a.date > b.date ? 1 : -1))[0] || null;
  const daysToNext = nextComp ? Math.max(0, Math.ceil((new Date(nextComp.date) - new Date(todayStr)) / 86400000)) : null;

  return (
    <div style={{ background: LIGHT_PAGE_BG, minHeight:"100vh" }} className="pt-28 px-4 sm:px-6 pb-20"> {/* theme: gradient-mesh page */}
      <div className="max-w-5xl mx-auto">

        {/* Team setup modal */}
        {setupOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
            <div className="w-full max-w-md rounded-3xl p-8 bg-white" style={{boxShadow:"0 24px 60px rgba(0,0,0,0.12)"}}>
              <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 rounded-xl bg-red-600 flex items-center justify-center">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                </div>
                <div>
                  <h3 className="text-gray-900 font-bold text-xl">Set up your team</h3>
                  <p className="text-gray-400 text-xs">Saved locally — only you see this.</p>
                </div>
              </div>
              <div className="space-y-3">
                {/* Refinement: each field declares its sanitizer — rankings are digits-only,
                    name/region letters-only, team number follows the VEX 1234A format.
                    Invalid characters are stripped as typed (lib/sanitizers.js).
                    inputMode brings up the matching mobile keyboard. */}
                {[
                  {key:"number",       label:"Team Number",      ph:"e.g. 1234A",             clean:sanitizeTeamNumber, mode:"text"},
                  {key:"name",         label:"Team Name",        ph:"e.g. RoboNinjas",        clean:sanitizeLetters,    mode:"text"},
                  {key:"region",       label:"Region / State",   ph:"e.g. Pacific Northwest", clean:sanitizeLetters,    mode:"text"},
                ].map(f=>(
                  <div key={f.key}>
                    <label className="text-gray-500 text-xs font-semibold mb-1 block uppercase tracking-wider">{f.label}</label>
                    <input value={teamForm[f.key]} onChange={e=>setTeamForm(p=>({...p,[f.key]:f.clean(e.target.value)}))}
                      placeholder={f.ph} inputMode={f.mode} aria-label={f.label}
                      className="w-full rounded-xl px-4 py-2.5 text-sm text-gray-900 outline-none"
                      style={LIGHT_CARD}/>
                  </div>
                ))}
              </div>
              <div className="flex gap-3 mt-6">
                {store.setupDone&&(
                  <button onClick={()=>setSetupOpen(false)}
                    className="flex-1 py-3 rounded-xl text-gray-500 text-sm font-semibold transition hover:bg-gray-50"
                    style={{border:"1px solid #e5e7eb"}}>Cancel</button>
                )}
                <button onClick={saveTeam}
                  className="flex-1 py-3 rounded-xl text-white font-bold text-sm transition hover:opacity-90" style={{background:"#dc2626"}}>
                  Save Team Info
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Header — GSAP reveal on page entry */}
        <div className="mb-7" data-reveal="up">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-1 h-4 rounded-full bg-red-500"/>
            <p className="text-xs font-bold tracking-widest text-red-500 uppercase">Season 2026–27 · Override</p>
          </div>
          <h2 className="text-4xl sm:text-5xl font-semibold tracking-tight leading-none" style={{ color: "#1d1d1f" }}>Team HQ</h2>
        </div>

        {/* ── Pit-wall hero — team plate + season scoreboard + next event ── */}
        <div className="relative overflow-hidden rounded-3xl p-6 sm:p-8 mb-6 flex flex-col lg:flex-row lg:items-center gap-7" data-reveal="up" data-reveal-delay="0.06"
          style={{ background:"#161619", boxShadow:"0 18px 50px rgba(0,0,0,0.22)" }}>

          {/* Ambient glow — the plate casts red light across the pit wall */}
          <div aria-hidden="true" className="absolute pointer-events-none"
            style={{ inset:-60, background:"radial-gradient(560px 280px at 10% 25%, rgba(220,38,38,0.28), transparent 65%), radial-gradient(420px 220px at 92% 80%, rgba(220,38,38,0.1), transparent 70%)" }}/>

          {/* Team identity — VEX-style license plate */}
          <div className="flex items-center gap-5 min-w-0">
            <div className="shrink-0 rounded-2xl px-5 py-3.5 text-center"
              style={{ background:"#dc2626", border:"3px solid #ffffff", boxShadow:"0 8px 22px rgba(220,38,38,0.4)" }}>
              <p className="brand-wordmark text-white text-3xl sm:text-4xl leading-none tracking-wide">
                {store.team?.number || "— — —"}
              </p>
            </div>
            <div className="min-w-0">
              <p className="text-white font-semibold text-xl tracking-tight truncate">{store.team?.name || "Set up your team"}</p>
              <p className="text-sm truncate" style={{ color:"rgba(255,255,255,0.55)" }}>{store.team?.region || "Add your region"}</p>
            </div>
          </div>

          <div className="flex-1"/>

          {/* Scoreboard: record + next event */}
          <div className="flex items-center gap-7 sm:gap-9">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.16em] mb-1" style={{ color:"rgba(255,255,255,0.45)" }}>Season record</p>
              <p className="brand-wordmark text-white text-4xl sm:text-5xl leading-none tabular-nums">
                {heroW}<span style={{ color:"rgba(255,255,255,0.35)" }}>–</span>{heroL}
              </p>
            </div>
            <div className="w-px self-stretch" style={{ background:"rgba(255,255,255,0.12)" }}/>
            <div className="min-w-0">
              <p className="text-[11px] font-bold uppercase tracking-[0.16em] mb-1" style={{ color:"rgba(255,255,255,0.45)" }}>Next event</p>
              {nextComp ? (<>
                <p className="text-white font-semibold text-lg leading-tight truncate max-w-[220px]">{nextComp.name}</p>
                <p className="text-sm" style={{ color:"#f87171" }}>{daysToNext === 0 ? "Today — good luck!" : `in ${daysToNext} day${daysToNext === 1 ? "" : "s"}`}</p>
              </>) : (<>
                <p className="text-white font-semibold text-lg leading-tight">Nothing scheduled</p>
                <p className="text-sm" style={{ color:"rgba(255,255,255,0.5)" }}>Add a tournament below</p>
              </>)}
            </div>
          </div>

          {/* Edit team */}
          <button onClick={()=>setSetupOpen(true)} aria-label="Edit team info"
            className="self-start lg:self-center shrink-0 p-2.5 rounded-full transition hover:bg-white/10"
            style={{ border:"1px solid rgba(255,255,255,0.15)" }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
        </div>

        {/* Tab bar — Apple segmented control track */}
        <div className="flex gap-1 mb-8 p-1 rounded-full" style={{ background: "#e8e8ed" }}>
          {TABS.map(t=>(
            <button key={t.id} onClick={()=>setTab(t.id)}
              className="flex-1 py-2.5 px-3 rounded-full text-sm font-medium transition"
              style={{
                background: tab===t.id ? "#ffffff" : "transparent", // Apple segmented control
                color:      "#1d1d1f",
                opacity:    tab===t.id ? 1 : 0.6,
                boxShadow:  tab===t.id ? "0 1px 4px rgba(0,0,0,0.12)" : "none",
              }}>
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab panels — ref'd so useSwapAnimation cascades each switched-to panel */}
        <div ref={tabPanelRef}>
          {tab==="competition" && <CompetitionHub  store={store} update={update}/>}
          {tab==="goals"       && <SeasonGoals     store={store} update={update}/>}
          {tab==="practice"    && <PracticeCalendar store={store} update={update}/>}
        </div>

        <div className="mt-12 flex items-center justify-center gap-4">
          {/* Refinement: destructive reset behind a styled danger dialog instead of window.confirm */}
          <button onClick={async ()=>{
              const ok = await confirmDialog({
                title: "Reset ALL dashboard data?",
                message: "This permanently clears study time, skills, badges, goals, and activity on this device.",
                confirmLabel: "Reset everything", danger: true,
              });
              if (ok) { update(()=>defaultStore()); setSetupOpen(true); }
            }}
            className="text-gray-300 hover:text-red-400 text-xs transition">Reset all data</button>
          <span className="text-gray-200 text-xs">·</span>
          <OwnerStats />
        </div>
      </div>
    </div>
  );
}

// Owner-only site analytics — how many people use Voltz and how many have signed
// in. PIN-gated (same SHA-256 owner PIN as automod) so it stays private; reads
// aggregate counts via the get_site_stats() RPC (counts only, never raw rows/IPs).
// Floating "Feedback" button + quick form. Anyone can submit; stored in Supabase
// (see submitFeedback / 20260824_feedback.sql). Sits bottom-left so it never
// clashes with the bottom-right Voltz chat launcher.
function FeedbackWidget() {
  const { user } = useAuth() || {};
  const [open, setOpen]   = React.useState(false);
  const [msg, setMsg]     = React.useState("");
  const [state, setState] = React.useState("idle"); // idle | sending | done
  const close = () => { setOpen(false); setTimeout(() => { setState("idle"); setMsg(""); }, 200); };
  const send = async () => {
    if (!msg.trim() || state === "sending") return;
    setState("sending");
    const ok = await submitFeedback({ type: "other", message: msg.trim(), userId: user?.id });
    if (ok) { setState("done"); setTimeout(close, 1800); }
    else { setState("idle"); notify("Couldn't send — try again in a moment.", { level: "error" }); }
  };
  return (
    <>
      <button onClick={() => setOpen(true)} aria-label="Send feedback"
        className="fixed left-5 bottom-5 z-[120] flex items-center gap-2 pl-3 pr-4 py-2.5 rounded-full text-sm font-semibold shadow-lg transition hover:-translate-y-0.5 hover:shadow-xl active:scale-95"
        style={{ background: "#ffffff", color: "#1d1d1f", border: "1px solid #e2e2e9" }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        Feedback
      </button>
      {open && (
        <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
          onClick={(e) => e.target === e.currentTarget && close()}>
          <div className="w-full max-w-sm bg-white rounded-3xl shadow-2xl overflow-hidden" data-reveal="scale">
            <div className="p-7">
              {state === "done" ? (
                <div className="text-center py-6">
                  <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
                    <svg width="24" height="20" viewBox="0 0 24 20" fill="none"><path d="M2 10l7 7L22 2" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </div>
                  <p className="font-semibold text-lg" style={{ color: "#1d1d1f" }}>Thank you!</p>
                  <p className="text-sm mt-1" style={{ color: "#6e6e73" }}>Your feedback helps make Voltz better.</p>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg font-semibold tracking-tight" style={{ color: "#1d1d1f" }}>Send feedback</h3>
                    <button onClick={close} className="w-7 h-7 rounded-full bg-gray-100 text-gray-400 hover:bg-gray-200 transition text-sm">✕</button>
                  </div>
                  <textarea value={msg} onChange={(e) => setMsg(e.target.value)} rows={5} autoFocus maxLength={2000}
                    placeholder="What's working, what's not, what would you love to see?"
                    className="w-full rounded-xl px-4 py-3 text-sm text-gray-900 outline-none resize-none" style={LIGHT_CARD} />
                  <button onClick={send} disabled={!msg.trim() || state === "sending"}
                    className="mt-4 w-full py-3 rounded-xl text-white font-bold text-sm transition hover:opacity-90 disabled:opacity-50" style={{ background: "#dc2626" }}>
                    {state === "sending" ? "Sending…" : "Send feedback"}
                  </button>
                  <p className="text-[11px] text-center mt-3" style={{ color: "#9a9aa2" }}>
                    {user ? "Sent with your account so we can follow up." : "Anonymous — sign in if you'd like a reply."}
                  </p>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function OwnerStats() {
  const [open, setOpen]         = React.useState(false);
  const [unlocked, setUnlocked] = React.useState(false);
  const [pin, setPin]           = React.useState("");
  const [err, setErr]           = React.useState("");
  const [stats, setStats]       = React.useState(null);
  const [feedback, setFeedback] = React.useState(null);
  const [loading, setLoading]   = React.useState(false);

  const submitPin = async () => {
    setErr("");
    if (await checkPin(pin)) {
      setUnlocked(true); setPin(""); setLoading(true);
      const [s, f] = await Promise.all([fetchSiteStats(), fetchFeedback()]);
      setStats(s); setFeedback(f); setLoading(false);
    } else { setErr("Incorrect PIN."); }
  };
  const close = () => { setOpen(false); setUnlocked(false); setPin(""); setErr(""); setStats(null); setFeedback(null); };

  const N = (v) => (v == null ? "—" : Number(v).toLocaleString());
  // "Signed-in users" was dropped from display — it measures something subtly
  // different from total signups (visits recorded while authenticated, not
  // total accounts) and was a recurring source of confusion. The raw number
  // is still returned by get_site_stats() for anyone querying Supabase
  // directly; this just simplifies what the owner sees in the app.
  const rows = stats && [
    ["Total visits",     stats.total_visits],
    ["Unique visitors",  stats.unique_visitors],
    ["Visits today",     stats.visits_today],
  ];

  return (
    <>
      <button onClick={()=>setOpen(true)} className="text-gray-300 hover:text-gray-500 text-xs transition">Site stats</button>
      {open && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
          onClick={(e)=>e.target===e.currentTarget&&close()}>
          <div className="w-full max-w-md bg-white rounded-3xl shadow-2xl overflow-hidden max-h-[88vh] flex flex-col">
            <div className="p-7 overflow-y-auto">
              <div className="flex items-center justify-between mb-5">
                <h3 className="text-lg font-semibold tracking-tight" style={{ color:"#1d1d1f" }}>Site analytics</h3>
                <button onClick={close} className="w-7 h-7 rounded-full bg-gray-100 text-gray-400 hover:bg-gray-200 transition text-sm">✕</button>
              </div>

              {!unlocked ? (
                <div>
                  <p className="text-xs mb-3" style={{ color:"#6e6e73" }}>Enter the owner PIN to view visitor stats.</p>
                  <input type="password" value={pin} inputMode="numeric" autoFocus
                    onChange={(e)=>setPin(e.target.value)} onKeyDown={(e)=>e.key==="Enter"&&submitPin()}
                    placeholder="••••" className="w-full rounded-xl px-4 py-2.5 text-sm outline-none" style={LIGHT_CARD}/>
                  {err && <p className="text-red-500 text-xs mt-2">{err}</p>}
                  <button onClick={submitPin} className="mt-4 w-full py-3 rounded-xl text-white font-bold text-sm transition hover:opacity-90" style={{ background:"#dc2626" }}>Unlock</button>
                </div>
              ) : loading ? (
                <p className="text-sm text-center py-6" style={{ color:"#6e6e73" }}>Loading…</p>
              ) : !stats ? (
                <p className="text-sm leading-relaxed py-2" style={{ color:"#6e6e73" }}>
                  Analytics isn't set up yet. Apply the <code className="font-mono text-[12px] px-1 rounded" style={{ background:"#f2f2f5" }}>20260810_analytics.sql</code> migration and reload — visits will start counting automatically.
                </p>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    {rows.map(([label, val])=>(
                      <div key={label} className="rounded-2xl p-4" style={{ background:"#f8f8fb", border:"1px solid #ececf1" }}>
                        <p className="text-2xl font-semibold tracking-tight tabular-nums" style={{ color:"#1d1d1f" }}>{N(val)}</p>
                        <p className="text-xs mt-1" style={{ color:"#6e6e73" }}>{label}</p>
                      </div>
                    ))}
                  </div>

                  {/* Recent feedback */}
                  <div className="mt-6">
                    <div className="flex items-baseline justify-between mb-2">
                      <p className="text-xs font-bold uppercase tracking-[0.12em]" style={{ color:"#9a9aa2" }}>Feedback</p>
                      {feedback && <span className="text-xs" style={{ color:"#9a9aa2" }}>{feedback.length}</span>}
                    </div>
                    {feedback == null ? (
                      <p className="text-xs leading-relaxed" style={{ color:"#6e6e73" }}>
                        Not set up yet — apply <code className="font-mono text-[11px] px-1 rounded" style={{ background:"#f2f2f5" }}>20260824_feedback.sql</code>.
                      </p>
                    ) : feedback.length === 0 ? (
                      <p className="text-xs" style={{ color:"#9a9aa2" }}>No feedback yet.</p>
                    ) : (
                      <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                        {feedback.map(f => (
                          <div key={f.id} className="rounded-xl px-3 py-2.5" style={{ background:"#f8f8fb", border:"1px solid #ececf1" }}>
                            <p className="text-[13px] leading-relaxed" style={{ color:"#1d1d1f" }}>{f.message}</p>
                            <p className="text-[10px] mt-1.5" style={{ color:"#9a9aa2" }}>{new Date(f.created_at).toLocaleDateString()}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ---------- APP ----------
function FloatingChat() {
  const [open, setOpen] = React.useState(false);
  const [messages, setMessages] = React.useState([
    { role: "assistant", content: "Hey! I'm Voltz 👋 Ask me anything about VEX — Override (2026–27 upcoming), High Stakes (2024–25), C++, robot design, auton strategies, you name it!" }
  ]);
  const [input, setInput] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const endRef = React.useRef(null);
  const rootRef = React.useRef(null);
  const bobRef = React.useRef(null);
  const [pos, setPos] = React.useState({ x: 0, y: 0 });
  const dragRef = React.useRef({ active: false, moved: false, sx: 0, sy: 0, ox: 0, oy: 0 });

  // GSAP: springy pop-in for the floating assistant on first mount.
  React.useEffect(() => { popIn(rootRef.current); }, []);

  // Content pages can hand Voltz a question: "Ask Voltz" buttons dispatch a
  // `voltz-ask` CustomEvent — the chat opens with the question pre-filled so
  // the reader just hits send.
  React.useEffect(() => {
    const onAsk = (e) => { setOpen(true); if (e.detail) setInput(String(e.detail)); };
    window.addEventListener("voltz-ask", onAsk);
    return () => window.removeEventListener("voltz-ask", onAsk);
  }, []);

  // GSAP idle float — Volt gently bobs so it feels alive; stops while the panel is open.
  React.useEffect(() => { if (!open) return floatIdle(bobRef.current); }, [open]);

  // Drag-anywhere: pointer-drag moves the whole widget; a release with no movement
  // is treated as a click (open/close). Position is clamped to stay on-screen.
  const onLauncherDown = (e) => {
    dragRef.current = { active: true, moved: false, sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic/unsupported */ }
  };
  const onLauncherMove = (e) => {
    const d = dragRef.current;
    if (!d.active) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
    setPos({
      x: Math.min(12, Math.max(-(window.innerWidth - 92), d.ox + dx)),
      y: Math.min(12, Math.max(-(window.innerHeight - 116), d.oy + dy)),
    });
  };
  const onLauncherUp = (e) => {
    dragRef.current.active = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* synthetic/unsupported */ }
  };
  const onLauncherClick = () => {
    if (dragRef.current.moved) { dragRef.current.moved = false; return; }
    setOpen(v => !v);
  };

  React.useEffect(() => {
    if (open) setTimeout(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
  }, [messages, open]);

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;

    const next = [...messages, { role: "user", content: text }];
    setMessages(next);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/groq-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            { role: "system", content: `You are Voltz, a friendly and knowledgeable VEX Robotics and C++ tutor for high school students. You know VEX V5 hardware, VEXcode C++ API, competition strategy, robot design, and C++ programming inside-out.

CRITICAL — VEX GAME SEASONS (get these years exactly right, never mix them up):

UPCOMING GAME: OVERRIDE (2026–2027)
- Override is the VRC (V5RC) game for the 2026–2027 season. It was announced/unveiled at the VEX Robotics World Championship in April 2026.
- DO NOT say it is 2025-2026 or 2023-2024 or any other year. It is 2026-2027.
- Played on a 12×12 ft field, two alliances of 2 robots.
- Game objects: Cups and Pins — alliances stack cups and pins on the field to earn points.
- NOTE: "Override" is ONLY the name of the 2026-2027 game. It is NOT a controller feature, NOT a software mode, NOT a button on the controller. Never confuse it with any controller override function.
- If someone asks about "VEX Override" or "teach me Override", explain the 2026-2027 competition game (cups, pins, stacking).

HIGH STAKES (2024–2025)
- Rings + Mobile Goals. Wall Stakes, Alliance Stakes, Neutral Stake (centre field).
- Top ring on each stake determines who controls it. Positive/Negative corners add/subtract from score.
- Endgame: Elevation on alliance bars (A/B/C/D tier scoring).
- Meta: fast mobile goal rush, ring stacking, corner control, elevation for endgame points.

OVER UNDER (2023–2024) — completely different from Override, do NOT mix these up
- Triballs (green triangular prism objects). Large centre barrier that robots can drive over OR under.
- Triballs scored in own zone (1 pt each), push under barrier counts. Elevation bars in corners (A/B tiers).
- "Over Under" refers to going over or under the centre barrier — has nothing to do with Override.

SPIN UP (2022–2023): Discs (flat frisbees), roller goals on field walls, low/high goal scoring, expansion endgame.
TIPPING POINT (2021–2022): Rings + Mobile Goals, platform balancing for endgame bonus.
CHANGE UP (2020–2021): Balls in 3×3 connected goal grid, row/column bonus scoring.
TOWER TAKEOVER (2019–2020): Cubes with tower colour multipliers.

VEX V5 HARDWARE:
- V5 Brain: ARM Cortex-A9 @ 800MHz, 128MB RAM, 21 Smart Ports, touchscreen, WiFi
- V5 Smart Motors: 11W, cartridges: 100RPM (red/torque), 200RPM (green/balanced), 600RPM (blue/speed)
- Sensors: Inertial (IMU), Distance, Rotation, Optical, Vision, GPS, Bumper, Encoder
- Controller: 2 joysticks (Axis 1-4), A/B/X/Y + L1/L2/R1/R2 buttons, D-pad

VEXCODE C++ KEY API:
- Motors: vex::motor M(vex::PORT1); M.spin(fwd, 80, pct); M.spinFor(fwd, 1000, msec); M.stop(brake);
- Controller: Controller1.Axis3.value(); Controller1.ButtonA.pressing();
- IMU: Imu.heading(); Imu.calibrate(); Imu.resetHeading();
- Competition template: void autonomous(){} void usercontrol(){while(true){wait(20,msec);}}

Formatting rules (ALWAYS follow):
- Short paragraphs with blank lines between them — never one giant wall of text.
- Bullet points for lists, numbered lists for steps.
- **Bold** for key terms. \`\`\`cpp code blocks for all code. \`backticks\` for inline code.
- Answer directly and concisely. Short answer for simple questions, detailed only when needed.
- Tone: casual, encouraging, like a helpful older teammate.` },
            ...next.map(m => ({ role: m.role, content: m.content }))
          ],
          max_tokens: 900,
          temperature: 0.75,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      setMessages(prev => [...prev, { role: "assistant", content: data.choices[0].message.content }]);
    } catch (e) {
      aiLog.error("FloatingChat request failed", e?.message || e);
      setMessages(prev => [...prev, { role: "assistant", content: `Hmm, something went wrong: ${e.message}` }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div ref={rootRef} className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-3"
      style={{ transform: (pos.x || pos.y) ? `translate(${pos.x}px, ${pos.y}px)` : undefined }}>

      {/* Chat popup */}
      {open && (
        <div className="w-[340px] h-[520px] rounded-3xl shadow-2xl flex flex-col overflow-hidden"
          style={{ background: "linear-gradient(145deg, #0f0f1a 0%, #1a0a0a 100%)", border: "1px solid rgba(255,60,60,0.2)", boxShadow: "0 0 40px rgba(220,38,38,0.2), 0 25px 60px rgba(0,0,0,0.6)" }}>

          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 shrink-0"
            style={{ background: "linear-gradient(135deg, #dc2626 0%, #b91c1c 50%, #7f1d1d 100%)" }}>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full flex items-center justify-center overflow-hidden ring-2 ring-white/40 shrink-0"
                style={{ background: "radial-gradient(circle at 50% 32%, #2b2e35, #141519)" }}>
                <VoltLogo size={40} />
              </div>
              <div>
                <p className="text-sm font-bold text-white tracking-wide">Voltz</p>
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                  <p className="text-xs text-red-200">VEX AI Tutor · Online</p>
                </div>
              </div>
            </div>
            <button onClick={() => setOpen(false)}
              className="w-7 h-7 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white/70 hover:text-white transition text-sm font-bold">
              ×
            </button>
          </div>


          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-3 py-4 space-y-3"
            style={{ scrollbarWidth: "none" }}>
            {messages.map((msg, i) => (
              <div key={i} className={`flex items-end gap-2 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                {msg.role === "assistant" && (
                  <div className="w-6 h-6 rounded-full flex items-center justify-center overflow-hidden shrink-0 mb-0.5 ring-1 ring-black/5"><VoltLogo size={24} /></div>
                )}
                <div className={`max-w-[80%] rounded-2xl px-3 py-2 text-xs leading-relaxed ${
                  msg.role === "user"
                    ? "text-white rounded-br-sm"
                    : "rounded-bl-sm"
                }`} style={msg.role === "user"
                  ? { background: "linear-gradient(135deg, #dc2626, #b91c1c)", boxShadow: "0 4px 15px rgba(220,38,38,0.3)" }
                  : { background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.08)" }}>
                  <ChatMessage content={msg.content} isUser={msg.role === "user"} />
                </div>
              </div>
            ))}
            {loading && (
              <div className="flex items-end gap-2 justify-start">
                <div className="w-6 h-6 rounded-full flex items-center justify-center overflow-hidden shrink-0 ring-1 ring-black/5"><VoltLogo size={24} /></div>
                <div className="rounded-2xl rounded-bl-sm px-4 py-3 flex gap-1 items-center"
                  style={{ background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.08)" }}>
                  <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-bounce" style={{animationDelay:"0ms"}} />
                  <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-bounce" style={{animationDelay:"150ms"}} />
                  <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-bounce" style={{animationDelay:"300ms"}} />
                </div>
              </div>
            )}
            <div ref={endRef} />
          </div>

          {/* Input */}
          <div className="px-3 py-3 shrink-0" style={{ borderTop: "1px solid rgba(255,60,60,0.15)", background: "rgba(0,0,0,0.3)" }}>
            <div className="flex gap-2">
              <input
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && !e.shiftKey && send()}
                placeholder="Ask Voltz anything..."
                className="flex-1 rounded-xl px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none transition"
                style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)" }}
              />
              <button onClick={send} disabled={loading || !input.trim()}
                className="px-3 py-2 rounded-xl text-xs font-bold text-white transition disabled:opacity-30"
                style={{ background: "linear-gradient(135deg, #dc2626, #b91c1c)", boxShadow: "0 0 12px rgba(220,38,38,0.4)" }}>
                ↑
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bubble */}
      <div ref={bobRef} className="relative">
        {/* Breathing halo when closed — slow soft glow that invites a tap */}
        {!open && (<><span className="volt-halo" /><span className="volt-halo2" /></>)}
        <button
          onClick={onLauncherClick}
          onPointerDown={onLauncherDown}
          onPointerMove={onLauncherMove}
          onPointerUp={onLauncherUp}
          aria-label={open ? "Close Voltz assistant" : "Open Voltz assistant (drag to move)"}
          className="relative w-16 h-16 rounded-full flex items-center justify-center overflow-hidden transition-all duration-200 hover:scale-110 active:scale-95 touch-none cursor-grab active:cursor-grabbing"
          style={{
            background: open
              ? "linear-gradient(135deg, #374151, #1f2937)"
              : "radial-gradient(circle at 50% 32%, #2b2e35, #141519)",
            boxShadow: open
              ? "0 4px 20px rgba(0,0,0,0.4)"
              : "0 0 0 4px rgba(220,38,38,0.18), 0 10px 28px rgba(220,38,38,0.45)"
          }}>
          {open ? (
            <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          ) : (
            <VoltLogo size={64} />
          )}
        </button>
      </div>
    </div>
  );
}

// GSAP page transition (replaces the old CSS `pageIn` keyframe here). Fail-safe:
// the page renders visible and animatePageEnter fades/rises it — if the effect
// can't run, the page is simply shown without motion.
function PageTransition({ children, pageKey }) {
  const ref = React.useRef(null);
  // Layout effect: start the fade BEFORE the browser paints the new page —
  // a plain effect painted the page fully visible for one frame, then snapped
  // it to opacity 0 to fade it back in (visible flash on every tab switch).
  React.useLayoutEffect(() => { animatePageEnter(ref.current); }, [pageKey]);
  return (
    <div key={pageKey} ref={ref}>
      {children}
    </div>
  );
}

export default function VexLearningHub() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <StoreProvider>
          <VexLearningHubInner />
        </StoreProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}

function VexLearningHubInner() {
  // Opening an invite link (?invite=TOKEN) lands the visitor straight on the
  // Community page, where TeamChat reads the same token and auto-joins the server.
  const hasInvite = typeof window !== "undefined" && /[?&]invite=/.test(window.location.search);
  const [currentPage, setCurrentPage] = useState(hasInvite ? "community" : "home");
  // navPage updates synchronously so the clicked tab highlights instantly,
  // even while the heavy page render is still in flight in the transition.
  const [navPage, setNavPage] = useState(hasInvite ? "community" : "home");
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authModalEmail, setAuthModalEmail] = useState(""); // pre-fill, e.g. after a password reset
  const [lessonsNonce, setLessonsNonce] = useState(0);
  // True for the brief window between "OAuth returned on the wrong tab" and
  // "signed back out + modal reopened" — see the effect below. Renders a full
  // veil in place of the whole app so the Nav never flashes signed-in.
  const [googleIntentFixing, setGoogleIntentFixing] = useState(false);
  const { user, authLoading } = useAuth();

  // Record one visit per browser session for the owner analytics counter.
  // Wait until Supabase has restored the session (authLoading === false) so a
  // returning signed-in user's visit carries their user_id — otherwise it logs
  // before auth resolves and signed_in_users always reads 0. isNewSession() in
  // recordVisit still guards against duplicate rows. Fire-and-forget.
  const initialAuthUserRef = React.useRef(undefined); // undefined = not yet snapshotted
  React.useEffect(() => {
    if (authLoading) return;
    if (initialAuthUserRef.current === undefined) initialAuthUserRef.current = user ?? null; // snapshot once, at the moment auth resolves
    recordVisit(user?.id);
  }, [authLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  // The effect above only runs ONCE, right when auth first resolves — it never
  // re-fires just because `user` changes later. So someone who lands signed
  // OUT and signs in mid-session was recorded with user_id=null forever,
  // undercounting signed_in_users. Catch that one transition (signed-out ->
  // signed-in, within this page load) and force one extra visit row carrying
  // their user_id — same visitor_id, so unique_visitors is unaffected; only
  // fires for a genuine sign-in-during-visit, not for someone already signed
  // in on load (that's already handled correctly by the effect above).
  const signInVisitFiredRef = React.useRef(false);
  React.useEffect(() => {
    if (authLoading || !user || signInVisitFiredRef.current) return;
    if (initialAuthUserRef.current !== null) return; // was already signed in at load — nothing to catch up
    signInVisitFiredRef.current = true;
    recordVisit(user.id, { force: true });
  }, [user, authLoading]);

  // Enforce Sign In vs Create Account for Google too (see GoogleButton's
  // comment) — the OAuth redirect itself can't tell Supabase "only if this
  // account already exists" or vice versa, so we check after the fact: if the
  // AuthModal's Create Account tab sent the person to Google and they land
  // back on an account that already existed (created_at far in the past, not
  // "just now"), or the Sign In tab sent them and they land on a BRAND NEW
  // account, that's the wrong tab for what actually happened — sign them
  // back out and reopen the modal on the tab that matches reality, so Google
  // is held to the same rule as the email/password fields.
  //
  // useLayoutEffect (not useEffect) + the googleIntentFixing veil below: a
  // plain effect runs AFTER the browser paints, so the Nav would flash fully
  // signed-in (avatar, name) for a frame before flipping back — a visible
  // glitch. Flipping the veil on synchronously, before paint, means the very
  // first frame after the OAuth redirect already shows the veil instead.
  React.useLayoutEffect(() => {
    if (authLoading || !user) return;
    let intent;
    try { intent = localStorage.getItem(GOOGLE_OAUTH_INTENT_KEY); } catch { intent = null; }
    if (!intent) return;
    try { localStorage.removeItem(GOOGLE_OAUTH_INTENT_KEY); } catch { /* ignore */ }
    const createdAt = user.created_at ? new Date(user.created_at).getTime() : null;
    const isBrandNew = createdAt !== null && (Date.now() - createdAt < 15_000);
    const wrongTab = (intent === "signup" && !isBrandNew) || (intent === "signin" && isBrandNew);
    if (!wrongTab) return;
    setGoogleIntentFixing(true);
    getSB()?.auth.signOut().then(() => {
      notify(
        intent === "signup"
          ? "You already have an account with that Google email — signed you out. Please use Sign In instead."
          : "No account exists yet for that Google email — signed you out. Please use Create Account instead.",
        { level: "error" }
      );
      setAuthModalOpen(true);
      setGoogleIntentFixing(false);
    });
  }, [user, authLoading]);

  // SignInPrompt (and anywhere else) can ask the shell to open the full auth
  // modal — e.g. its "sign in with email" option. ResetPasswordModal passes
  // an email to pre-fill (after a password reset, they land straight back on
  // Sign In with it already typed in rather than retyping their address).
  React.useEffect(() => {
    const open = (e) => { setAuthModalEmail(e?.detail?.email || ""); setAuthModalOpen(true); };
    window.addEventListener("voltz-open-auth", open);
    return () => window.removeEventListener("voltz-open-auth", open);
  }, []);

  // useTransition (not bare startTransition) so we get `isPending` — true while a
  // heavy page (CodeLab's Monaco editor, CAD's three.js) is mounting. We surface
  // that as a branded loader so the click feels responsive instead of frozen.
  const [isPending, startTransition] = React.useTransition();
  const navigate = (page) => {
    setNavPage(page);
    startTransition(() => {
      // Clicking "Lessons" always returns to the lesson overview. Lessons keeps an
      // internal selected-lesson state, and re-clicking the tab while already on it
      // wouldn't change currentPage — so bump a key to remount Lessons and drop the
      // open lesson detail.
      if (page === "lessons") setLessonsNonce((n) => n + 1);
      setCurrentPage(page);
    });
  };
  // Only the two genuinely heavy pages warrant a loading veil.
  const heavyLoading = isPending && (navPage === "codelab" || navPage === "cad");

  // Replaces the ENTIRE app (not just an overlay) so nothing underneath —
  // Nav included — ever paints in its briefly-signed-in state. See the
  // useLayoutEffect above for why this needs to be pre-paint, not just early.
  if (googleIntentFixing) return (
    <div className="fixed inset-0 flex flex-col items-center justify-center gap-4" style={{ background: LIGHT_PAGE_BG, zIndex: 9999 }}>
      <div className="w-16 h-16 rounded-full overflow-hidden" style={{ animation: "floatIdleSpin 1.4s ease-in-out infinite", background: "radial-gradient(circle at 50% 32%, #2b2e35, #141519)" }}>
        <VoltLogo size={64} />
      </div>
      <p className="text-sm font-medium" style={{ color: "#6e6e73" }}>One moment…</p>
    </div>
  );

  return (
    <div className="font-sans overflow-x-hidden">
      <style>{`
        @keyframes pageIn {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
      `}</style>

      <Nav currentPage={navPage} setCurrentPage={navigate} onSignIn={()=>setAuthModalOpen(true)} />

      {/* Single mount point for the toast stack + confirm modal (lib/notify.jsx) */}
      <ToastHost />

      {/* GSAP ScrollTrigger reveals — re-scans [data-reveal]/[data-parallax] marks on page change */}
      <ScrollFx pageKey={currentPage} />

      {authModalOpen && <AuthModal onClose={()=>setAuthModalOpen(false)} defaultEmail={authModalEmail} />}

      {/* Google One Tap inline account picker + engagement-triggered nudge */}
      <GoogleOneTap />
      <SignInPrompt />
      <UsernameSetup />
      <ResetPasswordModal />

      {/* Loading veil while a heavy page (Code Lab editor / CAD 3D engine) mounts */}
      {heavyLoading && (
        <div className="fixed inset-0 z-[120] flex flex-col items-center justify-center gap-4"
          style={{ background: "rgba(13,17,23,0.85)", backdropFilter: "blur(6px)" }}>
          <div className="w-16 h-16 rounded-full overflow-hidden" style={{ animation: "floatIdleSpin 1.4s ease-in-out infinite", background: "radial-gradient(circle at 50% 32%, #2b2e35, #141519)" }}>
            <VoltLogo size={64} />
          </div>
          <p className="text-sm font-medium" style={{ color: "rgba(255,255,255,0.72)" }}>
            {navPage === "cad" ? "Warming up the 3D studio…" : "Loading the code editor…"}
          </p>
        </div>
      )}

      <PageTransition pageKey={currentPage}>
        {currentPage === "home"      && <Home setCurrentPage={navigate} />}
        {currentPage === "lessons"   && <Lessons key={lessonsNonce} />}
        {currentPage === "codelab"   && <CodeLab />}
        {currentPage === "cad"       && <CAD />}
        {currentPage === "dashboard" && <Dashboard />}
        {currentPage === "resources" && <Resources />}
        {currentPage === "community" && <TeamChat />}
      </PageTransition>

      {currentPage !== "codelab" && currentPage !== "community" && <FloatingChat />}
      {currentPage !== "codelab" && currentPage !== "community" && <FeedbackWidget />}
    </div>
  );
}
