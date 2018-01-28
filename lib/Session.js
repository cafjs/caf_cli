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
 * The type `caf.sessionOptions` defines the configuration properties for a
 * session:
 *
 *     {token: string, ca: string, from: string, session: string,
 *      appPublisher: string, appLocalName: string, disableBackchannel: boolean,
 *      maxRetries: number, retryTimeoutMsec: number, timeoutMsec: number,
 *      cacheKey: string,
 *      log: function(string),
 *      newToken: function(caf.msg, caf.cb),
 *      newURL: function(caf.msg, caf.cb),
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
 *  * `log`: custom function to log messages.
 *  * `newToken`: custom function to negotiate an authentication token.
 *  * `newURL`: custom function to redirect the session.
 *  * `timeAdjuster`: custom object to synchronize clocks with the cloud.
 *
 *  see {@link module:caf_cli/TokenFactory} for other options.
 *
 * @module caf_cli/Session
 */
var urlParser = require('url');
var global = (function() { return this; })() || (0, eval)('this');
// browserify ignores 'ws'
var WebSocket = global.WebSocket || global.MozWebSocket || require('ws');

var json_rpc = require('caf_transport').json_rpc;
var Queue = require('./Queue').Queue;
var querystring = require('querystring');
var tf = require('./TokenFactory');

var TokenFactory = exports.TokenFactory = tf.TokenFactory;
var TimeAdjuster = exports.TimeAdjuster = require('./TimeAdjuster')
        .TimeAdjuster;

var EVENTS = ['close', 'message', 'open'];

var DEFAULT_MAX_RETRIES=1000000000000000; // retry forever

var DEFAULT_RETRY_TIMEOUT_MSEC=1000;

/* Timeout to close a session if it cannot sent messages during that time.*/
var DEFAULT_TIMEOUT_MSEC=25000;

var MULTI_METHOD = '__external_ca_multi__';

var cryptoSession = require('./cryptoSession');

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
 * @param {caf.sessionOptions=} options Configuration for this session.
 *
 * @return {Session} A session object.
 *
 * @memberof! module:caf_cli/Session
 * @alias Session
 */
exports.Session = function(url, caId, options) {

    var safeSetImmediate = function(f) {
        if ((typeof window === 'undefined') && setImmediate) {
            setImmediate(f);
        } else {
            // 4ms delay in many browsers...
            setTimeout(f, 0);
        }
    };

    var mixin = function(dest, source) {
        source = source || {};
        Object.keys(source).forEach(function(x) {
            if (source.hasOwnProperty(x)) {
                dest[x] = source[x];
            }
        });
    };

    var cloneOptions = function(obj) {
        var result = {};
        mixin(result, obj);
        return result;
    };

    var multi = null;

    var crypto = null;

    options = cloneOptions(options);
    options.token = options.token || json_rpc.DUMMY_TOKEN;
    options.from = options.from || json_rpc.DEFAULT_FROM;
    options.session = options.session || json_rpc.DEFAULT_SESSION;
    // eslint-disable-next-line
    options.log = options.log || function(msg) { console.log(msg);};

    var newHash = function(keys) {
        var result = {};
        keys.forEach(function(key) {
            if (options[key] !== undefined) {
                result[key] = options[key];
            }
        });
        return result;
    };

    options.newToken = options.newToken || function(msg, cb) {
        try {
            var root = (0, eval)('this');
            if (root && root.location && root.location.href) {
                // In the browser, just redirect...
                var accountsURL = tf.getAccountsURL(options, msg);
                var accURL = urlParser.parse(accountsURL);
                var hashObj = newHash([
                    'from', 'ca', 'session', 'disableBackchannel',
                    'durationInSec', 'unrestrictedToken'
                ]);
                hashObj.goTo = url;
                accURL.hash = '#' + querystring.stringify(hashObj);
                root.location.href = urlParser.format(accURL);
            } else {
                // node.js client
                var tokenF = new TokenFactory(options);
                tokenF.newToken(msg, cb);
            }
        } catch (err) {
            cb(err);
        }
    };

    options.timeAdjuster = options.timeAdjuster || new TimeAdjuster(options);

    var parsedURL = urlParser.parse(url);
    if (parsedURL.query) {
        mixin(options, querystring.parse(parsedURL.query));
    }
    if (parsedURL.hash && (parsedURL.hash.indexOf('#') === 0)) {
        mixin(options, querystring.parse(parsedURL.hash.slice(1)));
    }
    parsedURL.protocol = (parsedURL.protocol === 'http:' ?
                          'ws:': parsedURL.protocol);
    parsedURL.protocol = (parsedURL.protocol === 'https:' ?
                          'wss:': parsedURL.protocol);
    parsedURL.search = null; //remove query
    parsedURL.hash = null; // remove fragment

    try {
        var h = json_rpc.splitName(parsedURL.hostname.split('.')[0]);
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
        var newUrl = json_rpc.redirectDestination(msg);
        newUrl = parsedURL.protocol + '//' + newUrl;
        if (newUrl) {
            cb(null, newUrl);
        } else {
            var err = new Error('Not a valid redirection message');
            err.msg = msg;
            cb(err);
        }
    };
    options.maxRetries = ((typeof options.maxRetries === 'number') ?
                          options.maxRetries : DEFAULT_MAX_RETRIES);
    options.retryTimeoutMsec =
        ((typeof options.retryTimeoutMsec === 'number') ?
         options.retryTimeoutMsec : DEFAULT_RETRY_TIMEOUT_MSEC);

    options.timeoutMsec =
        ((typeof options.timeoutMsec === 'number') ?
         options.timeoutMsec : DEFAULT_TIMEOUT_MSEC);

    //options.disableBackchannel= <boolean>

    var that = {};

    var currentUrl = url;

    var listeners = {};

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

    var queues = {rpc: Queue(caId, options), backchannel: Queue(caId, options)};

    var doQueues = function(f) {
        Object.keys(queues).forEach(function(x) { f(x);});
    };

    var retry = function() {
        doQueues(function(x) { queues[x].retry(webSocket, options.token);});
    };

    var progress = function() {
        var result = true;
        doQueues(function(x) { if (!queues[x].progress()) { result = false;}});
        return result;
    };


    var addMethods = function(meta) {

        var multiInvoke = function(f) {
            queues.rpc.remoteInvoke(webSocket, MULTI_METHOD,
                                    meta[MULTI_METHOD], [multi, f]);
            multi = null;
        };

        Object.keys(meta)
            .forEach(function(x) {
                that[x] = that[x] || function() {
                    var args = Array.prototype.slice.call(arguments);
                    // if last argument not a function: multi-method or promise
                    if ((args.length > 0) &&
                        (typeof args[args.length -1] === 'function')) {
                        if (multi === null) {
                            queues.rpc.remoteInvoke(webSocket, x, meta[x],
                                                    args);
                        } else {
                            var f = args.pop();
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
                var err = new Error('No methods to call');
                throw err;
            } else {
                return new Promise(function(resolve, reject) {
                    var cb = function(err, data) {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(data);
                        }
                    };
                    if (multi.length === 1) {
                        // normal call
                        var method = multi[0].method;
                        var args = multi[0].args;
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

    var addBackchannel = function() {
        var cb = function(err, msg) {
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

    var startTimeout = function() {
        return setInterval(function() {
            if (!progress()) {
                var err = new Error('Timeout');
                err.timeout = true;
                that.close(err);
            } else {
                numRetries = 0;
            }
        }, options.timeoutMsec);
    };


    // Internal WebSocket event handlers that delegate to external ones.

    var onopen = function() {
        var cb = function(err, meta) {
            if (err) {
                var error =
                        new Error('BUG: __external_ca_touch__ ' +
                                  'should not return app error');
                error.err = err;
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
            queues.rpc.remoteInvoke(webSocket, '__external_ca_touch__', [],
                                    [cb]);
        } else {
            retry();
        }
    };

    var recover = function(msg, err) {
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
                var error = new Error('Max retries exceeded');
                error.err = err;
                error.maxRetriesExceeded = true;
                that.close(error);
            }
        }
    };

    var onclose = function(err) {
        recover('Closed WebSocket: error ', err);
    };

    var onerror = function(err) {
        recover('Error in websocket ', err);
    };

    var onmessage = function(ev) {
        try {
            var msg = JSON.parse(ev.data);
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
    var handleMsg = function(msg) {
        if (json_rpc.isSystemError(msg)) {
            if (json_rpc.isRedirect(msg)) {
                var cb = function(err, newUrl) {
                    if (err) {
                        that.close(err);
                    } else {
                        currentUrl = newUrl;
                        resetWebSocket();
                    }
                };
                options.newURL(msg, cb);
            } else if (json_rpc.isNotAuthenticated(msg)) {
                var cb0 = function(err, token) {
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
                that.close(msg);
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

    var newWebSocket = function() {
        options.log('new WebSocket:' + currentUrl);
        webSocket = new WebSocket(currentUrl);
        webSocket.onclose = onclose;
        webSocket.onmessage = onmessage;
        webSocket.onopen = onopen;
        webSocket.onerror = onerror;
    };

    var closeWebSocket = function() {
        if (webSocket) {
            webSocket.onclose = null;
            webSocket.onmessage = null;
            webSocket.onopen = null;
            // leave 'onerror' to avoid 'error' bringing down the process.
            webSocket.onerror = function() {};
            var old = webSocket;
            webSocket = null;
            try {
                old.close();
            } catch (ex) {
                options.log('Exception closing websocket: ' + ex);
            }
        }
    };

    var resetWebSocket = function() {
        closeWebSocket();
        newWebSocket();
    };

    /**
     * Close the session.
     *
     * A session cannot be re-opened, a new one needs to be created.
     *
     * @param {Error} err An error to propagate in the handler.
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
            crypto = cryptoSession.newInstance();
        }
        return crypto;
    };

    /**
     * Returns the estimated time shift in msec between server and client
     *  clocks.
     *
     * Add this value to the current time to match server time, e.g.:
     *
     *      var now = new Date().getTime();
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
        var old = options.session;
        options.session = newSession;
        return old;
    };

    EVENTS.forEach(function(method) {
        var prop = 'on' + method;
        var desc = {
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
        var prop = 'on' + method;
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
    var token = null;
    var parsedURL = urlParser.parse(urlStr);
    if (parsedURL.hash && (parsedURL.hash.indexOf('#') === 0)) {
        var hash = querystring.parse(parsedURL.hash.slice(1));
        token = hash.token;
    }
    return token;
};

/**
 * Helper function to extract a spec in a URL fragment.
 *
 * type of `caf.specURL`is
 *
 *    { appProtocol : string, appPublisher: string, appLocalName: string,
 *       appSuffix: string, myId: string}
 *
 * @param {string} urlStr A serialized URL
 * @return {caf.specURL} Metadata extracted from  that URL.
 *
 * @memberof! module:caf_cli/Session
 * @alias extractSpecFromURL
 */
exports.extractSpecFromURL = function(urlStr) {
    var result = {};
    var parsedURL = urlParser.parse(urlStr);
    if (parsedURL.hash && (parsedURL.hash.indexOf('#') === 0)) {
        var hash = querystring.parse(parsedURL.hash.slice(1));
        result.myId = hash.from;
    }
    result.appProtocol = (parsedURL.protocol === 'http:' ? 'http' : 'https');
    var hostSplit = parsedURL.host.split('.');
    var name = json_rpc.splitName(hostSplit.shift());
    result.appPublisher = name[0];
    result.appLocalName = name[1];
    result.appSuffix = hostSplit.join('.');
    return result;
};

/** Gets original method arguments from message.
 *
 * @param {caf.msg} msg A message
 * @return {Array.<caf.json>} An array with method arguments.
 * @throws {Error} when invalid message.
 *
 * @memberof! module:caf_cli/Session
 * @alias getMethodArgs
 */
exports.getMethodArgs = function(msg) {
    return json_rpc.getMethodArgs(msg);
};


/**
 * Adds a fragment to a URL with some metadata and, if needed, rewrite hostname.
 *
 * The type of `caf.cliProps` is:
 *
 *       {caOwner: string, caLocalName: string, appPublisher: string,
 *        appLocalName: string, token: string, cacheKey: string}
 *
 * @param {string} url A URL to patch.
 * @param {caf.cliProps} props Properties to add to the URL fragment.
 * @return {string} A patched URL.
 *
 * @memberof! module:caf_cli/Session
 * @alias patchURL
 */
exports.patchURL = function(url, props) {

    var options = {};
    var parsedURL = urlParser.parse(url);
    if (parsedURL.hash && (parsedURL.hash.indexOf('#') === 0)) {
        options = querystring.parse(parsedURL.hash.slice(1));
    }
    if (props.caOwner && props.caLocalName) {
        var caName = props.caOwner + json_rpc.NAME_SEPARATOR +
                props.caLocalName;
        options.ca = caName;
        options.from = caName;
    }
    if (props.token) {
        options.token = props.token;
    }

    if (props.appPublisher && props.appLocalName) {
        var app = props.appPublisher + json_rpc.NAME_SEPARATOR +
                props.appLocalName;
        var splitHost = parsedURL.host.split('.');
        splitHost[0] = app;
        parsedURL.host = splitHost.join('.');
    }

    parsedURL.hash = '#' + querystring.stringify(options);

    var optionsQuery = {};
    if (props.cacheKey) {
        if (parsedURL.search && (parsedURL.search.indexOf('?') === 0)) {
            optionsQuery = querystring.parse(parsedURL.search.slice(1));
        }
        optionsQuery.cacheKey = props.cacheKey;
        parsedURL.search = '?' + querystring.stringify(optionsQuery);
    }

    return urlParser.format(parsedURL);
};
