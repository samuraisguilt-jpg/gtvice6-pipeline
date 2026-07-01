/**
 * GTVice6 News Pipeline
 * ─────────────────────
 * Runs on a schedule (cron job, GitHub Actions, or Supabase Edge Function).
 * Pulls RSS feeds + YouTube → summarizes with Claude API → writes to Supabase.
 *
 * SETUP (one time):
 *   npm install @supabase/supabase-js @anthropic-ai/sdk rss-parser
 *
 * RUN MANUALLY:
 *   node gtvice6-pipeline.js
 *
 * RUN ON A SCHEDULE (GitHub Actions — free, see bottom of this file):
 *   Push this file + package.json to a GitHub repo and add the workflow file.
 */

import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import Parser from 'rss-parser';

/* ══════════════════════════════════════════════════════
   CONFIG — replace these with your real values
   (store them as environment variables, never hardcode)
   ══════════════════════════════════════════════════════ */
const SUPABASE_URL     = process.env.SUPABASE_URL     || 'https://vbcysigsmsluesewwzfa.supabase.co';
const SUPABASE_KEY     = process.env.SUPABASE_SERVICE_KEY;  // use SERVICE key here (server-side only)
const ANTHROPIC_KEY    = process.env.ANTHROPIC_API_KEY;
const YOUTUBE_API_KEY  = process.env.YOUTUBE_API_KEY;       // optional, for streamer clips

/* ══════════════════════════════════════════════════════
   RSS SOURCES
   Add / remove feeds here anytime. Format:
   { url, name, defaultCategory }
   Categories: official | rumor | streamer | servers | community
   ══════════════════════════════════════════════════════ */
const RSS_SOURCES = [
  // Gaming news outlets
  { url: 'https://www.ign.com/articles.rss',                   name: 'IGN',          cat: 'official'   },
  { url: 'https://www.gamespot.com/feeds/news',                name: 'GameSpot',     cat: 'official'   },
  { url: 'https://kotaku.com/rss',                             name: 'Kotaku',       cat: 'community'  },
  { url: 'https://www.eurogamer.net/?format=rss',              name: 'Eurogamer',    cat: 'official'   },
  { url: 'https://www.polygon.com/rss/index.xml',              name: 'Polygon',      cat: 'community'  },
  { url: 'https://rock-paper-shotgun.com/feed',                name: 'RPS',          cat: 'community'  },
  { url: 'https://www.pushsquare.com/feeds/latest',            name: 'Push Square',  cat: 'official'   },
  { url: 'https://www.vg247.com/feed',                         name: 'VG247',        cat: 'community'  },
  // GTA-specific communities
  { url: 'https://www.reddit.com/r/GTA6/.rss',                 name: 'r/GTA6',       cat: 'community'  },
  { url: 'https://www.reddit.com/r/GTA6Hype/.rss',             name: 'r/GTA6Hype',  cat: 'community'  },
  { url: 'https://www.reddit.com/r/GrandTheftAutoV/.rss',      name: 'r/GTAV',       cat: 'servers'    },
];

/* ══════════════════════════════════════════════════════
   KEYWORDS — only process articles about GTA 6
   ══════════════════════════════════════════════════════ */
const KEYWORDS = [
  'gta 6','gta vi','grand theft auto 6','grand theft auto vi',
  'gta6','gtavi','rockstar games','vice city','leonida',
  'jason','lucia','gta online','pre-order gta','gta preorder'
];

function isRelevant(text='') {
  const t = text.toLowerCase();
  return KEYWORDS.some(k => t.includes(k));
}

/* ══════════════════════════════════════════════════════
   CATEGORY DETECTION
   ══════════════════════════════════════════════════════ */
function detectCategory(text='', defaultCat='community') {
  const t = text.toLowerCase();
  if (t.includes('leak') || t.includes('rumor') || t.includes('allegedly') || t.includes('reportedly')) return 'rumor';
  if (t.includes('streamer') || t.includes('youtube') || t.includes('twitch') || t.includes('stream')) return 'streamer';
  if (t.includes('server') || t.includes('roleplay') || t.includes('fivem') || t.includes('rp')) return 'servers';
  if (t.includes('official') || t.includes('rockstar') || t.includes('confirmed') || t.includes('announce')) return 'official';
  return defaultCat;
}

/* ══════════════════════════════════════════════════════
   MAIN PIPELINE
   ══════════════════════════════════════════════════════ */
async function run() {
  if (!SUPABASE_KEY) { console.error('Missing SUPABASE_SERVICE_KEY env var'); process.exit(1); }
  if (!ANTHROPIC_KEY) { console.error('Missing ANTHROPIC_API_KEY env var'); process.exit(1); }

  const db     = createClient(SUPABASE_URL, SUPABASE_KEY);
  const ai     = new Anthropic({ apiKey: ANTHROPIC_KEY });
  const parser = new Parser({ timeout: 10000 });

  // Fetch recently published URLs already in DB (avoid duplicates)
  const { data: existing } = await db
    .from('stories')
    .select('source_url')
    .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
  const seen = new Set((existing || []).map(r => r.source_url));

  let added = 0;

  for (const source of RSS_SOURCES) {
    try {
      console.log(`Fetching ${source.name}...`);
      const feed = await parser.parseURL(source.url);
      const cutoff = Date.now() - 24 * 60 * 60 * 1000; // last 24h only

      for (const item of feed.items) {
        const pub = new Date(item.pubDate || item.isoDate || Date.now()).getTime();
        if (pub < cutoff) continue;

        const fullText = `${item.title || ''} ${item.contentSnippet || item.content || ''}`;
        if (!isRelevant(fullText)) continue;
        if (seen.has(item.link)) continue;
        seen.add(item.link);

        // Summarize with Claude
        let summary = '';
        let category = detectCategory(fullText, source.cat);
        let isRumor = category === 'rumor';

        try {
          const msg = await ai.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 120,
            messages: [{
              role: 'user',
              content: `You are the GTVice6 news desk. Write a punchy 1-2 sentence news summary (max 160 chars) of this article for a GTA 6 fan community site. Credit the source. Be factual. If it's a rumor or leak, start with "RUMOR:". Article: "${item.title}". Snippet: "${(item.contentSnippet || '').slice(0, 400)}"`
            }]
          });
          summary = msg.content[0]?.text?.trim() || item.contentSnippet?.slice(0, 160) || '';
        } catch (e) {
          summary = (item.contentSnippet || item.title || '').slice(0, 160);
        }

        if (summary.toUpperCase().startsWith('RUMOR')) isRumor = true;

        const { error } = await db.from('stories').insert({
          title:        (item.title || '').slice(0, 200),
          summary:      summary.slice(0, 500),
          category,
          source_name:  source.name,
          source_url:   item.link || source.url,
          is_rumor:     isRumor,
          is_live:      false,
          published_at: new Date(item.pubDate || item.isoDate || Date.now()).toISOString()
        });

        if (!error) {
          added++;
          console.log(`  ✓ [${category}] ${item.title?.slice(0, 60)}`);
        } else {
          console.error(`  ✗ ${error.message}`);
        }

        // Rate limit: don't hammer Claude
        await new Promise(r => setTimeout(r, 400));
      }
    } catch (e) {
      console.error(`Failed ${source.name}: ${e.message}`);
    }
  }

  // Clean up stories older than 14 days
  await db.from('stories')
    .delete()
    .lt('published_at', new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString());

  console.log(`\nDone. Added ${added} new stories.`);
}

run().catch(console.error);

/*
════════════════════════════════════════════════════════
  GITHUB ACTIONS WORKFLOW (free, runs every 30 minutes)
  Save as: .github/workflows/pipeline.yml
════════════════════════════════════════════════════════

name: GTVice6 News Pipeline
on:
  schedule:
    - cron: '*/30 * * * *'   # every 30 minutes
  workflow_dispatch:           # manual run button in GitHub

jobs:
  run-pipeline:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm install
      - run: node gtvice6-pipeline.js
        env:
          SUPABASE_URL:          ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_KEY:  ${{ secrets.SUPABASE_SERVICE_KEY }}
          ANTHROPIC_API_KEY:     ${{ secrets.ANTHROPIC_API_KEY }}

  (Add these 3 secrets in GitHub repo → Settings → Secrets → Actions)
════════════════════════════════════════════════════════
*/
