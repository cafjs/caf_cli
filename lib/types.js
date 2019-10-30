
/**
 * @global
 * @typedef {function(Error?, any?)} cbType
 *
 */


/**
 * @global
 * @typedef {Object} specType
 * @property {string} name
 * @property {string|null} module
 * @property {string=} description
 * @property {Object} env
 * @property {Array.<specType>=} components
 *
 */

/**
 * @global
 * @typedef {Object} specURLType
 * @property {string} appProtocol `http` or `https`.
 * @property {string} appPublisher The publisher of this app.
 * @property {string} appLocalName The local name of the app.
 * @property {string} appSuffix A URL suffix, e.g., `cafjs.com`.
 * @property {string} myId Name of the `from` CA, of the form
 * `caOwner-caLocalName`.
 */


/**
 * @global
 * @typedef {Object} cliPropsType
 * @property {string} caOwner Owner's name of the target CA.
 * @property {string} caLocalName Local name of the target CA.
 * @property {string} appPublisher The publisher of this app.
 * @property {string} appLocalName The local name of the app.
 * @property {string=} token  Authentication token for the `from` principal.
 * @property {string=} cacheKey A key to cache server side rendering.
 */

/**
 * @global
 * @typedef {Object | Array | string | number | null | boolean} jsonType
 *
 */

/**
 * @global
 * @typedef {Object<string, jsonType>} msgType
 *
 */

/**
 * @global
 * @typedef {Object} tokenFactoryOptionsType
 * @property {string=} password The password for the authentication service.
 * @property {string=} accountsURL The url for an authentication service.
 * @property {boolean=} unrestrictedToken True if the desired token
 * authenticates to all apps.
 * @property {number=} durationInSec Time in seconds from `now` till token
 * expires.
 * @property {Object=} securityClient A client implementation of the
 * authentication protocol. See `caf_srp` for an example.
 */

/**
 * @global
 * @typedef {Object} sessionOptionsType
 * @property {string} ca Name of the target CA, of the form
 * `caOwner-caLocalName`.
 * @property {string} from Name of the source CA, or equal to `ca` if the
 * client is the owner.
 * @property {string=} token Authentication token for the `from` principal.
 * @property {string=} session The logical session id.
 * @property {string=} appPublisher The publisher of this app.
 * @property {string=} appLocalName The local name of the app.
 * @property {boolean=} disableBackchannel No notifications are needed,
 * disable the backchannel.
 * @property {number=} maxRetries Number of error retries before closing a
 * session. If progress, they reset every `timeoutMsec`.
 * @property {number=} retryTimeoutMsec Time between retries in miliseconds.
 * @property {number=} timeoutMsec Max time in miliseconds for a request before
 * assuming an irrecoverable error, and closing the session.
 * @property {string=} cacheKey Custom key to cache server side rendering.
 * @property {boolean=} initUser Whether the owner in `from` is a new user that
 * has to be registered.
 * @property {function(string)=} log Custom function to log messages.
 * @property {function(msgType, cbType)=} newToken Custom function to negotiate
 * an authentication token.
 * @property {function(msgType, cbType)=} newURL Custom function to redirect
 * the session.
 * @property {function(string, Object, cbType)=} newUser Custom function to
 * register a new user.
 * @property {Object=} timeAdjuster Custom object to synchronize clocks with the
 * cloud. See `TimeAdjuster.js` for details.
 * @property {string=} password  See `tokenFactoryOptionsType`.
 * @property {string=} accountsURL  See `tokenFactoryOptionsType`.
 * @property {boolean=} unrestrictedToken See `tokenFactoryOptionsType`.
 * @property {number=} durationInSec See `tokenFactoryOptionsType`.
 * @property {Object=} securityClient See `tokenFactoryOptionsType`.
 * @property {number=} timeSmooth See `timeAdjusterOptionsType`.
 * @property {number=} timeMaxRTT  See `timeAdjusterOptionsType`.
 * @property {number=} timeMaxWindow  See `timeAdjusterOptionsType`.
 */


/**
 * @global
 * @typedef {Object} timeAdjusterOptionsType
 * @property {number=} timeSmooth Low pass filter coefficient.
 * Defaults to `1.0`, i.e., no filtering.
 * @property {number=} timeMaxRTT Maximum round trip time in msec before we
 * ignore it.
 * @property {number=} timeMaxWindow Size of the historical window. The
 *  algorithm  picks the quickest roundtrip in that window.
 */


/**
 * @global
 * @typedef {Object.<string, Object>} ctxType
 */
