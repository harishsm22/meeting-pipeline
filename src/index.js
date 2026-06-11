// Meeting Pipeline — Cloudflare Worker
// Flow: /upload (audio) -> R2 + ElevenLabs Scribe (async, diarized)
//       /webhook/elevenlabs (transcript) -> Claude (speaker naming + enhancement) -> GitHub commit

import RECORDER_HTML from "./recorder.html";

const ANTHROPIC_VERSION = "2023-06-01";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (request.method === "GET" && path === "/") {
        return new Response(RECORDER_HTML, { headers: { "content-type": "text/html;charset=utf-8" } });
      }
      if (request.method === "POST" && path === "/upload") return await handleUpload(request, env);
      if (request.method === "POST" && path === "/webhook/elevenlabs") return await handleWebhook(request, env, ctx);
      if (request.method === "GET" && path === "/jobs") return await listJobs(request, env);
      if (request.method === "POST" && path === "/retry") return await handleRetry(request, env, ctx);
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: e.message || String(e) }, 500);
    }
  },
};

// ---------- auth ----------

function authorized(request, env) {
  const h = request.headers.get("authorization") || "";
  return env.APP_SECRET && h === `Bearer ${env.APP_SECRET}`;
}

// ---------- upload ----------

async function handleUpload(request, env) {
  if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);

  const form = await request.formData();
  const file = form.get("file");
  if (!file || typeof file === "string") return json({ error: "no audio file" }, 400);

  const id = crypto.randomUUID().slice(0, 8);
  const title = (form.get("title") || "Untitled meeting").toString().trim();
  const attendees = (form.get("attendees") || "").toString().trim();
  const recordedAt = (form.get("recorded_at") || new Date().toISOString()).toString();
  const ext = extFor(file.type, file.name);
  const audioKey = `audio/${id}.${ext}`;

  const bytes = await file.arrayBuffer();
  await env.AUDIO.put(audioKey, bytes, {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
  });

  const job = {
    id, title, attendees,
    recorded_at: recordedAt,
    created_at: new Date().toISOString(),
    status: "transcribing",
    audio_key: audioKey,
  };
  await saveJob(env, job);

  const err = await submitToElevenLabs(env, job, bytes, file.type, ext);
  if (err) {
    job.status = "failed"; job.error = err;
    await saveJob(env, job);
    return json({ error: err }, 502);
  }
  await saveJob(env, job);
  return json({ job_id: id, status: "transcribing" });
}

async function submitToElevenLabs(env, job, bytes, mimeType, ext) {
  const fd = new FormData();
  fd.append("model_id", "scribe_v2");
  fd.append("file", new File([bytes], `meeting.${ext}`, { type: mimeType || "audio/mpeg" }));
  fd.append("diarize", "true");
  fd.append("tag_audio_events", "false");
  fd.append("webhook", "true");
  fd.append("webhook_metadata", JSON.stringify({ job_id: job.id }));

  const r = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY },
    body: fd,
  });
  if (!r.ok) return `ElevenLabs error ${r.status}: ${(await r.text()).slice(0, 500)}`;
  const data = await r.json().catch(() => ({}));
  if (data.request_id) {
    job.request_id = data.request_id;
    await env.AUDIO.put(`reqmap/${data.request_id}`, job.id);
  }
  return null;
}

// ---------- ElevenLabs webhook ----------

async function handleWebhook(request, env, ctx) {
  const body = await request.text();

  if (env.ELEVENLABS_WEBHOOK_SECRET) {
    const sig = request.headers.get("elevenlabs-signature") || "";
    const ok = await verifySignature(body, sig, env.ELEVENLABS_WEBHOOK_SECRET);
    if (!ok) return json({ error: "bad signature" }, 401);
  }

  const payload = JSON.parse(body);
  const data = payload.data || payload;
  const transcription = data.transcription || data;

  let jobId = null;
  const meta = data.webhook_metadata ?? payload.webhook_metadata;
  if (meta) {
    try { jobId = (typeof meta === "string" ? JSON.parse(meta) : meta).job_id; } catch {}
  }
  if (!jobId && data.request_id) {
    const mapped = await env.AUDIO.get(`reqmap/${data.request_id}`);
    if (mapped) jobId = await mapped.text();
  }
  if (!jobId) return json({ ok: true, warning: "no job_id in webhook" });

  const job = await loadJob(env, jobId);
  if (!job) return json({ ok: true, warning: "unknown job" });

  // Acknowledge immediately; do the slow work (Claude + GitHub) in the background.
  ctx.waitUntil(processTranscript(env, job, transcription));
  return json({ ok: true });
}

async function processTranscript(env, job, transcription) {
  try {
    await env.AUDIO.put(`transcripts/${job.id}.json`, JSON.stringify(transcription));
    job.status = "enhancing";
    await saveJob(env, job);

    const segments = buildSegments(transcription);
    const enhanced = await enhanceWithClaude(env, job, segments);

    job.status = "committing";
    await saveJob(env, job);

    const ghPath = await commitToGitHub(env, job, enhanced);
    job.status = "done";
    job.github_path = ghPath;
    job.github_url = `https://github.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/blob/main/${ghPath}`;
    await saveJob(env, job);
  } catch (e) {
    job.status = "failed";
    job.error = (e.message || String(e)).slice(0, 1000);
    await saveJob(env, job);
  }
}

// Turn word-level diarized output into "speaker_0: ..." lines
function buildSegments(transcription) {
  const words = transcription.words;
  if (!Array.isArray(words) || words.length === 0) {
    return transcription.text || "";
  }
  const lines = [];
  let speaker = null, parts = [];
  for (const w of words) {
    if (w.type && w.type !== "word") continue;
    const sp = w.speaker_id || "speaker_0";
    if (sp !== speaker) {
      if (parts.length) lines.push(`${speaker}: ${parts.join(" ")}`);
      speaker = sp; parts = [];
    }
    parts.push(w.text);
  }
  if (parts.length) lines.push(`${speaker}: ${parts.join(" ")}`);
  return lines.join("\n\n");
}

// ---------- Claude enhancement ----------

async function enhanceWithClaude(env, job, segments) {
  const system = `You convert raw diarized meeting transcripts into polished meeting notes.
The transcript labels speakers as speaker_0, speaker_1, etc. Your tasks:
1. Identify who each speaker is, using the attendee list, how people address each other, self-introductions, and context. The recorder/organizer is usually "${env.OWNER_NAME || "the organizer"}". If you cannot identify a speaker confidently, keep them as "Speaker N (unidentified)".
2. Produce clean meeting notes in this exact structure (markdown, no preamble, no code fences):

## Summary
(3-6 sentences)

## Participants
(bullet list: name — speaker label you mapped them from, and a confidence note if unsure)

## Key decisions
(bullet list; write "None recorded" if none)

## Action items
(bullet list as "Owner — action"; write "None recorded" if none)

## Transcript
(the full conversation with real names as bold speaker labels, cleaned up: remove filler words and false starts, fix obvious transcription errors, merge fragmented sentences. Do NOT summarize or drop content — keep every substantive statement.)`;

  const user = `Meeting title: ${job.title}
Recorded at: ${job.recorded_at}
Attendees (per organizer, may be incomplete): ${job.attendees || "not provided"}

Diarized transcript:

${segments}`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.CLAUDE_MODEL || "claude-sonnet-4-6",
      max_tokens: 32000,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!r.ok) throw new Error(`Claude error ${r.status}: ${(await r.text()).slice(0, 500)}`);
  const data = await r.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
  if (!text) throw new Error("Claude returned no text");
  return text;
}

// ---------- GitHub commit ----------

async function commitToGitHub(env, job, markdownBody) {
  const d = new Date(job.recorded_at);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const path = `meetings/${yyyy}/${mm}/${yyyy}-${mm}-${dd}-${slug(job.title)}-${job.id}.md`;

  const md = `---
title: "${job.title.replace(/"/g, "'")}"
date: ${job.recorded_at}
attendees: "${(job.attendees || "").replace(/"/g, "'")}"
job_id: ${job.id}
---

${markdownBody}
`;

  const r = await fetch(
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: "application/vnd.github+json",
        "user-agent": "meeting-pipeline-worker",
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: `Add meeting notes: ${job.title}`, content: b64(md) }),
    }
  );
  if (!r.ok) throw new Error(`GitHub error ${r.status}: ${(await r.text()).slice(0, 500)}`);
  return path;
}

// ---------- jobs ----------

async function saveJob(env, job) {
  await env.AUDIO.put(`jobs/${job.id}.json`, JSON.stringify(job));
}

async function loadJob(env, id) {
  const obj = await env.AUDIO.get(`jobs/${id}.json`);
  return obj ? JSON.parse(await obj.text()) : null;
}

async function listJobs(request, env) {
  if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
  const list = await env.AUDIO.list({ prefix: "jobs/", limit: 200 });
  const jobs = [];
  for (const item of list.objects) {
    const obj = await env.AUDIO.get(item.key);
    if (obj) jobs.push(JSON.parse(await obj.text()));
  }
  jobs.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  return json({ jobs: jobs.slice(0, 50) });
}

// Re-run a failed job. If we already have the transcript, redo Claude+GitHub;
// otherwise resubmit the stored audio to ElevenLabs.
async function handleRetry(request, env, ctx) {
  if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
  const id = new URL(request.url).searchParams.get("id");
  const job = id && (await loadJob(env, id));
  if (!job) return json({ error: "job not found" }, 404);

  const t = await env.AUDIO.get(`transcripts/${job.id}.json`);
  if (t) {
    const transcription = JSON.parse(await t.text());
    job.status = "enhancing"; job.error = undefined;
    await saveJob(env, job);
    ctx.waitUntil(processTranscript(env, job, transcription));
    return json({ ok: true, resumed_from: "transcript" });
  }
  const audio = await env.AUDIO.get(job.audio_key);
  if (!audio) return json({ error: "audio no longer stored" }, 410);
  const bytes = await audio.arrayBuffer();
  const ext = job.audio_key.split(".").pop();
  job.status = "transcribing"; job.error = undefined;
  const err = await submitToElevenLabs(env, job, bytes, audio.httpMetadata?.contentType, ext);
  if (err) { job.status = "failed"; job.error = err; await saveJob(env, job); return json({ error: err }, 502); }
  await saveJob(env, job);
  return json({ ok: true, resumed_from: "audio" });
}

// ---------- helpers ----------

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function extFor(mime, name) {
  const m = (mime || "").toLowerCase();
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
  if (m.includes("webm")) return "webm";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("wav")) return "wav";
  if (m.includes("ogg")) return "ogg";
  const fromName = (name || "").split(".").pop();
  return fromName && fromName.length <= 4 ? fromName.toLowerCase() : "bin";
}

function slug(s) {
  return (s || "meeting").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "meeting";
}

function b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

async function verifySignature(body, sigHeader, secret) {
  try {
    const parts = Object.fromEntries(sigHeader.split(",").map(p => p.trim().split("=")));
    const t = parts.t, v0 = parts.v0;
    if (!t || !v0) return false;
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`));
    const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
    return hex === v0;
  } catch {
    return false;
  }
}
