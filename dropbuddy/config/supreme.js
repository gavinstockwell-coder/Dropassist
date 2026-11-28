// Supreme (us.supreme.com, Shopify). Every selector and URL the extension uses for this site lives here.
// Verified against the live site on 2026-11-25. If the site changes, fix it here (see README → "Updating selectors").
(function (root) {
  'use strict';
  const DA = (root.DA = root.DA || {});
  DA.config = DA.config || {};

  DA.config.supreme = {
    id: 'supreme',
    name: 'Supreme',
    origin: 'https://us.supreme.com',

    // Monitoring: the collection page embeds every product (all colors + size availability) as JSON.
    // /products.json and /products/<handle>.js return 403 on this store, so we read the page instead.
    listingPath: '/collections/new',
    productsJsonRe: /<script[^>]*\bid=["']products-json["'][^>]*>([\s\S]*?)<\/script>/i,
    productPath: (handle) => `/products/${handle}`,

    // Shopify AJAX cart (the site's own "add to cart" button calls this).
    cartAddPath: '/cart/add.js',
    cartPath: '/cart.js',
    cartClearPath: '/cart/clear.js',
    checkoutPath: '/checkout', // redirects to /checkouts/cn/<token>/...

    selectors: {
      // product page
      sizeSelect: 'select[data-testid="size-dropdown"]', // option values are Shopify variant IDs; only in-stock sizes are listed
      addToCart: 'button[data-testid="add-to-cart-button"]',
      inCartMessage: '[data-testid="product-in-cart-message"], [data-testid="remove-from-cart-button"]',
      miniCartCheckout: 'a[data-testid="mini-cart-checkout-link"]',
      // checkout (Shopify one-page checkout)
      payButton: ['#checkout-pay-button', 'button[type="submit"][aria-label*="payment" i]'],
      cardNumberFrame: 'iframe[title="Card number"]'
    },

    // Fill order matters: country first (it re-renders the state list).
    // Shopify also renders hidden "autofill_*" capture inputs with the same names; those are excluded.
    checkoutExclude: '[id^="autofill_"], [name="autofill_phone_capture"]',
    checkoutFields: [
      { key: 'country', selectors: ['select[name="countryCode"]'], waitAfterMs: 400, optional: true },
      { key: 'email', selectors: ['input#email', 'input[name="email"]'] },
      { key: 'firstName', selectors: ['input[name="firstName"]'] },
      { key: 'lastName', selectors: ['input[name="lastName"]'] },
      { key: 'address1', selectors: ['input#shipping-address1', 'input[name="address1"]'], waitAfterMs: 150 },
      { key: 'address2', selectors: ['input[name="address2"]'], optional: true },
      { key: 'city', selectors: ['input[name="city"]'] },
      { key: 'state', selectors: ['select[name="zone"]'] }, // option values are state codes, e.g. "TX"
      { key: 'zip', selectors: ['input[name="postalCode"]'] },
      { key: 'phone', selectors: ['input[name="phone"]'] }
    ],

    blockers: {
      queueUrl: /\/(throttle|queue|checkpoint)\b/i,
      queueText: /you('|’)re in line|waiting room|in the queue|high demand/i,
      captchaSelectors: [
        'iframe[src*="hcaptcha.com"]',
        'iframe[src*="recaptcha"][src*="bframe"]',
        'iframe[title*="challenge" i]',
        '#challenge-form', '#cf-challenge-running'
      ]
    }
  };
})(typeof self !== 'undefined' ? self : globalThis);
