/**
 * Studypup Cloud Functions — server-side recording → notes pipeline (Path B).
 *
 * When the app uploads a long recording to `recordings/{uid}/{jobId}.m4a`
 * (see lib/recording-pipeline.ts → processRemoteJob), this trigger transcribes
 * it with OpenAI Whisper (chunking large files), generates a structured note
 * with the SAME prompt the on-device path uses, and writes it to Firestore at
 * `professionals/{uid}/notes/{jobId}`. The app's onSnapshot listener then turns
 * that into a finished note and clears the "Processing…" card automatically.
 *
 * The note `id` is the `jobId` so the server write maps cleanly onto the client
 * job (idempotent — a duplicate finalize won't regenerate an existing note).
 */
import { onObjectFinalized } from 'firebase-functions/v2/storage';
import { defineSecret } from 'firebase-functions/params';
import * as logger from 'firebase-functions/logger';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import OpenAI from 'openai';
import { createReadStream, promises as fs, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import ffmpegPath from 'ffmpeg-static';

initializeApp();

const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY');

// Whisper caps uploads at 25 MB; stay safely under and split anything larger.
const MAX_WHISPER_BYTES = 24 * 1024 * 1024;
const SEGMENT_SECONDS = 600; // ~10 min chunks when we must split

// Mirror the on-device pipeline so server- and on-device-generated notes match.
const TRANSCRIBE_MODEL = 'gpt-4o-transcribe';
const TRANSCRIBE_PROMPT =
  'When multiple speakers are present, label each turn as "Speaker 1:", "Speaker 2:", "Speaker 3:", etc. on its own line before the spoken text.';
const NOTE_MODEL = 'gpt-4o-mini';

type StorageBucket = ReturnType<ReturnType<typeof getStorage>['bucket']>;

interface GeneratedNote {
  title: string;
  subtitle: string;
  overview: Array<{ bold?: string; text: string }>;
  topicSegments: Array<{ title: string; bullets: string[] }>;
  keyTopics: Array<{ bold?: string; text: string }>;
  actionItems: string[];
  finalReflection: string;
}

// ── Transcription ────────────────────────────────────────────────────────────

async function transcribeFile(openai: OpenAI, path: string): Promise<string> {
  const result = await openai.audio.transcriptions.create({
    file: createReadStream(path),
    model: TRANSCRIBE_MODEL,
    prompt: TRANSCRIBE_PROMPT,
  });
  return result.text ?? '';
}

/** Split an audio file into ~10-min segments using a bundled static ffmpeg. */
function splitAudio(inputPath: string, workDir: string): Promise<string[]> {
  if (!ffmpegPath) return Promise.reject(new Error('ffmpeg binary not available'));
  const pattern = join(workDir, 'chunk_%03d.m4a');
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath as string, [
      '-y',
      '-i', inputPath,
      '-f', 'segment',
      '-segment_time', String(SEGMENT_SECONDS),
      '-reset_timestamps', '1',
      '-c', 'copy',
      pattern,
    ]);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', async (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
        return;
      }
      try {
        const files = (await fs.readdir(workDir))
          .filter((f) => /^chunk_\d+\.m4a$/.test(f))
          .sort()
          .map((f) => join(workDir, f));
        resolve(files);
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function transcribe(openai: OpenAI, inputPath: string, workDir: string): Promise<string> {
  const size = statSync(inputPath).size;
  if (size <= MAX_WHISPER_BYTES) {
    return (await transcribeFile(openai, inputPath)).trim();
  }
  logger.info(`Audio is ${size} bytes — splitting into ${SEGMENT_SECONDS}s chunks`);
  const chunks = await splitAudio(inputPath, workDir);
  if (!chunks.length) throw new Error('Audio split produced no chunks');
  const parts: string[] = [];
  for (const chunk of chunks) {
    parts.push((await transcribeFile(openai, chunk)).trim());
  }
  return parts.filter(Boolean).join('\n\n');
}

// ── Note generation (same prompt as lib/recording-pipeline.ts) ───────────────

async function generateNote(openai: OpenAI, transcript: string): Promise<GeneratedNote> {
  const completion = await openai.chat.completions.create({
    model: NOTE_MODEL,
    temperature: 0.7,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You are an expert meeting intelligence AI. Return only valid JSON — no markdown, no code fences.',
      },
      {
        role: 'user',
        content: `Analyze this meeting transcript and return a JSON object with this exact shape:
{
  "title": "Meeting topic in 2-4 words",
  "subtitle": "One sentence describing the meeting and its main outcome",
  "overview": [
    { "bold": "Meeting Type", "text": "e.g. team standup, client call, strategy session, 1-on-1" },
    { "bold": "Core Objective", "text": "what the meeting was trying to accomplish" },
    { "bold": "Key Outcome", "text": "the main decision, result, or conclusion reached" }
  ],
  "topicSegments": [
    {
      "title": "Chapter name capturing this segment's theme (e.g. 'Q3 Budget Review', 'Hiring Plan', 'Product Roadmap')",
      "bullets": [
        "Key fact, decision, or data point from this segment",
        "Another important point discussed here",
        "Any conclusion or next step resolved in this segment"
      ]
    }
  ],
  "keyTopics": [
    { "bold": "Topic", "text": "why it matters and what was said about it" }
  ],
  "actionItems": [
    "Alice: Send the revised proposal to stakeholders (by Thursday)",
    "Bob: Book the venue for the offsite (within 2 weeks)",
    "Team: Complete sprint review before Monday standup"
  ],
  "finalReflection": "A 2-3 sentence summary of the meeting's significance and what to watch for going forward."
}

Rules:
- topicSegments: Break the meeting into 2-6 logical chapters IN THE ORDER they occurred. Each chapter needs 2-4 bullet points capturing the key facts, data, or decisions from that segment. Do not skip any meaningful topic covered.
- actionItems: Capture EVERY commitment or next step mentioned. Format each as "[Who]: [What] ([by when if stated])". Use a role or "Team" if no specific person was named. Omit the deadline clause if none was mentioned. Include at least one item if any work was referenced.
- overview: Exactly 3 bullets — meeting type, objective, and outcome.
- keyTopics: 3-6 topics explaining why each matters in context of this meeting.

Transcript:
${transcript.slice(0, 12000)}`,
      },
    ],
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error('No response content from OpenAI');
  return JSON.parse(content) as GeneratedNote;
}

// ── Storage download URL ─────────────────────────────────────────────────────

/**
 * Mint a Firebase Storage download URL for the audio. Uses a download token
 * (the same mechanism `getDownloadURL()` returns) so the URL works regardless
 * of the read-deny security rule on `recordings/`.
 */
async function makeDownloadUrl(bucket: StorageBucket, objectName: string): Promise<string> {
  const token = randomUUID();
  await bucket.file(objectName).setMetadata({
    metadata: { firebaseStorageDownloadTokens: token },
  });
  const encoded = encodeURIComponent(objectName);
  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encoded}?alt=media&token=${token}`;
}

// ── Trigger ──────────────────────────────────────────────────────────────────

export const processRecording = onObjectFinalized(
  {
    bucket: 'studypup-b3973.firebasestorage.app',
    region: 'us-east1',
    timeoutSeconds: 540,
    memory: '1GiB',
    secrets: [OPENAI_API_KEY],
  },
  async (event) => {
    const objectName = event.data.name; // recordings/{uid}/{jobId}.m4a
    if (!objectName || !objectName.startsWith('recordings/')) return;

    const parts = objectName.split('/');
    if (parts.length !== 3) {
      logger.warn(`Unexpected recordings path, ignoring: ${objectName}`);
      return;
    }
    const uid = parts[1];
    const jobId = parts[2].replace(/\.[^.]+$/, '');

    const db = getFirestore();
    const noteRef = db.doc(`professionals/${uid}/notes/${jobId}`);
    const errorRef = db.doc(`professionals/${uid}/recordingJobErrors/${jobId}`);

    // Idempotency: a duplicate finalize must not regenerate an existing note.
    if ((await noteRef.get()).exists) {
      logger.info(`Note ${jobId} already exists — skipping`);
      return;
    }

    const bucket = getStorage().bucket(event.data.bucket);
    const workDir = join(tmpdir(), jobId);
    const inputPath = join(workDir, 'input.m4a');

    try {
      await fs.mkdir(workDir, { recursive: true });
      await bucket.file(objectName).download({ destination: inputPath });

      const openai = new OpenAI({ apiKey: OPENAI_API_KEY.value() });

      const transcript = await transcribe(openai, inputPath, workDir);
      if (!transcript.trim()) throw new Error('Transcription returned no text.');

      const note = await generateNote(openai, transcript);
      const audioUri = await makeDownloadUrl(bucket, objectName);

      // Use the recording's original timestamp (set as upload metadata) so it
      // sorts correctly alongside on-device notes; fall back to now.
      const createdAt = Number(event.data.metadata?.createdAt) || Date.now();
      const now = Date.now();

      await noteRef.set({
        ...note,
        id: jobId,
        transcript,
        audioUri,
        createdAt,
        updatedAt: now,
      });
      // Clear any stale error from a prior failed attempt.
      await errorRef.delete().catch(() => {});
      logger.info(`Wrote note ${jobId} for ${uid}`);
    } catch (e: any) {
      logger.error(`Failed to process ${objectName}`, e);
      // Surface a retryable failure to the client (see startRecordingErrorsSync).
      await errorRef.set({
        id: jobId,
        status: 'failed',
        message: e?.message ?? 'Could not process recording on the server.',
        updatedAt: Date.now(),
      });
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
);
