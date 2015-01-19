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

"use strict";

var WebSocket = require('ws');
var json_rpc = require('caf_transport').json_rpc;
var Queue = require('./Queue').Queue;

var EVENTS = ['close', 'message', 'open'];

var DEFAULT_MAX_RETRIES=1000000000000000; // retry forever

var DEFAULT_RETRY_TIMEOUT_MSEC=1000;

/** Timeout to close a session if it cannot sent messages during that time.*/
var DEFAULT_TIMEOUT_MSEC=25000;

/**
 *
 * A communication channel with a CA for remote
 * invocations and notifications.
 *
 * @param {string} url A websocket address for the node.
 * @param {string} caId An identifier for the target CA.
 * @param {Object} options Configuration for this session.
 *
 * @return {Session} A session object (it can be invoked using 'new').
 * @constructor
 * @module caf_cli/Session
 */

var Session = exports.Session = function(url, caId, options) {
    var cloneOptions = function(obj) {
        obj = obj || {};
        var result = {};
        Object.keys(obj).forEach(function(x) { result[x] = obj[x];});
        return result;
    };

    var safeSetImmediate = function(f) {
        if (setImmediate) {
            setImmediate(f);
        } else {
            // 4ms delay in many browsers...
            setTimeout(f, 0);
        }
    };

    options = cloneOptions(options);
    options.token = options.token || json_rpc.DUMMY_TOKEN;
    options.from = options.from || json_rpc.DEFAULT_FROM;
    options.session = options.session || json_rpc.DEFAULT_SESSION;
    options.log = options.log || function(msg) { console.log(msg);};
    options.newToken = options.newToken || function(msg, cb) {
        cb('not implemented');
    };
    options.newURL = options.newURL || function(msg, cb) {
        var newUrl = json_rpc.redirectDestination(msg);
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

    var listeners = {};

    // non-recoverable session shutdown
    var closed = false;

    var webSocket = null;

    var firstTime = true;

    var numRetries = 0;

    var timeout = null;

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
        Object.keys(meta)
            .forEach(function(x) {
                         that[x] = function() {
                             var args = Array.prototype.slice.call(arguments);
                             queues.rpc.remoteInvoke(webSocket, x, meta[x],
                                                     args);
                         };
                     });
    };

    var addBackchannel = function() {
        var cb = function(err, notif) {
            if (err) {
                if (err.timeout) {
                    if (!closed) {
                        safeSetImmediate(addBackchannel);
                    }
                } else {
                    options.log("Error in backchannel : to disable use " +
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
        if (!options.disableBackchannel) {
            queues.backchannel.remoteInvoke(webSocket, 'backchannel', ['cb'],
                                            [cb]);
        }
    };

    var startTimeout = function() {
        return setInterval(function() {
                               if (!progress()) {
                                   var err = new Error('Timeout');
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
            queues.rpc.remoteInvoke(webSocket, '__external_ca_touch__', ['cb'],
                                [cb]);
        } else {
            retry();
        }
    };

    var onclose = function(err) {
        if (!closed) {
            options.log('Closed WebSocket: error ' + JSON.stringify(err));
            if (numRetries < options.maxRetries) {
                numRetries = numRetries + 1;
                setTimeout(function() {
                               options.log('Retrying...' + numRetries);
                               resetWebSocket();
                           }, options.retryTimeoutMsec);
            } else {
                that.close(err);
            }
        }
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
        } catch(err) {
            options.log('Ignoring unparsable message ' + ev.data);
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
                var cb = function(err, newURL) {
                    if (err) {
                        that.close(err);
                    } else {
                        url = newURL;
                        resetWebSocket();
                    }
                };
                options.newURL(msg, cb);
            } else if (json_rpc.isNotAuthorized(msg)) {
                var cb0 = function(err, token) {
                    if (err) {
                        that.close(err);
                    } else {
                        options.token = token;
                        resetWebSocket();
                    }
                };
                options.newToken(msg, cb0);
            } else if (json_rpc.isErrorRecoverable(msg) &&
                       (numRetries < options.maxRetries)) {
                numRetries = numRetries + 1;
                setTimeout(function() {
                               resetWebSocket();
                           }, options.retryTimeoutMsec);
            } else {
                // Non-recoverable error
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

    var newWebSocket =  function() {
        webSocket = new WebSocket(url);
        webSocket.onclose = onclose;
        webSocket.onmessage = onmessage;
        webSocket.onopen = onopen;
    };

    var closeWebSocket = function() {
        if (webSocket) {
            webSocket.close();
            webSocket.onclose = null;
            webSocket.onmessage = null;
            webSocket.onopen = null;
            webSocket = null;
        }
    };

    var resetWebSocket = function() {
        closeWebSocket();
        newWebSocket();
    };

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

    EVENTS.forEach(function(method) {
                       var prop = 'on' + method;
                       var desc =  {
                           get: function() {
                               return listeners[method];
                           },
                           set : function(newListener) {
                               listeners[method] = newListener;
                           }
                       };
                       Object.defineProperty(that, prop, desc);
                   });

    newWebSocket();

    return that;
};

exports.cbPrint = function(err, data) {
    if (err) {
        console.log('Got error: ' + JSON.stringify(err));
    } else {
        console.log('Got data: ' + JSON.stringify(data));
    };
};
