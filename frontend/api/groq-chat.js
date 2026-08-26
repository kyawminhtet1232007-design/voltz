// Vercel Serverless Function — Groq chat proxy.
// Mirrors backend/index.js's /groq-chat so production needs NO separate Express
// server: the frontend already calls "/api/groq-chat", and on Vercel this file
// answers it. The Groq API key stays server-side (set GROQ_API_KEY in the Vercel
// project env — never a VITE_ var). Local dev still uses the Express backend via
// the vite proxy; this function is the production path.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { messages, max_tokens = 1024, temperature = 0.75 } = req.body || {};
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "messages array required" });
  }
  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({ error: "GROQ_API_KEY not configured on the server" });
  }

  const model = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({ model, messages, max_tokens, temperature }),
    });
    const data = await response.json();
    if (!response.ok) {
      // Never forward the provider's error body to the browser: it contains
      // the org id, model name, token limits and a billing link to OUR
      // account. Log it server-side (visible in Vercel function logs) and
      // return only a status code + generic message the client can map to
      // friendly copy. 429 is preserved so the UI can say "try again shortly".
      console.error("[groq-chat] upstream error", response.status, JSON.stringify(data).slice(0, 500));
      const isRateLimit = response.status === 429;
      return res.status(response.status).json({
        error: isRateLimit ? "rate_limited" : "upstream_error",
      });
    }
    return res.status(200).json(data);
  } catch (err) {
    console.error("[groq-chat] fetch failed", err?.message);
    return res.status(502).json({ error: "upstream_unreachable" });
  }
}
