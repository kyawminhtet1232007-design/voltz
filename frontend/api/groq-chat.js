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
    return res.status(response.ok ? 200 : response.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: "Failed to reach Groq API" });
  }
}
