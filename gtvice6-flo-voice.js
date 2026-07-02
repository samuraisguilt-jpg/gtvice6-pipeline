// GTVice6 — FLO voice segments
// Runs on a schedule. Pulls real content from Supabase (news + live streams),
// writes short in-character lines for FLO via Claude, converts each to real
// audio via ElevenLabs (voice: "FLo"), uploads the mp3s, and upserts them into
// flo_segments so the site's Play button can play FLO actually talking.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

const FLO_VOICE_ID = 'ZT7BZcl8NCLQWrgTQNUD'; // "FLo" — designed in ElevenLabs Voice Design
const ELEVEN_MODEL = 'eleven_multilingual_v2';
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001'; // fast + cheap, plenty for short DJ lines

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Each segment pulls from a different slice of what's already in the database.
// No invented content — FLO only riffs on real scraped stories / real stream data.
const SEGMENT_DEFS = [
  {
    id: 'top_story',
    label: 'Top story',
    style: `Give the real headline like it's breaking news, hype but factual. No "unconfirmed" hedging needed unless the story itself is a rumor. 30-45 words.`,
  },
  {
    id: 'server_spotlight',
    label: 'Server spotlight',
    style: `This is community/private-server gossip. Sell it like insider tea — "yo have you heard over on..." energy — but you MUST make clear this is community chatter, not official news. Never state it as confirmed fact. 30-45 words.`,
  },
  {
    id: 'rumor_control',
    label: 'Rumor control',
    style: `This is a rumor. Be playful about it but explicitly call it a rumor / unconfirmed / "take it with a grain of salt." Never state it as fact. 30-45 words.`,
  },
  {
    id: 'creator_watch',
    label: 'Creator watch',
    style: `Hype up this streamer/creator like you're calling their run live. High energy, like a sports announcer meets radio DJ. 25-40 words.`,
  },
  {
    id: 'quick_hits',
    label: 'Quick hits',
    style: `Rapid-fire "and in other news..." roundup of BOTH stories given below, back to back, high energy, like a DJ blasting through headlines before the next track drops. Keep any rumor clearly labeled as a rumor. 50-70 words total.`,
  },
];

async function fetchSourceStory(category) {
  const { data } = await supabase
    .from('stories')
    .select('title,summary,category')
    .eq('category', category)
    .order('created_at', { ascending: false })
    .limit(1);
  return data && data[0] ? data[0] : null;
}

async function fetchSourceStoryAny(categories) {
  const { data } = await supabase
    .from('stories')
    .select('title,summary,category')
    .in('category', categories)
    .order('created_at', { ascending: false })
    .limit(1);
  return data && data[0] ? data[0] : null;
}

async function fetchLatestStories(limit) {
  const { data } = await supabase
    .from('stories')
    .select('title,summary,category')
    .order('created_at', { ascending: false })
    .limit(limit);
  return data || [];
}

async function fetchTopCreator() {
  const { data } = await supabase
    .from('live_streams')
    .select('title,display_name,twitch_login,is_live,viewer_count')
    .order('is_live', { ascending: false })
    .order('viewer_count', { ascending: false })
    .limit(1);
  return data && data[0] ? data[0] : null;
}

async function writeLine(segmentDef, sourceText) {
  const system = `You are writing spoken lines for "FLO", the AI DJ/news anchor character on GTVice6, a GTA6 fan community site. FLO's voice: hype Miami radio DJ energy, confident, funny, a little sarcastic, blunt jokes, but ultimately friendly — the guy who always knows the tea. Follow the word count given in the instruction. Write ONLY the line he'd say out loud. No stage directions, no quotation marks, no emoji, no hashtags. It must be speakable text only.`;
  const user = `Segment type: ${segmentDef.label}\nInstruction: ${segmentDef.style}\n\nSource content to riff on:\n${sourceText}\n\nWrite FLO's line now.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 200,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.content.find(b => b.type === 'text')?.text?.trim();
  if (!text) throw new Error('No text returned by Claude');
  return text;
}

async function synthesize(text) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${FLO_VOICE_ID}`, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      text,
      model_id: ELEVEN_MODEL,
      voice_settings: { stability: 0.5, similarity_boost: 0.8 },
    }),
  });
  if (!res.ok) throw new Error(`ElevenLabs API error ${res.status}: ${await res.text()}`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function run() {
  console.log(`Building ${SEGMENT_DEFS.length} FLO segments...`);

  for (const def of SEGMENT_DEFS) {
    try {
      let sourceText = null;

      if (def.id === 'top_story') {
        const s = await fetchSourceStory('official');
        if (s) sourceText = `${s.title} — ${s.summary}`;
      } else if (def.id === 'server_spotlight') {
        const s = await fetchSourceStoryAny(['servers', 'community']);
        if (s) sourceText = `${s.title} — ${s.summary}`;
      } else if (def.id === 'rumor_control') {
        const s = await fetchSourceStory('rumor');
        if (s) sourceText = `${s.title} — ${s.summary}`;
      } else if (def.id === 'creator_watch') {
        const c = await fetchTopCreator();
        if (c) sourceText = c.is_live
          ? `${c.display_name || c.twitch_login} is live right now: "${c.title}"`
          : `${c.display_name || c.twitch_login} recently posted: "${c.title}"`;
      } else if (def.id === 'quick_hits') {
        const latest = await fetchLatestStories(5);
        const picks = latest.slice(2, 4); // skip the freshest ones already used elsewhere, grab the next 2
        if (picks.length) {
          sourceText = picks
            .map((s, idx) => `Story ${idx + 1} (category: ${s.category}): ${s.title} — ${s.summary}`)
            .join('\n');
        }
      }

      if (!sourceText) {
        console.log(`- Skipping "${def.label}": no source content in the database yet.`);
        continue;
      }

      console.log(`Writing line for "${def.label}"...`);
      const line = await writeLine(def, sourceText);
      console.log(`  "${line}"`);

      console.log(`  Generating audio...`);
      const mp3 = await synthesize(line);

      const path = `${def.id}.mp3`; // fixed filename per segment — always overwrites with the latest
      const { error: upErr } = await supabase.storage
        .from('flo-audio')
        .upload(path, mp3, { contentType: 'audio/mpeg', upsert: true });
      if (upErr) throw new Error(`Storage upload failed: ${upErr.message}`);

      const { data: pub } = supabase.storage.from('flo-audio').getPublicUrl(path);
      const audio_url = `${pub.publicUrl}?t=${Date.now()}`; // cache-bust so browsers fetch the new file

      const { error: dbErr } = await supabase
        .from('flo_segments')
        .upsert({ id: def.id, label: def.label, text: line, audio_url, updated_at: new Date().toISOString() });
      if (dbErr) throw new Error(`DB upsert failed: ${dbErr.message}`);

      console.log(`  ✓ ${def.id} done.`);
    } catch (e) {
      console.log(`  ✗ Failed for "${def.label}": ${e.message}`);
    }
  }

  console.log('Done.');
}

run();
