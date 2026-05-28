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
  const headline = poll.title;
  const subline = poll.destination ?? '';
  const participants = `${poll.participants.length} people`;
  const footer =
    daysLeft > 0
      ? `Polling closes in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`
      : 'Polling closed';

  // Compose a 1200×630 OG card.
  // Palette mirrors Barcelona Pixel Dawn, with the teal accent that makes
  // when-we-go visually distinct from pay-me-back's rust.
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
          padding: '64px 72px',
          background:
            'linear-gradient(135deg, #f8d4a8 0%, #e8a570 55%, #2c8c8c 100%)',
          fontFamily: 'Inter',
          color: '#2a1f1a',
        },
        children: [
          // Top row: small "WHEN WE GO" brand
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: '16px',
                fontSize: '28px',
                letterSpacing: '6px',
                opacity: 0.85,
              },
              children: [
                {
                  type: 'div',
                  props: {
                    style: {
                      width: '20px',
                      height: '20px',
                      background: '#2a1f1a',
                    },
                  },
                },
                'WHEN WE GO',
              ],
            },
          },
          // Middle: title + destination + participant count
          {
            type: 'div',
            props: {
              style: { display: 'flex', flexDirection: 'column', gap: '12px' },
              children: [
                {
                  type: 'div',
                  props: {
                    style: {
                      fontSize: '82px',
                      lineHeight: 1,
                      letterSpacing: '-3px',
                    },
                    children: headline,
                  },
                },
                ...(subline
                  ? [
                      {
                        type: 'div',
                        props: {
                          style: {
                            fontSize: '52px',
                            lineHeight: 1.1,
                            letterSpacing: '-1.5px',
                            opacity: 0.92,
                          },
                          children: subline,
                        },
                      },
                    ]
                  : []),
                {
                  type: 'div',
                  props: {
                    style: {
                      fontSize: '32px',
                      letterSpacing: '0.5px',
                      opacity: 0.8,
                      marginTop: '6px',
                    },
                    children: participants,
                  },
                },
              ],
            },
          },
          // Bottom: countdown + tap-to-vote button
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                fontSize: '26px',
                letterSpacing: '2px',
                color: '#fef3e2',
              },
              children: [
                { type: 'div', props: { children: footer } },
                {
                  type: 'div',
                  props: {
                    style: {
                      padding: '12px 24px',
                      border: '4px solid #2a1f1a',
                      background: '#fef3e2',
                      color: '#2a1f1a',
                      boxShadow: '6px 6px 0 #2a1f1a',
                    },
                    children: 'TAP TO VOTE →',
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
