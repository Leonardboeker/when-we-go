// src/pages/og/[slug].png.ts
// Per-poll Open Graph preview image — what shows up in WhatsApp / iMessage /
// Slack / Twitter when a per-slug URL is shared.
// Pre-rendered at build time for every poll. Output: dist/og/<slug>.png
//
// Implementation: Satori turns a small JSX-ish tree into SVG, Resvg rasterises
// that SVG to a 1200×630 PNG (the canonical OG dimensions). No runtime cost —
// the whole thing is baked into dist/ during `astro build`.
//
// Mirror of pay-me-back's src/pages/og/[token].png.ts, adapted for the
// poll-shaped data + teal-accented palette swap.
import type { APIRoute, GetStaticPaths } from 'astro';
import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { polls } from '../../data/polls';
import { daysUntil } from '../../lib/calendar';

// Font is loaded once at module init — Satori needs raw TTF bytes.
const fontPath = resolve(process.cwd(), 'public/fonts/Inter-ExtraBold.ttf');
const interBold = readFileSync(fontPath);

export const getStaticPaths: GetStaticPaths = () =>
  polls.map((p) => ({ params: { slug: p.slug } }));

export const GET: APIRoute = async ({ params }) => {
  const poll = polls.find((p) => p.slug === params.slug);
  if (!poll) return new Response('Not found', { status: 404 });

  const daysLeft = daysUntil(poll.pollCloseAt);
  const destination = poll.destination ?? poll.title;
  const participants = `${poll.participants.length} people`;
  // Date-range line, e.g. "Jul – Sep 2026"
  const fmtMon = (iso: string) =>
    new Date(iso + 'T00:00:00Z').toLocaleString('en-GB', {
      month: 'short',
      year: 'numeric',
    });
  const startMon = fmtMon(poll.dateRangeStart);
  const endMon = fmtMon(poll.dateRangeEnd);
  const dateLine = startMon === endMon ? startMon : `${startMon} – ${endMon}`;
  const footer =
    daysLeft > 0
      ? `Poll closes in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`
      : 'Poll closed';

  // Compose a 1200×630 OG card — modern Ocean Blue design system.
  // White surface, blue accent bar, clean hierarchy (matches the app UI).
  const svg = await satori(
    {
      type: 'div',
      props: {
        style: {
          width: '1200px',
          height: '630px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '0',
          background: '#f0f4f8',
          fontFamily: 'Inter',
          color: '#0f172a',
        },
        children: [
          // Top accent bar (Ocean Blue → indigo gradient)
          {
            type: 'div',
            props: {
              style: {
                width: '1200px',
                height: '14px',
                background: 'linear-gradient(90deg, #0066cc 0%, #6366f1 100%)',
                display: 'flex',
              },
            },
          },
          // Main white card area
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                flexGrow: 1,
                margin: '40px',
                padding: '56px 64px',
                background: '#ffffff',
                borderRadius: '24px',
                boxShadow: '0 8px 32px rgba(15,23,42,0.10)',
              },
              children: [
                // Brand row
                {
                  type: 'div',
                  props: {
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: '14px',
                      fontSize: '26px',
                      fontWeight: 800,
                      letterSpacing: '0.5px',
                      color: '#0066cc',
                    },
                    children: [
                      {
                        type: 'div',
                        props: {
                          style: {
                            width: '18px',
                            height: '18px',
                            borderRadius: '5px',
                            background: '#0066cc',
                            display: 'flex',
                          },
                        },
                      },
                      'when-we-go',
                    ],
                  },
                },
                // Destination pill + headline + dates
                {
                  type: 'div',
                  props: {
                    style: {
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '18px',
                    },
                    children: [
                      {
                        type: 'div',
                        props: {
                          style: {
                            display: 'flex',
                            alignSelf: 'flex-start',
                            padding: '8px 20px',
                            background: '#cce0ff',
                            color: '#001e42',
                            borderRadius: '999px',
                            fontSize: '28px',
                            fontWeight: 800,
                          },
                          children: destination,
                        },
                      },
                      {
                        type: 'div',
                        props: {
                          style: {
                            fontSize: '76px',
                            lineHeight: 1.02,
                            letterSpacing: '-3px',
                            color: '#0f172a',
                          },
                          children: 'When can you come?',
                        },
                      },
                      {
                        type: 'div',
                        props: {
                          style: {
                            display: 'flex',
                            gap: '18px',
                            fontSize: '30px',
                            color: '#475569',
                          },
                          children: `${dateLine}  ·  ${participants}`,
                        },
                      },
                    ],
                  },
                },
                // Bottom: countdown + tap-to-vote pill
                {
                  type: 'div',
                  props: {
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      fontSize: '26px',
                      color: '#475569',
                    },
                    children: [
                      { type: 'div', props: { children: footer } },
                      {
                        type: 'div',
                        props: {
                          style: {
                            padding: '14px 30px',
                            background: '#0066cc',
                            color: '#ffffff',
                            borderRadius: '10px',
                            fontSize: '26px',
                            fontWeight: 800,
                          },
                          children: 'Tap to vote →',
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    } as Parameters<typeof satori>[0],
    {
      width: 1200,
      height: 630,
      fonts: [{ name: 'Inter', data: interBold, weight: 800, style: 'normal' }],
    }
  );

  // Rasterise SVG → PNG (PNG is the universally-supported OG image format)
  const pngBuffer = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } })
    .render()
    .asPng();

  // Astro's image endpoint expects Uint8Array body. Buffer is a Uint8Array.
  return new Response(new Uint8Array(pngBuffer), {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400',
    },
  });
};
