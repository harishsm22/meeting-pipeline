// Meeting Pipeline — Cloudflare Worker
// Flow: /upload (audio) -> R2 + ElevenLabs Scribe (async, diarized)
//       /webhook/elevenlabs (transcript) -> raw transcript committed to GitHub,
//       where a Claude Code GitHub Action writes the polished note and
//       maintains the org context files.

import RECORDER_HTML from "./recorder.html";

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
      if (request.method === "GET" && path === "/calendar") return await handleCalendar(request, env);
      if (request.method === "POST" && path === "/calendar-push") return await handleCalendarPush(request, env);
      if (request.method === "POST" && path === "/retry") return await handleRetry(request, env, ctx);
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: e.message || String(e) }, 500);
    }
  },

  // Cron sweeper: re-runs jobs stuck in enhancing/committing for >10 min
  async scheduled(event, env, ctx) {
    const list = await env.AUDIO.list({ prefix: "jobs/", limit: 200 });
    const now = Date.now();
    for (const item of list.objects) {
      const obj = await env.AUDIO.get(item.key);
      if (!obj) continue;
      const job = JSON.parse(await obj.text());
      if (!["enhancing", "committing"].includes(job.status)) continue;
      const age = now - Date.parse(job.updated_at || job.created_at || 0);
      if (isNaN(age) || age < 10 * 60e3) continue;
      if ((job.auto_retries || 0) >= 3) {
        job.status = "failed";
        job.error = "Stuck after 3 automatic retries — press retry to try again";
        await saveJob(env, job);
        continue;
      }
      const t = await env.AUDIO.get(`transcripts/${job.id}.json`);
      if (!t) continue;
      job.auto_retries = (job.auto_retries || 0) + 1;
      await saveJob(env, job);
      ctx.waitUntil(processTranscript(env, job, JSON.parse(await t.text())));
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

  // Acknowledge immediately; do the slow work in the background.
  ctx.waitUntil(processTranscript(env, job, transcription));
  return json({ ok: true });
}

async function processTranscript(env, job, transcription) {
  try {
    await env.AUDIO.put(`transcripts/${job.id}.json`, JSON.stringify(transcription));
    job.status = "committing";
    await saveJob(env, job);

    const segments = buildSegments(transcription);
    if (!segments || segments.trim().length < 20) {
      throw new Error("Empty recording — no speech detected in the audio");
    }

    // Commit the raw transcript; the Claude Code GitHub Action in the
    // notes repo picks it up, writes the polished note at note_path,
    // and updates the context files.
    const d = new Date(job.recorded_at);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const notePath = `meetings/${yyyy}/${mm}/${yyyy}-${mm}-${dd}-${slug(job.title)}-${job.id}.md`;

    const raw = {
      job_id: job.id,
      title: job.title,
      attendees: job.attendees,
      recorded_at: job.recorded_at,
      note_path: notePath,
      transcript: segments,
    };
    await ghPut(env, `raw/${job.id}.json`, JSON.stringify(raw, null, 2), `Add raw transcript: ${job.title}`);

    job.status = "done";
    job.github_path = notePath;
    job.github_url = `https://github.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/blob/main/${notePath}`;
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

// ---------- GitHub commit ----------

async function ghPut(env, path, content, message) {
  const base = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;
  const headers = {
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    accept: "application/vnd.github+json",
    "user-agent": "meeting-pipeline-worker",
  };
  // If the file already exists (e.g. a retry), we must send its sha
  let sha;
  const existing = await fetch(base, { headers });
  if (existing.ok) sha = (await existing.json()).sha;
  const r = await fetch(base, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ message, content: b64(content), ...(sha ? { sha } : {}) }),
  });
  if (!r.ok) throw new Error(`GitHub error ${r.status}: ${(await r.text()).slice(0, 500)}`);
  return path;
}

// ---------- jobs ----------

async function saveJob(env, job) {
  job.updated_at = new Date().toISOString();
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

// Re-run a failed job. If we already have the transcript, redo the
// GitHub commit; otherwise resubmit the stored audio to ElevenLabs.
async function handleRetry(request, env, ctx) {
  if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
  const id = new URL(request.url).searchParams.get("id");
  const job = id && (await loadJob(env, id));
  if (!job) return json({ error: "job not found" }, 404);

  const t = await env.AUDIO.get(`transcripts/${job.id}.json`);
  if (t) {
    const transcription = JSON.parse(await t.text());
    job.status = "committing"; job.error = undefined;
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

// ---------- Google Calendar (secret iCal feed) ----------

// Returns events from 4h ago to 14h ahead so you can pick the meeting
// before it starts or right after it ends. Two sources, in priority order:
//   1. GCAL_ICS_URL secret (Google Calendar's "secret iCal address")
//   2. Events pushed by the Google Apps Script (apps-script/Code.gs) to
//      /calendar-push — for workspace accounts where the secret address
//      is disabled by an admin.
async function handleCalendar(request, env) {
  if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
  const from = Date.now() - 4 * 3600e3;
  const to = Date.now() + 14 * 3600e3;
  const events = [];

  if (env.GCAL_ICS_URL) {
    const r = await fetch(env.GCAL_ICS_URL, { cf: { cacheTtl: 300 } });
    if (!r.ok) return json({ error: `calendar fetch failed (${r.status})` }, 502);
    for (const e of parseICS(await r.text())) {
      const start = nextOccurrence(e, from, to);
      if (!start) continue;
      events.push({
        title: e.summary || "Untitled event",
        start: new Date(start).toISOString(),
        attendees: e.attendees.join(", "),
      });
    }
  } else {
    const obj = await env.AUDIO.get("calendar/events.json");
    if (!obj) return json({ enabled: false, events: [] });
    const stored = JSON.parse(await obj.text());
    for (const e of stored.events || []) {
      const t = Date.parse(e.start);
      if (!isNaN(t) && t >= from && t <= to) {
        events.push({ title: e.title || "Untitled event", start: e.start, attendees: e.attendees || "" });
      }
    }
  }

  events.sort((a, b) => a.start.localeCompare(b.start));
  return json({ enabled: true, events: events.slice(0, 25) });
}

// Receives today's events from the Google Apps Script (runs every 15 min)
async function handleCalendarPush(request, env) {
  if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
  const data = await request.json().catch(() => null);
  if (!data || !Array.isArray(data.events)) return json({ error: "events array required" }, 400);
  // Drop meeting-room resources from attendee lists
  const cleaned = data.events.slice(0, 100).map(e => ({
    ...e,
    attendees: (e.attendees || "").split(",").map(s => s.trim())
      .filter(a => a && !a.includes("resource.calendar.google.com")).join(", "),
  }));
  await env.AUDIO.put("calendar/events.json", JSON.stringify({
    updated_at: new Date().toISOString(),
    events: cleaned,
  }));
  return json({ ok: true, count: cleaned.length });
}

function parseICS(ics) {
  // Unfold continuation lines, then walk VEVENT blocks
  const lines = ics.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { cur = { attendees: [], rrule: null }; continue; }
    if (line === "END:VEVENT") { if (cur && cur.start && cur.status !== "CANCELLED") events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const left = line.slice(0, idx), value = line.slice(idx + 1);
    const [prop, ...paramParts] = left.split(";");
    const params = Object.fromEntries(paramParts.map(p => { const i = p.indexOf("="); return [p.slice(0, i), p.slice(i + 1)]; }));
    if (prop === "SUMMARY") cur.summary = value.replace(/\\,/g, ",").replace(/\\n/g, " ");
    else if (prop === "DTSTART") cur.start = parseIcsDate(value, params.TZID);
    else if (prop === "RRULE") cur.rrule = value;
    else if (prop === "STATUS") cur.status = value;
    else if (prop === "ATTENDEE" || prop === "ORGANIZER") {
      const email = value.replace(/^mailto:/i, "").trim();
      const name = (params.CN || "").replace(/^"|"$/g, "");
      if (email.includes("@") && !email.includes("resource.calendar.google.com") && cur.attendees.length < 50) {
        cur.attendees.push(name && !name.includes("@") ? `${name} <${email}>` : email);
      }
    }
  }
  return events;
}

function parseIcsDate(val, tzid) {
  const m = val.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/);
  if (!m) return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0", z] = m;
  const utcGuess = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  if (z || !tzid) return utcGuess;
  return utcGuess - tzOffsetMs(new Date(utcGuess), tzid);
}

function tzOffsetMs(date, tz) {
  try {
    const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    const p = Object.fromEntries(f.formatToParts(date).map(x => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - date.getTime();
  } catch { return 0; }
}

// Handles one-off events plus simple DAILY/WEEKLY recurrences (covers
// standups and weekly syncs). Returns the occurrence time within the
// window, or null.
function nextOccurrence(e, from, to) {
  if (e.start >= from && e.start <= to) return e.start;
  if (!e.rrule || e.start > to) return null;
  const rules = Object.fromEntries(e.rrule.split(";").map(p => p.split("=")));
  const freq = rules.FREQ;
  const interval = (parseInt(rules.INTERVAL) || 1);
  const until = rules.UNTIL ? parseIcsDate(rules.UNTIL, null) : null;
  let stepMs;
  if (freq === "DAILY") stepMs = interval * 86400e3;
  else if (freq === "WEEKLY") stepMs = interval * 7 * 86400e3;
  else return null;
  // Jump close to the window, then walk
  let t = e.start + Math.max(0, Math.floor((from - e.start) / stepMs)) * stepMs;
  for (let i = 0; i < 400 && t <= to; i++) {
    if (t >= from && (!until || t <= until)) {
      if (freq === "WEEKLY" && rules.BYDAY) {
        // For multi-day rules (e.g. MO,WE,FR), check day matches
        const days = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
        const wanted = rules.BYDAY.split(",");
        for (let d = 0; d < 7; d++) {
          const cand = t + d * 86400e3;
          if (cand >= from && cand <= to && wanted.includes(days[new Date(cand).getUTCDay()]) && (!until || cand <= until)) return cand;
        }
      } else {
        return t;
      }
    }
    t += stepMs;
  }
  return null;
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
