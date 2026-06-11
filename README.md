# Meeting Pipeline

Record meetings on your phone or laptop → ElevenLabs transcribes with speaker detection → Claude names the speakers, cleans the transcript, and writes a summary with action items → the finished notes are committed to the `meeting-notes` GitHub repo.

```
Phone / laptop recorder (web page) ◄── Google Calendar (picks event, fills attendees)
        │  audio + title + attendees
        ▼
Cloudflare Worker  ──►  R2 storage (audio kept as backup)
        │
        ▼
ElevenLabs Scribe (transcription + who-spoke-when)
        │  webhook
        ▼
Claude (names speakers, cleans transcript, summary, action items)
        │
        ▼
GitHub: meeting-notes/meetings/2026/06/2026-06-11-title.md
```

No servers to maintain. Everything runs on Cloudflare's free tier (the only real costs are ElevenLabs transcription minutes and small Claude API usage).

## Setup (one time, ~20 minutes)

You need four things: a Cloudflare account, an ElevenLabs API key, an Anthropic API key, and a GitHub token. Step by step:

### 1. Get your API keys

1. **ElevenLabs** — sign up at elevenlabs.io → click your profile (bottom left) → **API Keys** → Create. Copy the key.
2. **Anthropic** — sign up at console.anthropic.com → **API Keys** → Create. Copy the key. (Add a small amount of billing credit.)
3. **GitHub token** — github.com → Settings → Developer settings → **Fine-grained personal access tokens** → Generate new token. Repository access: *Only select repositories* → `meeting-notes`. Permissions: **Contents → Read and write**. Copy the token.
4. **Invent an app password** — any random phrase (e.g. from a password generator). This is what you'll type into the recorder app to log in. Called `APP_SECRET` below.

### 2. Deploy on Cloudflare

1. Sign up at dash.cloudflare.com (free).
2. In the left sidebar: **R2 Object Storage** → enable it (free 10 GB) → **Create bucket** → name it exactly `meeting-audio`.
3. Left sidebar: **Workers & Pages** → **Create** → **Import a repository** → connect your GitHub account → pick `meeting-pipeline` → Deploy. Cloudflare will build and deploy automatically (and redeploy whenever the code changes).
4. Open the new worker → **Settings** → **Variables and Secrets** → add these as **Secrets**:
   - `ELEVENLABS_API_KEY`
   - `ANTHROPIC_API_KEY`
   - `GITHUB_TOKEN`
   - `APP_SECRET`
5. Note your worker URL, e.g. `https://meeting-pipeline.YOURNAME.workers.dev`.

### 3. Tell ElevenLabs where to send transcripts

1. In ElevenLabs: profile → **Webhooks** → Create webhook.
2. URL: `https://meeting-pipeline.YOURNAME.workers.dev/webhook/elevenlabs`
3. Auth method: HMAC. Copy the signing secret it gives you, and add it in Cloudflare as another secret named `ELEVENLABS_WEBHOOK_SECRET`.
4. Make sure the webhook is enabled for **Speech to Text** events.

### 4. (Optional) Link Google Calendar

This lets the recorder show today's meetings in a dropdown — picking one auto-fills the title and attendees.

1. Open [Google Calendar settings](https://calendar.google.com/calendar/r/settings) on a computer → click your calendar under **Settings for my calendars** → scroll to **Integrate calendar**.
2. Copy the **Secret address in iCal format** (a long `.ics` URL). Treat it like a password — anyone with it can read your calendar.
3. In Cloudflare, add it as a secret named `GCAL_ICS_URL`.

The dropdown shows events from 4 hours ago to 14 hours ahead. Recurring meetings (daily/weekly) are supported.

### 5. Use it

- Open your worker URL on your phone → enter your `APP_SECRET` once → Share button → **Add to Home Screen**. Now it behaves like an app.
- Tap record at the start of a meeting. **Keep the page open** — the page keeps your screen awake while recording (iPhone web apps can't record with the screen locked).
- For Zoom/Meet calls: record on your laptop (same URL works in any browser), or upload the meeting's audio file using the file picker.
- After uploading, notes appear in `meeting-notes` within a few minutes. The recorder page shows status and links to the finished notes.

## Where things live

- Finished notes: `meeting-notes` repo, organized `meetings/YYYY/MM/`.
- Original audio + raw transcripts: the `meeting-audio` R2 bucket (backup; safe to clean out periodically).
- Failed jobs show a **retry** button in the recorder app.

## Known limits (v1)

- iPhone web recording pauses if the screen locks or you switch apps for a long time. The page holds a screen wake-lock to prevent auto-lock; for true background recording a native TestFlight app is the v2 path.
- Uploads are limited to ~100 MB (Cloudflare free plan) ≈ 3 hours of audio at the recorder's bitrate.
- The transcript quality of speaker *identification* improves a lot when you fill in the attendees field — linking a calendar event does this automatically.
