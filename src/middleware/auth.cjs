const https = require('https');
const session = require('express-session');
const passport = require('passport');
const xml2js = require('xml2js');
const { Strategy: SamlStrategy } = require('@node-saml/passport-saml');
const config = require('../config.cjs');

// IdP metadata fetch + strategy construction is async (single HTTPS GET +
// XML parse). We don't want every request paying for it, so we cache the
// strategy promise on first call. If construction fails the cached rejection
// would poison every later call, so we clear the cache to allow retry.
let strategyPromise = null;

async function getSamlStrategy() {
  if (!config.AUTH_ENABLED) {
    throw new Error('AUTH_ENABLED=false; getSamlStrategy() should not be called');
  }
  if (!strategyPromise) {
    strategyPromise = (async () => {
      const opts = await buildSamlOptions();
      const strategy = new SamlStrategy(opts, verifySaml);
      passport.use('saml', strategy);
      return strategy;
    })();
    strategyPromise.catch(() => { strategyPromise = null; });
  }
  return strategyPromise;
}

// Two ways to configure the IdP side:
//  1. SAML_IDP_METADATA_URL  → fetch + parse XML, derive entryPoint/cert/issuer
//  2. SAML_IDP_SSO_URL + SAML_IDP_CERT (+ optional SAML_IDP_ENTITY_ID) → manual
// (1) is what Okta admins typically hand out; (2) is the fallback for IdPs
// that won't expose a metadata URL or for offline configs.
async function buildSamlOptions() {
  const base = {
    callbackUrl: config.SAML_CALLBACK_URL,
    issuer: config.SAML_ENTITY_ID,
    identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    signatureAlgorithm: 'sha256',
    digestAlgorithm: 'sha256',
    // Most clock skew is < 1s but Okta and our EC2 clocks can drift a few
    // seconds; 5s keeps assertions valid without opening a meaningful replay
    // window (assertions also have NotOnOrAfter typically ≤ 5min).
    acceptedClockSkewMs: 5000,
    wantAuthnResponseSigned: true,
    wantAssertionsSigned: true,
  };

  if (config.SAML_IDP_METADATA_URL) {
    const md = await fetchIdpMetadata(config.SAML_IDP_METADATA_URL);
    return { ...base, entryPoint: md.entryPoint, idpCert: md.idpCert, idpIssuer: md.entityID };
  }
  return {
    ...base,
    entryPoint: config.SAML_IDP_SSO_URL,
    idpCert: config.SAML_IDP_CERT,
    // idpIssuer is optional in passport-saml; including it makes it strictly
    // verify the IdP's <Issuer> matches what we expect.
    ...(config.SAML_IDP_ENTITY_ID ? { idpIssuer: config.SAML_IDP_ENTITY_ID } : {}),
  };
}

async function fetchIdpMetadata(url) {
  const xml = await fetchUrl(url);
  // stripPrefix drops `md:` / `ds:` namespace prefixes so we can navigate the
  // tree without sprinkling them everywhere.
  const parser = new xml2js.Parser({
    explicitArray: false,
    tagNameProcessors: [xml2js.processors.stripPrefix],
  });
  const parsed = await parser.parseStringPromise(xml);
  const ed = parsed.EntityDescriptor;
  if (!ed) throw new Error('SAML metadata: no <EntityDescriptor>');
  const idp = ed.IDPSSODescriptor;
  if (!idp) throw new Error('SAML metadata: no <IDPSSODescriptor>');

  const ssoList = Array.isArray(idp.SingleSignOnService) ? idp.SingleSignOnService : [idp.SingleSignOnService];
  // Prefer HTTP-Redirect (smaller request, GET-friendly) over POST. Fall back
  // to whatever's listed first if neither standard binding is present.
  const redirect = ssoList.find((s) => s && s.$ && s.$.Binding === 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect');
  const post = ssoList.find((s) => s && s.$ && s.$.Binding === 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST');
  const chosen = redirect || post || ssoList[0];
  if (!chosen || !chosen.$ || !chosen.$.Location) {
    throw new Error('SAML metadata: no usable <SingleSignOnService Location>');
  }
  const entryPoint = chosen.$.Location;

  const keyList = Array.isArray(idp.KeyDescriptor) ? idp.KeyDescriptor : [idp.KeyDescriptor];
  // IdPs may publish separate signing/encryption keys, or a single key with
  // no `use` attribute that's used for both. Pick `use=signing` first, then
  // fall back to the first key.
  const signingKey = keyList.find((k) => k && (!k.$ || !k.$.use || k.$.use === 'signing')) || keyList[0];
  const certB64 = signingKey && signingKey.KeyInfo && signingKey.KeyInfo.X509Data && signingKey.KeyInfo.X509Data.X509Certificate;
  const certRaw = (typeof certB64 === 'string' ? certB64 : (certB64 && certB64._)) || '';
  if (!certRaw.trim()) throw new Error('SAML metadata: no <X509Certificate>');
  const idpCert = pemWrapCert(certRaw);

  return { entryPoint, idpCert, entityID: ed.$ && ed.$.entityID };
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`SAML metadata fetch failed: HTTP ${res.statusCode} for ${url}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('SAML metadata fetch timed out')));
  });
}

// passport-saml accepts a PEM-wrapped cert. Metadata XML carries just the
// base64; wrap it with BEGIN/END markers and 64-col line wrapping to be safe.
function pemWrapCert(b64) {
  const cleaned = b64.replace(/\s+/g, '');
  const wrapped = cleaned.match(/.{1,64}/g).join('\n');
  return `-----BEGIN CERTIFICATE-----\n${wrapped}\n-----END CERTIFICATE-----`;
}

function verifySaml(profile, done) {
  // We do user mapping + group gating in the callback route (so the rejection
  // page can show useful debug info). Just pass the raw profile through.
  return done(null, profile);
}

// Maps the raw SAML profile (attribute keys depend on Okta config) onto the
// minimal user object we store in the session.
function profileToUser(profile) {
  if (!profile) return null;
  const groupAttr = config.SAML_GROUP_ATTRIBUTE;
  const raw = profile[groupAttr];
  const groups = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  return {
    sub: profile.nameID,
    email: profile.email || profile.mail || profile.nameID,
    name:
      profile.displayName ||
      [profile.firstName, profile.lastName].filter(Boolean).join(' ') ||
      profile.email ||
      profile.nameID,
    groups,
    via: 'saml',
  };
}

// Paths that must NOT require auth:
//   /health  → ALB target health checks have no session
//   /auth/*  → the login flow itself can't require being logged in
const PUBLIC_PREFIXES = ['/health', '/auth/'];

function isPublicPath(path) {
  return PUBLIC_PREFIXES.some((p) => path === p || path === p.replace(/\/$/, '') || path.startsWith(p));
}

function initSession(app) {
  if (!config.AUTH_ENABLED) return;

  app.use(session({
    name: 'mockserver.sid',
    secret: config.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      // 'auto' = Secure when the request was HTTPS (works for both local HTTP
      // dev and ALB-terminated HTTPS in prod).
      secure: 'auto',
      maxAge: 8 * 60 * 60 * 1000,
    },
  }));

  // passport.initialize() lets passport.authenticate() run inside route
  // handlers. We deliberately DO NOT use passport.session() — we manage the
  // post-login user in req.session.user ourselves so group gating + redirect
  // happen in one place (the /auth/saml/callback handler).
  app.use(passport.initialize());
}

function requireAuth(req, res, next) {
  if (!config.AUTH_ENABLED) return next();
  if (isPublicPath(req.path)) return next();

  // Programmatic callers (CI, mobile apps, monitoring) cannot do interactive
  // SAML login — they present a shared API key instead. Constant-time compare
  // so a probe attacker can't infer key length/content from response timing.
  const apiKey = req.headers['x-api-key'];
  if (apiKey && config.MOCK_API_KEY && safeEqual(String(apiKey), config.MOCK_API_KEY)) {
    req.user = { sub: 'api-key', name: 'service-account', via: 'api-key' };
    return next();
  }

  if (req.session && req.session.user) {
    req.user = req.session.user;
    return next();
  }

  // Browser GETs get redirected to login; remember the original URL so the
  // callback can drop them back where they were. JSON / non-GET / non-HTML
  // requests get a 401 with a hint instead of a confusing redirect.
  const acceptsHtml = (req.headers.accept || '').includes('text/html');
  if (acceptsHtml && req.method === 'GET') {
    if (req.session) req.session.returnTo = req.originalUrl;
    return res.redirect('/auth/saml/login');
  }

  return res.status(401).json({
    error: 'Authentication required',
    hint: 'Browser users: GET /auth/saml/login. Programmatic callers: send X-API-Key header.',
  });
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

module.exports = { initSession, requireAuth, getSamlStrategy, profileToUser, isPublicPath };
