# Tripwire — marketing site

The public site for Tripwire, built with Next.js and Tailwind.

## Stack

- Next.js 16 (App Router, Turbopack) + TypeScript
- Tailwind CSS v4 — theme tokens in `src/app/globals.css`
- `motion` for scroll reveals, `swiper` for the feature carousel
- shadcn/ui primitives under `src/components/ui/`

## Run

```bash
npm install
npm run dev     # http://localhost:3000
npm run build
npm start
```

## Routes

| Route      | Sections                                                        |
| ---------- | --------------------------------------------------------------- |
| `/`        | Hero, features, use cases, pricing, testimonials, FAQ, CTA       |
| `/pricing` | Pricing cards, comparison table, FAQ, CTA                        |
| `/docs`    | Sidebar nav + introduction                                       |
| `/support` | Quick-answer card + contact form                                 |
| `*`        | 404                                                              |

## Brand

Monochrome: near-black (`--color-theme-dark: #030303`), white text, `white/20`
hairline borders. Inter for body copy, a mono stack for buttons and labels.

The mark is `src/components/TripwireMark.tsx` — a wire strung between two posts
with the trigger node at its centre. It is `currentColor`-driven, so it takes the
colour of whatever it sits in. `src/app/icon.svg` is the same mark as the favicon.

## Assets

There are none. Every decorative element is drawn by the browser: the hero and
card glows are CSS radial gradients (`.bloom*` in `globals.css`), the closing
CTA is a canvas (`RibbonField.tsx`), and the 404 numeral is SVG type. Nothing
under `public/` needs licensing, and there are no images on the render path.

## Content status

The testimonials are **illustrative sample content**, labelled as such on the
page, and use role labels rather than social handles. Replace them with real,
attributed quotes before treating the page as a live marketing site.

Body copy is still inherited from the layout this site was built on and
describes an AI writing product. It needs rewriting for Tripwire.
