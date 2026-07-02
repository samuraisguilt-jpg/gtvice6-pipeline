// gtvice6-cover-art.js
// Runs every 12 hours (see cover-art.yml). Finds stories that don't have cover art yet
// and generates a REAL, story-specific GTVice6-style scene for each one
// (not a reusable template) using Gemini image generation.
//
// Only ever generates original characters and original scenes —
// never Rockstar's actual characters, never real people, never
// screenshots of any existing game. Same rule as FLO.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const IMAGE_MODEL = 'gemini-2.5-flash-image'; // stable as of mid-2026 ("Nano Banana")

// How many stories to draw per run. Keeps cost/time bounded per run;
// backlog just gets picked up on the next run.
const BATCH_SIZE = 5;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const STYLE_PREFIX = `Original painterly video-game-style illustration in a retro-futuristic Miami vice-city `
  + `aesthetic — hot pink and cyan neon lighting, glowing skyline at dusk, cinematic composition, `
  + `high detail, dramatic lighting, photorealistic rendering quality. `
  + `Include original human characters relevant to the scene, doing the action described. `
  + `No text, no logos, no watermarks, no real brand names or trademarks. `
  + `These must be entirely original characters and an original scene — `
  + `not likenesses of real people, not any existing copyrighted game's characters, `
  + `not a screenshot or recreation of any existing video game.`;

function buildPrompt(story) {
  const basis = story.summary || story.title;
  return `${STYLE_PREFIX} Depict this scene: ${basis}`;
}

async function pickCandidateStories() {
  const { data, error } = await supabase
    .from('stories')
    .select('id, title, summary, category, created_at')
    .is('cover_image_url', null)
    .order('created_at', { ascending: false })
    .limit(BATCH_SIZE);

  if (error) throw new Error(`Fetching candidates failed: ${error.message}`);
  return data || [];
}

async function generateImage(prompt) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig: { aspectRatio: '16:9' },
        },
      }),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(p => p.inlineData);

  if (!imagePart) throw new Error('No image returned by Gemini.');

  return Buffer.from(imagePart.inlineData.data, 'base64');
}

async function processStory(story) {
  console.log(`Generating cover for: "${story.title}" [${story.category}]`);

  const prompt = buildPrompt(story);
  const imageBuffer = await generateImage(prompt);
  const fileName = `cover-${story.id}.png`;

  const { error: uploadError } = await supabase
    .storage
    .from('story-covers')
    .upload(fileName, imageBuffer, { contentType: 'image/png', upsert: true });

  if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

  const { data: urlData } = supabase
    .storage
    .from('story-covers')
    .getPublicUrl(fileName);

  const { error: updateError } = await supabase
    .from('stories')
    .update({ cover_image_url: urlData.publicUrl })
    .eq('id', story.id);

  if (updateError) throw new Error(`DB update failed: ${updateError.message}`);

  console.log(`  ✓ ${urlData.publicUrl}`);
}

async function run() {
  const stories = await pickCandidateStories();

  if (stories.length === 0) {
    console.log('No stories waiting on cover art. Nothing to do.');
    return;
  }

  console.log(`Found ${stories.length} stories needing cover art.`);

  for (const story of stories) {
    try {
      await processStory(story);
    } catch (e) {
      console.error(`  ✗ Failed for "${story.title}": ${e.message}`);
    }
    // Gentle pacing between image calls
    await new Promise(r => setTimeout(r, 800));
  }

  console.log('Done.');
}

run().catch(err => {
  console.error('Cover art job failed:', err.message);
  process.exit(1);
});
