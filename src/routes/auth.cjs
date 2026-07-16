const express = require('express');
const passport = require('passport');
const rateLimit = require('express-rate-limit');
const { getSamlStrategy, profileToUser } = require('../middleware/auth.cjs');
const config = require('../config.cjs');

const router = express.Router();

const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 auth requests per window
  standardHeaders: true,
  legacyHeaders: false,
});

router.use('/auth', authRateLimiter);

function authDisabled(res) {
  return res.status(404).json({ error: 'Auth not enabled (set AUTH_ENABLED=true)' });
}

// Browser hits this; passport-saml builds the AuthnRequest and 302s the user
// off to Okta. We stash returnTo in the session beforehand so the callback
// can drop them back where they came from.
router.get('/auth/saml/login', async (req, res, next) => {
  if (!config.AUTH_ENABLED) return authDisabled(res);
  try {
    await getSamlStrategy();
    if (req.query.returnTo) req.session.returnTo = String(req.query.returnTo);
    passport.authenticate('saml', { session: false })(req, res, next);
  } catch (err) {
    next(err);
  }
});

// Backward-compat alias: the dormant OIDC code redirected to /auth/login.
// Anything still pointing there (bookmarks, internal links) keeps working.
router.get('/auth/login', (req, res) => res.redirect('/auth/saml/login'));

// Okta POSTs the SAMLResponse here as form-urlencoded. The global app uses
// json/text parsers only, so we add a scoped urlencoded parser just for this
// route. 5mb matches the global limit (signed assertions can get large).
router.post(
  '/auth/saml/callback',
  express.urlencoded({ extended: false, limit: '5mb' }),
  async (req, res, next) => {
    if (!config.AUTH_ENABLED) return authDisabled(res);
    try {
      await getSamlStrategy();
      passport.authenticate('saml', { session: false }, (err, profile) => {
        if (err) return next(err);
        if (!profile) return res.status(401).send('SAML authentication failed.');

        const user = profileToUser(profile);

        // Group gating: if AUTH_ALLOWED_GROUPS is non-empty, the user must
        // have at least one matching group. Empty list = open to anyone the
        // IdP authenticated (still gated by Okta app assignment). Rejection
        // page lists actual vs. expected groups so failures are debuggable
        // without shell-tailing the server logs.
        if (config.AUTH_ALLOWED_GROUPS.length > 0) {
          const ok = user.groups.some((g) => config.AUTH_ALLOWED_GROUPS.includes(g));
          if (!ok) {
            return res.status(403).send(
              `<h1>Access denied</h1>` +
              `<p>Your Okta account is not in any of the groups allowed for this app.</p>` +
              `<p>Required (any of): <code>${config.AUTH_ALLOWED_GROUPS.join(', ')}</code></p>` +
              `<p>Your groups: <code>${user.groups.join(', ') || '(none)'}</code></p>`,
            );
          }
        }

        req.session.user = user;
        const returnTo = req.session.returnTo || '/';
        delete req.session.returnTo;
        res.redirect(returnTo);
      })(req, res, next);
    } catch (err) {
      next(err);
    }
  },
);

router.post('/auth/logout', (req, res) => {
  if (!req.session) return res.json({ ok: true, loggedOut: false });
  req.session.destroy(() => {
    res.clearCookie('mockserver.sid');
    res.json({ ok: true, loggedOut: true });
  });
});

router.get('/auth/me', (req, res) => {
  if (!config.AUTH_ENABLED) return res.json({ authEnabled: false });
  if (req.session && req.session.user) {
    return res.json({ authEnabled: true, user: req.session.user });
  }
  return res.status(401).json({ authEnabled: true, user: null });
});

// SP metadata XML for the Okta admin: GET this URL once auth is enabled and
// they can compare the SP entity ID + ACS URL against what they configured,
// instead of us emailing values back and forth.
router.get('/auth/saml/metadata', async (req, res, next) => {
  if (!config.AUTH_ENABLED) return authDisabled(res);
  try {
    const strategy = await getSamlStrategy();
    res.type('application/xml');
    res.send(strategy.generateServiceProviderMetadata(null));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
