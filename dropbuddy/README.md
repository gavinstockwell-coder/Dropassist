# DropBuddy

A personal drop-day helper for **Supreme** (us.supreme.com). (The North Face support was removed in v1.2.)
It runs in **Google Chrome** and **Opera GX** (Manifest V3).

It watches for your items, adds the right color and size to your cart, opens checkout, and fills in your saved shipping
and card details. Then it alerts you. **You** check the card, solve any CAPTCHA, and click the final pay button.

What it never does:

- Solve or get around CAPTCHAs, queues, or bot detection
- Use proxies, multiple accounts, or multiple tabs
- Click the final purchase button
- Store your card unencrypted (cards are AES-256 encrypted with your passphrase; see *Profiles & cards*)

---

## How Supreme works (checked against the live site on 2026-11-25)

| | Supreme |
|---|---|
| Platform | Shopify (theme `SNY-webshop`) |
| What it watches | `/collections/new`. The page embeds every product, color, and size, with stock status, as JSON (`<script id="products-json">`). One request covers the whole drop (~680 KB, ~0.2 s). `/products.json` and similar feeds return **403** on this store. |
| Add to cart | `POST /cart/add.js`, the same request the site's own button sends. If that fails, it falls back to clicking through the product page. |
| Checkout | One page (`/checkouts/cn/…`). Contact, shipping, and card are all on one screen. Card fields are in Shopify's secure frames; the extension fills them from your saved profile (or use browser autofill / Shop Pay). Final button: **process payment**. |
| Drop time | Thursdays 11:00 AM New York time during the season |

---

## Install

### Chrome
1. Unzip `dropassist.zip` somewhere permanent (for example `Documents\dropassist`). Chrome loads the extension from
   that folder, so don't delete it.
2. Go to `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `dropassist` folder (the one that has `manifest.json` in it).
4. Pin it: click the puzzle icon, then the pin next to DropBuddy.

### Opera GX
1. Unzip as above.
2. Go to `opera://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `dropassist` folder.
4. Pin it from the extensions (cube) icon in the sidebar or toolbar.
5. Opera GX's **RAM/CPU limiters (GX Control)** can slow background tabs. Turn them off on drop day, or keep the
   Supreme tab in front.

After you edit any file, click the **reload ↻** icon on the extension's card. Then reload any open Supreme tabs.

---

## Set up (one time)

Open the popup and click **Options, watchlist & profile**.

1. **Profiles**: shipping (email, name, address, 2-letter state, ZIP, phone) plus a card. Make as many as you like
   (say, your card and a partner's) and tick **Use at checkout** on the one to use. See *Profiles & cards* below.
2. **Watchlist**: one item per product you want, top item = highest priority.
   - **Keywords**: all must appear in the product name, whole words only (`box logo, hooded`).
   - **Exclude**: skip the product if any of these appear (`tee, beanie`).
   - **Colors / Sizes**: list them in priority order (`black, grey, any` / `L, XL`). End a list with `any` to accept
     anything else as a last resort. Leave it blank to accept anything.
   - **Product URL**: skips the search and goes straight to that product.
   - **Drop time**: leave blank for the weekly default. Set it for surprise drops.
3. **Timing**: the defaults are good. It checks every 3 s, starts 30 s before the drop, and stops 10 min after.
   Don't set the check interval below ~2 s: every check downloads the full product page.
4. Click **Save** (or Ctrl+S).

---

## Use it

| Button | What it does |
|---|---|
| **Arm next drop** | Schedules a run for the next drop on your watchlist. About 1 minute before, it re-syncs the clock and opens and focuses the site tab. Just before the drop, it notes what's already listed so old stock is ignored, then starts checking. Leave the browser open and the computer awake. |
| **Start now** | Starts checking immediately on the site picked in the dropdown. Use it for restocks and surprise drops. The old-stock filter is off. |
| **Dry run** | Runs the whole flow on something in stock right now and stops at a filled checkout. Nothing is submitted. Click **Clear cart** on the page banner when you're done. Type a keyword, or leave it blank for any in-stock item. |
| **Fill checkout on this tab** | Fills the checkout you're looking at, whether or not a run is going. |
| **Stop** | Ends the run. |
| **sync** | Measures the site's server clock against yours. It watches for the server's `Date` header to tick over, which typically gives ±100–300 ms accuracy (the popup shows the actual figure). The countdown and start time use the server's clock. |

When checkout is ready, you get a loud beep, a desktop notification, the tab brought to the front, and a pulsing green
outline on the pay button.

A banner in the top-right of the page always shows what the extension is doing. The popup log records every match
decision (`MATCH` / `skip … : reason`), plus timings:

```
drop→match 312 ms · match→cart 41 ms · cart→checkout ready 1,480 ms · total 1,833 ms
```

**Queues and CAPTCHAs:** the run pauses and alerts you. Get through it yourself, and the run picks back up
automatically.

**403 from the site:** the run pauses instead of retrying, so it doesn't make things worse. Reload the page yourself,
then press **Resume**.

---

## Profiles & cards

You enter shipping and a card **once** per profile in Options. The card is saved encrypted.

- **First card:** you pick a passphrase. The card is encrypted with AES-256-GCM, using a key derived from that
  passphrase (PBKDF2-SHA256, 310,000 rounds). Only the ciphertext and the last 4 digits are stored on disk. Without the
  passphrase, the stored data can't be read back into a card number.
- **Each browser session:** type the passphrase once. You can do that in the popup (🔒 → **Unlock**) or in Options. The
  unlocked key is held in memory (`chrome.storage.session`) and disappears when the browser closes. **Unlock it before
  you arm a drop.** If it's locked, the log warns you and the card is left for you to fill.
- **At checkout:** the card fields sit inside the payment processor's secure iframes (Shopify's
  `checkout.pci.shopifyinc.com`). A small script in those iframes asks the extension for *its
  one field*. The background only answers when all of these are true:
  - the vault is unlocked
  - the request comes from a payment iframe
  - that iframe is inside a Supreme **checkout** tab
  - that checkout asked for a fill within the last 2 minutes
- **Forgot the passphrase:** Options → **Forgot passphrase** deletes every saved card. Shipping is kept, and you
  re-enter the cards.
- **Alternative:** if you'd rather not store the card in the extension at all, leave it off the profile. Then pick your
  card from the browser's own autofill at checkout. Chrome: `chrome://settings/payments`. Opera: Settings → Autofill →
  Payment methods. On Supreme you can also use Shop Pay.

Security notes: anything that runs as you on this computer, like malware or a keylogger, could still grab the card while
the vault is unlocked. Use a passphrase you don't use elsewhere. Lock the vault (popup → Options → **Lock now**) when
you're not dropping.

---

## Look (themes & fonts)

Go to **Settings → Look**, click a theme, and it changes everywhere instantly: popup, settings, ledger, and the banner
on Supreme's pages.

| Theme | Feel | Default font |
|---|---|---|
| Night sky | deep blue sky with interactive stars | Space Grotesk |
| Linux terminal | charcoal background, light grey text, green `user@dropbuddy:~$` prompt, `[ bracket ]` buttons | Ubuntu Mono |
| Archive | black, bone white, blood red and gold | Space Mono + IBM Plex Mono |
| Mono | pure black and white | Space Mono |
| Paper | light mode | Space Grotesk |

The **Font** setting overrides the theme's font. **Animated stars** turns the starfield on or off. The fonts are bundled
with the extension under the SIL Open Font License (`ui/fonts/`), so they look the same on every computer.

---

## Pre-drop inspection, phone alerts, preview import, restock watch, ledger (v1.5)

- **Pre-drop inspection** (popup button): checks that
  - your watchlist has items and your shipping profile is complete
  - your card isn't expired and the card vault is unlocked
  - the server clock synced
  - Supreme's product data is still readable, and how many current products match each item
  - desktop notifications, sound, and phone alerts are on

  Every ✗ is something to fix before the drop.
- **Phone alerts (Discord)**: Options → *Phone alerts*. Paste a Discord webhook URL, then choose which events send:
  match, checkout ready, CAPTCHA/queue, your turn, resale result, window ended, and restocks. Use **Send test** to
  check it. Alerts never include your address, card, or checkout link.
- **Import from Supreme preview**: Options → load the season's preview (`supreme.com/previews/<season>/all`), filter,
  tick items, and add them to your watchlist. Keywords are generated from each item's name.
- **Restock watcher**: tick *Restock watch* on an item and turn on the watcher in *Timing & behavior*. Every N minutes
  (default 2) it checks `/collections/all` in the background. It **alerts only, it never buys**. It alerts once per size,
  and again only if that size sells out and comes back. It pauses while a drop run is active.
- **Ledger** (popup → *Purchase log*): every real checkout DropBuddy reaches is logged as *pending*, with the retail
  price and resale estimate. Mark each one bought / missed / sold / kept, and enter what it sold for and the fee %.
  You get your hit rate, total spent, and realized profit. Export it as CSV.

---

## Resale value check

**When an item matches during a run**, DropBuddy looks up its resale value in the background and writes it to the log.
This never slows down checkout. A log line looks like this:

```
Resale · Box Logo Hooded Sweatshirt – Black / Medium: StockX M: ask $320 / bid $260 / last $285 · eBay asks: median $288, low $250 (37 listings) · retail $168 · est. spread +$117 before fees
```

**Any time**, use popup → **Resale check**: type the item (and optionally a size) and press **Check**. You get the
numbers plus one-click links to StockX, GOAT, Grailed and eBay sold listings.

| Source | How | What you get |
|---|---|---|
| StockX | Official Public API v2. You need approval in the StockX Developer Program, then an API key, OAuth client ID/secret, and a refresh token. | Lowest ask, highest bid, last sale for your size (or across all sizes) |
| eBay | Official Browse API. Free keys from developer.eBay.com (Production App ID + Cert ID). | Current asking prices: median, low, count. eBay's sold-price API is limited to approved partners, so sold prices are a link. |
| Grailed, GOAT | No public API | One-click search links |

Paste keys in **Options → Resale data → Save keys & grant access**. The browser asks once for permission to reach those
APIs. Keys stay in this browser, and access tokens are kept in memory only. "Est. spread" is resale value minus retail,
**before** platform fees and shipping (often 10–15%+).

---

## Updating selectors when a site changes

Everything site-specific lives in **`config/supreme.js`**.

If the log says something like `products-json not found` or `not found: email, zip`, or a step stalls:

1. Open the page in question. Right-click the element (size picker, Add to Cart, a checkout field) and choose
   **Inspect**.
2. In DevTools, find a stable attribute: `data-testid` / `data-test-id`, `name`, `id`, or `autocomplete`.
   Avoid class names like `sc-fFubgA`, which change on every site build.
3. Test it in the DevTools **Console**: `document.querySelectorAll('your selector')`. It should return the element you
   expect.
4. Put it in the matching line of the config file, click **reload ↻** on the extension's card, then do a **dry run**.

---

## Permissions (and why)

| Permission | Why |
|---|---|
| `us.supreme.com` (host access) | Run the page script on Supreme only, read products, and sync the clock. No other sites. |
| `supreme.com` | Read the season preview page for *Import from Supreme preview*. |
| `checkout.pci.shopifyinc.com` | Fill the card fields inside Shopify's secure payment iframes. |
| `api.stockx.com`, `accounts.stockx.com`, `api.ebay.com`, `discord.com` (optional) | Only requested when you save resale API keys or turn on phone alerts. |
| `storage` | Your watchlist, settings, profiles (cards encrypted), and log. All stored locally in this browser. The unlocked vault key is kept in memory only. |
| `alarms` | Wake up for an armed drop even if the extension's background worker went to sleep. |
| `notifications` | The "READY", "your turn", and "CAPTCHA" pop-ups. |
| `offscreen` | Play the alert sound. Extensions need a hidden page to play audio. If a browser doesn't support that, it beeps from the site tab instead. |

---

## Good to know

- **Terms of service.** Supreme's terms prohibit automated purchasing, and it can cancel
  orders it flags. That's why this extension stays human-in-the-loop with one tab, and you click pay.
- **Keep the site tab in front** during a run. Browsers slow down timers in background tabs.
- **Order limits.** Supreme limits most products to 1 per order. The extension adds one of each watchlist item.
- **If the extension updates or reloads mid-run**, reload the site tab.
- **Sounds.** If you hear nothing, use **test** next to *Sound alerts* in Options. Your OS may be muting browser
  notifications.

## Files

```
manifest.json          MV3 manifest
background.js          run state, alarms, clock sync, notifications, sound
content/runner.js      on-page state machine (armed → monitoring → carting → checkout → ready)
adapters/supreme.js    Supreme: read products, cart API, product page, checkout
config/supreme.js      ← every selector and URL
lib/match.js           keyword / color / size priority matching (unit tested)
lib/time.js            weekly drop time in New York time, DST-safe (unit tested)
lib/fill.js            field filling for React/Vue checkouts, queue/CAPTCHA detection
lib/ui.js              page banner, highlight, beep
lib/resale.js          StockX + eBay official API lookups, resale links (unit tested)
lib/vault.js           card encryption (AES-GCM + PBKDF2), card validation (unit tested)
content/cardframe.js   runs inside the payment iframes; fills its one card field
popup/, options/       UI
orders/                purchase ledger
ui/                    themes, bundled fonts, starfield
tests/                 unit tests (node --test tests/unit.test.js) and a headless-Chrome end-to-end test
```
