// Modifications copyright 2020 Caf.js Labs and contributors
/*!
 Copyright 2013 Hewlett-Packard Development Company, L.P.

 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

 http://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
 */

'use strict';

/**
 * A session object to interact with a CA.
 *
 * Remote invocations are always serialized. The session locally buffers new
 * requests until the previous ones have been processed.
 *
 * In case of a system error, the session will try to transparently recover,
 * typically by retrying, or refreshing a token, or redirecting....
 *
 * If successful, the client just experiences a delay. Otherwise, the session
 * closes, propagating the error in the `onclose` handler (the `onerror`
 *  handler is for *internal use* only).
 *
 * If a client wants parallel requests, it needs to create multiple sessions
 * with its CA. Parallel requests may improve performance with high network
 * latency, but requests are always executed serially by the CA.
 *
 * The type `sessionOptionsType` defines the configuration properties for a
 * session:
 *
 *     {token: string, ca: string, from: string, session: string,
 *      appPublisher: string, appLocalName: string, disableBackchannel: boolean,
 *      maxRetries: number, retryTimeoutMsec: number, timeoutMsec: number,
 *      cacheKey: string, initUser: boolean, maxQueueLength: boolean,
 *      log: function(string),
 *      newToken: function(caf.msg, cbType),
 *      newUser: function(url: string, options: sessionOptionsType, cbType),
 *      newURL: function(caf.msg, cbType),
 *      timeAdjuster: TimeAdjuster()} + TokenFactory.options
 *
 *  All options except `ca` and `from` (and `token` with security active)
 *  have sensible defaults. Options can be properties in a URL fragment.
 *
 *  Where:
 *  * `token`: Authentication token for the `from` principal.
 *  * `ca`: name of the target CA, of the form `<caOwner>-<caLocalName>`.
 *  * `from`: name of the source CA, or equal to `ca` if the client is the
 * owner. An owner transparently creates a missing CA the first time it tries
 * to access it.
 *  * `session`: the logical session id (see {@link external:caf_session}).
 *  * `appPublisher`: the publisher of this app.
 *  * `appLocalName`: the local name of the app. By convention the hostname in
 * the target URL is `appPublisher-appLocalName`, e.g.,
 * `https://root-helloworld.cafjs.com`.
 *  * `disableBackchannel` No notifications are needed, disable the backchannel.
 *  * `maxRetries`: Number of error retries before closing a session. If
 * progress, they reset every `timeoutMsec`.
 *  * `retryTimeoutMsec`: Time between retries in miliseconds.
 *  * `timeoutMsec`: Max time in miliseconds for a request before
 * assuming an irrecoverable error, and closing the session.
 *  * `cacheKey`: custom key to cache server side rendering.
 *  * `initUser`: Whether the owner in `from` is a new user that
 * has to be registered.
 *  * `maxQueueLength`: The maximum queue length of non-started requests.
 *  * `log`: custom function to log messages.
 *  * `newToken`: custom function to negotiate an authentication token.
 *  * `newURL`: custom function to redirect the session.
 *  * `newUser`: custom function to initialize a new user.
 *  * `timeAdjuster`: custom object to synchronize clocks with the cloud.
 *
 *  see {@link module:caf_cli/TokenFactory} for other options.
 *
 * @module caf_cli/Session
 */
const urlParser = require('url');
const crypto = require('crypto');
const global = (function() { return this; })() || (0, eval)('this');
// browserify ignores 'ws'
const WebSocket = global.WebSocket || global.MozWebSocket || require('ws');

const json_rpc = require('caf_transport').json_rpc;
const Queue = require('./Queue').Queue;
const querystring = require('querystring');
const CreateUser = require('./CreateUser');
const tf = require('./TokenFactory');
const TokenFactory = exports.TokenFactory = tf.TokenFactory;

const TimeAdjuster = require('./TimeAdjuster').TimeAdjuster;
exports.TimeAdjuster = TimeAdjuster;

const EVENTS = ['close', 'message', 'open'];

const DEFAULT_MAX_RETRIES=1000000000000000; // retry forever

const DEFAULT_RETRY_TIMEOUT_MSEC=1000;

/* Timeout to close a session if it cannot sent messages during that time.*/
const DEFAULT_TIMEOUT_MSEC=25000;

const MULTI_METHOD = '__external_ca_multi__';

const cryptoSession = require('./cryptoSession');

/**
 *  Constructor.
 *
 * A communication channel to interact with a CA using remote invocations
 * and notifications.
 *
 * @param {string} url A target URL. Properties similar to `caf.sessionOptions`
 * can be added with a URL fragment; if present, they have priority over the
 * arguments `caId` and `options`.
 * @param {string=} caId A name for the target CA.
 * @param {sessionOptionsType=} options Configuration for this session.
 *
 * @return {Object} A session object.
 *
 * @memberof! module:caf_cli/Session
 * @alias Session
 */
exports.Session = function(url, caId, options) {

    const safeSetImmediate = function(f) {
        if ((typeof window === 'undefined') && setImmediate) {
            setImmediate(f);
        } else {
            // 4ms delay in many browsers...
            setTimeout(f, 0);
        }
    };

    const mixin = function(dest, source) {
        source = source || {};
        Object.keys(source).forEach(function(x) {
            dest[x] = source[x];
        });
    };

    const cloneOptions = function(obj) {
        const result = {};
        mixin(result, obj);
        return result;
    };

    var multi = null;

    var crypto = null;

    options = /** @type {sessionOptionsType}*/ (cloneOptions(options));
    options.token = options.token || json_rpc.DUMMY_TOKEN;
    options.from = options.from || json_rpc.DEFAULT_FROM;
    options.session = options.session || json_rpc.DEFAULT_SESSION;
    // eslint-disable-next-line
    options.log = options.log || function(msg) { console.log(msg);};

    const newHash = function(keys) {
        const result = {};
        keys.forEach(function(key) {
            if (options[key] !== undefined) {
                result[key] = options[key];
            }
        });
        return result;
    };

    options.newToken = options.newToken || function(msg, cb) {
        try {
            const root = (0, eval)('this');
            if (root && root.location && root.location.href) {
                // In the browser, just redirect...
                const accountsURL = tf.getAccountsURL(options, msg);
                const accURL = urlParser.parse(accountsURL);
                const hashObj = newHash([
                    'from', 'ca', 'session', 'disableBackchannel',
                    'durationInSec', 'unrestrictedToken', 'disableCache',
                    'keepToken', 'newAccount'
                ]);
                hashObj['goTo'] = url;
                // {} does not assign to ParsedUrlQueryInput type?
                //@ts-ignore
                accURL.hash = '#' + querystring.stringify(hashObj);
                root.location.href = urlParser.format(accURL);
            } else {
                // node.js client
                const tokenF = TokenFactory(options);
                tokenF.newToken(msg, cb);
            }
        } catch (err) {
            cb(err);
        }
    };

    options.timeAdjuster = options.timeAdjuster || TimeAdjuster(options);

    const parsedURL = urlParser.parse(url);
    if (parsedURL.query) {
        mixin(options, querystring.parse(parsedURL.query));
    }
    if (parsedURL.hash && (parsedURL.hash.indexOf('#') === 0)) {
        mixin(options, querystring.parse(parsedURL.hash.slice(1)));
    }
    parsedURL.protocol = parsedURL.protocol === 'http:' ?
        'ws:':
        parsedURL.protocol;

    parsedURL.protocol = parsedURL.protocol === 'https:' ?
        'wss:':
        parsedURL.protocol;

    parsedURL.search = null; //remove query
    parsedURL.hash = null; // remove fragment

    try {
        const h = json_rpc.splitName(parsedURL.hostname.split('.')[0]);
        options.appPublisher = options.appPublisher || h[0];
        options.appLocalName = options.appLocalName || h[1];
    } catch (err) {
        options.log && options.log('Warning: hostname in url ' + url +
                                   ' is not of the form' +
                                   ' appPublisher-appLocalName \n Exception:' +
                                   err);
    }

    url = urlParser.format(parsedURL);
    caId = (options.ca ? options.ca : caId);
    options.ca = caId;

    options.newURL = options.newURL || function(msg, cb) {
        const newUrl = parsedURL.protocol + '//' +
                  json_rpc.redirectDestination(msg);
        if (newUrl) {
            cb(null, newUrl);
        } else {
            const err = new Error('Not a valid redirection message');
            err['msg'] = msg;
            cb(err);
        }
    };

    options.maxRetries = typeof options.maxRetries === 'number' ?
        options.maxRetries :
        DEFAULT_MAX_RETRIES;

    options.retryTimeoutMsec = typeof options.retryTimeoutMsec === 'number' ?
        options.retryTimeoutMsec :
        DEFAULT_RETRY_TIMEOUT_MSEC;

    options.timeoutMsec = typeof options.timeoutMsec === 'number' ?
        options.timeoutMsec :
        DEFAULT_TIMEOUT_MSEC;

    options.newUser = options.newUser || CreateUser.newUser;

    //options.disableBackchannel= <boolean>

    const that = {};

    var currentUrl = url;

    const listeners = {};

    // non-recoverable session shutdown
    var closed = false;

    var webSocket = null;

    var firstTime = true;

    var numRetries = 0;

    var timeout = null;

    /**
     * Whether the session is closed.
     *
     * A session cannot be re-opened, a new one needs to be created.
     *
     * @return {boolean} True if the session is closed.
     *
     * @memberof! module:caf_cli/Session#
     * @alias isClosed
     *
     */
    that.isClosed = function() {
        return closed;
    };

    const queues = {
        rpc: Queue(caId, options),
        backchannel: Queue(caId, options)
    };

    const doQueues = function(f) {
        Object.keys(queues).forEach(function(x) { f(x);});
    };

    const retry = function() {
        doQueues(function(x) { queues[x].retry(webSocket, options.token);});
    };

    const progress = function() {
        var result = true;
        doQueues(function(x) { if (!queues[x].progress()) { result = false;}});
        return result;
    };


    const addMethods = function(meta) {

        const multiInvoke = function(f) {
            queues.rpc.remoteInvoke(webSocket, MULTI_METHOD,
                                    meta[MULTI_METHOD], [multi, f]);
            multi = null;
        };

        Object.keys(meta)
            .forEach(function(x) {
                that[x] = that[x] || function() {
                    const args = Array.prototype.slice.call(arguments);
                    // if last argument not a function: multi-method or promise
                    if ((args.length > 0) &&
                        (typeof args[args.length -1] === 'function')) {
                        if (multi === null) {
                            queues.rpc.remoteInvoke(webSocket, x, meta[x],
                                                    args);
                        } else {
                            const f = args.pop();
                            multi.push({method: x, meta: meta[x], args: args});
                            multiInvoke(f);
                        }
                        return null; //end of chaining
                    } else {
                        multi = multi || [];
                        multi.push({method: x, meta: meta[x], args: args});
                        return that;
                    }
                };
            });

        /**
         * Invoke the pending method(s) and return a promise with the results.
         *
         *
         * @return {Promise} A promise with the results.
         *
         * @throws {Error} If there are no pending methods.
         *
         * @memberof! module:caf_cli/Session#
         * @alias getPromise
         *
         */
        that.getPromise = function() {
            if (multi === null) {
                const err = new Error('No methods to call');
                throw err;
            } else {
                return new Promise(function(resolve, reject) {
                    const cb = function(err, data) {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(data);
                        }
                    };
                    if (multi.length === 1) {
                        // normal call
                        const method = multi[0].method;
                        const args = multi[0].args;
                        args.push(cb);
                        multi = null;
                        that[method].apply(that, args);
                    } else {
                        // true multi-method call
                        multiInvoke(cb);
                    }
                });
            }
        };
    };

    const addBackchannel = function() {
        const cb = function(err, msg) {
            if (err) {
                if (err.timeout) {
                    if (!closed) {
                        safeSetImmediate(addBackchannel);
                    }
                } else {
                    options.log('Error in backchannel : to disable use ' +
                                "option 'disableBackchannel=true' Error:" +
                                JSON.stringify(err));
                    that.close(err);
                }
            } else {
                if (!closed) {
                    safeSetImmediate(addBackchannel);
                    if (listeners.message && json_rpc.isNotification(msg)) {
                        listeners.message(msg);
                    } else {
                        options.log('Ignoring backchannel message ' +
                                    JSON.stringify(msg));
                    }
                }
            }
        };
        if (!options.disableBackchannel && !closed) {
            queues.backchannel.remoteInvoke(webSocket, 'backchannel', [], [cb]);
        }
    };

    const startTimeout = function() {
        return setInterval(function() {
            if (!progress()) {
                const err = new Error('Timeout');
                err['timeout'] = true;
                that.close(err);
            } else {
                numRetries = 0;
            }
        }, options.timeoutMsec);
    };


    // Internal WebSocket event handlers that delegate to external ones.

    const onopen = function() {
        const cb = function(err, meta) {
            if (err) {
                const error = new Error('BUG: __external_ca_touch__ ' +
                                        'should not return app error');
                error['err'] = err;
                that.close(error);
            } else {
                addMethods(meta);
                addBackchannel();
                timeout = startTimeout();
                if (listeners.open) {
                    listeners.open();
                }
            }
        };
        if (firstTime) {
            firstTime = false;
            let startF = () => queues.rpc.remoteInvoke(webSocket,
                                                       '__external_ca_touch__',
                                                       [], [cb]);
            if (options.initUser) {
                options.newUser(url, options, function (err) {
                    if (err) {
                        cb(err);
                    } else {
                        startF();
                    }
                });
            } else {
                startF();
            }
        } else {
            retry();
        }
    };

    const recover = function(msg, err) {
        if (!closed) {
            options.log(msg + err);
            if (numRetries < options.maxRetries) {
                numRetries = numRetries + 1;
                setTimeout(function() {
                    options.log('Retrying...' + numRetries);
                    currentUrl = url; // original url
                    resetWebSocket();
                }, options.retryTimeoutMsec);
            } else {
                const error = new Error('Max retries exceeded');
                error['err'] = err;
                error['maxRetriesExceeded'] = true;
                that.close(error);
            }
        }
    };

    const onclose = function(err) {
        recover('Closed WebSocket: error ', err);
    };

    const onerror = function(err) {
        recover('Error in websocket ', err);
    };

    const onmessage = function(ev) {
        try {
            const msg = JSON.parse(ev.data);
            if (!handleMsg(msg)) {
                if (listeners.message && json_rpc.isNotification(msg)) {
                    listeners.message(msg);
                } else {
                    options.log('Ignoring message ' + ev.data);
                }
            }
        } catch (err) {
            options.log('Ignoring unparsable message ' + ev.data + ' error:' +
                        err);
        }
    };

    /**
     * Handles a CA message. We have the following cases:
     *
     * 1) No error -> route to appropriate queue.
     * 2) Application error -> route to appropriate queue.
     * 3) System error
     *   3-a) Redirect -> new WebSocket url + retry
     *   3-b) Security -> new token + retry
     *   3-c) Recoverable -> wait for timeout + retry
     *   3-d) Non-Recoverable -> close session/log error
     */
    const handleMsg = function(msg) {
        if (json_rpc.isSystemError(msg)) {
            if (json_rpc.isRedirect(msg)) {
                const cb = function(err, newUrl) {
                    if (err) {
                        that.close(err);
                    } else {
                        currentUrl = newUrl;
                        resetWebSocket();
                    }
                };
                options.newURL(msg, cb);
            } else if (json_rpc.isNotAuthenticated(msg)) {
                const cb0 = function(err, token) {
                    if (err) {
                        options.log(err);
                        that.close(err);
                    } else {
                        options.token = token;
                        // do not change url until authenticated
                        resetWebSocket();
                    }
                };
                //options.log('Not authenticated' + JSON.stringify(msg));
                options.newToken(msg, cb0);
            } else if (json_rpc.isErrorRecoverable(msg) &&
                       (numRetries < options.maxRetries)) {
                numRetries = numRetries + 1;
                setTimeout(function() {
                    currentUrl = url; // original url
                    resetWebSocket();
                }, options.retryTimeoutMsec);
            } else {
                // Non-recoverable error
                options.log(msg);
                const err = new Error('Non-recoverable error');
                err['msg'] = msg;
                that.close(err);
            }
            return true;
        } else if (json_rpc.isAppReply(msg)){
            return Object.keys(queues)
                .some(function(x) {
                    return queues[x].processAppReply(webSocket, msg);
                });
        } else {
            return false;
        }
    };

    const newWebSocket = function() {
        options.log('new WebSocket:' + currentUrl);
        webSocket = new WebSocket(currentUrl);
        webSocket.onclose = onclose;
        webSocket.onmessage = onmessage;
        webSocket.onopen = onopen;
        webSocket.onerror = onerror;
    };

    const closeWebSocket = function() {
        if (webSocket) {
            webSocket.onclose = null;
            webSocket.onmessage = null;
            webSocket.onopen = null;
            // leave 'onerror' to avoid 'error' bringing down the process.
            webSocket.onerror = function() {};
            const old = webSocket;
            webSocket = null;
            try {
                old.close();
            } catch (ex) {
                options.log('Exception closing websocket: ' + ex);
            }
        }
    };

    const resetWebSocket = function() {
        closeWebSocket();
        newWebSocket();
    };

    /**
     * Close the session.
     *
     * A session cannot be re-opened, a new one needs to be created.
     *
     * @param {Error} err An error to propagate in the handler. If available,
     * the message with the original exception is in `err.msg`.
     *
     * @memberof! module:caf_cli/Session#
     * @alias close
     *
     */
    that.close = function(err) {
        closed = true;
        Object.keys(queues).forEach(function(x) { queues[x].clear(); });
        closeWebSocket();
        if (timeout) {
            clearInterval(timeout);
        }
        if (listeners.close) {
            listeners.close(err);
        }
    };

    /**
     * Gets the number of messages in the queue.
     *
     *
     * @return {number} The number of queued messages.
     *
     * @memberof! module:caf_cli/Session#
     * @alias numPending
     *
     */
    that.numPending = function() {
        var result = 0;
        doQueues(function(x) { result = result + queues[x].numPending();});
        return result;
    };

    /**
     * Gets a unique key associated with a cached server-side rendering.
     *
     * @return {string} A key associated with a cached server-side rendering.
     *
     * @memberof! module:caf_cli/Session#
     * @alias getCacheKey
     *
     */
    that.getCacheKey = function() {
        return options.cacheKey;
    };

    /**
     * Gets a crypto object to generate DH keys.
     *
     * @return {Object} A crypto object to generate DH keys.
     *
     * @memberof! module:caf_cli/Session#
     * @alias getCrypto
     *
     */
    that.getCrypto = function() {
        if (!crypto) {
            crypto = cryptoSession.create();
        }
        return crypto;
    };

    /**
     * Returns the estimated time shift in msec between server and client
     *  clocks.
     *
     * Add this value to the current time to match server time, e.g.:
     *
     *      const now = new Date().getTime();
     *      now = now + session.getEstimatedTimeOffset();
     *
     * @return {number} Time shift in msec between server and client.
     *
     * @memberof! module:caf_cli/Session#
     * @alias getEstimatedTimeOffset
     */
    that.getEstimatedTimeOffset = function() {
        return options.timeAdjuster.getOffset();
    };

    /**
     * Changes the session identifier of future requests on this session.
     *
     * @param {string} newSession A new session identifier.
     * @return {string} The previous session identifier.
     *
     * @memberof! module:caf_cli/Session#
     * @alias changeSessionId
     */
    that.changeSessionId = function(newSession) {
        const old = options.session;
        options.session = newSession;
        return old;
    };

    EVENTS.forEach(function(method) {
        const prop = 'on' + method;
        const desc = {
            get: function() {
                return listeners[method];
            },
            set: function(newListener) {
                listeners[method] = newListener;
            }
        };
        Object.defineProperty(that, prop, desc);
    });

    EVENTS.forEach(function(method) {
        const prop = 'on' + method;
        if (typeof options[prop] === 'function') {
            that[prop] = options[prop];
        }
    });

    newWebSocket();

    return that;
};

exports.cbPrint = function(err, data) {
    if (err) {
        // eslint-disable-next-line
        console.log('Got error: ' + JSON.stringify(err));
    } else {
        // eslint-disable-next-line
        console.log('Got data: ' + JSON.stringify(data));
    }
};

/**
 * Helper function to extract a token encoded in a URL fragment.
 *
 * @param {string} urlStr A serialized URL
 * @return {string|null} A serialized token in that URL.
 *
 * @memberof! module:caf_cli/Session
 * @alias extractTokenFromURL
 */
exports.extractTokenFromURL = function(urlStr) {
    let token = null;
    const parsedURL = urlParser.parse(urlStr);
    if (parsedURL.hash && (parsedURL.hash.indexOf('#') === 0)) {
        const hash = querystring.parse(parsedURL.hash.slice(1));
        if (Array.isArray(hash.token)) {
            token = hash.token[0];
        } else if (typeof hash.token === 'string') {
            token = hash.token;
        }
    }
    return token;
};

/**
 * Helper function to delete a token encoded in a URL fragment.
 *
 * @param {string} urlStr A serialized URL
 * @return {string} A serialized URL without a token in its fragment.
 *
 * @memberof! module:caf_cli/Session
 * @alias deleteTokenFromURL
 */
exports.deleteTokenFromURL = function(urlStr) {
    const parsedURL = urlParser.parse(urlStr);
    if (parsedURL.hash && (parsedURL.hash.indexOf('#') === 0)) {
        const hash = querystring.parse(parsedURL.hash.slice(1));
        delete hash.token;
        parsedURL.hash = '#' + querystring.stringify(hash);
        return urlParser.format(parsedURL);
    } else {
        return urlStr;
    }
};

/**
 * Helper function to extract a spec in a URL fragment.
 *
 *
 * @param {string} urlStr A serialized URL
 * @return {specURLType} Metadata extracted from  that URL.
 *
 * @memberof! module:caf_cli/Session
 * @alias extractSpecFromURL
 */
exports.extractSpecFromURL = function(urlStr) {
    var myId = null;
    const parsedURL = urlParser.parse(urlStr);
    if (parsedURL.hash && (parsedURL.hash.indexOf('#') === 0)) {
        const hash = querystring.parse(parsedURL.hash.slice(1));
        if (Array.isArray(hash.from)) {
            myId = hash.from[0];
        } else if (typeof hash.from === 'string') {
            myId = hash.from;
        }
    }
    if (!myId) {
        const err = new Error("Missing 'from' field in URL");
        err['url'] = urlStr;
        throw err;
    }
    const appProtocol = (parsedURL.protocol === 'http:' ? 'http' : 'https');
    const hostSplit = parsedURL.host.split('.');
    const name = json_rpc.splitName(hostSplit.shift());
    const appPublisher = name[0];
    const appLocalName = name[1];
    const appSuffix = hostSplit.join('.');
    return {
        appPublisher: appPublisher,
        appLocalName: appLocalName,
        appSuffix: appSuffix,
        appProtocol: appProtocol,
        myId: myId
    };
};

/** Gets original method arguments from message.
 *
 * @param {msgType} msg A message
 * @return {Array.<jsonType>} An array with method arguments.
 * @throws {Error} when invalid message.
 *
 * @memberof! module:caf_cli/Session
 * @alias getMethodArgs
 */
exports.getMethodArgs = function(msg) {
    return json_rpc.getMethodArgs(msg);
};

/**
 * Returns a random string with capital letters and digits.
 *
 * @param {number} len The number of characters in the string.
 *
 * @return {string} The new string.
 *
 * @memberof! module:caf_cli/Session
 * @alias randomString
 */
exports.randomString = function(len) {
    const result = [];
    while (result.length < len) {
        const ch = crypto.randomBytes(1).readUInt8(0);
        if (((ch >= 48) && (ch < 58)) || ((ch >= 65) && (ch < 91))) {
            result.push(String.fromCharCode(ch));
        }
    }
    return result.join('');
};


/**
 * Adds a fragment to a URL with some metadata and, if needed, rewrites the
 * hostname.
 *
 * The definition of `cliPropsType` is in `types.js`.
 *
 * @param {string} url A URL to patch.
 * @param {cliPropsType} props Properties to add to the URL fragment.
 * @return {string} A patched URL.
 *
 * @memberof! module:caf_cli/Session
 * @alias patchURL
 */
exports.patchURL = function(url, props) {

    let options = {};
    const parsedURL = urlParser.parse(url);
    if (parsedURL.hash && (parsedURL.hash.indexOf('#') === 0)) {
        //@ts-ignore
        options = querystring.parse(parsedURL.hash.slice(1));
    }
    if (props.caOwner && props.caLocalName) {
        const caName = props.caOwner + json_rpc.NAME_SEPARATOR +
                  props.caLocalName;
        options['ca'] = caName;
        options['from'] = caName;
    }

    if (props.token) {
        options['token'] = props.token;
    }

    if (props.session) {
        options['session'] = props.session;
    }

    if (props.keepToken) {
        options['keepToken'] = props.keepToken;
    }

    if (props.appPublisher && props.appLocalName) {
        const app = props.appPublisher + json_rpc.NAME_SEPARATOR +
                  props.appLocalName;
        const splitHost = parsedURL.host.split('.');
        splitHost[0] = app;
        parsedURL.host = splitHost.join('.');
    }
    //@ts-ignore
    parsedURL.hash = '#' + querystring.stringify(options);

    let optionsQuery = {};
    if (props.cacheKey) {
        if (parsedURL.search && (parsedURL.search.indexOf('?') === 0)) {
            //@ts-ignore
            optionsQuery = querystring.parse(parsedURL.search.slice(1));
        }
        optionsQuery['cacheKey'] = props.cacheKey;
        //@ts-ignore
        parsedURL.search = '?' + querystring.stringify(optionsQuery);
    }

    return urlParser.format(parsedURL);
};
