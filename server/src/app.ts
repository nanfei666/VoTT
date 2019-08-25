import * as bodyParser from 'body-parser';
import * as morgan from 'morgan';
import * as bunyan from 'bunyan';
import * as cookies from 'cookies';
import * as cookieParser from 'cookie-parser';
import * as express from 'express';
import cookieSession = require('cookie-session');
import * as methodOverride from 'method-override';
import * as passport from 'passport';
import * as passportAzureAD from 'passport-azure-ad';
import * as config from './config';
import * as path from 'path';
import * as express_request_id from 'express-request-id';
import * as graph from './graph';

const OIDCStrategyTemplate = {} as passportAzureAD.IOIDCStrategyOptionWithoutRequest;

const log = bunyan.createLogger({
  name: 'BUNYAN-LOGGER',
  src: true,
});

/******************************************************************************
 * Set up passport in the app
 ******************************************************************************/

// -----------------------------------------------------------------------------
// To support persistent login sessions, Passport needs to be able to
// serialize users into and deserialize users out of the session.  Typically,
// this will be as simple as storing the user ID when serializing, and finding
// the user by ID when deserializing.
// -----------------------------------------------------------------------------

interface ISerializedUser {
  oid: string;
  access_token: string;
  refresh_token: string;
}

passport.serializeUser((user: ISerializedUser, done) => {
  const stored = { oid: user.oid, access_token: user.access_token, refresh_token: user.refresh_token};
  done(null, stored );
});

passport.deserializeUser(async (stored: ISerializedUser, done) => {
  if (!stored.access_token) { return done(Error('no user profile')); }
  const result = await graph.getUserDetails(stored.access_token);
  if (!result) { return done(Error('no user profile')); }
  return done(null, result);
});

// array to hold logged in users
const users = new Map<string, any>();

const findByOid = (oid: string, fn: (err: Error, user: any) => void) => {
  log.info(`finding user by oid ${oid}`);
  if (users.has(oid)) {
    return fn(null, users.get(oid));
  }
  return fn(null, null);
};

// -----------------------------------------------------------------------------
// Use the OIDCStrategy within Passport.
//
// Strategies in passport require a `verify` function, which accepts credentials
// (in this case, the `oid` claim in id_token), and invoke a callback to find
// the corresponding user object.
//
// The following are the accepted prototypes for the `verify` function
// (1) function(iss, sub, done)
// (2) function(iss, sub, profile, done)
// (3) function(iss, sub, profile, access_token, refresh_token, done)
// (4) function(iss, sub, profile, access_token, refresh_token, params, done)
// (5) function(iss, sub, profile, jwtClaims, access_token, refresh_token, params, done)
// (6) prototype (1)-(5) with an additional `req` parameter as the first parameter
//
// To do prototype (6), passReqToCallback must be set to true in the config.
// -----------------------------------------------------------------------------
passport.use(new passportAzureAD.OIDCStrategy({
  identityMetadata: config.creds.identityMetadata,
  clientID: config.creds.clientID,
  responseType: config.creds.responseType as typeof OIDCStrategyTemplate.responseType,
  responseMode: config.creds.responseMode as typeof OIDCStrategyTemplate.responseMode,
  redirectUrl: config.creds.redirectUrl,
  allowHttpForRedirectUrl: config.creds.allowHttpForRedirectUrl,
  clientSecret: config.creds.clientSecret,
  validateIssuer: config.creds.validateIssuer,
  isB2C: config.creds.isB2C,
  issuer: config.creds.issuer,
  passReqToCallback: true,
  scope: config.creds.scope,
  loggingLevel: config.creds.logLevel as typeof OIDCStrategyTemplate.loggingLevel,
  nonceLifetime: config.creds.nonceLifetime,
  nonceMaxAmount: config.creds.nonceMaxAmount,
  useCookieInsteadOfSession: config.creds.useCookieInsteadOfSession,
  cookieEncryptionKeys: config.creds.cookieEncryptionKeys,
  clockSkew: config.creds.clockSkew,
},
  (req: express.Request, iss: string, sub: string, profile: passportAzureAD.IProfile, jwtClaims: any, access_token: string, refresh_token: string, params: any, done: passportAzureAD.VerifyCallback) => {
    if (!profile.oid) {
      return done(new Error('No oid found'), null);
    }
    // asynchronous verification, for effect...
    process.nextTick(async () => {

/*    const session = req.session;
      const profileCookie = session.profile;
      if (profileCookie) {
        const user = JSON.parse(profileCookie);
        return done(null, user);
      }
      // profile.refreshToken = refreshToken;
      // profile.accessToken = accessToken;
      session.set('User', JSON.stringify(profile), { maxAge: 1000 * 60 * 60 * 24 * 365 });
      users.set(profile.oid, profile);
      return done(null, profile); */

      const fullProfile = await graph.getUserDetails(access_token);
      if (!fullProfile) {
        return done(Error('no profile'));
      }
      fullProfile.access_token = access_token;
      fullProfile.refresh_token = refresh_token;
      fullProfile.oid = profile.oid;
      return done(null, fullProfile);

/*       findByOid(profile.oid, (err, user) => {
        if (err) {
          return done(err);
        }
        if (!user) {
          // "Auto-registration"
          log.info(`storing user`, profile)
          users.push(profile);
          return done(null, profile);
        }
        return done(null, user);
      });
 */    });
  },
));

// -----------------------------------------------------------------------------
// Config the app, include middlewares
// -----------------------------------------------------------------------------
const app = express();

app.use(morgan(config.httpLogFormat));
app.set('trust proxy', true);
app.set('views', path.join(__dirname, '../public/views'));
app.set('view engine', 'ejs');
app.use(express_request_id());
app.use(methodOverride());
app.use(cookieParser());
app.use(cookieSession({ secret: 'xyzzy       1234', secure: false, maxAge: 1000 * 60 * 60 * 24 * 365 }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(passport.initialize());
app.use(passport.session());

// -----------------------------------------------------------------------------
// Set up the route controller
//
// 1. For 'login' route and 'returnURL' route, use `passport.authenticate`.
// This way the passport middleware can redirect the user to login page, receive
// id_token etc from returnURL.
//
// 2. For the routes you want to check if user is already logged in, use
// `ensureAuthenticated`. It checks if there is an user stored in session, if not
// it will call `passport.authenticate` to ask for user to log in.
// -----------------------------------------------------------------------------
function ensureAuthenticated(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (req.isAuthenticated()) { return next(); }
  res.redirect('/login');
}

function ensureAuthenticatedApi(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (req.isAuthenticated()) { return next(); }
  res.sendStatus(401).end();
  return next();
}

app.get('/', (req, res) => {
  res.render('index', { user: req.user });
});

// '/account' is only available to logged in user
app.get('/account', ensureAuthenticated, (req, res, next) => {
  res.render('account', { user: req.user });
});

app.get('/login',
  (req, res, next) => {
    log.info('testing');
    passport.authenticate('azuread-openidconnect',
      {
        response: res,                      // required
        // resourceURL: config.creds.redirectUrl,    // optional. Provide a value if you want to specify the resource.
        customState: 'my_state',            // optional. Provide a value if you want to provide custom state value.
        failureRedirect: '/',
        // session: false,
      } as passport.AuthenticateOptions,
    )(req, res, next);
  },
  (req, res) => {
    log.info('login was called');
    res.redirect('/');
  });

// 'GET returnURL'
// `passport.authenticate` will try to authenticate the content returned in
// query (such as authorization code). If authentication fails, user will be
// redirected to '/' (home page); otherwise, it passes to the next middleware.
app.get('/auth/openid/return',
  (req, res, next) => {
    passport.authenticate('azuread-openidconnect',
      {
        response: res,                      // required
        failureRedirect: '/',
        // session: false,

      } as passport.AuthenticateOptions,
    )(req, res, next);
  },
  (req, res, next) => {
    log.info('received a return from AzureAD.');
    res.redirect('/');
  });

// 'POST returnURL'
// `passport.authenticate` will try to authenticate the content returned in
// body (such as authorization code). If authentication fails, user will be
// redirected to '/' (home page); otherwise, it passes to the next middleware.
app.post('/auth/openid/return',
  (req, res, next) => {
    passport.authenticate('azuread-openidconnect',
      {
        response: res,                      // required
        failureRedirect: '/',
        // session: false,
      } as passport.AuthenticateOptions,
    )(req, res, next);
  },
  (req, res, next) => {
    log.info('received a return from AzureAD.');
    res.redirect('/');
  });

// 'logout' route, logout from passport, and destroy the session with AAD.
app.get('/logout', (req, res) => {
  req.session = null;
  // req.session.destroy((err) => {
  req.logOut();
  res.redirect(config.destroySessionUrl);
  // });
});

const cloudConnections = new Map<string, any>([
  ['connection1', { foo: 'bar' }],
  ['connection2', { foo: 'baz' }],
]);

app.get('/api/v1.0/cloudconnections', ensureAuthenticatedApi,
  (req, res, next) => {
    res.json(Array.from(cloudConnections.keys()));
    res.end();
    next();
  });

app.get('/api/v1.0/cloudconnections/:id', ensureAuthenticatedApi,
  (req, res, next) => {
    const id = req.params.id;
    res.json(cloudConnections.get(id));
    res.end();
    next();
  });

app.put('/api/v1.0/cloudconnections/:id', ensureAuthenticatedApi,
  (req, res, next) => {
    const id = req.params.id;
    const body = req.body;
    const status = cloudConnections.has(id) ? 200 : 201;
    cloudConnections.set(id, body);
    res.sendStatus(status);
    res.json(body);
    next();
  });

app.delete('/api/v1.0/cloudconnections/:id', ensureAuthenticatedApi,
  (req, res, next) => {
    const id = req.params.id;
    if (cloudConnections.has(id)) {
      res.sendStatus(404).end();
      return next();
    }
    cloudConnections.delete(id);
    res.end();
    return next();
  });

app.use('/public', express.static(path.join(__dirname, '../public')));

app.listen(config.port);
