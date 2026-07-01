// gtvice6-youtube.js
// Runs every 30 minutes. Most GTA content creators post to YouTube rather
// than stream live on Twitch, so this pulls each curated channel's most
// recent upload instead of checking live status.
//
// Writes into the SAME live_streams table Twitch uses, but only ever
// touches rows where platform='youtube' — never disturbs Twitch's rows.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

// EDIT THIS: the handle/username/custom-slug part of the channel's URL
// (whatever comes after youtube.com/, /c/, /@, or /user/).
// Verify these resolve correctly the first time this runs — check the logs.
const YOUTUBE_CHANNELS = ['MrBossFTW', 'DarkViperAU'];

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function resolveChannel(name) {
  // Try as a modern @handle first
  let res = await fetch(
    `https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails&forHandle=${encodeURIComponent(name)}&key=${YOUTUBE_API_KEY}`
  );
  let data = await res.json();
  if (data.items && data.items.length) return data.items[0];

  // Fall back to legacy username-style channels
  res = await fetch(
    `https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails&forUsername=${encodeURIComponent(name)}&key=${YOUTUBE_API_KEY}`
  );
  data = await res.json();
  if (data.items && data.items.length) return data.items[0];

  return null;
}

async function getLatestVideo(uploadsPlaylistId) {
  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=1&key=${YOUTUBE_API_KEY}`
  );
  const data = await res.json();
  return (data.items && data.items[0]) || null;
}

async function getVideoDetails(videoId) {
  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics&id=${videoId}&key=${YOUTUBE_API_KEY}`
  );
  const data = await res.json();
  return (data.items && data.items[0]) || null;
}

function isoDurationToClock(iso) {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  const h = parseInt(m[1] || '0', 10);
  const min = parseInt(m[2] || '0', 10);
  const s = parseInt(m[3] || '0', 10);
  const totalMin = h * 60 + min;
  return `${totalMin}:${String(s).padStart(2, '0')}`;
}

async function run() {
  const rows = [];

  for (const name of YOUTUBE_CHANNELS) {
    const channel = await resolveChannel(name);
    if (!channel) {
      console.error(`  ✗ Could not resolve channel "${name}" — check the handle/username in YOUTUBE_CHANNELS.`);
      continue;
    }

    const uploadsPlaylistId = channel.contentDetails.relatedPlaylists.uploads;
    const latest = await getLatestVideo(uploadsPlaylistId);
    if (!latest) {
      console.log(`  (no uploads found for "${name}")`);
      continue;
    }

    const videoId = latest.snippet.resourceId.videoId;
    const details = await getVideoDetails(videoId);

    rows.push({
      twitch_login: name,
      display_name: channel.snippet.title,
      title: latest.snippet.title,
      thumbnail_url: latest.snippet.thumbnails?.high?.url || latest.snippet.thumbnails?.default?.url || null,
      is_live: false,
      viewer_count: null,
      duration: details ? isoDurationToClock(details.contentDetails.duration) : null,
      view_count: details ? parseInt(details.statistics.viewCount, 10) : null,
      video_url: `https://www.youtube.com/watch?v=${videoId}`,
      source: 'curated',
      platform: 'youtube',
    });

    console.log(`  ✓ ${channel.snippet.title}: "${latest.snippet.title}"`);
  }

  console.log(`Built ${rows.length} YouTube cards.`);

  // Replace only this platform's rows each run — leaves Twitch's rows untouched
  const { error: deleteError } = await supabase.from('live_streams').delete().eq('platform', 'youtube');
  if (deleteError) throw new Error(`Clearing table failed: ${deleteError.message}`);

  if (rows.length > 0) {
    const { error: insertError } = await supabase.from('live_streams').insert(rows);
    if (insertError) throw new Error(`Insert failed: ${insertError.message}`);
  }

  console.log('Done.');
}

run().catch(err => {
  console.error('YouTube job failed:', err.message);
  process.exit(1);
});
