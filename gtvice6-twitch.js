// gtvice6-twitch.js
// Runs every 5 minutes. Finds GTA 6-relevant live streams two ways —
// a curated creator list (checked first, highest priority) and a
// keyword search across Twitch — then fills any remaining slots with
// recent VODs from the curated creators so the strip is never empty.
// Writes the current snapshot into Supabase's live_streams table.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;

// EDIT THIS: exact Twitch usernames (lowercase, no @) you want prioritized.
// Verify these are correct/active before relying on them — seed list only.
const CURATED_LOGINS = ['sashagrey', 'summit1g', 'xqc', 'jltomy', 'sykkuno', 'pokimane', 'esfandtv', 'edelweisschen'];

const SEARCH_QUERIES = ['GTA 6', 'GTA VI'];
const DESIRED_TOTAL = 8; // how many cards to try to fill the strip with

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function getAppToken() {
  const res = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${TWITCH_CLIENT_ID}&client_secret=${TWITCH_CLIENT_SECRET}&grant_type=client_credentials`,
    { method: 'POST' }
  );
  if (!res.ok) throw new Error(`Twitch token request failed: ${res.status}`);
  const data = await res.json();
  return data.access_token;
}

function authHeaders(token) {
  return { 'Client-Id': TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` };
}

async function getUsersByLogin(token, logins) {
  if (logins.length === 0) return [];
  const qs = logins.map(l => `login=${encodeURIComponent(l)}`).join('&');
  const res = await fetch(`https://api.twitch.tv/helix/users?${qs}`, { headers: authHeaders(token) });
  if (!res.ok) return [];
  const data = await res.json();
  return data.data || [];
}

async function getStreamsByLogin(token, logins) {
  if (logins.length === 0) return [];
  const qs = logins.map(l => `user_login=${encodeURIComponent(l)}`).join('&');
  const res = await fetch(`https://api.twitch.tv/helix/streams?${qs}`, { headers: authHeaders(token) });
  if (!res.ok) return [];
  const data = await res.json();
  return data.data || [];
}

async function searchLiveChannels(token, query) {
  const res = await fetch(
    `https://api.twitch.tv/helix/search/channels?query=${encodeURIComponent(query)}&live_only=true&first=10`,
    { headers: authHeaders(token) }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return data.data || [];
}

async function getLatestVideo(token, userId) {
  const res = await fetch(
    `https://api.twitch.tv/helix/videos?user_id=${userId}&type=archive&first=1`,
    { headers: authHeaders(token) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return (data.data && data.data[0]) || null;
}

function fixThumb(url, w = 320, h = 180) {
  if (!url) return null;
  return url.replace('{width}', w).replace('{height}', h).replace('%{width}', w).replace('%{height}', h);
}

function durationToClock(iso) {
  // Twitch returns duration like "1h23m45s"
  const m = iso.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
  const h = parseInt(m[1] || '0', 10);
  const min = parseInt(m[2] || '0', 10);
  const s = parseInt(m[3] || '0', 10);
  const totalMin = h * 60 + min;
  return `${totalMin}:${String(s).padStart(2, '0')}`;
}

async function run() {
  const token = await getAppToken();
  const rows = [];
  const seenLogins = new Set();

  // 1. Curated list — checked first, highest priority
  const curatedStreams = await getStreamsByLogin(token, CURATED_LOGINS);
  for (const s of curatedStreams) {
    rows.push({
      twitch_login: s.user_login,
      display_name: s.user_name,
      title: s.title,
      thumbnail_url: fixThumb(s.thumbnail_url),
      is_live: true,
      viewer_count: s.viewer_count,
      duration: null,
      view_count: null,
      source: 'curated',
      platform: 'twitch',
    });
    seenLogins.add(s.user_login.toLowerCase());
  }

  // 2. Keyword search — fills in anything curated missed
  for (const q of SEARCH_QUERIES) {
    if (rows.length >= DESIRED_TOTAL) break;
    const found = await searchLiveChannels(token, q);
    for (const c of found) {
      if (rows.length >= DESIRED_TOTAL) break;
      const login = (c.broadcaster_login || '').toLowerCase();
      if (!login || seenLogins.has(login)) continue;
      rows.push({
        twitch_login: c.broadcaster_login,
        display_name: c.display_name,
        title: c.title,
        thumbnail_url: fixThumb(c.thumbnail_url),
        is_live: true,
        viewer_count: null,
        duration: null,
        view_count: null,
        source: 'search',
        platform: 'twitch',
      });
      seenLogins.add(login);
    }
  }

  // 3. Fill remaining slots with recent VODs from curated creators not already live
  if (rows.length < DESIRED_TOTAL) {
    const curatedUsers = await getUsersByLogin(token, CURATED_LOGINS);
    for (const u of curatedUsers) {
      if (rows.length >= DESIRED_TOTAL) break;
      if (seenLogins.has(u.login.toLowerCase())) continue;
      const video = await getLatestVideo(token, u.id);
      if (!video) continue;
      rows.push({
        twitch_login: u.login,
        display_name: u.display_name,
        title: video.title,
        thumbnail_url: fixThumb(video.thumbnail_url),
        is_live: false,
        viewer_count: null,
        duration: durationToClock(video.duration),
        view_count: video.view_count,
        source: 'curated-vod',
        platform: 'twitch',
      });
      seenLogins.add(u.login.toLowerCase());
    }
  }

  console.log(`Built ${rows.length} stream cards (${rows.filter(r => r.is_live).length} live).`);

  // Replace only this platform's rows each run — leaves YouTube's rows untouched
  const { error: deleteError } = await supabase.from('live_streams').delete().eq('platform', 'twitch');
  if (deleteError) throw new Error(`Clearing table failed: ${deleteError.message}`);

  if (rows.length > 0) {
    const { error: insertError } = await supabase.from('live_streams').insert(rows);
    if (insertError) throw new Error(`Insert failed: ${insertError.message}`);
  }

  console.log('Done.');
}

run().catch(err => {
  console.error('Twitch job failed:', err.message);
  process.exit(1);
});
