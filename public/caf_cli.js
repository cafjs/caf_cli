require=(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
/*!
Copyright 2014 Hewlett-Packard Development Company, L.P.

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

var json_rpc = require('caf_transport').json_rpc;

/**
 * A queue of pending requests.
 *
 * @module caf_cli/Queue
 */
var Queue = exports.Queue = function(caId, options) {
    var queue = [];
    var that = {};
    var pending = null;
    var messagesProcessed = 0;
    var lastMessagesProcessed = -1;

    // duplicate, move to util
    var safeSetImmediate = function(f) {
        if ((typeof window === 'undefined') && setImmediate) {
            setImmediate(f);
        } else {
            // 4ms delay in many browsers...
            setTimeout(f, 0);
        }
    };

    that.numPending = function() {
       return queue.length + (pending ? 1 : 0);
    };

    that.clear = function() {
        queue = [];
        pending = null;
        messagesProcessed = 0;
        lastMessagesProcessed = -1;
    };

    that.progress = function() {
        var result = true;
        if ((messagesProcessed === lastMessagesProcessed) &&
            ((queue.length > 0) || pending)) {
            result = false;
        }
        lastMessagesProcessed = messagesProcessed;
        return result;
    };

    var drain = function(webSocket) {
        if ((queue.length === 0) || pending) { // no message pipelining
            return;
        }
        pending = queue.shift();
        try {
            webSocket.send(JSON.stringify(pending.req), function(err) {
                               if (err) {
                                   /* Cannot send, wait for a new websocket that
                                    * with its open event will trigger 'retry'.
                                    *
                                    */
                                   options.log('Error sending request ' + err);
                               }
                           });
        } catch(err) {
             options.log('Exception sending request ' + err);
        }
    };

    that.retry = function(webSocket, newToken) {
        if (pending) {
            queue.unshift(pending);
            pending = null;
        }
        if (newToken) {
            queue.forEach(function(x) {
                              json_rpc.setToken(x.req, newToken);
                          });
        }
        drain(webSocket);
    };

    that.remoteInvoke = function(webSocket, method, expectedArgs, args) {
        var doThrow = function(msg) {
            var err =  new Error(msg);
            err.method = method;
            err.args = args;
            err.expectedArgs = expectedArgs;
            throw err;
        };

        if (typeof method !== 'string') {
            doThrow('method name is not a string');
        }
        if (!Array.isArray(args)) {
            doThrow('args not an array');
        }
        if (!Array.isArray(expectedArgs)) {
            doThrow('expectedArgs not an array');
        }
        if (args.length !== expectedArgs.length) {
            doThrow('Unexpected number of arguments');
        }

        var cb = args.pop();
        if (typeof cb !== 'function') {
            doThrow('No callback');
        }
        var all = [options.token, caId, options.from, options.session, method]
            .concat(args);

        var req = json_rpc.request.apply(json_rpc.request, all);
        queue.push({cb: cb, req : req});
        drain(webSocket);
    };

    that.processAppReply = function(webSocket, reply) {
        if (pending && pending.req && (reply.id === pending.req.id) &&
            (json_rpc.isAppReply(reply))) {
            var cb = pending.cb;
            var err = json_rpc.getAppReplyError(reply);
            var data = json_rpc.getAppReplyData(reply);
            safeSetImmediate(function() { cb(err, data);});
            pending = null;
            messagesProcessed = messagesProcessed + 1;
            drain(webSocket);
            return true;
        } else {
            return false;
        }
    };

    return that;
};

},{"caf_transport":9}],2:[function(require,module,exports){
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
var urlParser = require('url');
var WebSocket = require('ws');
var json_rpc = require('caf_transport').json_rpc;
var Queue = require('./Queue').Queue;
var querystring = require('querystring');

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
 * @param {string} url A websocket address for the node or a URL using query
 *  parameters to provide the CA name ('ca=XXX'), security token ('token=YYY'),
 * and other options. The 'url' query parameters have precedence over the
 * optional 'options' or 'caId' parameters.
 * @param {string=} caId An identifier for the target CA.
 * @param {Object=} options Configuration for this session.
 *
 * @return {Session} A session object (it can be invoked using 'new').
 * @constructor
 * @module caf_cli/Session
 */

var Session = exports.Session = function(url, caId, options) {

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

    var tokenFactory = null;

    options = cloneOptions(options);
    options.token = options.token || json_rpc.DUMMY_TOKEN;
    options.from = options.from || json_rpc.DEFAULT_FROM;
    options.session = options.session || json_rpc.DEFAULT_SESSION;
    options.log = options.log || function(msg) { console.log(msg);};
    options.newToken = options.newToken || function(msg, cb) {
        throw new Error('not implemented');
    };
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
        var cb = function(err, msg) {
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
        if (!options.disableBackchannel && !closed) {
            queues.backchannel.remoteInvoke(webSocket, 'backchannel', ['cb'],
                                            [cb]);
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
            queues.rpc.remoteInvoke(webSocket, '__external_ca_touch__', ['cb'],
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
        } catch(err) {
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

    var newWebSocket =  function() {
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

    that.numPending = function() {
        var result = 0;
        doQueues(function(x) { result = result + queues[x].numPending();});
        return result;
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

},{"./Queue":1,"caf_transport":9,"querystring":7,"url":8,"ws":12}],3:[function(require,module,exports){
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
module.exports = require('./Session');


},{"./Session":2}],4:[function(require,module,exports){
(function (global){
/*! http://mths.be/punycode v1.2.4 by @mathias */
;(function(root) {

	/** Detect free variables */
	var freeExports = typeof exports == 'object' && exports;
	var freeModule = typeof module == 'object' && module &&
		module.exports == freeExports && module;
	var freeGlobal = typeof global == 'object' && global;
	if (freeGlobal.global === freeGlobal || freeGlobal.window === freeGlobal) {
		root = freeGlobal;
	}

	/**
	 * The `punycode` object.
	 * @name punycode
	 * @type Object
	 */
	var punycode,

	/** Highest positive signed 32-bit float value */
	maxInt = 2147483647, // aka. 0x7FFFFFFF or 2^31-1

	/** Bootstring parameters */
	base = 36,
	tMin = 1,
	tMax = 26,
	skew = 38,
	damp = 700,
	initialBias = 72,
	initialN = 128, // 0x80
	delimiter = '-', // '\x2D'

	/** Regular expressions */
	regexPunycode = /^xn--/,
	regexNonASCII = /[^ -~]/, // unprintable ASCII chars + non-ASCII chars
	regexSeparators = /\x2E|\u3002|\uFF0E|\uFF61/g, // RFC 3490 separators

	/** Error messages */
	errors = {
		'overflow': 'Overflow: input needs wider integers to process',
		'not-basic': 'Illegal input >= 0x80 (not a basic code point)',
		'invalid-input': 'Invalid input'
	},

	/** Convenience shortcuts */
	baseMinusTMin = base - tMin,
	floor = Math.floor,
	stringFromCharCode = String.fromCharCode,

	/** Temporary variable */
	key;

	/*--------------------------------------------------------------------------*/

	/**
	 * A generic error utility function.
	 * @private
	 * @param {String} type The error type.
	 * @returns {Error} Throws a `RangeError` with the applicable error message.
	 */
	function error(type) {
		throw RangeError(errors[type]);
	}

	/**
	 * A generic `Array#map` utility function.
	 * @private
	 * @param {Array} array The array to iterate over.
	 * @param {Function} callback The function that gets called for every array
	 * item.
	 * @returns {Array} A new array of values returned by the callback function.
	 */
	function map(array, fn) {
		var length = array.length;
		while (length--) {
			array[length] = fn(array[length]);
		}
		return array;
	}

	/**
	 * A simple `Array#map`-like wrapper to work with domain name strings.
	 * @private
	 * @param {String} domain The domain name.
	 * @param {Function} callback The function that gets called for every
	 * character.
	 * @returns {Array} A new string of characters returned by the callback
	 * function.
	 */
	function mapDomain(string, fn) {
		return map(string.split(regexSeparators), fn).join('.');
	}

	/**
	 * Creates an array containing the numeric code points of each Unicode
	 * character in the string. While JavaScript uses UCS-2 internally,
	 * this function will convert a pair of surrogate halves (each of which
	 * UCS-2 exposes as separate characters) into a single code point,
	 * matching UTF-16.
	 * @see `punycode.ucs2.encode`
	 * @see <http://mathiasbynens.be/notes/javascript-encoding>
	 * @memberOf punycode.ucs2
	 * @name decode
	 * @param {String} string The Unicode input string (UCS-2).
	 * @returns {Array} The new array of code points.
	 */
	function ucs2decode(string) {
		var output = [],
		    counter = 0,
		    length = string.length,
		    value,
		    extra;
		while (counter < length) {
			value = string.charCodeAt(counter++);
			if (value >= 0xD800 && value <= 0xDBFF && counter < length) {
				// high surrogate, and there is a next character
				extra = string.charCodeAt(counter++);
				if ((extra & 0xFC00) == 0xDC00) { // low surrogate
					output.push(((value & 0x3FF) << 10) + (extra & 0x3FF) + 0x10000);
				} else {
					// unmatched surrogate; only append this code unit, in case the next
					// code unit is the high surrogate of a surrogate pair
					output.push(value);
					counter--;
				}
			} else {
				output.push(value);
			}
		}
		return output;
	}

	/**
	 * Creates a string based on an array of numeric code points.
	 * @see `punycode.ucs2.decode`
	 * @memberOf punycode.ucs2
	 * @name encode
	 * @param {Array} codePoints The array of numeric code points.
	 * @returns {String} The new Unicode string (UCS-2).
	 */
	function ucs2encode(array) {
		return map(array, function(value) {
			var output = '';
			if (value > 0xFFFF) {
				value -= 0x10000;
				output += stringFromCharCode(value >>> 10 & 0x3FF | 0xD800);
				value = 0xDC00 | value & 0x3FF;
			}
			output += stringFromCharCode(value);
			return output;
		}).join('');
	}

	/**
	 * Converts a basic code point into a digit/integer.
	 * @see `digitToBasic()`
	 * @private
	 * @param {Number} codePoint The basic numeric code point value.
	 * @returns {Number} The numeric value of a basic code point (for use in
	 * representing integers) in the range `0` to `base - 1`, or `base` if
	 * the code point does not represent a value.
	 */
	function basicToDigit(codePoint) {
		if (codePoint - 48 < 10) {
			return codePoint - 22;
		}
		if (codePoint - 65 < 26) {
			return codePoint - 65;
		}
		if (codePoint - 97 < 26) {
			return codePoint - 97;
		}
		return base;
	}

	/**
	 * Converts a digit/integer into a basic code point.
	 * @see `basicToDigit()`
	 * @private
	 * @param {Number} digit The numeric value of a basic code point.
	 * @returns {Number} The basic code point whose value (when used for
	 * representing integers) is `digit`, which needs to be in the range
	 * `0` to `base - 1`. If `flag` is non-zero, the uppercase form is
	 * used; else, the lowercase form is used. The behavior is undefined
	 * if `flag` is non-zero and `digit` has no uppercase form.
	 */
	function digitToBasic(digit, flag) {
		//  0..25 map to ASCII a..z or A..Z
		// 26..35 map to ASCII 0..9
		return digit + 22 + 75 * (digit < 26) - ((flag != 0) << 5);
	}

	/**
	 * Bias adaptation function as per section 3.4 of RFC 3492.
	 * http://tools.ietf.org/html/rfc3492#section-3.4
	 * @private
	 */
	function adapt(delta, numPoints, firstTime) {
		var k = 0;
		delta = firstTime ? floor(delta / damp) : delta >> 1;
		delta += floor(delta / numPoints);
		for (/* no initialization */; delta > baseMinusTMin * tMax >> 1; k += base) {
			delta = floor(delta / baseMinusTMin);
		}
		return floor(k + (baseMinusTMin + 1) * delta / (delta + skew));
	}

	/**
	 * Converts a Punycode string of ASCII-only symbols to a string of Unicode
	 * symbols.
	 * @memberOf punycode
	 * @param {String} input The Punycode string of ASCII-only symbols.
	 * @returns {String} The resulting string of Unicode symbols.
	 */
	function decode(input) {
		// Don't use UCS-2
		var output = [],
		    inputLength = input.length,
		    out,
		    i = 0,
		    n = initialN,
		    bias = initialBias,
		    basic,
		    j,
		    index,
		    oldi,
		    w,
		    k,
		    digit,
		    t,
		    /** Cached calculation results */
		    baseMinusT;

		// Handle the basic code points: let `basic` be the number of input code
		// points before the last delimiter, or `0` if there is none, then copy
		// the first basic code points to the output.

		basic = input.lastIndexOf(delimiter);
		if (basic < 0) {
			basic = 0;
		}

		for (j = 0; j < basic; ++j) {
			// if it's not a basic code point
			if (input.charCodeAt(j) >= 0x80) {
				error('not-basic');
			}
			output.push(input.charCodeAt(j));
		}

		// Main decoding loop: start just after the last delimiter if any basic code
		// points were copied; start at the beginning otherwise.

		for (index = basic > 0 ? basic + 1 : 0; index < inputLength; /* no final expression */) {

			// `index` is the index of the next character to be consumed.
			// Decode a generalized variable-length integer into `delta`,
			// which gets added to `i`. The overflow checking is easier
			// if we increase `i` as we go, then subtract off its starting
			// value at the end to obtain `delta`.
			for (oldi = i, w = 1, k = base; /* no condition */; k += base) {

				if (index >= inputLength) {
					error('invalid-input');
				}

				digit = basicToDigit(input.charCodeAt(index++));

				if (digit >= base || digit > floor((maxInt - i) / w)) {
					error('overflow');
				}

				i += digit * w;
				t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);

				if (digit < t) {
					break;
				}

				baseMinusT = base - t;
				if (w > floor(maxInt / baseMinusT)) {
					error('overflow');
				}

				w *= baseMinusT;

			}

			out = output.length + 1;
			bias = adapt(i - oldi, out, oldi == 0);

			// `i` was supposed to wrap around from `out` to `0`,
			// incrementing `n` each time, so we'll fix that now:
			if (floor(i / out) > maxInt - n) {
				error('overflow');
			}

			n += floor(i / out);
			i %= out;

			// Insert `n` at position `i` of the output
			output.splice(i++, 0, n);

		}

		return ucs2encode(output);
	}

	/**
	 * Converts a string of Unicode symbols to a Punycode string of ASCII-only
	 * symbols.
	 * @memberOf punycode
	 * @param {String} input The string of Unicode symbols.
	 * @returns {String} The resulting Punycode string of ASCII-only symbols.
	 */
	function encode(input) {
		var n,
		    delta,
		    handledCPCount,
		    basicLength,
		    bias,
		    j,
		    m,
		    q,
		    k,
		    t,
		    currentValue,
		    output = [],
		    /** `inputLength` will hold the number of code points in `input`. */
		    inputLength,
		    /** Cached calculation results */
		    handledCPCountPlusOne,
		    baseMinusT,
		    qMinusT;

		// Convert the input in UCS-2 to Unicode
		input = ucs2decode(input);

		// Cache the length
		inputLength = input.length;

		// Initialize the state
		n = initialN;
		delta = 0;
		bias = initialBias;

		// Handle the basic code points
		for (j = 0; j < inputLength; ++j) {
			currentValue = input[j];
			if (currentValue < 0x80) {
				output.push(stringFromCharCode(currentValue));
			}
		}

		handledCPCount = basicLength = output.length;

		// `handledCPCount` is the number of code points that have been handled;
		// `basicLength` is the number of basic code points.

		// Finish the basic string - if it is not empty - with a delimiter
		if (basicLength) {
			output.push(delimiter);
		}

		// Main encoding loop:
		while (handledCPCount < inputLength) {

			// All non-basic code points < n have been handled already. Find the next
			// larger one:
			for (m = maxInt, j = 0; j < inputLength; ++j) {
				currentValue = input[j];
				if (currentValue >= n && currentValue < m) {
					m = currentValue;
				}
			}

			// Increase `delta` enough to advance the decoder's <n,i> state to <m,0>,
			// but guard against overflow
			handledCPCountPlusOne = handledCPCount + 1;
			if (m - n > floor((maxInt - delta) / handledCPCountPlusOne)) {
				error('overflow');
			}

			delta += (m - n) * handledCPCountPlusOne;
			n = m;

			for (j = 0; j < inputLength; ++j) {
				currentValue = input[j];

				if (currentValue < n && ++delta > maxInt) {
					error('overflow');
				}

				if (currentValue == n) {
					// Represent delta as a generalized variable-length integer
					for (q = delta, k = base; /* no condition */; k += base) {
						t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);
						if (q < t) {
							break;
						}
						qMinusT = q - t;
						baseMinusT = base - t;
						output.push(
							stringFromCharCode(digitToBasic(t + qMinusT % baseMinusT, 0))
						);
						q = floor(qMinusT / baseMinusT);
					}

					output.push(stringFromCharCode(digitToBasic(q, 0)));
					bias = adapt(delta, handledCPCountPlusOne, handledCPCount == basicLength);
					delta = 0;
					++handledCPCount;
				}
			}

			++delta;
			++n;

		}
		return output.join('');
	}

	/**
	 * Converts a Punycode string representing a domain name to Unicode. Only the
	 * Punycoded parts of the domain name will be converted, i.e. it doesn't
	 * matter if you call it on a string that has already been converted to
	 * Unicode.
	 * @memberOf punycode
	 * @param {String} domain The Punycode domain name to convert to Unicode.
	 * @returns {String} The Unicode representation of the given Punycode
	 * string.
	 */
	function toUnicode(domain) {
		return mapDomain(domain, function(string) {
			return regexPunycode.test(string)
				? decode(string.slice(4).toLowerCase())
				: string;
		});
	}

	/**
	 * Converts a Unicode string representing a domain name to Punycode. Only the
	 * non-ASCII parts of the domain name will be converted, i.e. it doesn't
	 * matter if you call it with a domain that's already in ASCII.
	 * @memberOf punycode
	 * @param {String} domain The domain name to convert, as a Unicode string.
	 * @returns {String} The Punycode representation of the given domain name.
	 */
	function toASCII(domain) {
		return mapDomain(domain, function(string) {
			return regexNonASCII.test(string)
				? 'xn--' + encode(string)
				: string;
		});
	}

	/*--------------------------------------------------------------------------*/

	/** Define the public API */
	punycode = {
		/**
		 * A string representing the current Punycode.js version number.
		 * @memberOf punycode
		 * @type String
		 */
		'version': '1.2.4',
		/**
		 * An object of methods to convert from JavaScript's internal character
		 * representation (UCS-2) to Unicode code points, and back.
		 * @see <http://mathiasbynens.be/notes/javascript-encoding>
		 * @memberOf punycode
		 * @type Object
		 */
		'ucs2': {
			'decode': ucs2decode,
			'encode': ucs2encode
		},
		'decode': decode,
		'encode': encode,
		'toASCII': toASCII,
		'toUnicode': toUnicode
	};

	/** Expose `punycode` */
	// Some AMD build optimizers, like r.js, check for specific condition patterns
	// like the following:
	if (
		typeof define == 'function' &&
		typeof define.amd == 'object' &&
		define.amd
	) {
		define('punycode', function() {
			return punycode;
		});
	} else if (freeExports && !freeExports.nodeType) {
		if (freeModule) { // in Node.js or RingoJS v0.8.0+
			freeModule.exports = punycode;
		} else { // in Narwhal or RingoJS v0.7.0-
			for (key in punycode) {
				punycode.hasOwnProperty(key) && (freeExports[key] = punycode[key]);
			}
		}
	} else { // in Rhino or a web browser
		root.punycode = punycode;
	}

}(this));

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{}],5:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

// If obj.hasOwnProperty has been overridden, then calling
// obj.hasOwnProperty(prop) will break.
// See: https://github.com/joyent/node/issues/1707
function hasOwnProperty(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

module.exports = function(qs, sep, eq, options) {
  sep = sep || '&';
  eq = eq || '=';
  var obj = {};

  if (typeof qs !== 'string' || qs.length === 0) {
    return obj;
  }

  var regexp = /\+/g;
  qs = qs.split(sep);

  var maxKeys = 1000;
  if (options && typeof options.maxKeys === 'number') {
    maxKeys = options.maxKeys;
  }

  var len = qs.length;
  // maxKeys <= 0 means that we should not limit keys count
  if (maxKeys > 0 && len > maxKeys) {
    len = maxKeys;
  }

  for (var i = 0; i < len; ++i) {
    var x = qs[i].replace(regexp, '%20'),
        idx = x.indexOf(eq),
        kstr, vstr, k, v;

    if (idx >= 0) {
      kstr = x.substr(0, idx);
      vstr = x.substr(idx + 1);
    } else {
      kstr = x;
      vstr = '';
    }

    k = decodeURIComponent(kstr);
    v = decodeURIComponent(vstr);

    if (!hasOwnProperty(obj, k)) {
      obj[k] = v;
    } else if (isArray(obj[k])) {
      obj[k].push(v);
    } else {
      obj[k] = [obj[k], v];
    }
  }

  return obj;
};

var isArray = Array.isArray || function (xs) {
  return Object.prototype.toString.call(xs) === '[object Array]';
};

},{}],6:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

var stringifyPrimitive = function(v) {
  switch (typeof v) {
    case 'string':
      return v;

    case 'boolean':
      return v ? 'true' : 'false';

    case 'number':
      return isFinite(v) ? v : '';

    default:
      return '';
  }
};

module.exports = function(obj, sep, eq, name) {
  sep = sep || '&';
  eq = eq || '=';
  if (obj === null) {
    obj = undefined;
  }

  if (typeof obj === 'object') {
    return map(objectKeys(obj), function(k) {
      var ks = encodeURIComponent(stringifyPrimitive(k)) + eq;
      if (isArray(obj[k])) {
        return map(obj[k], function(v) {
          return ks + encodeURIComponent(stringifyPrimitive(v));
        }).join(sep);
      } else {
        return ks + encodeURIComponent(stringifyPrimitive(obj[k]));
      }
    }).join(sep);

  }

  if (!name) return '';
  return encodeURIComponent(stringifyPrimitive(name)) + eq +
         encodeURIComponent(stringifyPrimitive(obj));
};

var isArray = Array.isArray || function (xs) {
  return Object.prototype.toString.call(xs) === '[object Array]';
};

function map (xs, f) {
  if (xs.map) return xs.map(f);
  var res = [];
  for (var i = 0; i < xs.length; i++) {
    res.push(f(xs[i], i));
  }
  return res;
}

var objectKeys = Object.keys || function (obj) {
  var res = [];
  for (var key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) res.push(key);
  }
  return res;
};

},{}],7:[function(require,module,exports){
'use strict';

exports.decode = exports.parse = require('./decode');
exports.encode = exports.stringify = require('./encode');

},{"./decode":5,"./encode":6}],8:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var punycode = require('punycode');

exports.parse = urlParse;
exports.resolve = urlResolve;
exports.resolveObject = urlResolveObject;
exports.format = urlFormat;

exports.Url = Url;

function Url() {
  this.protocol = null;
  this.slashes = null;
  this.auth = null;
  this.host = null;
  this.port = null;
  this.hostname = null;
  this.hash = null;
  this.search = null;
  this.query = null;
  this.pathname = null;
  this.path = null;
  this.href = null;
}

// Reference: RFC 3986, RFC 1808, RFC 2396

// define these here so at least they only have to be
// compiled once on the first module load.
var protocolPattern = /^([a-z0-9.+-]+:)/i,
    portPattern = /:[0-9]*$/,

    // RFC 2396: characters reserved for delimiting URLs.
    // We actually just auto-escape these.
    delims = ['<', '>', '"', '`', ' ', '\r', '\n', '\t'],

    // RFC 2396: characters not allowed for various reasons.
    unwise = ['{', '}', '|', '\\', '^', '`'].concat(delims),

    // Allowed by RFCs, but cause of XSS attacks.  Always escape these.
    autoEscape = ['\''].concat(unwise),
    // Characters that are never ever allowed in a hostname.
    // Note that any invalid chars are also handled, but these
    // are the ones that are *expected* to be seen, so we fast-path
    // them.
    nonHostChars = ['%', '/', '?', ';', '#'].concat(autoEscape),
    hostEndingChars = ['/', '?', '#'],
    hostnameMaxLen = 255,
    hostnamePartPattern = /^[a-z0-9A-Z_-]{0,63}$/,
    hostnamePartStart = /^([a-z0-9A-Z_-]{0,63})(.*)$/,
    // protocols that can allow "unsafe" and "unwise" chars.
    unsafeProtocol = {
      'javascript': true,
      'javascript:': true
    },
    // protocols that never have a hostname.
    hostlessProtocol = {
      'javascript': true,
      'javascript:': true
    },
    // protocols that always contain a // bit.
    slashedProtocol = {
      'http': true,
      'https': true,
      'ftp': true,
      'gopher': true,
      'file': true,
      'http:': true,
      'https:': true,
      'ftp:': true,
      'gopher:': true,
      'file:': true
    },
    querystring = require('querystring');

function urlParse(url, parseQueryString, slashesDenoteHost) {
  if (url && isObject(url) && url instanceof Url) return url;

  var u = new Url;
  u.parse(url, parseQueryString, slashesDenoteHost);
  return u;
}

Url.prototype.parse = function(url, parseQueryString, slashesDenoteHost) {
  if (!isString(url)) {
    throw new TypeError("Parameter 'url' must be a string, not " + typeof url);
  }

  var rest = url;

  // trim before proceeding.
  // This is to support parse stuff like "  http://foo.com  \n"
  rest = rest.trim();

  var proto = protocolPattern.exec(rest);
  if (proto) {
    proto = proto[0];
    var lowerProto = proto.toLowerCase();
    this.protocol = lowerProto;
    rest = rest.substr(proto.length);
  }

  // figure out if it's got a host
  // user@server is *always* interpreted as a hostname, and url
  // resolution will treat //foo/bar as host=foo,path=bar because that's
  // how the browser resolves relative URLs.
  if (slashesDenoteHost || proto || rest.match(/^\/\/[^@\/]+@[^@\/]+/)) {
    var slashes = rest.substr(0, 2) === '//';
    if (slashes && !(proto && hostlessProtocol[proto])) {
      rest = rest.substr(2);
      this.slashes = true;
    }
  }

  if (!hostlessProtocol[proto] &&
      (slashes || (proto && !slashedProtocol[proto]))) {

    // there's a hostname.
    // the first instance of /, ?, ;, or # ends the host.
    //
    // If there is an @ in the hostname, then non-host chars *are* allowed
    // to the left of the last @ sign, unless some host-ending character
    // comes *before* the @-sign.
    // URLs are obnoxious.
    //
    // ex:
    // http://a@b@c/ => user:a@b host:c
    // http://a@b?@c => user:a host:c path:/?@c

    // v0.12 TODO(isaacs): This is not quite how Chrome does things.
    // Review our test case against browsers more comprehensively.

    // find the first instance of any hostEndingChars
    var hostEnd = -1;
    for (var i = 0; i < hostEndingChars.length; i++) {
      var hec = rest.indexOf(hostEndingChars[i]);
      if (hec !== -1 && (hostEnd === -1 || hec < hostEnd))
        hostEnd = hec;
    }

    // at this point, either we have an explicit point where the
    // auth portion cannot go past, or the last @ char is the decider.
    var auth, atSign;
    if (hostEnd === -1) {
      // atSign can be anywhere.
      atSign = rest.lastIndexOf('@');
    } else {
      // atSign must be in auth portion.
      // http://a@b/c@d => host:b auth:a path:/c@d
      atSign = rest.lastIndexOf('@', hostEnd);
    }

    // Now we have a portion which is definitely the auth.
    // Pull that off.
    if (atSign !== -1) {
      auth = rest.slice(0, atSign);
      rest = rest.slice(atSign + 1);
      this.auth = decodeURIComponent(auth);
    }

    // the host is the remaining to the left of the first non-host char
    hostEnd = -1;
    for (var i = 0; i < nonHostChars.length; i++) {
      var hec = rest.indexOf(nonHostChars[i]);
      if (hec !== -1 && (hostEnd === -1 || hec < hostEnd))
        hostEnd = hec;
    }
    // if we still have not hit it, then the entire thing is a host.
    if (hostEnd === -1)
      hostEnd = rest.length;

    this.host = rest.slice(0, hostEnd);
    rest = rest.slice(hostEnd);

    // pull out port.
    this.parseHost();

    // we've indicated that there is a hostname,
    // so even if it's empty, it has to be present.
    this.hostname = this.hostname || '';

    // if hostname begins with [ and ends with ]
    // assume that it's an IPv6 address.
    var ipv6Hostname = this.hostname[0] === '[' &&
        this.hostname[this.hostname.length - 1] === ']';

    // validate a little.
    if (!ipv6Hostname) {
      var hostparts = this.hostname.split(/\./);
      for (var i = 0, l = hostparts.length; i < l; i++) {
        var part = hostparts[i];
        if (!part) continue;
        if (!part.match(hostnamePartPattern)) {
          var newpart = '';
          for (var j = 0, k = part.length; j < k; j++) {
            if (part.charCodeAt(j) > 127) {
              // we replace non-ASCII char with a temporary placeholder
              // we need this to make sure size of hostname is not
              // broken by replacing non-ASCII by nothing
              newpart += 'x';
            } else {
              newpart += part[j];
            }
          }
          // we test again with ASCII char only
          if (!newpart.match(hostnamePartPattern)) {
            var validParts = hostparts.slice(0, i);
            var notHost = hostparts.slice(i + 1);
            var bit = part.match(hostnamePartStart);
            if (bit) {
              validParts.push(bit[1]);
              notHost.unshift(bit[2]);
            }
            if (notHost.length) {
              rest = '/' + notHost.join('.') + rest;
            }
            this.hostname = validParts.join('.');
            break;
          }
        }
      }
    }

    if (this.hostname.length > hostnameMaxLen) {
      this.hostname = '';
    } else {
      // hostnames are always lower case.
      this.hostname = this.hostname.toLowerCase();
    }

    if (!ipv6Hostname) {
      // IDNA Support: Returns a puny coded representation of "domain".
      // It only converts the part of the domain name that
      // has non ASCII characters. I.e. it dosent matter if
      // you call it with a domain that already is in ASCII.
      var domainArray = this.hostname.split('.');
      var newOut = [];
      for (var i = 0; i < domainArray.length; ++i) {
        var s = domainArray[i];
        newOut.push(s.match(/[^A-Za-z0-9_-]/) ?
            'xn--' + punycode.encode(s) : s);
      }
      this.hostname = newOut.join('.');
    }

    var p = this.port ? ':' + this.port : '';
    var h = this.hostname || '';
    this.host = h + p;
    this.href += this.host;

    // strip [ and ] from the hostname
    // the host field still retains them, though
    if (ipv6Hostname) {
      this.hostname = this.hostname.substr(1, this.hostname.length - 2);
      if (rest[0] !== '/') {
        rest = '/' + rest;
      }
    }
  }

  // now rest is set to the post-host stuff.
  // chop off any delim chars.
  if (!unsafeProtocol[lowerProto]) {

    // First, make 100% sure that any "autoEscape" chars get
    // escaped, even if encodeURIComponent doesn't think they
    // need to be.
    for (var i = 0, l = autoEscape.length; i < l; i++) {
      var ae = autoEscape[i];
      var esc = encodeURIComponent(ae);
      if (esc === ae) {
        esc = escape(ae);
      }
      rest = rest.split(ae).join(esc);
    }
  }


  // chop off from the tail first.
  var hash = rest.indexOf('#');
  if (hash !== -1) {
    // got a fragment string.
    this.hash = rest.substr(hash);
    rest = rest.slice(0, hash);
  }
  var qm = rest.indexOf('?');
  if (qm !== -1) {
    this.search = rest.substr(qm);
    this.query = rest.substr(qm + 1);
    if (parseQueryString) {
      this.query = querystring.parse(this.query);
    }
    rest = rest.slice(0, qm);
  } else if (parseQueryString) {
    // no query string, but parseQueryString still requested
    this.search = '';
    this.query = {};
  }
  if (rest) this.pathname = rest;
  if (slashedProtocol[lowerProto] &&
      this.hostname && !this.pathname) {
    this.pathname = '/';
  }

  //to support http.request
  if (this.pathname || this.search) {
    var p = this.pathname || '';
    var s = this.search || '';
    this.path = p + s;
  }

  // finally, reconstruct the href based on what has been validated.
  this.href = this.format();
  return this;
};

// format a parsed object into a url string
function urlFormat(obj) {
  // ensure it's an object, and not a string url.
  // If it's an obj, this is a no-op.
  // this way, you can call url_format() on strings
  // to clean up potentially wonky urls.
  if (isString(obj)) obj = urlParse(obj);
  if (!(obj instanceof Url)) return Url.prototype.format.call(obj);
  return obj.format();
}

Url.prototype.format = function() {
  var auth = this.auth || '';
  if (auth) {
    auth = encodeURIComponent(auth);
    auth = auth.replace(/%3A/i, ':');
    auth += '@';
  }

  var protocol = this.protocol || '',
      pathname = this.pathname || '',
      hash = this.hash || '',
      host = false,
      query = '';

  if (this.host) {
    host = auth + this.host;
  } else if (this.hostname) {
    host = auth + (this.hostname.indexOf(':') === -1 ?
        this.hostname :
        '[' + this.hostname + ']');
    if (this.port) {
      host += ':' + this.port;
    }
  }

  if (this.query &&
      isObject(this.query) &&
      Object.keys(this.query).length) {
    query = querystring.stringify(this.query);
  }

  var search = this.search || (query && ('?' + query)) || '';

  if (protocol && protocol.substr(-1) !== ':') protocol += ':';

  // only the slashedProtocols get the //.  Not mailto:, xmpp:, etc.
  // unless they had them to begin with.
  if (this.slashes ||
      (!protocol || slashedProtocol[protocol]) && host !== false) {
    host = '//' + (host || '');
    if (pathname && pathname.charAt(0) !== '/') pathname = '/' + pathname;
  } else if (!host) {
    host = '';
  }

  if (hash && hash.charAt(0) !== '#') hash = '#' + hash;
  if (search && search.charAt(0) !== '?') search = '?' + search;

  pathname = pathname.replace(/[?#]/g, function(match) {
    return encodeURIComponent(match);
  });
  search = search.replace('#', '%23');

  return protocol + host + pathname + search + hash;
};

function urlResolve(source, relative) {
  return urlParse(source, false, true).resolve(relative);
}

Url.prototype.resolve = function(relative) {
  return this.resolveObject(urlParse(relative, false, true)).format();
};

function urlResolveObject(source, relative) {
  if (!source) return relative;
  return urlParse(source, false, true).resolveObject(relative);
}

Url.prototype.resolveObject = function(relative) {
  if (isString(relative)) {
    var rel = new Url();
    rel.parse(relative, false, true);
    relative = rel;
  }

  var result = new Url();
  Object.keys(this).forEach(function(k) {
    result[k] = this[k];
  }, this);

  // hash is always overridden, no matter what.
  // even href="" will remove it.
  result.hash = relative.hash;

  // if the relative url is empty, then there's nothing left to do here.
  if (relative.href === '') {
    result.href = result.format();
    return result;
  }

  // hrefs like //foo/bar always cut to the protocol.
  if (relative.slashes && !relative.protocol) {
    // take everything except the protocol from relative
    Object.keys(relative).forEach(function(k) {
      if (k !== 'protocol')
        result[k] = relative[k];
    });

    //urlParse appends trailing / to urls like http://www.example.com
    if (slashedProtocol[result.protocol] &&
        result.hostname && !result.pathname) {
      result.path = result.pathname = '/';
    }

    result.href = result.format();
    return result;
  }

  if (relative.protocol && relative.protocol !== result.protocol) {
    // if it's a known url protocol, then changing
    // the protocol does weird things
    // first, if it's not file:, then we MUST have a host,
    // and if there was a path
    // to begin with, then we MUST have a path.
    // if it is file:, then the host is dropped,
    // because that's known to be hostless.
    // anything else is assumed to be absolute.
    if (!slashedProtocol[relative.protocol]) {
      Object.keys(relative).forEach(function(k) {
        result[k] = relative[k];
      });
      result.href = result.format();
      return result;
    }

    result.protocol = relative.protocol;
    if (!relative.host && !hostlessProtocol[relative.protocol]) {
      var relPath = (relative.pathname || '').split('/');
      while (relPath.length && !(relative.host = relPath.shift()));
      if (!relative.host) relative.host = '';
      if (!relative.hostname) relative.hostname = '';
      if (relPath[0] !== '') relPath.unshift('');
      if (relPath.length < 2) relPath.unshift('');
      result.pathname = relPath.join('/');
    } else {
      result.pathname = relative.pathname;
    }
    result.search = relative.search;
    result.query = relative.query;
    result.host = relative.host || '';
    result.auth = relative.auth;
    result.hostname = relative.hostname || relative.host;
    result.port = relative.port;
    // to support http.request
    if (result.pathname || result.search) {
      var p = result.pathname || '';
      var s = result.search || '';
      result.path = p + s;
    }
    result.slashes = result.slashes || relative.slashes;
    result.href = result.format();
    return result;
  }

  var isSourceAbs = (result.pathname && result.pathname.charAt(0) === '/'),
      isRelAbs = (
          relative.host ||
          relative.pathname && relative.pathname.charAt(0) === '/'
      ),
      mustEndAbs = (isRelAbs || isSourceAbs ||
                    (result.host && relative.pathname)),
      removeAllDots = mustEndAbs,
      srcPath = result.pathname && result.pathname.split('/') || [],
      relPath = relative.pathname && relative.pathname.split('/') || [],
      psychotic = result.protocol && !slashedProtocol[result.protocol];

  // if the url is a non-slashed url, then relative
  // links like ../.. should be able
  // to crawl up to the hostname, as well.  This is strange.
  // result.protocol has already been set by now.
  // Later on, put the first path part into the host field.
  if (psychotic) {
    result.hostname = '';
    result.port = null;
    if (result.host) {
      if (srcPath[0] === '') srcPath[0] = result.host;
      else srcPath.unshift(result.host);
    }
    result.host = '';
    if (relative.protocol) {
      relative.hostname = null;
      relative.port = null;
      if (relative.host) {
        if (relPath[0] === '') relPath[0] = relative.host;
        else relPath.unshift(relative.host);
      }
      relative.host = null;
    }
    mustEndAbs = mustEndAbs && (relPath[0] === '' || srcPath[0] === '');
  }

  if (isRelAbs) {
    // it's absolute.
    result.host = (relative.host || relative.host === '') ?
                  relative.host : result.host;
    result.hostname = (relative.hostname || relative.hostname === '') ?
                      relative.hostname : result.hostname;
    result.search = relative.search;
    result.query = relative.query;
    srcPath = relPath;
    // fall through to the dot-handling below.
  } else if (relPath.length) {
    // it's relative
    // throw away the existing file, and take the new path instead.
    if (!srcPath) srcPath = [];
    srcPath.pop();
    srcPath = srcPath.concat(relPath);
    result.search = relative.search;
    result.query = relative.query;
  } else if (!isNullOrUndefined(relative.search)) {
    // just pull out the search.
    // like href='?foo'.
    // Put this after the other two cases because it simplifies the booleans
    if (psychotic) {
      result.hostname = result.host = srcPath.shift();
      //occationaly the auth can get stuck only in host
      //this especialy happens in cases like
      //url.resolveObject('mailto:local1@domain1', 'local2@domain2')
      var authInHost = result.host && result.host.indexOf('@') > 0 ?
                       result.host.split('@') : false;
      if (authInHost) {
        result.auth = authInHost.shift();
        result.host = result.hostname = authInHost.shift();
      }
    }
    result.search = relative.search;
    result.query = relative.query;
    //to support http.request
    if (!isNull(result.pathname) || !isNull(result.search)) {
      result.path = (result.pathname ? result.pathname : '') +
                    (result.search ? result.search : '');
    }
    result.href = result.format();
    return result;
  }

  if (!srcPath.length) {
    // no path at all.  easy.
    // we've already handled the other stuff above.
    result.pathname = null;
    //to support http.request
    if (result.search) {
      result.path = '/' + result.search;
    } else {
      result.path = null;
    }
    result.href = result.format();
    return result;
  }

  // if a url ENDs in . or .., then it must get a trailing slash.
  // however, if it ends in anything else non-slashy,
  // then it must NOT get a trailing slash.
  var last = srcPath.slice(-1)[0];
  var hasTrailingSlash = (
      (result.host || relative.host) && (last === '.' || last === '..') ||
      last === '');

  // strip single dots, resolve double dots to parent dir
  // if the path tries to go above the root, `up` ends up > 0
  var up = 0;
  for (var i = srcPath.length; i >= 0; i--) {
    last = srcPath[i];
    if (last == '.') {
      srcPath.splice(i, 1);
    } else if (last === '..') {
      srcPath.splice(i, 1);
      up++;
    } else if (up) {
      srcPath.splice(i, 1);
      up--;
    }
  }

  // if the path is allowed to go above the root, restore leading ..s
  if (!mustEndAbs && !removeAllDots) {
    for (; up--; up) {
      srcPath.unshift('..');
    }
  }

  if (mustEndAbs && srcPath[0] !== '' &&
      (!srcPath[0] || srcPath[0].charAt(0) !== '/')) {
    srcPath.unshift('');
  }

  if (hasTrailingSlash && (srcPath.join('/').substr(-1) !== '/')) {
    srcPath.push('');
  }

  var isAbsolute = srcPath[0] === '' ||
      (srcPath[0] && srcPath[0].charAt(0) === '/');

  // put the host back
  if (psychotic) {
    result.hostname = result.host = isAbsolute ? '' :
                                    srcPath.length ? srcPath.shift() : '';
    //occationaly the auth can get stuck only in host
    //this especialy happens in cases like
    //url.resolveObject('mailto:local1@domain1', 'local2@domain2')
    var authInHost = result.host && result.host.indexOf('@') > 0 ?
                     result.host.split('@') : false;
    if (authInHost) {
      result.auth = authInHost.shift();
      result.host = result.hostname = authInHost.shift();
    }
  }

  mustEndAbs = mustEndAbs || (result.host && srcPath.length);

  if (mustEndAbs && !isAbsolute) {
    srcPath.unshift('');
  }

  if (!srcPath.length) {
    result.pathname = null;
    result.path = null;
  } else {
    result.pathname = srcPath.join('/');
  }

  //to support request.http
  if (!isNull(result.pathname) || !isNull(result.search)) {
    result.path = (result.pathname ? result.pathname : '') +
                  (result.search ? result.search : '');
  }
  result.auth = relative.auth || result.auth;
  result.slashes = result.slashes || relative.slashes;
  result.href = result.format();
  return result;
};

Url.prototype.parseHost = function() {
  var host = this.host;
  var port = portPattern.exec(host);
  if (port) {
    port = port[0];
    if (port !== ':') {
      this.port = port.substr(1);
    }
    host = host.substr(0, host.length - port.length);
  }
  if (host) this.hostname = host;
};

function isString(arg) {
  return typeof arg === "string";
}

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}

function isNull(arg) {
  return arg === null;
}
function isNullOrUndefined(arg) {
  return  arg == null;
}

},{"punycode":4,"querystring":7}],9:[function(require,module,exports){
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
module.exports = require('./lib/main');

},{"./lib/main":11}],10:[function(require,module,exports){
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

/**
 * Functions to generate messages with JSON-RPC 2.0 format.
 *
 * CAF uses a subset of this spec and, for example, RPC arguments are
 * never passed by name, using instead an array.
 *
 * CAF always adds an implicit first argument to
 * requests/notifications containing meta-data, for instance:
 *
 *        {
 *           "token": string, // security token for authentication
 *           "sessionId": string,// logical session name
 *           "to": string, // target CA
 *           "from": string // source CA
 *        }
 *
 * We also add the same meta-data to replies but in this case the json-rpc reply
 * message format complicates things:
 *
 *  - *Application-level errors* use a similar approach to node.js
 * callbacks. We use an array with 3 arguments [meta, error, data] with the
 * second one using a falsy if everything went fine. This means that
 * we *NEVER* use the JSON-RPC error response object for propagating
 * application errors.
 *
 *  - *System-level errors* (e.g., non-parsable JSON or missing target
 * CA) do use the error response object using exports.ERROR_CODES. In that
 * case we use a tuple (i.e., array) in the data field to add the meta-data,
 * i.e., { "error": {"data": [meta, extraData]}}.
 *
 * Use provided getters and setters to hide this complexity.
 *
 *
 * @module json_rpc
 */
(function () {
     "use strict";

     var json_rpc = {};

     var root, previous_json_rpc;
     root = this || (0, eval)('this');// global object in strict mode

     if (root !== null) {
         previous_json_rpc = root.json_rpc;
     }

     json_rpc.noConflict = function () {
         root.json_rpc = previous_json_rpc;
         return json_rpc;
     };

     var NAME_SEPARATOR = json_rpc.NAME_SEPARATOR = '-';

     /** Enum with error codes. */
     var ERROR_CODES = json_rpc.ERROR_CODES = {
         parseError: -32700,
         invalidRequest: -32600,
         methodNotFound: -32601,
         invalidParams: -32602,
         internalError: -32603,
         //-32000 to -32099 for implementation-defined server-errors
         noSuchCA: -32000,
         shutdownCA: -32001,
         checkpointFailure: -32002,
         prepareFailure: -32003,
         exceptionThrown: -32004,
         commitFailure: -32005,
         forceRedirect: -32006,
         notAuthorized: -32007,
         beginFailure: -32008,
         notAuthenticated: -32009
     };


     /** Default ID in requests that come from entities that have no proper
      id */
     var DEFAULT_FROM_ID = json_rpc.DEFAULT_FROM_ID = 'UNKNOWN';
     /** Default username when user is unknown.*/
     var DEFAULT_FROM_USERNAME = json_rpc.DEFAULT_FROM_USERNAME =
         json_rpc.NOBODY = 'NOBODY';
     /** Default source of an external request. */
     var DEFAULT_FROM = json_rpc.DEFAULT_FROM =  DEFAULT_FROM_USERNAME + '-' +
         DEFAULT_FROM_ID;
     /** Default external session.*/
     var DEFAULT_SESSION =  json_rpc.DEFAULT_SESSION = 'default';

     /** Default id for a response to an invalid request with no id.*/
     var DEFAULT_REQUEST_ID = json_rpc.DEFAULT_REQUEST_ID = 42;

     /** Default token with no authentication. */
     var DUMMY_TOKEN = json_rpc.DUMMY_TOKEN = 'INVALID';

     /** Session id for internal sessions. We use the DEFAULT_SESSION.*/
     json_rpc.SYSTEM_SESSION_ID = DEFAULT_SESSION;
     /** Reserved from id for internal, local sessions.*/
     var SYSTEM_FROM_ID = json_rpc.SYSTEM_FROM_ID = 'sys1';
     /** Reserved username for internal, local sessions.*/
     var SYSTEM_USERNAME = json_rpc.SYSTEM_USERNAME = '!SYSTEM';
     /** Reserved username_fromid for internal, local sessions.*/
     var SYSTEM_FROM = json_rpc.SYSTEM_FROM =
         SYSTEM_USERNAME + '-' + SYSTEM_FROM_ID;

     /** Reserved token  for internal, local sessions.*/
     json_rpc.SYSTEM_TOKEN = DUMMY_TOKEN;

     /** Generate a random string.
      *
      * @return {string}
      * @function
      */
     var randomId = json_rpc.randomId = function() {
         var unique = Math.floor(Math.random() * 10000000000000000);
         var result = '' + (new Date()).getTime() + unique;
         return result;
     };

     /** Tests if it is a notification message.
      *
      * @param {caf.msg} msg
      * @return {boolean}
      *
      * @function
      */
     var isNotification = json_rpc.isNotification = function(msg) {
         return (msg && (msg.jsonrpc === '2.0') &&
                 (msg.method) &&
                 (msg.params && msg.params.length > 0) &&
                 (!msg.id));
     };

     /** Creates notification message.
      *
      * @param {string} to
      * @param {string} from
      * @param {string} sessionId
      * @param {string} methodName
      * @param {any...} var_args
      * @return {caf.msg}
      *
      * @function
      */
     var notification = json_rpc.notification = function(to, from, sessionId,
                                                         methodName, var_args) {
         var argsArray = Array.prototype.slice.call(arguments);
         argsArray.splice(0, 4);
         var firstArg = {'sessionId' : sessionId, 'to' : to, 'from' : from};
         argsArray.unshift(firstArg);
         return {
             'jsonrpc': '2.0',
             'method' : methodName,
             'params' : argsArray
         };
     };

     /** Tests if it is a request message.
      *
      * @param {caf.msg} msg
      * @return {boolean}
      *
      * @function
      */
     var isRequest = json_rpc.isRequest = function(msg) {
         return (msg && (msg.jsonrpc === '2.0') &&
                 (msg.method) &&
                 (msg.params && msg.params.length > 0) &&
                 (msg.id));
     };

     /** Creates a request message.
      *
      * @param {string} token
      * @param {string} to
      * @param {string} from
      * @param {string} sessionId
      * @param {string} methodName
      * @param {any...} var_args
      * @return {caf.msg}
      *
      * @function
      */
     var request = json_rpc.request = function(token, to, from, sessionId,
                                               methodName, var_args) {
         var argsArray = Array.prototype.slice.call(arguments);
         argsArray.shift(); // get rid of token
         var result = notification.apply(notification, argsArray);
         result.id = randomId();
         setToken(result, token);
         return result;
     };


     /** Creates a system request message.
      *
      * @param {string} to
      * @param {string} methodName
      * @param {any...} var_args
      * @return {caf.msg}
      *
      * @function
      */
     json_rpc.systemRequest = function(to, methodName, var_args) {
         var argsArray = Array.prototype.slice.call(arguments);
         var varArgsArray = argsArray.slice(2);
         var args = [json_rpc.SYSTEM_TOKEN, to, json_rpc.SYSTEM_FROM,
                     json_rpc.SYSTEM_SESSION_ID, methodName]
             .concat(varArgsArray);
         return request.apply(request, args);
     };

     /** Tests if it is an application reply message.
      *
      * @param {caf.msg} msg
      * @return {boolean}
      *
      * @function
      */
     var isAppReply = json_rpc.isAppReply = function(msg) {
         return (msg && (msg.jsonrpc === '2.0') &&
                 (msg.result && (msg.result.length === 3)) &&
                 (msg.id));
     };

     var newReplyMeta = function(request) {
         var result ;
         try {
             result = {
                 'token' : getToken(request),
                 'sessionId' : getSessionId(request),
                 'to' : getFrom(request),
                 'from' : getTo(request)
             };
         } catch(err) {
             // bad request message did not have meta section
             result = {
                 'token' : DUMMY_TOKEN,
                 'sessionId' :  DEFAULT_SESSION,
                 'to' : DEFAULT_FROM,
                 'from' : SYSTEM_FROM
             };
         }
         return result;
     };

     /**
      * Creates an application reply message.
      *
      * @param {caf.msg} request
      * @param {caf.json=} error
      * @param {caf.json} value
      * @return {caf.msg}
      *
      * @function
      *
      */
     var appReply = function(request, error, value) {
         error = toErrorObject(error);
         if (error && (typeof error === 'object')) {
             error.request = request;
         }
         return {
             'jsonrpc': '2.0',
             'result' : [newReplyMeta(request), error, value],
             'id': request.id
         };
     };

     /** Tests if it is a system error message.
      *
      * @param {caf.msg} msg
      * @return {boolean}
      *
      * @function
      */
     var isSystemError = json_rpc.isSystemError = function(msg) {
         return (msg && (msg.jsonrpc === '2.0') &&
                 (msg.error && msg.error.code) &&
                 (msg.error.data) && (msg.error.data.length === 2) &&
                 (msg.id));
     };


     var toErrorObject = function(err) {
         if (!err || (typeof err !== 'object')) {
             return err;
         } else {
             var obj = {};
             Object.getOwnPropertyNames(err) // include stack
                 .forEach(function(key) {
                              obj[key] =  err[key];
                          });
             return obj;
         }
     };

     /** Creates a system error message.
      *
      * @param {caf.msg} request
      * @param {number} code
      * @param {string} errMsg
      * @param {Error=} err Optional source error.
      * @return {caf.msg}
      *
      * @function
      */
     var systemError  = function(request, code, errMsg,
                                 err) {
         err = err || new Error(errMsg);
         err = toErrorObject(err);
         if (typeof err === 'object') {
             err.request = request;
         }
         var error = {
             'code' : code,
             'message' : errMsg,
             'data' : [newReplyMeta(request), err]
         };
         return {
             'jsonrpc': '2.0',
             'error' : error,
             'id': request.id || DEFAULT_REQUEST_ID
         };
     };

     /**
      * Wraps an Error object of type SystemError:
      *
      * {name: 'SystemError', msg: caf_msg, code: number, errorStr: string,
      *  error: Error}
      *
      * @return {caf.error}
      *
      */
     var newSysError = json_rpc.newSysError = function(msg, code, errorStr,
                                                       errorOrg) {
         var error = new Error(errorStr);
         error.error = toErrorObject(errorOrg);
         error.name = 'SystemError';
         error.msg = msg;
         error.code = code;
         error.errorStr = errorStr;
         return error;
     };

     /**
      * Wraps an Error object of type AppError:
      *
      * {name: 'AppError', msg: caf_msg,  errorStr: string, error: Error}
      *
      *  @return {caf.error}
      */
     var newAppError = json_rpc.newAppError =  function(msg, errorStr, errorOrg) {
         var error = new Error(errorStr);
         error.error = toErrorObject(errorOrg);
         error.name = 'AppError';
         error.msg = msg;
         error.errorStr = errorStr;
         return error;
     };

     /** Checks if it there is a recoverable error in message.
      *
      * @param {caf.msg} msg
      * @return {boolean}
      *
      * @function
      */
     var isErrorRecoverable = json_rpc.isErrorRecoverable = function(msg) {
         var code = getSystemErrorCode(msg);
         // Non-deterministic errors or specific to a particular node
         return ((code === ERROR_CODES.noSuchCA) ||
                 (code === ERROR_CODES.shutdownCA) ||
                 (code === ERROR_CODES.checkpointFailure) ||
                 (code === ERROR_CODES.prepareFailure) ||
                 (code === ERROR_CODES.commitFailure) ||
                 (code === ERROR_CODES.beginFailure) ||
                 (code === ERROR_CODES.internalError));

     };

     /**
      * Creates an error replay message
      *
      * @param {caf.err} error
      *
      * @throws {Error} Not a  SystemError or AppError.
      *
      */
     var errorReply = function(error) {
         if (error.name === 'SystemError') {
             return systemError(error.msg, error.code,
                                error.errorStr, error.error);
         } else if (error.name === 'AppError') {
                return appReply(error.msg, error.error, null);
         } else {
             var newErr = new Error('errorReply: not  App or System ' +
                                    JSON.stringify(error));
             newErr.err = error;
             throw newErr;
         }
     };

     /** Creates a reply message.
      *
      * @param {caf.err} error
      * @param {caf.msg} request
      * @param {caf.json} value
      * @return {cd caf.msg}
      *
      * @function
      */
     json_rpc.reply = function(error, request, value) {
         if (error) {
             return errorReply(error);
         } else {
             return appReply(request, error, value);
         }
     };

     /** Creates a redirect message.
      *
      * @param {caf.msg} request
      * @param {string} errMsg
      * @param {Error} errOrg
      * @return {caf.msg}
      *
      * @function
      */
     json_rpc.redirect = function(request, errMsg, errOrg) {
          var error = json_rpc.newSysError(request, ERROR_CODES.forceRedirect,
                                           errMsg, errOrg);
         return json_rpc.reply(error);
     };

     /** Tests if it is a redirect message.
      *
      * @param {caf.msg} msg
      * @return {boolean}
      *
      * @function
      */
     var isRedirect = json_rpc.isRedirect = function(msg) {
         return (isSystemError(msg) &&
                 (getSystemErrorCode(msg) === ERROR_CODES.forceRedirect));
     };

     /**
      * Extracts the destination address of a redirection message.
      *
      * @param {caf.msg} msg A redirection message.
      * @return {string| null} A redirection address or null if not a valid
      * redirection message.
      *
      * @function
      */
     json_rpc.redirectDestination = function(msg) {
         var result = null;
         if (isRedirect(msg) && getSystemErrorData(msg)) {
             result = getSystemErrorData(msg).remoteNode;
         }
         return result;
     };

     /** Checks if it is a "not authorized" message.
      *
      * @param {caf.msg} msg
      * @return {boolean}
      *
      * @function
      */
     json_rpc.isNotAuthorized = function(msg) {
         return (isSystemError(msg) &&
                 (getSystemErrorCode(msg) === ERROR_CODES.notAuthorized));
     };

    /** Checks if it is a "principal not authenticated" message.
      *
      * @param {caf.msg} msg
      * @return {boolean}
      *
      * @function
      */
     json_rpc.isNotAuthenticated = function(msg) {
         return (isSystemError(msg) &&
                 (getSystemErrorCode(msg) === ERROR_CODES.notAuthenticated));
     };


     /** Executes an asynchronous method in a target CA  using arguments in an
      *  RPC request message.
      *
      * @param {caf.msg} msg
      * @param {Object} target
      * @param {caf.cb} cb Returns first argument optional error of type
      * caf.error (System or App error)  or, in the second argument,
      * the result of the method invocation.
      *
      * @function
      */
     json_rpc.call = function(msg, target, cb) {
         var error;
         if (typeof target !== 'object') {
             error = newSysError(msg, ERROR_CODES.noSuchCA,
                                 'CA not found');
         }
         if ((!error) && !(isRequest(msg) || isNotification(msg))) {
             error = newSysError(msg, ERROR_CODES.invalidRequest,
                                 'Invalid request');
         }
         if ((!error) && (typeof target[msg.method] !== 'function')) {
             error = newSysError(msg, ERROR_CODES.methodNotFound,
                                 'method not found');
         }
         if (!error) {
             try {
                 var args = msg.params.slice(1); // get rid of meta-data
                 var cb1 = function(err, data) {
                     if (err) {
                         err = newAppError(msg, 'AppError', err);
                     }
                     cb(err, data);
                 };
                 args.push(cb1);
                 target[msg.method].apply(target, args);
             } catch (x) {
                 error = newSysError(msg, ERROR_CODES.exceptionThrown,
                                     'Exception in application code', x);
                 cb(error);
             }
         } else {
             cb(error);
         }
     };

     /** Gets original method arguments from message.
      *
      * @param {caf.msg} msg
      * @return {Array.<caf.json>}
      * @throws {Error}
      * @function
      */
     json_rpc.getMethodArgs = function(msg) {
         if (isRequest(msg) || isNotification(msg)) {
             return msg.params && msg.params.slice(1);
         } else {
             var err =  new Error('Invalid msg');
             err.msg = msg;
             throw err;
         }
     };

     /** Gets the method name from message.
      *
      * @param {caf.msg} msg
      * @return {string}
      * @throws {Error}
      * @function
      */
     json_rpc.getMethodName = function(msg) {
         if (isRequest(msg) || isNotification(msg)) {
             return msg.method;
         } else {
             var err =  new Error('Invalid msg');
             err.msg = msg;
             throw err;
         }
     };

     /** Freezes meta-data in message.
      *
      * @param {caf.msg} msg
      *
      *
      * @throws {Error} if msg is not a proper caf.msg type.
      * @function
      */
     json_rpc.metaFreeze = function(msg) {
         Object.freeze(msg);
         if (isNotification(msg) || isRequest(msg)) {
             Object.freeze(msg.params);
             Object.freeze(msg.params[0]);
         } else if (isAppReply(msg)) {
             Object.freeze(msg.result);
             Object.freeze(msg.result[0]);
         } else if (isSystemError(msg)) {
             Object.freeze(msg.error);
             Object.freeze(msg.error.data);
             Object.freeze(msg.error.data[0]);
         } else {
             var err = new Error('Freezing  badly defined msg');
             err.msg = msg;
             throw err;
         }
     };

     /** Gets meta-data from message.
      *
      * @param {caf.msg} msg
      * @return {caf.meta}
      * @throws {Error}
      *
      * @function
      */
     var getMeta = json_rpc.getMeta = function(msg) {
         if (isRequest(msg) || isNotification(msg)) {
             return msg.params[0];
         } else if (isAppReply(msg)) {
             return msg.result[0];
         } else if (isSystemError(msg)) {
             return msg.error.data[0];
         } else {
             var err = new Error('No meta in msg');
             err.msg = msg;
             throw err;
         }
     };

     /** Sets meta-data in message.
      *
      * @param {caf.msg} msg
      * @param {caf.meta} meta
      *
      * @throws {Error}
      *
      * @function
      */
     var setMeta = json_rpc.setMeta = function(msg, meta) {
         if (isRequest(msg) || isNotification(msg)) {
             msg.params[0] = meta;
         } else if (isAppReply(msg)) {
             msg.result[0] = meta;
         } else if (isSystemError(msg)) {
             msg.error.data[0] = meta;
         } else {
             var err = new Error('Setting metadata in a badly formatted msg.');
             err.msg = msg;
             throw err;
         }
     };

     /** Gets token from meta-data in message.
      *
      * @param {caf.msg} msg
      * @return {string | undefined}
      *
      * @function
      */
     var getToken = json_rpc.getToken = function(msg) {
         var meta = getMeta(msg);
         return (meta ? meta.token : undefined);
     };

     /** Gets session id from meta-data in message.
      *
      * @param {caf.msg} msg
      * @return {string | undefined}
      *
      * @function
      */
     var getSessionId = json_rpc.getSessionId = function(msg) {
         var meta = getMeta(msg);
         return (meta ? meta.sessionId : undefined);
     };

     /** Gets target CA  from meta-data in message.
      *
      * @param {caf.msg} msg
      * @return {string | undefined}
      *
      * @function
      */
     var getTo = json_rpc.getTo = function(msg) {
         var meta = getMeta(msg);
         return (meta ? meta.to : undefined);
     };

     /** Gets source CA  from meta-data in message.
      *
      * @param {caf.msg} msg
      * @return {string | undefined}
      *
      * @function
      */
     var getFrom = json_rpc.getFrom = function(msg) {
         var meta = getMeta(msg);
         return (meta ? meta.from : undefined);
     };


     /** Gets error field from application reply message.
      *
      * @param {caf.msg} msg
      * @return {caf.err | undefined}
      *
      * @function
      */
     var getAppReplyError = json_rpc.getAppReplyError = function(msg) {
         return (isAppReply(msg) ? msg.result[1] : undefined);
     };

     /** Gets data field from application reply message.
      *
      * @param {caf.msg} msg
      * @return {caf.json | undefined}
      *
      * @function
      */
     var getAppReplyData = json_rpc.getAppReplyData = function(msg) {
         return (isAppReply(msg) ? msg.result[2] : undefined);
     };

     /** Gets system error data from message.
      *
      * @param {caf.msg} msg
      * @return {caf.json | undefined}
      *
      * @function
      */
     var getSystemErrorData = json_rpc.getSystemErrorData = function(msg) {
         return (isSystemError(msg) ? msg.error.data[1] : undefined);
     };

     /** Gets system error code from message.
      *
      * @param {caf.msg} msg
      * @return {number | undefined}
      *
      * @function
      */
     var getSystemErrorCode = json_rpc.getSystemErrorCode = function(msg) {
         return (isSystemError(msg) ? msg.error.code : undefined);
     };

     /** Gets system error msg from message.
      *
      * @param {caf.msg} msg
      * @return {string | undefined}
      *
      * @function
      */
     var getSystemErrorMsg = json_rpc.getSystemErrorMsg = function(msg) {
         return (isSystemError(msg) ? msg.error.message : undefined);
     };

     /** Sets source CA in message meta-data.
      *
      * @param {caf.msg} msg
      * @param {string} from
      *
      * @function
      */
     var setFrom = json_rpc.setFrom = function(msg, from) {
         var meta = getMeta(msg) || {};
         meta.from = from;
         setMeta(msg, meta);
     };

     /** Sets target CA in message meta-data.
      *
      * @param {caf.msg} msg
      * @param {string} to
      *
      * @function
      */
     var setTo = json_rpc.setTo = function(msg, to) {
         var meta = getMeta(msg) || {};
         meta.to = to;
         setMeta(msg, meta);
     };

     /** Sets session id in message meta-data.
      *
      * @param {caf.msg} msg
      * @param {string} sessionId
      *
      *
      * @function
      */
     var setSessionId = json_rpc.setSessionId = function(msg, sessionId) {
         var meta = getMeta(msg) || {};
         meta.sessionId = sessionId;
         setMeta(msg, meta);
     };

     /** Sets token in message meta-data.
      *
      * @param {caf.msg} msg
      * @param {string} token
      *
      * @function
      */
     var setToken = json_rpc.setToken = function(msg, token) {
         var meta = getMeta(msg) || {};
         meta.token = token;
         setMeta(msg, meta);
     };




     /**
      * Splits a compound name into namespace root and local name.
      *  The convention is to use the character '-' to separate them.
      *
      * @param {string} name A name to split.
      * @return {Array.<string>} An array with two elements: namespace root and
      * local name.
      *
      * @throws {Error} Invalid compound name.
      * @name  json_rpc/splitName
      * @function
      *
      */
     var splitName = json_rpc.splitName = function(name) {
         var result = name.split(NAME_SEPARATOR);
         if (result.length === 2) {
             return result;
         } else {
             var err = new Error('Invalid name');
             err.name = name;
             throw err;
         }
     };


     if (typeof module !== 'undefined' && module.exports) {
         // node.js
         module.exports = json_rpc;
     } else if (typeof define !== 'undefined' && define.amd) {
         // AMD / RequireJS
         define([], function () {
                    return json_rpc;
                });
     } else {
         // <script> tag
         root.json_rpc = json_rpc;
     }

 }());

},{}],11:[function(require,module,exports){
/*!
Copyright 2014 Hewlett-Packard Development Company, L.P.

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

exports.json_rpc = require('./json_rpc');

// module
exports.getModule = function() {
    return module;
};

},{"./json_rpc":10}],12:[function(require,module,exports){

/**
 * Module dependencies.
 */

var global = (function() { return this; })();

/**
 * WebSocket constructor.
 */

var WebSocket = global.WebSocket || global.MozWebSocket;

/**
 * Module exports.
 */

module.exports = WebSocket ? ws : null;

/**
 * WebSocket constructor.
 *
 * The third `opts` options object gets ignored in web browsers, since it's
 * non-standard, and throws a TypeError if passed to the constructor.
 * See: https://github.com/einaros/ws/issues/227
 *
 * @param {String} uri
 * @param {Array} protocols (optional)
 * @param {Object) opts (optional)
 * @api public
 */

function ws(uri, protocols, opts) {
  var instance;
  if (protocols) {
    instance = new WebSocket(uri, protocols);
  } else {
    instance = new WebSocket(uri);
  }
  return instance;
}

if (WebSocket) ws.prototype = WebSocket.prototype;

},{}],"caf_cli":[function(require,module,exports){
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
module.exports = require('./lib/main');

},{"./lib/main":3}]},{},[])
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJsaWIvUXVldWUuanMiLCJsaWIvU2Vzc2lvbi5qcyIsImxpYi9tYWluLmpzIiwibm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL3B1bnljb2RlL3B1bnljb2RlLmpzIiwibm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL3F1ZXJ5c3RyaW5nLWVzMy9kZWNvZGUuanMiLCJub2RlX21vZHVsZXMvYnJvd3NlcmlmeS9ub2RlX21vZHVsZXMvcXVlcnlzdHJpbmctZXMzL2VuY29kZS5qcyIsIm5vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9xdWVyeXN0cmluZy1lczMvaW5kZXguanMiLCJub2RlX21vZHVsZXMvYnJvd3NlcmlmeS9ub2RlX21vZHVsZXMvdXJsL3VybC5qcyIsIm5vZGVfbW9kdWxlcy9jYWZfdHJhbnNwb3J0L2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL2NhZl90cmFuc3BvcnQvbGliL2pzb25fcnBjLmpzIiwibm9kZV9tb2R1bGVzL2NhZl90cmFuc3BvcnQvbGliL21haW4uanMiLCJub2RlX21vZHVsZXMvd3MvbGliL2Jyb3dzZXIuanMiLCJpbmRleC5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTtBQ0FBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDcEpBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2hiQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUNuQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7QUMzZkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDcEZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDckZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDSkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ25zQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2pCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2MUJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMzQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EiLCJmaWxlIjoiZ2VuZXJhdGVkLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXNDb250ZW50IjpbIihmdW5jdGlvbiBlKHQsbixyKXtmdW5jdGlvbiBzKG8sdSl7aWYoIW5bb10pe2lmKCF0W29dKXt2YXIgYT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2lmKCF1JiZhKXJldHVybiBhKG8sITApO2lmKGkpcmV0dXJuIGkobywhMCk7dmFyIGY9bmV3IEVycm9yKFwiQ2Fubm90IGZpbmQgbW9kdWxlICdcIitvK1wiJ1wiKTt0aHJvdyBmLmNvZGU9XCJNT0RVTEVfTk9UX0ZPVU5EXCIsZn12YXIgbD1uW29dPXtleHBvcnRzOnt9fTt0W29dWzBdLmNhbGwobC5leHBvcnRzLGZ1bmN0aW9uKGUpe3ZhciBuPXRbb11bMV1bZV07cmV0dXJuIHMobj9uOmUpfSxsLGwuZXhwb3J0cyxlLHQsbixyKX1yZXR1cm4gbltvXS5leHBvcnRzfXZhciBpPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7Zm9yKHZhciBvPTA7bzxyLmxlbmd0aDtvKyspcyhyW29dKTtyZXR1cm4gc30pIiwiLyohXG5Db3B5cmlnaHQgMjAxNCBIZXdsZXR0LVBhY2thcmQgRGV2ZWxvcG1lbnQgQ29tcGFueSwgTC5QLlxuXG5MaWNlbnNlZCB1bmRlciB0aGUgQXBhY2hlIExpY2Vuc2UsIFZlcnNpb24gMi4wICh0aGUgXCJMaWNlbnNlXCIpO1xueW91IG1heSBub3QgdXNlIHRoaXMgZmlsZSBleGNlcHQgaW4gY29tcGxpYW5jZSB3aXRoIHRoZSBMaWNlbnNlLlxuWW91IG1heSBvYnRhaW4gYSBjb3B5IG9mIHRoZSBMaWNlbnNlIGF0XG5cbiAgICAgICBodHRwOi8vd3d3LmFwYWNoZS5vcmcvbGljZW5zZXMvTElDRU5TRS0yLjBcblxuVW5sZXNzIHJlcXVpcmVkIGJ5IGFwcGxpY2FibGUgbGF3IG9yIGFncmVlZCB0byBpbiB3cml0aW5nLCBzb2Z0d2FyZVxuZGlzdHJpYnV0ZWQgdW5kZXIgdGhlIExpY2Vuc2UgaXMgZGlzdHJpYnV0ZWQgb24gYW4gXCJBUyBJU1wiIEJBU0lTLFxuV0lUSE9VVCBXQVJSQU5USUVTIE9SIENPTkRJVElPTlMgT0YgQU5ZIEtJTkQsIGVpdGhlciBleHByZXNzIG9yIGltcGxpZWQuXG5TZWUgdGhlIExpY2Vuc2UgZm9yIHRoZSBzcGVjaWZpYyBsYW5ndWFnZSBnb3Zlcm5pbmcgcGVybWlzc2lvbnMgYW5kXG5saW1pdGF0aW9ucyB1bmRlciB0aGUgTGljZW5zZS5cbiovXG5cblwidXNlIHN0cmljdFwiO1xuXG52YXIganNvbl9ycGMgPSByZXF1aXJlKCdjYWZfdHJhbnNwb3J0JykuanNvbl9ycGM7XG5cbi8qKlxuICogQSBxdWV1ZSBvZiBwZW5kaW5nIHJlcXVlc3RzLlxuICpcbiAqIEBtb2R1bGUgY2FmX2NsaS9RdWV1ZVxuICovXG52YXIgUXVldWUgPSBleHBvcnRzLlF1ZXVlID0gZnVuY3Rpb24oY2FJZCwgb3B0aW9ucykge1xuICAgIHZhciBxdWV1ZSA9IFtdO1xuICAgIHZhciB0aGF0ID0ge307XG4gICAgdmFyIHBlbmRpbmcgPSBudWxsO1xuICAgIHZhciBtZXNzYWdlc1Byb2Nlc3NlZCA9IDA7XG4gICAgdmFyIGxhc3RNZXNzYWdlc1Byb2Nlc3NlZCA9IC0xO1xuXG4gICAgLy8gZHVwbGljYXRlLCBtb3ZlIHRvIHV0aWxcbiAgICB2YXIgc2FmZVNldEltbWVkaWF0ZSA9IGZ1bmN0aW9uKGYpIHtcbiAgICAgICAgaWYgKCh0eXBlb2Ygd2luZG93ID09PSAndW5kZWZpbmVkJykgJiYgc2V0SW1tZWRpYXRlKSB7XG4gICAgICAgICAgICBzZXRJbW1lZGlhdGUoZik7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAvLyA0bXMgZGVsYXkgaW4gbWFueSBicm93c2Vycy4uLlxuICAgICAgICAgICAgc2V0VGltZW91dChmLCAwKTtcbiAgICAgICAgfVxuICAgIH07XG5cbiAgICB0aGF0Lm51bVBlbmRpbmcgPSBmdW5jdGlvbigpIHtcbiAgICAgICByZXR1cm4gcXVldWUubGVuZ3RoICsgKHBlbmRpbmcgPyAxIDogMCk7XG4gICAgfTtcblxuICAgIHRoYXQuY2xlYXIgPSBmdW5jdGlvbigpIHtcbiAgICAgICAgcXVldWUgPSBbXTtcbiAgICAgICAgcGVuZGluZyA9IG51bGw7XG4gICAgICAgIG1lc3NhZ2VzUHJvY2Vzc2VkID0gMDtcbiAgICAgICAgbGFzdE1lc3NhZ2VzUHJvY2Vzc2VkID0gLTE7XG4gICAgfTtcblxuICAgIHRoYXQucHJvZ3Jlc3MgPSBmdW5jdGlvbigpIHtcbiAgICAgICAgdmFyIHJlc3VsdCA9IHRydWU7XG4gICAgICAgIGlmICgobWVzc2FnZXNQcm9jZXNzZWQgPT09IGxhc3RNZXNzYWdlc1Byb2Nlc3NlZCkgJiZcbiAgICAgICAgICAgICgocXVldWUubGVuZ3RoID4gMCkgfHwgcGVuZGluZykpIHtcbiAgICAgICAgICAgIHJlc3VsdCA9IGZhbHNlO1xuICAgICAgICB9XG4gICAgICAgIGxhc3RNZXNzYWdlc1Byb2Nlc3NlZCA9IG1lc3NhZ2VzUHJvY2Vzc2VkO1xuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH07XG5cbiAgICB2YXIgZHJhaW4gPSBmdW5jdGlvbih3ZWJTb2NrZXQpIHtcbiAgICAgICAgaWYgKChxdWV1ZS5sZW5ndGggPT09IDApIHx8IHBlbmRpbmcpIHsgLy8gbm8gbWVzc2FnZSBwaXBlbGluaW5nXG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgcGVuZGluZyA9IHF1ZXVlLnNoaWZ0KCk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICB3ZWJTb2NrZXQuc2VuZChKU09OLnN0cmluZ2lmeShwZW5kaW5nLnJlcSksIGZ1bmN0aW9uKGVycikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLyogQ2Fubm90IHNlbmQsIHdhaXQgZm9yIGEgbmV3IHdlYnNvY2tldCB0aGF0XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAqIHdpdGggaXRzIG9wZW4gZXZlbnQgd2lsbCB0cmlnZ2VyICdyZXRyeScuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAqXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvcHRpb25zLmxvZygnRXJyb3Igc2VuZGluZyByZXF1ZXN0ICcgKyBlcnIpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICB9IGNhdGNoKGVycikge1xuICAgICAgICAgICAgIG9wdGlvbnMubG9nKCdFeGNlcHRpb24gc2VuZGluZyByZXF1ZXN0ICcgKyBlcnIpO1xuICAgICAgICB9XG4gICAgfTtcblxuICAgIHRoYXQucmV0cnkgPSBmdW5jdGlvbih3ZWJTb2NrZXQsIG5ld1Rva2VuKSB7XG4gICAgICAgIGlmIChwZW5kaW5nKSB7XG4gICAgICAgICAgICBxdWV1ZS51bnNoaWZ0KHBlbmRpbmcpO1xuICAgICAgICAgICAgcGVuZGluZyA9IG51bGw7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKG5ld1Rva2VuKSB7XG4gICAgICAgICAgICBxdWV1ZS5mb3JFYWNoKGZ1bmN0aW9uKHgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGpzb25fcnBjLnNldFRva2VuKHgucmVxLCBuZXdUb2tlbik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIGRyYWluKHdlYlNvY2tldCk7XG4gICAgfTtcblxuICAgIHRoYXQucmVtb3RlSW52b2tlID0gZnVuY3Rpb24od2ViU29ja2V0LCBtZXRob2QsIGV4cGVjdGVkQXJncywgYXJncykge1xuICAgICAgICB2YXIgZG9UaHJvdyA9IGZ1bmN0aW9uKG1zZykge1xuICAgICAgICAgICAgdmFyIGVyciA9ICBuZXcgRXJyb3IobXNnKTtcbiAgICAgICAgICAgIGVyci5tZXRob2QgPSBtZXRob2Q7XG4gICAgICAgICAgICBlcnIuYXJncyA9IGFyZ3M7XG4gICAgICAgICAgICBlcnIuZXhwZWN0ZWRBcmdzID0gZXhwZWN0ZWRBcmdzO1xuICAgICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICB9O1xuXG4gICAgICAgIGlmICh0eXBlb2YgbWV0aG9kICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgZG9UaHJvdygnbWV0aG9kIG5hbWUgaXMgbm90IGEgc3RyaW5nJyk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KGFyZ3MpKSB7XG4gICAgICAgICAgICBkb1Rocm93KCdhcmdzIG5vdCBhbiBhcnJheScpO1xuICAgICAgICB9XG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShleHBlY3RlZEFyZ3MpKSB7XG4gICAgICAgICAgICBkb1Rocm93KCdleHBlY3RlZEFyZ3Mgbm90IGFuIGFycmF5Jyk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGFyZ3MubGVuZ3RoICE9PSBleHBlY3RlZEFyZ3MubGVuZ3RoKSB7XG4gICAgICAgICAgICBkb1Rocm93KCdVbmV4cGVjdGVkIG51bWJlciBvZiBhcmd1bWVudHMnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHZhciBjYiA9IGFyZ3MucG9wKCk7XG4gICAgICAgIGlmICh0eXBlb2YgY2IgIT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgIGRvVGhyb3coJ05vIGNhbGxiYWNrJyk7XG4gICAgICAgIH1cbiAgICAgICAgdmFyIGFsbCA9IFtvcHRpb25zLnRva2VuLCBjYUlkLCBvcHRpb25zLmZyb20sIG9wdGlvbnMuc2Vzc2lvbiwgbWV0aG9kXVxuICAgICAgICAgICAgLmNvbmNhdChhcmdzKTtcblxuICAgICAgICB2YXIgcmVxID0ganNvbl9ycGMucmVxdWVzdC5hcHBseShqc29uX3JwYy5yZXF1ZXN0LCBhbGwpO1xuICAgICAgICBxdWV1ZS5wdXNoKHtjYjogY2IsIHJlcSA6IHJlcX0pO1xuICAgICAgICBkcmFpbih3ZWJTb2NrZXQpO1xuICAgIH07XG5cbiAgICB0aGF0LnByb2Nlc3NBcHBSZXBseSA9IGZ1bmN0aW9uKHdlYlNvY2tldCwgcmVwbHkpIHtcbiAgICAgICAgaWYgKHBlbmRpbmcgJiYgcGVuZGluZy5yZXEgJiYgKHJlcGx5LmlkID09PSBwZW5kaW5nLnJlcS5pZCkgJiZcbiAgICAgICAgICAgIChqc29uX3JwYy5pc0FwcFJlcGx5KHJlcGx5KSkpIHtcbiAgICAgICAgICAgIHZhciBjYiA9IHBlbmRpbmcuY2I7XG4gICAgICAgICAgICB2YXIgZXJyID0ganNvbl9ycGMuZ2V0QXBwUmVwbHlFcnJvcihyZXBseSk7XG4gICAgICAgICAgICB2YXIgZGF0YSA9IGpzb25fcnBjLmdldEFwcFJlcGx5RGF0YShyZXBseSk7XG4gICAgICAgICAgICBzYWZlU2V0SW1tZWRpYXRlKGZ1bmN0aW9uKCkgeyBjYihlcnIsIGRhdGEpO30pO1xuICAgICAgICAgICAgcGVuZGluZyA9IG51bGw7XG4gICAgICAgICAgICBtZXNzYWdlc1Byb2Nlc3NlZCA9IG1lc3NhZ2VzUHJvY2Vzc2VkICsgMTtcbiAgICAgICAgICAgIGRyYWluKHdlYlNvY2tldCk7XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuICAgIH07XG5cbiAgICByZXR1cm4gdGhhdDtcbn07XG4iLCIvKiFcbkNvcHlyaWdodCAyMDEzIEhld2xldHQtUGFja2FyZCBEZXZlbG9wbWVudCBDb21wYW55LCBMLlAuXG5cbkxpY2Vuc2VkIHVuZGVyIHRoZSBBcGFjaGUgTGljZW5zZSwgVmVyc2lvbiAyLjAgKHRoZSBcIkxpY2Vuc2VcIik7XG55b3UgbWF5IG5vdCB1c2UgdGhpcyBmaWxlIGV4Y2VwdCBpbiBjb21wbGlhbmNlIHdpdGggdGhlIExpY2Vuc2UuXG5Zb3UgbWF5IG9idGFpbiBhIGNvcHkgb2YgdGhlIExpY2Vuc2UgYXRcblxuICAgICAgIGh0dHA6Ly93d3cuYXBhY2hlLm9yZy9saWNlbnNlcy9MSUNFTlNFLTIuMFxuXG5Vbmxlc3MgcmVxdWlyZWQgYnkgYXBwbGljYWJsZSBsYXcgb3IgYWdyZWVkIHRvIGluIHdyaXRpbmcsIHNvZnR3YXJlXG5kaXN0cmlidXRlZCB1bmRlciB0aGUgTGljZW5zZSBpcyBkaXN0cmlidXRlZCBvbiBhbiBcIkFTIElTXCIgQkFTSVMsXG5XSVRIT1VUIFdBUlJBTlRJRVMgT1IgQ09ORElUSU9OUyBPRiBBTlkgS0lORCwgZWl0aGVyIGV4cHJlc3Mgb3IgaW1wbGllZC5cblNlZSB0aGUgTGljZW5zZSBmb3IgdGhlIHNwZWNpZmljIGxhbmd1YWdlIGdvdmVybmluZyBwZXJtaXNzaW9ucyBhbmRcbmxpbWl0YXRpb25zIHVuZGVyIHRoZSBMaWNlbnNlLlxuKi9cblxuXCJ1c2Ugc3RyaWN0XCI7XG52YXIgdXJsUGFyc2VyID0gcmVxdWlyZSgndXJsJyk7XG52YXIgV2ViU29ja2V0ID0gcmVxdWlyZSgnd3MnKTtcbnZhciBqc29uX3JwYyA9IHJlcXVpcmUoJ2NhZl90cmFuc3BvcnQnKS5qc29uX3JwYztcbnZhciBRdWV1ZSA9IHJlcXVpcmUoJy4vUXVldWUnKS5RdWV1ZTtcbnZhciBxdWVyeXN0cmluZyA9IHJlcXVpcmUoJ3F1ZXJ5c3RyaW5nJyk7XG5cbnZhciBFVkVOVFMgPSBbJ2Nsb3NlJywgJ21lc3NhZ2UnLCAnb3BlbiddO1xuXG52YXIgREVGQVVMVF9NQVhfUkVUUklFUz0xMDAwMDAwMDAwMDAwMDAwOyAvLyByZXRyeSBmb3JldmVyXG5cbnZhciBERUZBVUxUX1JFVFJZX1RJTUVPVVRfTVNFQz0xMDAwO1xuXG4vKiogVGltZW91dCB0byBjbG9zZSBhIHNlc3Npb24gaWYgaXQgY2Fubm90IHNlbnQgbWVzc2FnZXMgZHVyaW5nIHRoYXQgdGltZS4qL1xudmFyIERFRkFVTFRfVElNRU9VVF9NU0VDPTI1MDAwO1xuXG4vKipcbiAqXG4gKiBBIGNvbW11bmljYXRpb24gY2hhbm5lbCB3aXRoIGEgQ0EgZm9yIHJlbW90ZVxuICogaW52b2NhdGlvbnMgYW5kIG5vdGlmaWNhdGlvbnMuXG4gKlxuICogQHBhcmFtIHtzdHJpbmd9IHVybCBBIHdlYnNvY2tldCBhZGRyZXNzIGZvciB0aGUgbm9kZSBvciBhIFVSTCB1c2luZyBxdWVyeVxuICogIHBhcmFtZXRlcnMgdG8gcHJvdmlkZSB0aGUgQ0EgbmFtZSAoJ2NhPVhYWCcpLCBzZWN1cml0eSB0b2tlbiAoJ3Rva2VuPVlZWScpLFxuICogYW5kIG90aGVyIG9wdGlvbnMuIFRoZSAndXJsJyBxdWVyeSBwYXJhbWV0ZXJzIGhhdmUgcHJlY2VkZW5jZSBvdmVyIHRoZVxuICogb3B0aW9uYWwgJ29wdGlvbnMnIG9yICdjYUlkJyBwYXJhbWV0ZXJzLlxuICogQHBhcmFtIHtzdHJpbmc9fSBjYUlkIEFuIGlkZW50aWZpZXIgZm9yIHRoZSB0YXJnZXQgQ0EuXG4gKiBAcGFyYW0ge09iamVjdD19IG9wdGlvbnMgQ29uZmlndXJhdGlvbiBmb3IgdGhpcyBzZXNzaW9uLlxuICpcbiAqIEByZXR1cm4ge1Nlc3Npb259IEEgc2Vzc2lvbiBvYmplY3QgKGl0IGNhbiBiZSBpbnZva2VkIHVzaW5nICduZXcnKS5cbiAqIEBjb25zdHJ1Y3RvclxuICogQG1vZHVsZSBjYWZfY2xpL1Nlc3Npb25cbiAqL1xuXG52YXIgU2Vzc2lvbiA9IGV4cG9ydHMuU2Vzc2lvbiA9IGZ1bmN0aW9uKHVybCwgY2FJZCwgb3B0aW9ucykge1xuXG4gICAgdmFyIHNhZmVTZXRJbW1lZGlhdGUgPSBmdW5jdGlvbihmKSB7XG4gICAgICAgIGlmICgodHlwZW9mIHdpbmRvdyA9PT0gJ3VuZGVmaW5lZCcpICYmIHNldEltbWVkaWF0ZSkge1xuICAgICAgICAgICAgc2V0SW1tZWRpYXRlKGYpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgLy8gNG1zIGRlbGF5IGluIG1hbnkgYnJvd3NlcnMuLi5cbiAgICAgICAgICAgIHNldFRpbWVvdXQoZiwgMCk7XG4gICAgICAgIH1cbiAgICB9O1xuXG4gICAgdmFyIG1peGluID0gZnVuY3Rpb24oZGVzdCwgc291cmNlKSB7XG4gICAgICAgIHNvdXJjZSA9IHNvdXJjZSB8fCB7fTtcbiAgICAgICAgT2JqZWN0LmtleXMoc291cmNlKS5mb3JFYWNoKGZ1bmN0aW9uKHgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoc291cmNlLmhhc093blByb3BlcnR5KHgpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RbeF0gPSBzb3VyY2VbeF07XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgfTtcblxuICAgIHZhciBjbG9uZU9wdGlvbnMgPSBmdW5jdGlvbihvYmopIHtcbiAgICAgICAgdmFyIHJlc3VsdCA9IHt9O1xuICAgICAgICBtaXhpbihyZXN1bHQsIG9iaik7XG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfTtcblxuICAgIHZhciB0b2tlbkZhY3RvcnkgPSBudWxsO1xuXG4gICAgb3B0aW9ucyA9IGNsb25lT3B0aW9ucyhvcHRpb25zKTtcbiAgICBvcHRpb25zLnRva2VuID0gb3B0aW9ucy50b2tlbiB8fCBqc29uX3JwYy5EVU1NWV9UT0tFTjtcbiAgICBvcHRpb25zLmZyb20gPSBvcHRpb25zLmZyb20gfHwganNvbl9ycGMuREVGQVVMVF9GUk9NO1xuICAgIG9wdGlvbnMuc2Vzc2lvbiA9IG9wdGlvbnMuc2Vzc2lvbiB8fCBqc29uX3JwYy5ERUZBVUxUX1NFU1NJT047XG4gICAgb3B0aW9ucy5sb2cgPSBvcHRpb25zLmxvZyB8fCBmdW5jdGlvbihtc2cpIHsgY29uc29sZS5sb2cobXNnKTt9O1xuICAgIG9wdGlvbnMubmV3VG9rZW4gPSBvcHRpb25zLm5ld1Rva2VuIHx8IGZ1bmN0aW9uKG1zZywgY2IpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdub3QgaW1wbGVtZW50ZWQnKTtcbiAgICB9O1xuICAgIHZhciBwYXJzZWRVUkwgPSB1cmxQYXJzZXIucGFyc2UodXJsKTtcbiAgICBpZiAocGFyc2VkVVJMLnF1ZXJ5KSB7XG4gICAgICAgIG1peGluKG9wdGlvbnMsIHF1ZXJ5c3RyaW5nLnBhcnNlKHBhcnNlZFVSTC5xdWVyeSkpO1xuICAgIH1cbiAgICBpZiAocGFyc2VkVVJMLmhhc2ggJiYgKHBhcnNlZFVSTC5oYXNoLmluZGV4T2YoJyMnKSA9PT0gMCkpIHtcbiAgICAgICAgIG1peGluKG9wdGlvbnMsIHF1ZXJ5c3RyaW5nLnBhcnNlKHBhcnNlZFVSTC5oYXNoLnNsaWNlKDEpKSk7XG4gICAgfVxuICAgIHBhcnNlZFVSTC5wcm90b2NvbCA9IChwYXJzZWRVUkwucHJvdG9jb2wgPT09ICdodHRwOicgP1xuICAgICAgICAgICAgICAgICAgICAgICAgICAnd3M6JzogcGFyc2VkVVJMLnByb3RvY29sKTtcbiAgICBwYXJzZWRVUkwucHJvdG9jb2wgPSAocGFyc2VkVVJMLnByb3RvY29sID09PSAnaHR0cHM6JyA/XG4gICAgICAgICAgICAgICAgICAgICAgICAgICd3c3M6JzogcGFyc2VkVVJMLnByb3RvY29sKTtcbiAgICBwYXJzZWRVUkwuc2VhcmNoID0gbnVsbDsgLy9yZW1vdmUgcXVlcnlcbiAgICBwYXJzZWRVUkwuaGFzaCA9IG51bGw7IC8vIHJlbW92ZSBmcmFnbWVudFxuXG4gICAgdHJ5IHtcbiAgICAgICAgdmFyIGggPSBqc29uX3JwYy5zcGxpdE5hbWUocGFyc2VkVVJMLmhvc3RuYW1lLnNwbGl0KCcuJylbMF0pO1xuICAgICAgICBvcHRpb25zLmFwcFB1Ymxpc2hlciA9IG9wdGlvbnMuYXBwUHVibGlzaGVyIHx8IGhbMF07XG4gICAgICAgIG9wdGlvbnMuYXBwTG9jYWxOYW1lID0gb3B0aW9ucy5hcHBMb2NhbE5hbWUgfHwgaFsxXTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgb3B0aW9ucy5sb2cgJiYgb3B0aW9ucy5sb2coJ1dhcm5pbmc6IGhvc3RuYW1lIGluIHVybCAnICsgdXJsICtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgJyBpcyBub3Qgb2YgdGhlIGZvcm0nICtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgJyBhcHBQdWJsaXNoZXItYXBwTG9jYWxOYW1lIFxcbiBFeGNlcHRpb246JyArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVycik7XG4gICAgfVxuXG4gICAgdXJsID0gdXJsUGFyc2VyLmZvcm1hdChwYXJzZWRVUkwpO1xuICAgIGNhSWQgPSAob3B0aW9ucy5jYSA/IG9wdGlvbnMuY2EgOiBjYUlkKTtcbiAgICBvcHRpb25zLmNhID0gY2FJZDtcblxuICAgIG9wdGlvbnMubmV3VVJMID0gb3B0aW9ucy5uZXdVUkwgfHwgZnVuY3Rpb24obXNnLCBjYikge1xuICAgICAgICB2YXIgbmV3VXJsID0ganNvbl9ycGMucmVkaXJlY3REZXN0aW5hdGlvbihtc2cpO1xuICAgICAgICBuZXdVcmwgPSBwYXJzZWRVUkwucHJvdG9jb2wgKyAnLy8nICsgbmV3VXJsO1xuICAgICAgICBpZiAobmV3VXJsKSB7XG4gICAgICAgICAgICBjYihudWxsLCBuZXdVcmwpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdmFyIGVyciA9IG5ldyBFcnJvcignTm90IGEgdmFsaWQgcmVkaXJlY3Rpb24gbWVzc2FnZScpO1xuICAgICAgICAgICAgZXJyLm1zZyA9IG1zZztcbiAgICAgICAgICAgIGNiKGVycik7XG4gICAgICAgIH1cbiAgICB9O1xuICAgIG9wdGlvbnMubWF4UmV0cmllcyA9ICgodHlwZW9mIG9wdGlvbnMubWF4UmV0cmllcyA9PT0gJ251bWJlcicpID9cbiAgICAgICAgICAgICAgICAgICAgICAgICAgb3B0aW9ucy5tYXhSZXRyaWVzIDogREVGQVVMVF9NQVhfUkVUUklFUyk7XG4gICAgb3B0aW9ucy5yZXRyeVRpbWVvdXRNc2VjID1cbiAgICAgICAgKCh0eXBlb2Ygb3B0aW9ucy5yZXRyeVRpbWVvdXRNc2VjID09PSAnbnVtYmVyJykgP1xuICAgICAgICAgb3B0aW9ucy5yZXRyeVRpbWVvdXRNc2VjIDogREVGQVVMVF9SRVRSWV9USU1FT1VUX01TRUMpO1xuXG4gICAgb3B0aW9ucy50aW1lb3V0TXNlYyA9XG4gICAgICAgICgodHlwZW9mIG9wdGlvbnMudGltZW91dE1zZWMgPT09ICdudW1iZXInKSA/XG4gICAgICAgICBvcHRpb25zLnRpbWVvdXRNc2VjIDogREVGQVVMVF9USU1FT1VUX01TRUMpO1xuXG4gICAgLy9vcHRpb25zLmRpc2FibGVCYWNrY2hhbm5lbD0gPGJvb2xlYW4+XG5cbiAgICB2YXIgdGhhdCA9IHt9O1xuXG4gICAgdmFyIGN1cnJlbnRVcmwgPSB1cmw7XG5cbiAgICB2YXIgbGlzdGVuZXJzID0ge307XG5cbiAgICAvLyBub24tcmVjb3ZlcmFibGUgc2Vzc2lvbiBzaHV0ZG93blxuICAgIHZhciBjbG9zZWQgPSBmYWxzZTtcblxuICAgIHZhciB3ZWJTb2NrZXQgPSBudWxsO1xuXG4gICAgdmFyIGZpcnN0VGltZSA9IHRydWU7XG5cbiAgICB2YXIgbnVtUmV0cmllcyA9IDA7XG5cbiAgICB2YXIgdGltZW91dCA9IG51bGw7XG5cbiAgICB0aGF0LmlzQ2xvc2VkID0gZnVuY3Rpb24oKSB7XG4gICAgICAgIHJldHVybiBjbG9zZWQ7XG4gICAgfTtcblxuICAgIHZhciBxdWV1ZXMgPSB7cnBjOiBRdWV1ZShjYUlkLCBvcHRpb25zKSwgYmFja2NoYW5uZWw6IFF1ZXVlKGNhSWQsIG9wdGlvbnMpfTtcblxuICAgIHZhciBkb1F1ZXVlcyA9IGZ1bmN0aW9uKGYpIHtcbiAgICAgICAgT2JqZWN0LmtleXMocXVldWVzKS5mb3JFYWNoKGZ1bmN0aW9uKHgpIHsgZih4KTt9KTtcbiAgICB9O1xuXG4gICAgdmFyIHJldHJ5ID0gZnVuY3Rpb24oKSB7XG4gICAgICAgIGRvUXVldWVzKGZ1bmN0aW9uKHgpIHsgcXVldWVzW3hdLnJldHJ5KHdlYlNvY2tldCwgb3B0aW9ucy50b2tlbik7fSk7XG4gICAgfTtcblxuICAgIHZhciBwcm9ncmVzcyA9IGZ1bmN0aW9uKCkge1xuICAgICAgICB2YXIgcmVzdWx0ID0gdHJ1ZTtcbiAgICAgICAgZG9RdWV1ZXMoZnVuY3Rpb24oeCkgeyBpZiAoIXF1ZXVlc1t4XS5wcm9ncmVzcygpKSB7IHJlc3VsdCA9IGZhbHNlO319KTtcbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9O1xuXG4gICAgdmFyIGFkZE1ldGhvZHMgPSBmdW5jdGlvbihtZXRhKSB7XG4gICAgICAgIE9iamVjdC5rZXlzKG1ldGEpXG4gICAgICAgICAgICAuZm9yRWFjaChmdW5jdGlvbih4KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgdGhhdFt4XSA9IGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YXIgYXJncyA9IEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGFyZ3VtZW50cyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgIHF1ZXVlcy5ycGMucmVtb3RlSW52b2tlKHdlYlNvY2tldCwgeCwgbWV0YVt4XSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXJncyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgIH07XG5cbiAgICB2YXIgYWRkQmFja2NoYW5uZWwgPSBmdW5jdGlvbigpIHtcbiAgICAgICAgdmFyIGNiID0gZnVuY3Rpb24oZXJyLCBtc2cpIHtcbiAgICAgICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICAgICAgICBpZiAoZXJyLnRpbWVvdXQpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFjbG9zZWQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHNhZmVTZXRJbW1lZGlhdGUoYWRkQmFja2NoYW5uZWwpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgb3B0aW9ucy5sb2coXCJFcnJvciBpbiBiYWNrY2hhbm5lbCA6IHRvIGRpc2FibGUgdXNlIFwiICtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJvcHRpb24gJ2Rpc2FibGVCYWNrY2hhbm5lbD10cnVlJyBFcnJvcjpcIiArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KGVycikpO1xuICAgICAgICAgICAgICAgICAgICB0aGF0LmNsb3NlKGVycik7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBpZiAoIWNsb3NlZCkge1xuICAgICAgICAgICAgICAgICAgICBzYWZlU2V0SW1tZWRpYXRlKGFkZEJhY2tjaGFubmVsKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGxpc3RlbmVycy5tZXNzYWdlICYmIGpzb25fcnBjLmlzTm90aWZpY2F0aW9uKG1zZykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxpc3RlbmVycy5tZXNzYWdlKG1zZyk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBvcHRpb25zLmxvZygnSWdub3JpbmcgYmFja2NoYW5uZWwgbWVzc2FnZSAnICtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgSlNPTi5zdHJpbmdpZnkobXNnKSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH07XG4gICAgICAgIGlmICghb3B0aW9ucy5kaXNhYmxlQmFja2NoYW5uZWwgJiYgIWNsb3NlZCkge1xuICAgICAgICAgICAgcXVldWVzLmJhY2tjaGFubmVsLnJlbW90ZUludm9rZSh3ZWJTb2NrZXQsICdiYWNrY2hhbm5lbCcsIFsnY2InXSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgW2NiXSk7XG4gICAgICAgIH1cbiAgICB9O1xuXG4gICAgdmFyIHN0YXJ0VGltZW91dCA9IGZ1bmN0aW9uKCkge1xuICAgICAgICByZXR1cm4gc2V0SW50ZXJ2YWwoZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFwcm9ncmVzcygpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhciBlcnIgPSBuZXcgRXJyb3IoJ1RpbWVvdXQnKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZXJyLnRpbWVvdXQgPSB0cnVlO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGF0LmNsb3NlKGVycik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbnVtUmV0cmllcyA9IDA7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICB9LCBvcHRpb25zLnRpbWVvdXRNc2VjKTtcbiAgICB9O1xuXG5cbiAgICAvLyBJbnRlcm5hbCBXZWJTb2NrZXQgZXZlbnQgaGFuZGxlcnMgdGhhdCBkZWxlZ2F0ZSB0byBleHRlcm5hbCBvbmVzLlxuXG4gICAgdmFyIG9ub3BlbiA9IGZ1bmN0aW9uKCkge1xuICAgICAgICB2YXIgY2IgPSBmdW5jdGlvbihlcnIsIG1ldGEpIHtcbiAgICAgICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICAgICAgICB2YXIgZXJyb3IgPVxuICAgICAgICAgICAgICAgICAgICBuZXcgRXJyb3IoJ0JVRzogX19leHRlcm5hbF9jYV90b3VjaF9fICcgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgJ3Nob3VsZCBub3QgcmV0dXJuIGFwcCBlcnJvcicpO1xuICAgICAgICAgICAgICAgIGVycm9yLmVyciA9IGVycjtcbiAgICAgICAgICAgICAgICB0aGF0LmNsb3NlKGVycm9yKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYWRkTWV0aG9kcyhtZXRhKTtcbiAgICAgICAgICAgICAgICBhZGRCYWNrY2hhbm5lbCgpO1xuICAgICAgICAgICAgICAgIHRpbWVvdXQgPSBzdGFydFRpbWVvdXQoKTtcbiAgICAgICAgICAgICAgICBpZiAobGlzdGVuZXJzLm9wZW4pIHtcbiAgICAgICAgICAgICAgICAgICAgbGlzdGVuZXJzLm9wZW4oKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH07XG4gICAgICAgIGlmIChmaXJzdFRpbWUpIHtcbiAgICAgICAgICAgIGZpcnN0VGltZSA9IGZhbHNlO1xuICAgICAgICAgICAgcXVldWVzLnJwYy5yZW1vdGVJbnZva2Uod2ViU29ja2V0LCAnX19leHRlcm5hbF9jYV90b3VjaF9fJywgWydjYiddLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBbY2JdKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHJldHJ5KCk7XG4gICAgICAgIH1cbiAgICB9O1xuXG4gICAgdmFyIHJlY292ZXIgPSBmdW5jdGlvbihtc2csIGVycikge1xuICAgICAgICBpZiAoIWNsb3NlZCkge1xuICAgICAgICAgICAgb3B0aW9ucy5sb2cobXNnICsgZXJyKTtcbiAgICAgICAgICAgIGlmIChudW1SZXRyaWVzIDwgb3B0aW9ucy5tYXhSZXRyaWVzKSB7XG4gICAgICAgICAgICAgICAgbnVtUmV0cmllcyA9IG51bVJldHJpZXMgKyAxO1xuICAgICAgICAgICAgICAgIHNldFRpbWVvdXQoZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb3B0aW9ucy5sb2coJ1JldHJ5aW5nLi4uJyArIG51bVJldHJpZXMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGN1cnJlbnRVcmwgPSB1cmw7IC8vIG9yaWdpbmFsIHVybFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlc2V0V2ViU29ja2V0KCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICB9LCBvcHRpb25zLnJldHJ5VGltZW91dE1zZWMpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB2YXIgZXJyb3IgPSBuZXcgRXJyb3IoJ01heCByZXRyaWVzIGV4Y2VlZGVkJyk7XG4gICAgICAgICAgICAgICAgZXJyb3IuZXJyID0gZXJyO1xuICAgICAgICAgICAgICAgIGVycm9yLm1heFJldHJpZXNFeGNlZWRlZCA9IHRydWU7XG4gICAgICAgICAgICAgICAgdGhhdC5jbG9zZShlcnJvcik7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9O1xuXG4gICAgdmFyIG9uY2xvc2UgPSBmdW5jdGlvbihlcnIpIHtcbiAgICAgICAgcmVjb3ZlcignQ2xvc2VkIFdlYlNvY2tldDogZXJyb3IgJywgZXJyKTtcbiAgICB9O1xuXG4gICAgdmFyIG9uZXJyb3IgPSBmdW5jdGlvbihlcnIpIHtcbiAgICAgICAgcmVjb3ZlcignRXJyb3IgaW4gd2Vic29ja2V0ICcsIGVycik7XG4gICAgfTtcblxuICAgIHZhciBvbm1lc3NhZ2UgPSBmdW5jdGlvbihldikge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgdmFyIG1zZyA9IEpTT04ucGFyc2UoZXYuZGF0YSk7XG4gICAgICAgICAgICBpZiAoIWhhbmRsZU1zZyhtc2cpKSB7XG4gICAgICAgICAgICAgICAgaWYgKGxpc3RlbmVycy5tZXNzYWdlICYmIGpzb25fcnBjLmlzTm90aWZpY2F0aW9uKG1zZykpIHtcbiAgICAgICAgICAgICAgICAgICAgbGlzdGVuZXJzLm1lc3NhZ2UobXNnKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBvcHRpb25zLmxvZygnSWdub3JpbmcgbWVzc2FnZSAnICsgZXYuZGF0YSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9IGNhdGNoKGVycikge1xuICAgICAgICAgICAgb3B0aW9ucy5sb2coJ0lnbm9yaW5nIHVucGFyc2FibGUgbWVzc2FnZSAnICsgZXYuZGF0YSArICcgZXJyb3I6JyArXG4gICAgICAgICAgICAgICAgICAgICAgICBlcnIpO1xuICAgICAgICB9XG4gICAgfTtcblxuICAgIC8qKlxuICAgICAqIEhhbmRsZXMgYSBDQSBtZXNzYWdlLiBXZSBoYXZlIHRoZSBmb2xsb3dpbmcgY2FzZXM6XG4gICAgICpcbiAgICAgKiAxKSBObyBlcnJvciAtPiByb3V0ZSB0byBhcHByb3ByaWF0ZSBxdWV1ZS5cbiAgICAgKiAyKSBBcHBsaWNhdGlvbiBlcnJvciAtPiByb3V0ZSB0byBhcHByb3ByaWF0ZSBxdWV1ZS5cbiAgICAgKiAzKSBTeXN0ZW0gZXJyb3JcbiAgICAgKiAgIDMtYSkgUmVkaXJlY3QgLT4gbmV3IFdlYlNvY2tldCB1cmwgKyByZXRyeVxuICAgICAqICAgMy1iKSBTZWN1cml0eSAtPiBuZXcgdG9rZW4gKyByZXRyeVxuICAgICAqICAgMy1jKSBSZWNvdmVyYWJsZSAtPiB3YWl0IGZvciB0aW1lb3V0ICsgcmV0cnlcbiAgICAgKiAgIDMtZCkgTm9uLVJlY292ZXJhYmxlIC0+IGNsb3NlIHNlc3Npb24vbG9nIGVycm9yXG4gICAgICovXG4gICAgdmFyIGhhbmRsZU1zZyA9IGZ1bmN0aW9uKG1zZykge1xuICAgICAgICBpZiAoanNvbl9ycGMuaXNTeXN0ZW1FcnJvcihtc2cpKSB7XG4gICAgICAgICAgICBpZiAoanNvbl9ycGMuaXNSZWRpcmVjdChtc2cpKSB7XG4gICAgICAgICAgICAgICAgdmFyIGNiID0gZnVuY3Rpb24oZXJyLCBuZXdVcmwpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhhdC5jbG9zZShlcnIpO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgY3VycmVudFVybCA9IG5ld1VybDtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlc2V0V2ViU29ja2V0KCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgIG9wdGlvbnMubmV3VVJMKG1zZywgY2IpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChqc29uX3JwYy5pc05vdEF1dGhlbnRpY2F0ZWQobXNnKSkge1xuICAgICAgICAgICAgICAgIHZhciBjYjAgPSBmdW5jdGlvbihlcnIsIHRva2VuKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIG9wdGlvbnMubG9nKGVycik7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGF0LmNsb3NlKGVycik7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBvcHRpb25zLnRva2VuID0gdG9rZW47XG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBkbyBub3QgY2hhbmdlIHVybCB1bnRpbCBhdXRoZW50aWNhdGVkXG4gICAgICAgICAgICAgICAgICAgICAgICByZXNldFdlYlNvY2tldCgpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICBvcHRpb25zLm5ld1Rva2VuKG1zZywgY2IwKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoanNvbl9ycGMuaXNFcnJvclJlY292ZXJhYmxlKG1zZykgJiZcbiAgICAgICAgICAgICAgICAgICAgICAgKG51bVJldHJpZXMgPCBvcHRpb25zLm1heFJldHJpZXMpKSB7XG4gICAgICAgICAgICAgICAgbnVtUmV0cmllcyA9IG51bVJldHJpZXMgKyAxO1xuICAgICAgICAgICAgICAgIHNldFRpbWVvdXQoZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY3VycmVudFVybCA9IHVybDsgLy8gb3JpZ2luYWwgdXJsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVzZXRXZWJTb2NrZXQoKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sIG9wdGlvbnMucmV0cnlUaW1lb3V0TXNlYyk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIC8vIE5vbi1yZWNvdmVyYWJsZSBlcnJvclxuICAgICAgICAgICAgICAgIG9wdGlvbnMubG9nKG1zZyk7XG4gICAgICAgICAgICAgICAgdGhhdC5jbG9zZShtc2cpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0gZWxzZSBpZiAoanNvbl9ycGMuaXNBcHBSZXBseShtc2cpKXtcbiAgICAgICAgICAgIHJldHVybiBPYmplY3Qua2V5cyhxdWV1ZXMpXG4gICAgICAgICAgICAgICAgLnNvbWUoZnVuY3Rpb24oeCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gcXVldWVzW3hdLnByb2Nlc3NBcHBSZXBseSh3ZWJTb2NrZXQsIG1zZyk7XG4gICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICB9O1xuXG4gICAgdmFyIG5ld1dlYlNvY2tldCA9ICBmdW5jdGlvbigpIHtcbiAgICAgICAgb3B0aW9ucy5sb2coJ25ldyBXZWJTb2NrZXQ6JyArIGN1cnJlbnRVcmwpO1xuICAgICAgICB3ZWJTb2NrZXQgPSBuZXcgV2ViU29ja2V0KGN1cnJlbnRVcmwpO1xuICAgICAgICB3ZWJTb2NrZXQub25jbG9zZSA9IG9uY2xvc2U7XG4gICAgICAgIHdlYlNvY2tldC5vbm1lc3NhZ2UgPSBvbm1lc3NhZ2U7XG4gICAgICAgIHdlYlNvY2tldC5vbm9wZW4gPSBvbm9wZW47XG4gICAgICAgIHdlYlNvY2tldC5vbmVycm9yID0gb25lcnJvcjtcbiAgICB9O1xuXG4gICAgdmFyIGNsb3NlV2ViU29ja2V0ID0gZnVuY3Rpb24oKSB7XG4gICAgICAgIGlmICh3ZWJTb2NrZXQpIHtcbiAgICAgICAgICAgIHdlYlNvY2tldC5vbmNsb3NlID0gbnVsbDtcbiAgICAgICAgICAgIHdlYlNvY2tldC5vbm1lc3NhZ2UgPSBudWxsO1xuICAgICAgICAgICAgd2ViU29ja2V0Lm9ub3BlbiA9IG51bGw7XG4gICAgICAgICAgICAvLyBsZWF2ZSAnb25lcnJvcicgdG8gYXZvaWQgJ2Vycm9yJyBicmluZ2luZyBkb3duIHRoZSBwcm9jZXNzLlxuICAgICAgICAgICAgd2ViU29ja2V0Lm9uZXJyb3IgPSBmdW5jdGlvbigpIHt9O1xuICAgICAgICAgICAgdmFyIG9sZCA9IHdlYlNvY2tldDtcbiAgICAgICAgICAgIHdlYlNvY2tldCA9IG51bGw7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIG9sZC5jbG9zZSgpO1xuICAgICAgICAgICAgfSBjYXRjaCAoZXgpIHtcbiAgICAgICAgICAgICAgICBvcHRpb25zLmxvZygnRXhjZXB0aW9uIGNsb3Npbmcgd2Vic29ja2V0OiAnICsgZXgpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfTtcblxuICAgIHZhciByZXNldFdlYlNvY2tldCA9IGZ1bmN0aW9uKCkge1xuICAgICAgICBjbG9zZVdlYlNvY2tldCgpO1xuICAgICAgICBuZXdXZWJTb2NrZXQoKTtcbiAgICB9O1xuXG4gICAgdGhhdC5jbG9zZSA9IGZ1bmN0aW9uKGVycikge1xuICAgICAgICBjbG9zZWQgPSB0cnVlO1xuICAgICAgICBPYmplY3Qua2V5cyhxdWV1ZXMpLmZvckVhY2goZnVuY3Rpb24oeCkgeyBxdWV1ZXNbeF0uY2xlYXIoKTsgfSk7XG4gICAgICAgIGNsb3NlV2ViU29ja2V0KCk7XG4gICAgICAgIGlmICh0aW1lb3V0KSB7XG4gICAgICAgICAgICBjbGVhckludGVydmFsKHRpbWVvdXQpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChsaXN0ZW5lcnMuY2xvc2UpIHtcbiAgICAgICAgICAgIGxpc3RlbmVycy5jbG9zZShlcnIpO1xuICAgICAgICB9XG4gICAgfTtcblxuICAgIHRoYXQubnVtUGVuZGluZyA9IGZ1bmN0aW9uKCkge1xuICAgICAgICB2YXIgcmVzdWx0ID0gMDtcbiAgICAgICAgZG9RdWV1ZXMoZnVuY3Rpb24oeCkgeyByZXN1bHQgPSByZXN1bHQgKyBxdWV1ZXNbeF0ubnVtUGVuZGluZygpO30pO1xuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH07XG5cbiAgICBFVkVOVFMuZm9yRWFjaChmdW5jdGlvbihtZXRob2QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgdmFyIHByb3AgPSAnb24nICsgbWV0aG9kO1xuICAgICAgICAgICAgICAgICAgICAgICB2YXIgZGVzYyA9ICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICBnZXQ6IGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBsaXN0ZW5lcnNbbWV0aG9kXTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICBzZXQgOiBmdW5jdGlvbihuZXdMaXN0ZW5lcikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxpc3RlbmVyc1ttZXRob2RdID0gbmV3TGlzdGVuZXI7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICAgICAgICAgICAgIE9iamVjdC5kZWZpbmVQcm9wZXJ0eSh0aGF0LCBwcm9wLCBkZXNjKTtcbiAgICAgICAgICAgICAgICAgICB9KTtcblxuICAgIG5ld1dlYlNvY2tldCgpO1xuXG4gICAgcmV0dXJuIHRoYXQ7XG59O1xuXG5leHBvcnRzLmNiUHJpbnQgPSBmdW5jdGlvbihlcnIsIGRhdGEpIHtcbiAgICBpZiAoZXJyKSB7XG4gICAgICAgIGNvbnNvbGUubG9nKCdHb3QgZXJyb3I6ICcgKyBKU09OLnN0cmluZ2lmeShlcnIpKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICBjb25zb2xlLmxvZygnR290IGRhdGE6ICcgKyBKU09OLnN0cmluZ2lmeShkYXRhKSk7XG4gICAgfTtcbn07XG4iLCIvKiFcbkNvcHlyaWdodCAyMDEzIEhld2xldHQtUGFja2FyZCBEZXZlbG9wbWVudCBDb21wYW55LCBMLlAuXG5cbkxpY2Vuc2VkIHVuZGVyIHRoZSBBcGFjaGUgTGljZW5zZSwgVmVyc2lvbiAyLjAgKHRoZSBcIkxpY2Vuc2VcIik7XG55b3UgbWF5IG5vdCB1c2UgdGhpcyBmaWxlIGV4Y2VwdCBpbiBjb21wbGlhbmNlIHdpdGggdGhlIExpY2Vuc2UuXG5Zb3UgbWF5IG9idGFpbiBhIGNvcHkgb2YgdGhlIExpY2Vuc2UgYXRcblxuICAgICAgIGh0dHA6Ly93d3cuYXBhY2hlLm9yZy9saWNlbnNlcy9MSUNFTlNFLTIuMFxuXG5Vbmxlc3MgcmVxdWlyZWQgYnkgYXBwbGljYWJsZSBsYXcgb3IgYWdyZWVkIHRvIGluIHdyaXRpbmcsIHNvZnR3YXJlXG5kaXN0cmlidXRlZCB1bmRlciB0aGUgTGljZW5zZSBpcyBkaXN0cmlidXRlZCBvbiBhbiBcIkFTIElTXCIgQkFTSVMsXG5XSVRIT1VUIFdBUlJBTlRJRVMgT1IgQ09ORElUSU9OUyBPRiBBTlkgS0lORCwgZWl0aGVyIGV4cHJlc3Mgb3IgaW1wbGllZC5cblNlZSB0aGUgTGljZW5zZSBmb3IgdGhlIHNwZWNpZmljIGxhbmd1YWdlIGdvdmVybmluZyBwZXJtaXNzaW9ucyBhbmRcbmxpbWl0YXRpb25zIHVuZGVyIHRoZSBMaWNlbnNlLlxuKi9cblxuXCJ1c2Ugc3RyaWN0XCI7XG5tb2R1bGUuZXhwb3J0cyA9IHJlcXVpcmUoJy4vU2Vzc2lvbicpO1xuXG4iLCIvKiEgaHR0cDovL210aHMuYmUvcHVueWNvZGUgdjEuMi40IGJ5IEBtYXRoaWFzICovXG47KGZ1bmN0aW9uKHJvb3QpIHtcblxuXHQvKiogRGV0ZWN0IGZyZWUgdmFyaWFibGVzICovXG5cdHZhciBmcmVlRXhwb3J0cyA9IHR5cGVvZiBleHBvcnRzID09ICdvYmplY3QnICYmIGV4cG9ydHM7XG5cdHZhciBmcmVlTW9kdWxlID0gdHlwZW9mIG1vZHVsZSA9PSAnb2JqZWN0JyAmJiBtb2R1bGUgJiZcblx0XHRtb2R1bGUuZXhwb3J0cyA9PSBmcmVlRXhwb3J0cyAmJiBtb2R1bGU7XG5cdHZhciBmcmVlR2xvYmFsID0gdHlwZW9mIGdsb2JhbCA9PSAnb2JqZWN0JyAmJiBnbG9iYWw7XG5cdGlmIChmcmVlR2xvYmFsLmdsb2JhbCA9PT0gZnJlZUdsb2JhbCB8fCBmcmVlR2xvYmFsLndpbmRvdyA9PT0gZnJlZUdsb2JhbCkge1xuXHRcdHJvb3QgPSBmcmVlR2xvYmFsO1xuXHR9XG5cblx0LyoqXG5cdCAqIFRoZSBgcHVueWNvZGVgIG9iamVjdC5cblx0ICogQG5hbWUgcHVueWNvZGVcblx0ICogQHR5cGUgT2JqZWN0XG5cdCAqL1xuXHR2YXIgcHVueWNvZGUsXG5cblx0LyoqIEhpZ2hlc3QgcG9zaXRpdmUgc2lnbmVkIDMyLWJpdCBmbG9hdCB2YWx1ZSAqL1xuXHRtYXhJbnQgPSAyMTQ3NDgzNjQ3LCAvLyBha2EuIDB4N0ZGRkZGRkYgb3IgMl4zMS0xXG5cblx0LyoqIEJvb3RzdHJpbmcgcGFyYW1ldGVycyAqL1xuXHRiYXNlID0gMzYsXG5cdHRNaW4gPSAxLFxuXHR0TWF4ID0gMjYsXG5cdHNrZXcgPSAzOCxcblx0ZGFtcCA9IDcwMCxcblx0aW5pdGlhbEJpYXMgPSA3Mixcblx0aW5pdGlhbE4gPSAxMjgsIC8vIDB4ODBcblx0ZGVsaW1pdGVyID0gJy0nLCAvLyAnXFx4MkQnXG5cblx0LyoqIFJlZ3VsYXIgZXhwcmVzc2lvbnMgKi9cblx0cmVnZXhQdW55Y29kZSA9IC9eeG4tLS8sXG5cdHJlZ2V4Tm9uQVNDSUkgPSAvW14gLX5dLywgLy8gdW5wcmludGFibGUgQVNDSUkgY2hhcnMgKyBub24tQVNDSUkgY2hhcnNcblx0cmVnZXhTZXBhcmF0b3JzID0gL1xceDJFfFxcdTMwMDJ8XFx1RkYwRXxcXHVGRjYxL2csIC8vIFJGQyAzNDkwIHNlcGFyYXRvcnNcblxuXHQvKiogRXJyb3IgbWVzc2FnZXMgKi9cblx0ZXJyb3JzID0ge1xuXHRcdCdvdmVyZmxvdyc6ICdPdmVyZmxvdzogaW5wdXQgbmVlZHMgd2lkZXIgaW50ZWdlcnMgdG8gcHJvY2VzcycsXG5cdFx0J25vdC1iYXNpYyc6ICdJbGxlZ2FsIGlucHV0ID49IDB4ODAgKG5vdCBhIGJhc2ljIGNvZGUgcG9pbnQpJyxcblx0XHQnaW52YWxpZC1pbnB1dCc6ICdJbnZhbGlkIGlucHV0J1xuXHR9LFxuXG5cdC8qKiBDb252ZW5pZW5jZSBzaG9ydGN1dHMgKi9cblx0YmFzZU1pbnVzVE1pbiA9IGJhc2UgLSB0TWluLFxuXHRmbG9vciA9IE1hdGguZmxvb3IsXG5cdHN0cmluZ0Zyb21DaGFyQ29kZSA9IFN0cmluZy5mcm9tQ2hhckNvZGUsXG5cblx0LyoqIFRlbXBvcmFyeSB2YXJpYWJsZSAqL1xuXHRrZXk7XG5cblx0LyotLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSovXG5cblx0LyoqXG5cdCAqIEEgZ2VuZXJpYyBlcnJvciB1dGlsaXR5IGZ1bmN0aW9uLlxuXHQgKiBAcHJpdmF0ZVxuXHQgKiBAcGFyYW0ge1N0cmluZ30gdHlwZSBUaGUgZXJyb3IgdHlwZS5cblx0ICogQHJldHVybnMge0Vycm9yfSBUaHJvd3MgYSBgUmFuZ2VFcnJvcmAgd2l0aCB0aGUgYXBwbGljYWJsZSBlcnJvciBtZXNzYWdlLlxuXHQgKi9cblx0ZnVuY3Rpb24gZXJyb3IodHlwZSkge1xuXHRcdHRocm93IFJhbmdlRXJyb3IoZXJyb3JzW3R5cGVdKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBBIGdlbmVyaWMgYEFycmF5I21hcGAgdXRpbGl0eSBmdW5jdGlvbi5cblx0ICogQHByaXZhdGVcblx0ICogQHBhcmFtIHtBcnJheX0gYXJyYXkgVGhlIGFycmF5IHRvIGl0ZXJhdGUgb3Zlci5cblx0ICogQHBhcmFtIHtGdW5jdGlvbn0gY2FsbGJhY2sgVGhlIGZ1bmN0aW9uIHRoYXQgZ2V0cyBjYWxsZWQgZm9yIGV2ZXJ5IGFycmF5XG5cdCAqIGl0ZW0uXG5cdCAqIEByZXR1cm5zIHtBcnJheX0gQSBuZXcgYXJyYXkgb2YgdmFsdWVzIHJldHVybmVkIGJ5IHRoZSBjYWxsYmFjayBmdW5jdGlvbi5cblx0ICovXG5cdGZ1bmN0aW9uIG1hcChhcnJheSwgZm4pIHtcblx0XHR2YXIgbGVuZ3RoID0gYXJyYXkubGVuZ3RoO1xuXHRcdHdoaWxlIChsZW5ndGgtLSkge1xuXHRcdFx0YXJyYXlbbGVuZ3RoXSA9IGZuKGFycmF5W2xlbmd0aF0pO1xuXHRcdH1cblx0XHRyZXR1cm4gYXJyYXk7XG5cdH1cblxuXHQvKipcblx0ICogQSBzaW1wbGUgYEFycmF5I21hcGAtbGlrZSB3cmFwcGVyIHRvIHdvcmsgd2l0aCBkb21haW4gbmFtZSBzdHJpbmdzLlxuXHQgKiBAcHJpdmF0ZVxuXHQgKiBAcGFyYW0ge1N0cmluZ30gZG9tYWluIFRoZSBkb21haW4gbmFtZS5cblx0ICogQHBhcmFtIHtGdW5jdGlvbn0gY2FsbGJhY2sgVGhlIGZ1bmN0aW9uIHRoYXQgZ2V0cyBjYWxsZWQgZm9yIGV2ZXJ5XG5cdCAqIGNoYXJhY3Rlci5cblx0ICogQHJldHVybnMge0FycmF5fSBBIG5ldyBzdHJpbmcgb2YgY2hhcmFjdGVycyByZXR1cm5lZCBieSB0aGUgY2FsbGJhY2tcblx0ICogZnVuY3Rpb24uXG5cdCAqL1xuXHRmdW5jdGlvbiBtYXBEb21haW4oc3RyaW5nLCBmbikge1xuXHRcdHJldHVybiBtYXAoc3RyaW5nLnNwbGl0KHJlZ2V4U2VwYXJhdG9ycyksIGZuKS5qb2luKCcuJyk7XG5cdH1cblxuXHQvKipcblx0ICogQ3JlYXRlcyBhbiBhcnJheSBjb250YWluaW5nIHRoZSBudW1lcmljIGNvZGUgcG9pbnRzIG9mIGVhY2ggVW5pY29kZVxuXHQgKiBjaGFyYWN0ZXIgaW4gdGhlIHN0cmluZy4gV2hpbGUgSmF2YVNjcmlwdCB1c2VzIFVDUy0yIGludGVybmFsbHksXG5cdCAqIHRoaXMgZnVuY3Rpb24gd2lsbCBjb252ZXJ0IGEgcGFpciBvZiBzdXJyb2dhdGUgaGFsdmVzIChlYWNoIG9mIHdoaWNoXG5cdCAqIFVDUy0yIGV4cG9zZXMgYXMgc2VwYXJhdGUgY2hhcmFjdGVycykgaW50byBhIHNpbmdsZSBjb2RlIHBvaW50LFxuXHQgKiBtYXRjaGluZyBVVEYtMTYuXG5cdCAqIEBzZWUgYHB1bnljb2RlLnVjczIuZW5jb2RlYFxuXHQgKiBAc2VlIDxodHRwOi8vbWF0aGlhc2J5bmVucy5iZS9ub3Rlcy9qYXZhc2NyaXB0LWVuY29kaW5nPlxuXHQgKiBAbWVtYmVyT2YgcHVueWNvZGUudWNzMlxuXHQgKiBAbmFtZSBkZWNvZGVcblx0ICogQHBhcmFtIHtTdHJpbmd9IHN0cmluZyBUaGUgVW5pY29kZSBpbnB1dCBzdHJpbmcgKFVDUy0yKS5cblx0ICogQHJldHVybnMge0FycmF5fSBUaGUgbmV3IGFycmF5IG9mIGNvZGUgcG9pbnRzLlxuXHQgKi9cblx0ZnVuY3Rpb24gdWNzMmRlY29kZShzdHJpbmcpIHtcblx0XHR2YXIgb3V0cHV0ID0gW10sXG5cdFx0ICAgIGNvdW50ZXIgPSAwLFxuXHRcdCAgICBsZW5ndGggPSBzdHJpbmcubGVuZ3RoLFxuXHRcdCAgICB2YWx1ZSxcblx0XHQgICAgZXh0cmE7XG5cdFx0d2hpbGUgKGNvdW50ZXIgPCBsZW5ndGgpIHtcblx0XHRcdHZhbHVlID0gc3RyaW5nLmNoYXJDb2RlQXQoY291bnRlcisrKTtcblx0XHRcdGlmICh2YWx1ZSA+PSAweEQ4MDAgJiYgdmFsdWUgPD0gMHhEQkZGICYmIGNvdW50ZXIgPCBsZW5ndGgpIHtcblx0XHRcdFx0Ly8gaGlnaCBzdXJyb2dhdGUsIGFuZCB0aGVyZSBpcyBhIG5leHQgY2hhcmFjdGVyXG5cdFx0XHRcdGV4dHJhID0gc3RyaW5nLmNoYXJDb2RlQXQoY291bnRlcisrKTtcblx0XHRcdFx0aWYgKChleHRyYSAmIDB4RkMwMCkgPT0gMHhEQzAwKSB7IC8vIGxvdyBzdXJyb2dhdGVcblx0XHRcdFx0XHRvdXRwdXQucHVzaCgoKHZhbHVlICYgMHgzRkYpIDw8IDEwKSArIChleHRyYSAmIDB4M0ZGKSArIDB4MTAwMDApO1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdC8vIHVubWF0Y2hlZCBzdXJyb2dhdGU7IG9ubHkgYXBwZW5kIHRoaXMgY29kZSB1bml0LCBpbiBjYXNlIHRoZSBuZXh0XG5cdFx0XHRcdFx0Ly8gY29kZSB1bml0IGlzIHRoZSBoaWdoIHN1cnJvZ2F0ZSBvZiBhIHN1cnJvZ2F0ZSBwYWlyXG5cdFx0XHRcdFx0b3V0cHV0LnB1c2godmFsdWUpO1xuXHRcdFx0XHRcdGNvdW50ZXItLTtcblx0XHRcdFx0fVxuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0b3V0cHV0LnB1c2godmFsdWUpO1xuXHRcdFx0fVxuXHRcdH1cblx0XHRyZXR1cm4gb3V0cHV0O1xuXHR9XG5cblx0LyoqXG5cdCAqIENyZWF0ZXMgYSBzdHJpbmcgYmFzZWQgb24gYW4gYXJyYXkgb2YgbnVtZXJpYyBjb2RlIHBvaW50cy5cblx0ICogQHNlZSBgcHVueWNvZGUudWNzMi5kZWNvZGVgXG5cdCAqIEBtZW1iZXJPZiBwdW55Y29kZS51Y3MyXG5cdCAqIEBuYW1lIGVuY29kZVxuXHQgKiBAcGFyYW0ge0FycmF5fSBjb2RlUG9pbnRzIFRoZSBhcnJheSBvZiBudW1lcmljIGNvZGUgcG9pbnRzLlxuXHQgKiBAcmV0dXJucyB7U3RyaW5nfSBUaGUgbmV3IFVuaWNvZGUgc3RyaW5nIChVQ1MtMikuXG5cdCAqL1xuXHRmdW5jdGlvbiB1Y3MyZW5jb2RlKGFycmF5KSB7XG5cdFx0cmV0dXJuIG1hcChhcnJheSwgZnVuY3Rpb24odmFsdWUpIHtcblx0XHRcdHZhciBvdXRwdXQgPSAnJztcblx0XHRcdGlmICh2YWx1ZSA+IDB4RkZGRikge1xuXHRcdFx0XHR2YWx1ZSAtPSAweDEwMDAwO1xuXHRcdFx0XHRvdXRwdXQgKz0gc3RyaW5nRnJvbUNoYXJDb2RlKHZhbHVlID4+PiAxMCAmIDB4M0ZGIHwgMHhEODAwKTtcblx0XHRcdFx0dmFsdWUgPSAweERDMDAgfCB2YWx1ZSAmIDB4M0ZGO1xuXHRcdFx0fVxuXHRcdFx0b3V0cHV0ICs9IHN0cmluZ0Zyb21DaGFyQ29kZSh2YWx1ZSk7XG5cdFx0XHRyZXR1cm4gb3V0cHV0O1xuXHRcdH0pLmpvaW4oJycpO1xuXHR9XG5cblx0LyoqXG5cdCAqIENvbnZlcnRzIGEgYmFzaWMgY29kZSBwb2ludCBpbnRvIGEgZGlnaXQvaW50ZWdlci5cblx0ICogQHNlZSBgZGlnaXRUb0Jhc2ljKClgXG5cdCAqIEBwcml2YXRlXG5cdCAqIEBwYXJhbSB7TnVtYmVyfSBjb2RlUG9pbnQgVGhlIGJhc2ljIG51bWVyaWMgY29kZSBwb2ludCB2YWx1ZS5cblx0ICogQHJldHVybnMge051bWJlcn0gVGhlIG51bWVyaWMgdmFsdWUgb2YgYSBiYXNpYyBjb2RlIHBvaW50IChmb3IgdXNlIGluXG5cdCAqIHJlcHJlc2VudGluZyBpbnRlZ2VycykgaW4gdGhlIHJhbmdlIGAwYCB0byBgYmFzZSAtIDFgLCBvciBgYmFzZWAgaWZcblx0ICogdGhlIGNvZGUgcG9pbnQgZG9lcyBub3QgcmVwcmVzZW50IGEgdmFsdWUuXG5cdCAqL1xuXHRmdW5jdGlvbiBiYXNpY1RvRGlnaXQoY29kZVBvaW50KSB7XG5cdFx0aWYgKGNvZGVQb2ludCAtIDQ4IDwgMTApIHtcblx0XHRcdHJldHVybiBjb2RlUG9pbnQgLSAyMjtcblx0XHR9XG5cdFx0aWYgKGNvZGVQb2ludCAtIDY1IDwgMjYpIHtcblx0XHRcdHJldHVybiBjb2RlUG9pbnQgLSA2NTtcblx0XHR9XG5cdFx0aWYgKGNvZGVQb2ludCAtIDk3IDwgMjYpIHtcblx0XHRcdHJldHVybiBjb2RlUG9pbnQgLSA5Nztcblx0XHR9XG5cdFx0cmV0dXJuIGJhc2U7XG5cdH1cblxuXHQvKipcblx0ICogQ29udmVydHMgYSBkaWdpdC9pbnRlZ2VyIGludG8gYSBiYXNpYyBjb2RlIHBvaW50LlxuXHQgKiBAc2VlIGBiYXNpY1RvRGlnaXQoKWBcblx0ICogQHByaXZhdGVcblx0ICogQHBhcmFtIHtOdW1iZXJ9IGRpZ2l0IFRoZSBudW1lcmljIHZhbHVlIG9mIGEgYmFzaWMgY29kZSBwb2ludC5cblx0ICogQHJldHVybnMge051bWJlcn0gVGhlIGJhc2ljIGNvZGUgcG9pbnQgd2hvc2UgdmFsdWUgKHdoZW4gdXNlZCBmb3Jcblx0ICogcmVwcmVzZW50aW5nIGludGVnZXJzKSBpcyBgZGlnaXRgLCB3aGljaCBuZWVkcyB0byBiZSBpbiB0aGUgcmFuZ2Vcblx0ICogYDBgIHRvIGBiYXNlIC0gMWAuIElmIGBmbGFnYCBpcyBub24temVybywgdGhlIHVwcGVyY2FzZSBmb3JtIGlzXG5cdCAqIHVzZWQ7IGVsc2UsIHRoZSBsb3dlcmNhc2UgZm9ybSBpcyB1c2VkLiBUaGUgYmVoYXZpb3IgaXMgdW5kZWZpbmVkXG5cdCAqIGlmIGBmbGFnYCBpcyBub24temVybyBhbmQgYGRpZ2l0YCBoYXMgbm8gdXBwZXJjYXNlIGZvcm0uXG5cdCAqL1xuXHRmdW5jdGlvbiBkaWdpdFRvQmFzaWMoZGlnaXQsIGZsYWcpIHtcblx0XHQvLyAgMC4uMjUgbWFwIHRvIEFTQ0lJIGEuLnogb3IgQS4uWlxuXHRcdC8vIDI2Li4zNSBtYXAgdG8gQVNDSUkgMC4uOVxuXHRcdHJldHVybiBkaWdpdCArIDIyICsgNzUgKiAoZGlnaXQgPCAyNikgLSAoKGZsYWcgIT0gMCkgPDwgNSk7XG5cdH1cblxuXHQvKipcblx0ICogQmlhcyBhZGFwdGF0aW9uIGZ1bmN0aW9uIGFzIHBlciBzZWN0aW9uIDMuNCBvZiBSRkMgMzQ5Mi5cblx0ICogaHR0cDovL3Rvb2xzLmlldGYub3JnL2h0bWwvcmZjMzQ5MiNzZWN0aW9uLTMuNFxuXHQgKiBAcHJpdmF0ZVxuXHQgKi9cblx0ZnVuY3Rpb24gYWRhcHQoZGVsdGEsIG51bVBvaW50cywgZmlyc3RUaW1lKSB7XG5cdFx0dmFyIGsgPSAwO1xuXHRcdGRlbHRhID0gZmlyc3RUaW1lID8gZmxvb3IoZGVsdGEgLyBkYW1wKSA6IGRlbHRhID4+IDE7XG5cdFx0ZGVsdGEgKz0gZmxvb3IoZGVsdGEgLyBudW1Qb2ludHMpO1xuXHRcdGZvciAoLyogbm8gaW5pdGlhbGl6YXRpb24gKi87IGRlbHRhID4gYmFzZU1pbnVzVE1pbiAqIHRNYXggPj4gMTsgayArPSBiYXNlKSB7XG5cdFx0XHRkZWx0YSA9IGZsb29yKGRlbHRhIC8gYmFzZU1pbnVzVE1pbik7XG5cdFx0fVxuXHRcdHJldHVybiBmbG9vcihrICsgKGJhc2VNaW51c1RNaW4gKyAxKSAqIGRlbHRhIC8gKGRlbHRhICsgc2tldykpO1xuXHR9XG5cblx0LyoqXG5cdCAqIENvbnZlcnRzIGEgUHVueWNvZGUgc3RyaW5nIG9mIEFTQ0lJLW9ubHkgc3ltYm9scyB0byBhIHN0cmluZyBvZiBVbmljb2RlXG5cdCAqIHN5bWJvbHMuXG5cdCAqIEBtZW1iZXJPZiBwdW55Y29kZVxuXHQgKiBAcGFyYW0ge1N0cmluZ30gaW5wdXQgVGhlIFB1bnljb2RlIHN0cmluZyBvZiBBU0NJSS1vbmx5IHN5bWJvbHMuXG5cdCAqIEByZXR1cm5zIHtTdHJpbmd9IFRoZSByZXN1bHRpbmcgc3RyaW5nIG9mIFVuaWNvZGUgc3ltYm9scy5cblx0ICovXG5cdGZ1bmN0aW9uIGRlY29kZShpbnB1dCkge1xuXHRcdC8vIERvbid0IHVzZSBVQ1MtMlxuXHRcdHZhciBvdXRwdXQgPSBbXSxcblx0XHQgICAgaW5wdXRMZW5ndGggPSBpbnB1dC5sZW5ndGgsXG5cdFx0ICAgIG91dCxcblx0XHQgICAgaSA9IDAsXG5cdFx0ICAgIG4gPSBpbml0aWFsTixcblx0XHQgICAgYmlhcyA9IGluaXRpYWxCaWFzLFxuXHRcdCAgICBiYXNpYyxcblx0XHQgICAgaixcblx0XHQgICAgaW5kZXgsXG5cdFx0ICAgIG9sZGksXG5cdFx0ICAgIHcsXG5cdFx0ICAgIGssXG5cdFx0ICAgIGRpZ2l0LFxuXHRcdCAgICB0LFxuXHRcdCAgICAvKiogQ2FjaGVkIGNhbGN1bGF0aW9uIHJlc3VsdHMgKi9cblx0XHQgICAgYmFzZU1pbnVzVDtcblxuXHRcdC8vIEhhbmRsZSB0aGUgYmFzaWMgY29kZSBwb2ludHM6IGxldCBgYmFzaWNgIGJlIHRoZSBudW1iZXIgb2YgaW5wdXQgY29kZVxuXHRcdC8vIHBvaW50cyBiZWZvcmUgdGhlIGxhc3QgZGVsaW1pdGVyLCBvciBgMGAgaWYgdGhlcmUgaXMgbm9uZSwgdGhlbiBjb3B5XG5cdFx0Ly8gdGhlIGZpcnN0IGJhc2ljIGNvZGUgcG9pbnRzIHRvIHRoZSBvdXRwdXQuXG5cblx0XHRiYXNpYyA9IGlucHV0Lmxhc3RJbmRleE9mKGRlbGltaXRlcik7XG5cdFx0aWYgKGJhc2ljIDwgMCkge1xuXHRcdFx0YmFzaWMgPSAwO1xuXHRcdH1cblxuXHRcdGZvciAoaiA9IDA7IGogPCBiYXNpYzsgKytqKSB7XG5cdFx0XHQvLyBpZiBpdCdzIG5vdCBhIGJhc2ljIGNvZGUgcG9pbnRcblx0XHRcdGlmIChpbnB1dC5jaGFyQ29kZUF0KGopID49IDB4ODApIHtcblx0XHRcdFx0ZXJyb3IoJ25vdC1iYXNpYycpO1xuXHRcdFx0fVxuXHRcdFx0b3V0cHV0LnB1c2goaW5wdXQuY2hhckNvZGVBdChqKSk7XG5cdFx0fVxuXG5cdFx0Ly8gTWFpbiBkZWNvZGluZyBsb29wOiBzdGFydCBqdXN0IGFmdGVyIHRoZSBsYXN0IGRlbGltaXRlciBpZiBhbnkgYmFzaWMgY29kZVxuXHRcdC8vIHBvaW50cyB3ZXJlIGNvcGllZDsgc3RhcnQgYXQgdGhlIGJlZ2lubmluZyBvdGhlcndpc2UuXG5cblx0XHRmb3IgKGluZGV4ID0gYmFzaWMgPiAwID8gYmFzaWMgKyAxIDogMDsgaW5kZXggPCBpbnB1dExlbmd0aDsgLyogbm8gZmluYWwgZXhwcmVzc2lvbiAqLykge1xuXG5cdFx0XHQvLyBgaW5kZXhgIGlzIHRoZSBpbmRleCBvZiB0aGUgbmV4dCBjaGFyYWN0ZXIgdG8gYmUgY29uc3VtZWQuXG5cdFx0XHQvLyBEZWNvZGUgYSBnZW5lcmFsaXplZCB2YXJpYWJsZS1sZW5ndGggaW50ZWdlciBpbnRvIGBkZWx0YWAsXG5cdFx0XHQvLyB3aGljaCBnZXRzIGFkZGVkIHRvIGBpYC4gVGhlIG92ZXJmbG93IGNoZWNraW5nIGlzIGVhc2llclxuXHRcdFx0Ly8gaWYgd2UgaW5jcmVhc2UgYGlgIGFzIHdlIGdvLCB0aGVuIHN1YnRyYWN0IG9mZiBpdHMgc3RhcnRpbmdcblx0XHRcdC8vIHZhbHVlIGF0IHRoZSBlbmQgdG8gb2J0YWluIGBkZWx0YWAuXG5cdFx0XHRmb3IgKG9sZGkgPSBpLCB3ID0gMSwgayA9IGJhc2U7IC8qIG5vIGNvbmRpdGlvbiAqLzsgayArPSBiYXNlKSB7XG5cblx0XHRcdFx0aWYgKGluZGV4ID49IGlucHV0TGVuZ3RoKSB7XG5cdFx0XHRcdFx0ZXJyb3IoJ2ludmFsaWQtaW5wdXQnKTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGRpZ2l0ID0gYmFzaWNUb0RpZ2l0KGlucHV0LmNoYXJDb2RlQXQoaW5kZXgrKykpO1xuXG5cdFx0XHRcdGlmIChkaWdpdCA+PSBiYXNlIHx8IGRpZ2l0ID4gZmxvb3IoKG1heEludCAtIGkpIC8gdykpIHtcblx0XHRcdFx0XHRlcnJvcignb3ZlcmZsb3cnKTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGkgKz0gZGlnaXQgKiB3O1xuXHRcdFx0XHR0ID0gayA8PSBiaWFzID8gdE1pbiA6IChrID49IGJpYXMgKyB0TWF4ID8gdE1heCA6IGsgLSBiaWFzKTtcblxuXHRcdFx0XHRpZiAoZGlnaXQgPCB0KSB7XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRiYXNlTWludXNUID0gYmFzZSAtIHQ7XG5cdFx0XHRcdGlmICh3ID4gZmxvb3IobWF4SW50IC8gYmFzZU1pbnVzVCkpIHtcblx0XHRcdFx0XHRlcnJvcignb3ZlcmZsb3cnKTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdHcgKj0gYmFzZU1pbnVzVDtcblxuXHRcdFx0fVxuXG5cdFx0XHRvdXQgPSBvdXRwdXQubGVuZ3RoICsgMTtcblx0XHRcdGJpYXMgPSBhZGFwdChpIC0gb2xkaSwgb3V0LCBvbGRpID09IDApO1xuXG5cdFx0XHQvLyBgaWAgd2FzIHN1cHBvc2VkIHRvIHdyYXAgYXJvdW5kIGZyb20gYG91dGAgdG8gYDBgLFxuXHRcdFx0Ly8gaW5jcmVtZW50aW5nIGBuYCBlYWNoIHRpbWUsIHNvIHdlJ2xsIGZpeCB0aGF0IG5vdzpcblx0XHRcdGlmIChmbG9vcihpIC8gb3V0KSA+IG1heEludCAtIG4pIHtcblx0XHRcdFx0ZXJyb3IoJ292ZXJmbG93Jyk7XG5cdFx0XHR9XG5cblx0XHRcdG4gKz0gZmxvb3IoaSAvIG91dCk7XG5cdFx0XHRpICU9IG91dDtcblxuXHRcdFx0Ly8gSW5zZXJ0IGBuYCBhdCBwb3NpdGlvbiBgaWAgb2YgdGhlIG91dHB1dFxuXHRcdFx0b3V0cHV0LnNwbGljZShpKyssIDAsIG4pO1xuXG5cdFx0fVxuXG5cdFx0cmV0dXJuIHVjczJlbmNvZGUob3V0cHV0KTtcblx0fVxuXG5cdC8qKlxuXHQgKiBDb252ZXJ0cyBhIHN0cmluZyBvZiBVbmljb2RlIHN5bWJvbHMgdG8gYSBQdW55Y29kZSBzdHJpbmcgb2YgQVNDSUktb25seVxuXHQgKiBzeW1ib2xzLlxuXHQgKiBAbWVtYmVyT2YgcHVueWNvZGVcblx0ICogQHBhcmFtIHtTdHJpbmd9IGlucHV0IFRoZSBzdHJpbmcgb2YgVW5pY29kZSBzeW1ib2xzLlxuXHQgKiBAcmV0dXJucyB7U3RyaW5nfSBUaGUgcmVzdWx0aW5nIFB1bnljb2RlIHN0cmluZyBvZiBBU0NJSS1vbmx5IHN5bWJvbHMuXG5cdCAqL1xuXHRmdW5jdGlvbiBlbmNvZGUoaW5wdXQpIHtcblx0XHR2YXIgbixcblx0XHQgICAgZGVsdGEsXG5cdFx0ICAgIGhhbmRsZWRDUENvdW50LFxuXHRcdCAgICBiYXNpY0xlbmd0aCxcblx0XHQgICAgYmlhcyxcblx0XHQgICAgaixcblx0XHQgICAgbSxcblx0XHQgICAgcSxcblx0XHQgICAgayxcblx0XHQgICAgdCxcblx0XHQgICAgY3VycmVudFZhbHVlLFxuXHRcdCAgICBvdXRwdXQgPSBbXSxcblx0XHQgICAgLyoqIGBpbnB1dExlbmd0aGAgd2lsbCBob2xkIHRoZSBudW1iZXIgb2YgY29kZSBwb2ludHMgaW4gYGlucHV0YC4gKi9cblx0XHQgICAgaW5wdXRMZW5ndGgsXG5cdFx0ICAgIC8qKiBDYWNoZWQgY2FsY3VsYXRpb24gcmVzdWx0cyAqL1xuXHRcdCAgICBoYW5kbGVkQ1BDb3VudFBsdXNPbmUsXG5cdFx0ICAgIGJhc2VNaW51c1QsXG5cdFx0ICAgIHFNaW51c1Q7XG5cblx0XHQvLyBDb252ZXJ0IHRoZSBpbnB1dCBpbiBVQ1MtMiB0byBVbmljb2RlXG5cdFx0aW5wdXQgPSB1Y3MyZGVjb2RlKGlucHV0KTtcblxuXHRcdC8vIENhY2hlIHRoZSBsZW5ndGhcblx0XHRpbnB1dExlbmd0aCA9IGlucHV0Lmxlbmd0aDtcblxuXHRcdC8vIEluaXRpYWxpemUgdGhlIHN0YXRlXG5cdFx0biA9IGluaXRpYWxOO1xuXHRcdGRlbHRhID0gMDtcblx0XHRiaWFzID0gaW5pdGlhbEJpYXM7XG5cblx0XHQvLyBIYW5kbGUgdGhlIGJhc2ljIGNvZGUgcG9pbnRzXG5cdFx0Zm9yIChqID0gMDsgaiA8IGlucHV0TGVuZ3RoOyArK2opIHtcblx0XHRcdGN1cnJlbnRWYWx1ZSA9IGlucHV0W2pdO1xuXHRcdFx0aWYgKGN1cnJlbnRWYWx1ZSA8IDB4ODApIHtcblx0XHRcdFx0b3V0cHV0LnB1c2goc3RyaW5nRnJvbUNoYXJDb2RlKGN1cnJlbnRWYWx1ZSkpO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdGhhbmRsZWRDUENvdW50ID0gYmFzaWNMZW5ndGggPSBvdXRwdXQubGVuZ3RoO1xuXG5cdFx0Ly8gYGhhbmRsZWRDUENvdW50YCBpcyB0aGUgbnVtYmVyIG9mIGNvZGUgcG9pbnRzIHRoYXQgaGF2ZSBiZWVuIGhhbmRsZWQ7XG5cdFx0Ly8gYGJhc2ljTGVuZ3RoYCBpcyB0aGUgbnVtYmVyIG9mIGJhc2ljIGNvZGUgcG9pbnRzLlxuXG5cdFx0Ly8gRmluaXNoIHRoZSBiYXNpYyBzdHJpbmcgLSBpZiBpdCBpcyBub3QgZW1wdHkgLSB3aXRoIGEgZGVsaW1pdGVyXG5cdFx0aWYgKGJhc2ljTGVuZ3RoKSB7XG5cdFx0XHRvdXRwdXQucHVzaChkZWxpbWl0ZXIpO1xuXHRcdH1cblxuXHRcdC8vIE1haW4gZW5jb2RpbmcgbG9vcDpcblx0XHR3aGlsZSAoaGFuZGxlZENQQ291bnQgPCBpbnB1dExlbmd0aCkge1xuXG5cdFx0XHQvLyBBbGwgbm9uLWJhc2ljIGNvZGUgcG9pbnRzIDwgbiBoYXZlIGJlZW4gaGFuZGxlZCBhbHJlYWR5LiBGaW5kIHRoZSBuZXh0XG5cdFx0XHQvLyBsYXJnZXIgb25lOlxuXHRcdFx0Zm9yIChtID0gbWF4SW50LCBqID0gMDsgaiA8IGlucHV0TGVuZ3RoOyArK2opIHtcblx0XHRcdFx0Y3VycmVudFZhbHVlID0gaW5wdXRbal07XG5cdFx0XHRcdGlmIChjdXJyZW50VmFsdWUgPj0gbiAmJiBjdXJyZW50VmFsdWUgPCBtKSB7XG5cdFx0XHRcdFx0bSA9IGN1cnJlbnRWYWx1ZTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHQvLyBJbmNyZWFzZSBgZGVsdGFgIGVub3VnaCB0byBhZHZhbmNlIHRoZSBkZWNvZGVyJ3MgPG4saT4gc3RhdGUgdG8gPG0sMD4sXG5cdFx0XHQvLyBidXQgZ3VhcmQgYWdhaW5zdCBvdmVyZmxvd1xuXHRcdFx0aGFuZGxlZENQQ291bnRQbHVzT25lID0gaGFuZGxlZENQQ291bnQgKyAxO1xuXHRcdFx0aWYgKG0gLSBuID4gZmxvb3IoKG1heEludCAtIGRlbHRhKSAvIGhhbmRsZWRDUENvdW50UGx1c09uZSkpIHtcblx0XHRcdFx0ZXJyb3IoJ292ZXJmbG93Jyk7XG5cdFx0XHR9XG5cblx0XHRcdGRlbHRhICs9IChtIC0gbikgKiBoYW5kbGVkQ1BDb3VudFBsdXNPbmU7XG5cdFx0XHRuID0gbTtcblxuXHRcdFx0Zm9yIChqID0gMDsgaiA8IGlucHV0TGVuZ3RoOyArK2opIHtcblx0XHRcdFx0Y3VycmVudFZhbHVlID0gaW5wdXRbal07XG5cblx0XHRcdFx0aWYgKGN1cnJlbnRWYWx1ZSA8IG4gJiYgKytkZWx0YSA+IG1heEludCkge1xuXHRcdFx0XHRcdGVycm9yKCdvdmVyZmxvdycpO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0aWYgKGN1cnJlbnRWYWx1ZSA9PSBuKSB7XG5cdFx0XHRcdFx0Ly8gUmVwcmVzZW50IGRlbHRhIGFzIGEgZ2VuZXJhbGl6ZWQgdmFyaWFibGUtbGVuZ3RoIGludGVnZXJcblx0XHRcdFx0XHRmb3IgKHEgPSBkZWx0YSwgayA9IGJhc2U7IC8qIG5vIGNvbmRpdGlvbiAqLzsgayArPSBiYXNlKSB7XG5cdFx0XHRcdFx0XHR0ID0gayA8PSBiaWFzID8gdE1pbiA6IChrID49IGJpYXMgKyB0TWF4ID8gdE1heCA6IGsgLSBiaWFzKTtcblx0XHRcdFx0XHRcdGlmIChxIDwgdCkge1xuXHRcdFx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdHFNaW51c1QgPSBxIC0gdDtcblx0XHRcdFx0XHRcdGJhc2VNaW51c1QgPSBiYXNlIC0gdDtcblx0XHRcdFx0XHRcdG91dHB1dC5wdXNoKFxuXHRcdFx0XHRcdFx0XHRzdHJpbmdGcm9tQ2hhckNvZGUoZGlnaXRUb0Jhc2ljKHQgKyBxTWludXNUICUgYmFzZU1pbnVzVCwgMCkpXG5cdFx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdFx0cSA9IGZsb29yKHFNaW51c1QgLyBiYXNlTWludXNUKTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRvdXRwdXQucHVzaChzdHJpbmdGcm9tQ2hhckNvZGUoZGlnaXRUb0Jhc2ljKHEsIDApKSk7XG5cdFx0XHRcdFx0YmlhcyA9IGFkYXB0KGRlbHRhLCBoYW5kbGVkQ1BDb3VudFBsdXNPbmUsIGhhbmRsZWRDUENvdW50ID09IGJhc2ljTGVuZ3RoKTtcblx0XHRcdFx0XHRkZWx0YSA9IDA7XG5cdFx0XHRcdFx0KytoYW5kbGVkQ1BDb3VudDtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHQrK2RlbHRhO1xuXHRcdFx0KytuO1xuXG5cdFx0fVxuXHRcdHJldHVybiBvdXRwdXQuam9pbignJyk7XG5cdH1cblxuXHQvKipcblx0ICogQ29udmVydHMgYSBQdW55Y29kZSBzdHJpbmcgcmVwcmVzZW50aW5nIGEgZG9tYWluIG5hbWUgdG8gVW5pY29kZS4gT25seSB0aGVcblx0ICogUHVueWNvZGVkIHBhcnRzIG9mIHRoZSBkb21haW4gbmFtZSB3aWxsIGJlIGNvbnZlcnRlZCwgaS5lLiBpdCBkb2Vzbid0XG5cdCAqIG1hdHRlciBpZiB5b3UgY2FsbCBpdCBvbiBhIHN0cmluZyB0aGF0IGhhcyBhbHJlYWR5IGJlZW4gY29udmVydGVkIHRvXG5cdCAqIFVuaWNvZGUuXG5cdCAqIEBtZW1iZXJPZiBwdW55Y29kZVxuXHQgKiBAcGFyYW0ge1N0cmluZ30gZG9tYWluIFRoZSBQdW55Y29kZSBkb21haW4gbmFtZSB0byBjb252ZXJ0IHRvIFVuaWNvZGUuXG5cdCAqIEByZXR1cm5zIHtTdHJpbmd9IFRoZSBVbmljb2RlIHJlcHJlc2VudGF0aW9uIG9mIHRoZSBnaXZlbiBQdW55Y29kZVxuXHQgKiBzdHJpbmcuXG5cdCAqL1xuXHRmdW5jdGlvbiB0b1VuaWNvZGUoZG9tYWluKSB7XG5cdFx0cmV0dXJuIG1hcERvbWFpbihkb21haW4sIGZ1bmN0aW9uKHN0cmluZykge1xuXHRcdFx0cmV0dXJuIHJlZ2V4UHVueWNvZGUudGVzdChzdHJpbmcpXG5cdFx0XHRcdD8gZGVjb2RlKHN0cmluZy5zbGljZSg0KS50b0xvd2VyQ2FzZSgpKVxuXHRcdFx0XHQ6IHN0cmluZztcblx0XHR9KTtcblx0fVxuXG5cdC8qKlxuXHQgKiBDb252ZXJ0cyBhIFVuaWNvZGUgc3RyaW5nIHJlcHJlc2VudGluZyBhIGRvbWFpbiBuYW1lIHRvIFB1bnljb2RlLiBPbmx5IHRoZVxuXHQgKiBub24tQVNDSUkgcGFydHMgb2YgdGhlIGRvbWFpbiBuYW1lIHdpbGwgYmUgY29udmVydGVkLCBpLmUuIGl0IGRvZXNuJ3Rcblx0ICogbWF0dGVyIGlmIHlvdSBjYWxsIGl0IHdpdGggYSBkb21haW4gdGhhdCdzIGFscmVhZHkgaW4gQVNDSUkuXG5cdCAqIEBtZW1iZXJPZiBwdW55Y29kZVxuXHQgKiBAcGFyYW0ge1N0cmluZ30gZG9tYWluIFRoZSBkb21haW4gbmFtZSB0byBjb252ZXJ0LCBhcyBhIFVuaWNvZGUgc3RyaW5nLlxuXHQgKiBAcmV0dXJucyB7U3RyaW5nfSBUaGUgUHVueWNvZGUgcmVwcmVzZW50YXRpb24gb2YgdGhlIGdpdmVuIGRvbWFpbiBuYW1lLlxuXHQgKi9cblx0ZnVuY3Rpb24gdG9BU0NJSShkb21haW4pIHtcblx0XHRyZXR1cm4gbWFwRG9tYWluKGRvbWFpbiwgZnVuY3Rpb24oc3RyaW5nKSB7XG5cdFx0XHRyZXR1cm4gcmVnZXhOb25BU0NJSS50ZXN0KHN0cmluZylcblx0XHRcdFx0PyAneG4tLScgKyBlbmNvZGUoc3RyaW5nKVxuXHRcdFx0XHQ6IHN0cmluZztcblx0XHR9KTtcblx0fVxuXG5cdC8qLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0qL1xuXG5cdC8qKiBEZWZpbmUgdGhlIHB1YmxpYyBBUEkgKi9cblx0cHVueWNvZGUgPSB7XG5cdFx0LyoqXG5cdFx0ICogQSBzdHJpbmcgcmVwcmVzZW50aW5nIHRoZSBjdXJyZW50IFB1bnljb2RlLmpzIHZlcnNpb24gbnVtYmVyLlxuXHRcdCAqIEBtZW1iZXJPZiBwdW55Y29kZVxuXHRcdCAqIEB0eXBlIFN0cmluZ1xuXHRcdCAqL1xuXHRcdCd2ZXJzaW9uJzogJzEuMi40Jyxcblx0XHQvKipcblx0XHQgKiBBbiBvYmplY3Qgb2YgbWV0aG9kcyB0byBjb252ZXJ0IGZyb20gSmF2YVNjcmlwdCdzIGludGVybmFsIGNoYXJhY3RlclxuXHRcdCAqIHJlcHJlc2VudGF0aW9uIChVQ1MtMikgdG8gVW5pY29kZSBjb2RlIHBvaW50cywgYW5kIGJhY2suXG5cdFx0ICogQHNlZSA8aHR0cDovL21hdGhpYXNieW5lbnMuYmUvbm90ZXMvamF2YXNjcmlwdC1lbmNvZGluZz5cblx0XHQgKiBAbWVtYmVyT2YgcHVueWNvZGVcblx0XHQgKiBAdHlwZSBPYmplY3Rcblx0XHQgKi9cblx0XHQndWNzMic6IHtcblx0XHRcdCdkZWNvZGUnOiB1Y3MyZGVjb2RlLFxuXHRcdFx0J2VuY29kZSc6IHVjczJlbmNvZGVcblx0XHR9LFxuXHRcdCdkZWNvZGUnOiBkZWNvZGUsXG5cdFx0J2VuY29kZSc6IGVuY29kZSxcblx0XHQndG9BU0NJSSc6IHRvQVNDSUksXG5cdFx0J3RvVW5pY29kZSc6IHRvVW5pY29kZVxuXHR9O1xuXG5cdC8qKiBFeHBvc2UgYHB1bnljb2RlYCAqL1xuXHQvLyBTb21lIEFNRCBidWlsZCBvcHRpbWl6ZXJzLCBsaWtlIHIuanMsIGNoZWNrIGZvciBzcGVjaWZpYyBjb25kaXRpb24gcGF0dGVybnNcblx0Ly8gbGlrZSB0aGUgZm9sbG93aW5nOlxuXHRpZiAoXG5cdFx0dHlwZW9mIGRlZmluZSA9PSAnZnVuY3Rpb24nICYmXG5cdFx0dHlwZW9mIGRlZmluZS5hbWQgPT0gJ29iamVjdCcgJiZcblx0XHRkZWZpbmUuYW1kXG5cdCkge1xuXHRcdGRlZmluZSgncHVueWNvZGUnLCBmdW5jdGlvbigpIHtcblx0XHRcdHJldHVybiBwdW55Y29kZTtcblx0XHR9KTtcblx0fSBlbHNlIGlmIChmcmVlRXhwb3J0cyAmJiAhZnJlZUV4cG9ydHMubm9kZVR5cGUpIHtcblx0XHRpZiAoZnJlZU1vZHVsZSkgeyAvLyBpbiBOb2RlLmpzIG9yIFJpbmdvSlMgdjAuOC4wK1xuXHRcdFx0ZnJlZU1vZHVsZS5leHBvcnRzID0gcHVueWNvZGU7XG5cdFx0fSBlbHNlIHsgLy8gaW4gTmFyd2hhbCBvciBSaW5nb0pTIHYwLjcuMC1cblx0XHRcdGZvciAoa2V5IGluIHB1bnljb2RlKSB7XG5cdFx0XHRcdHB1bnljb2RlLmhhc093blByb3BlcnR5KGtleSkgJiYgKGZyZWVFeHBvcnRzW2tleV0gPSBwdW55Y29kZVtrZXldKTtcblx0XHRcdH1cblx0XHR9XG5cdH0gZWxzZSB7IC8vIGluIFJoaW5vIG9yIGEgd2ViIGJyb3dzZXJcblx0XHRyb290LnB1bnljb2RlID0gcHVueWNvZGU7XG5cdH1cblxufSh0aGlzKSk7XG4iLCIvLyBDb3B5cmlnaHQgSm95ZW50LCBJbmMuIGFuZCBvdGhlciBOb2RlIGNvbnRyaWJ1dG9ycy5cbi8vXG4vLyBQZXJtaXNzaW9uIGlzIGhlcmVieSBncmFudGVkLCBmcmVlIG9mIGNoYXJnZSwgdG8gYW55IHBlcnNvbiBvYnRhaW5pbmcgYVxuLy8gY29weSBvZiB0aGlzIHNvZnR3YXJlIGFuZCBhc3NvY2lhdGVkIGRvY3VtZW50YXRpb24gZmlsZXMgKHRoZVxuLy8gXCJTb2Z0d2FyZVwiKSwgdG8gZGVhbCBpbiB0aGUgU29mdHdhcmUgd2l0aG91dCByZXN0cmljdGlvbiwgaW5jbHVkaW5nXG4vLyB3aXRob3V0IGxpbWl0YXRpb24gdGhlIHJpZ2h0cyB0byB1c2UsIGNvcHksIG1vZGlmeSwgbWVyZ2UsIHB1Ymxpc2gsXG4vLyBkaXN0cmlidXRlLCBzdWJsaWNlbnNlLCBhbmQvb3Igc2VsbCBjb3BpZXMgb2YgdGhlIFNvZnR3YXJlLCBhbmQgdG8gcGVybWl0XG4vLyBwZXJzb25zIHRvIHdob20gdGhlIFNvZnR3YXJlIGlzIGZ1cm5pc2hlZCB0byBkbyBzbywgc3ViamVjdCB0byB0aGVcbi8vIGZvbGxvd2luZyBjb25kaXRpb25zOlxuLy9cbi8vIFRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkXG4vLyBpbiBhbGwgY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS5cbi8vXG4vLyBUSEUgU09GVFdBUkUgSVMgUFJPVklERUQgXCJBUyBJU1wiLCBXSVRIT1VUIFdBUlJBTlRZIE9GIEFOWSBLSU5ELCBFWFBSRVNTXG4vLyBPUiBJTVBMSUVELCBJTkNMVURJTkcgQlVUIE5PVCBMSU1JVEVEIFRPIFRIRSBXQVJSQU5USUVTIE9GXG4vLyBNRVJDSEFOVEFCSUxJVFksIEZJVE5FU1MgRk9SIEEgUEFSVElDVUxBUiBQVVJQT1NFIEFORCBOT05JTkZSSU5HRU1FTlQuIElOXG4vLyBOTyBFVkVOVCBTSEFMTCBUSEUgQVVUSE9SUyBPUiBDT1BZUklHSFQgSE9MREVSUyBCRSBMSUFCTEUgRk9SIEFOWSBDTEFJTSxcbi8vIERBTUFHRVMgT1IgT1RIRVIgTElBQklMSVRZLCBXSEVUSEVSIElOIEFOIEFDVElPTiBPRiBDT05UUkFDVCwgVE9SVCBPUlxuLy8gT1RIRVJXSVNFLCBBUklTSU5HIEZST00sIE9VVCBPRiBPUiBJTiBDT05ORUNUSU9OIFdJVEggVEhFIFNPRlRXQVJFIE9SIFRIRVxuLy8gVVNFIE9SIE9USEVSIERFQUxJTkdTIElOIFRIRSBTT0ZUV0FSRS5cblxuJ3VzZSBzdHJpY3QnO1xuXG4vLyBJZiBvYmouaGFzT3duUHJvcGVydHkgaGFzIGJlZW4gb3ZlcnJpZGRlbiwgdGhlbiBjYWxsaW5nXG4vLyBvYmouaGFzT3duUHJvcGVydHkocHJvcCkgd2lsbCBicmVhay5cbi8vIFNlZTogaHR0cHM6Ly9naXRodWIuY29tL2pveWVudC9ub2RlL2lzc3Vlcy8xNzA3XG5mdW5jdGlvbiBoYXNPd25Qcm9wZXJ0eShvYmosIHByb3ApIHtcbiAgcmV0dXJuIE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChvYmosIHByb3ApO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKHFzLCBzZXAsIGVxLCBvcHRpb25zKSB7XG4gIHNlcCA9IHNlcCB8fCAnJic7XG4gIGVxID0gZXEgfHwgJz0nO1xuICB2YXIgb2JqID0ge307XG5cbiAgaWYgKHR5cGVvZiBxcyAhPT0gJ3N0cmluZycgfHwgcXMubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIG9iajtcbiAgfVxuXG4gIHZhciByZWdleHAgPSAvXFwrL2c7XG4gIHFzID0gcXMuc3BsaXQoc2VwKTtcblxuICB2YXIgbWF4S2V5cyA9IDEwMDA7XG4gIGlmIChvcHRpb25zICYmIHR5cGVvZiBvcHRpb25zLm1heEtleXMgPT09ICdudW1iZXInKSB7XG4gICAgbWF4S2V5cyA9IG9wdGlvbnMubWF4S2V5cztcbiAgfVxuXG4gIHZhciBsZW4gPSBxcy5sZW5ndGg7XG4gIC8vIG1heEtleXMgPD0gMCBtZWFucyB0aGF0IHdlIHNob3VsZCBub3QgbGltaXQga2V5cyBjb3VudFxuICBpZiAobWF4S2V5cyA+IDAgJiYgbGVuID4gbWF4S2V5cykge1xuICAgIGxlbiA9IG1heEtleXM7XG4gIH1cblxuICBmb3IgKHZhciBpID0gMDsgaSA8IGxlbjsgKytpKSB7XG4gICAgdmFyIHggPSBxc1tpXS5yZXBsYWNlKHJlZ2V4cCwgJyUyMCcpLFxuICAgICAgICBpZHggPSB4LmluZGV4T2YoZXEpLFxuICAgICAgICBrc3RyLCB2c3RyLCBrLCB2O1xuXG4gICAgaWYgKGlkeCA+PSAwKSB7XG4gICAgICBrc3RyID0geC5zdWJzdHIoMCwgaWR4KTtcbiAgICAgIHZzdHIgPSB4LnN1YnN0cihpZHggKyAxKTtcbiAgICB9IGVsc2Uge1xuICAgICAga3N0ciA9IHg7XG4gICAgICB2c3RyID0gJyc7XG4gICAgfVxuXG4gICAgayA9IGRlY29kZVVSSUNvbXBvbmVudChrc3RyKTtcbiAgICB2ID0gZGVjb2RlVVJJQ29tcG9uZW50KHZzdHIpO1xuXG4gICAgaWYgKCFoYXNPd25Qcm9wZXJ0eShvYmosIGspKSB7XG4gICAgICBvYmpba10gPSB2O1xuICAgIH0gZWxzZSBpZiAoaXNBcnJheShvYmpba10pKSB7XG4gICAgICBvYmpba10ucHVzaCh2KTtcbiAgICB9IGVsc2Uge1xuICAgICAgb2JqW2tdID0gW29ialtrXSwgdl07XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIG9iajtcbn07XG5cbnZhciBpc0FycmF5ID0gQXJyYXkuaXNBcnJheSB8fCBmdW5jdGlvbiAoeHMpIHtcbiAgcmV0dXJuIE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbCh4cykgPT09ICdbb2JqZWN0IEFycmF5XSc7XG59O1xuIiwiLy8gQ29weXJpZ2h0IEpveWVudCwgSW5jLiBhbmQgb3RoZXIgTm9kZSBjb250cmlidXRvcnMuXG4vL1xuLy8gUGVybWlzc2lvbiBpcyBoZXJlYnkgZ3JhbnRlZCwgZnJlZSBvZiBjaGFyZ2UsIHRvIGFueSBwZXJzb24gb2J0YWluaW5nIGFcbi8vIGNvcHkgb2YgdGhpcyBzb2Z0d2FyZSBhbmQgYXNzb2NpYXRlZCBkb2N1bWVudGF0aW9uIGZpbGVzICh0aGVcbi8vIFwiU29mdHdhcmVcIiksIHRvIGRlYWwgaW4gdGhlIFNvZnR3YXJlIHdpdGhvdXQgcmVzdHJpY3Rpb24sIGluY2x1ZGluZ1xuLy8gd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHMgdG8gdXNlLCBjb3B5LCBtb2RpZnksIG1lcmdlLCBwdWJsaXNoLFxuLy8gZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGwgY29waWVzIG9mIHRoZSBTb2Z0d2FyZSwgYW5kIHRvIHBlcm1pdFxuLy8gcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpcyBmdXJuaXNoZWQgdG8gZG8gc28sIHN1YmplY3QgdG8gdGhlXG4vLyBmb2xsb3dpbmcgY29uZGl0aW9uczpcbi8vXG4vLyBUaGUgYWJvdmUgY29weXJpZ2h0IG5vdGljZSBhbmQgdGhpcyBwZXJtaXNzaW9uIG5vdGljZSBzaGFsbCBiZSBpbmNsdWRlZFxuLy8gaW4gYWxsIGNvcGllcyBvciBzdWJzdGFudGlhbCBwb3J0aW9ucyBvZiB0aGUgU29mdHdhcmUuXG4vL1xuLy8gVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEIFwiQVMgSVNcIiwgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTU1xuLy8gT1IgSU1QTElFRCwgSU5DTFVESU5HIEJVVCBOT1QgTElNSVRFRCBUTyBUSEUgV0FSUkFOVElFUyBPRlxuLy8gTUVSQ0hBTlRBQklMSVRZLCBGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBTkQgTk9OSU5GUklOR0VNRU5ULiBJTlxuLy8gTk8gRVZFTlQgU0hBTEwgVEhFIEFVVEhPUlMgT1IgQ09QWVJJR0hUIEhPTERFUlMgQkUgTElBQkxFIEZPUiBBTlkgQ0xBSU0sXG4vLyBEQU1BR0VTIE9SIE9USEVSIExJQUJJTElUWSwgV0hFVEhFUiBJTiBBTiBBQ1RJT04gT0YgQ09OVFJBQ1QsIFRPUlQgT1Jcbi8vIE9USEVSV0lTRSwgQVJJU0lORyBGUk9NLCBPVVQgT0YgT1IgSU4gQ09OTkVDVElPTiBXSVRIIFRIRSBTT0ZUV0FSRSBPUiBUSEVcbi8vIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTiBUSEUgU09GVFdBUkUuXG5cbid1c2Ugc3RyaWN0JztcblxudmFyIHN0cmluZ2lmeVByaW1pdGl2ZSA9IGZ1bmN0aW9uKHYpIHtcbiAgc3dpdGNoICh0eXBlb2Ygdikge1xuICAgIGNhc2UgJ3N0cmluZyc6XG4gICAgICByZXR1cm4gdjtcblxuICAgIGNhc2UgJ2Jvb2xlYW4nOlxuICAgICAgcmV0dXJuIHYgPyAndHJ1ZScgOiAnZmFsc2UnO1xuXG4gICAgY2FzZSAnbnVtYmVyJzpcbiAgICAgIHJldHVybiBpc0Zpbml0ZSh2KSA/IHYgOiAnJztcblxuICAgIGRlZmF1bHQ6XG4gICAgICByZXR1cm4gJyc7XG4gIH1cbn07XG5cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24ob2JqLCBzZXAsIGVxLCBuYW1lKSB7XG4gIHNlcCA9IHNlcCB8fCAnJic7XG4gIGVxID0gZXEgfHwgJz0nO1xuICBpZiAob2JqID09PSBudWxsKSB7XG4gICAgb2JqID0gdW5kZWZpbmVkO1xuICB9XG5cbiAgaWYgKHR5cGVvZiBvYmogPT09ICdvYmplY3QnKSB7XG4gICAgcmV0dXJuIG1hcChvYmplY3RLZXlzKG9iaiksIGZ1bmN0aW9uKGspIHtcbiAgICAgIHZhciBrcyA9IGVuY29kZVVSSUNvbXBvbmVudChzdHJpbmdpZnlQcmltaXRpdmUoaykpICsgZXE7XG4gICAgICBpZiAoaXNBcnJheShvYmpba10pKSB7XG4gICAgICAgIHJldHVybiBtYXAob2JqW2tdLCBmdW5jdGlvbih2KSB7XG4gICAgICAgICAgcmV0dXJuIGtzICsgZW5jb2RlVVJJQ29tcG9uZW50KHN0cmluZ2lmeVByaW1pdGl2ZSh2KSk7XG4gICAgICAgIH0pLmpvaW4oc2VwKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJldHVybiBrcyArIGVuY29kZVVSSUNvbXBvbmVudChzdHJpbmdpZnlQcmltaXRpdmUob2JqW2tdKSk7XG4gICAgICB9XG4gICAgfSkuam9pbihzZXApO1xuXG4gIH1cblxuICBpZiAoIW5hbWUpIHJldHVybiAnJztcbiAgcmV0dXJuIGVuY29kZVVSSUNvbXBvbmVudChzdHJpbmdpZnlQcmltaXRpdmUobmFtZSkpICsgZXEgK1xuICAgICAgICAgZW5jb2RlVVJJQ29tcG9uZW50KHN0cmluZ2lmeVByaW1pdGl2ZShvYmopKTtcbn07XG5cbnZhciBpc0FycmF5ID0gQXJyYXkuaXNBcnJheSB8fCBmdW5jdGlvbiAoeHMpIHtcbiAgcmV0dXJuIE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbCh4cykgPT09ICdbb2JqZWN0IEFycmF5XSc7XG59O1xuXG5mdW5jdGlvbiBtYXAgKHhzLCBmKSB7XG4gIGlmICh4cy5tYXApIHJldHVybiB4cy5tYXAoZik7XG4gIHZhciByZXMgPSBbXTtcbiAgZm9yICh2YXIgaSA9IDA7IGkgPCB4cy5sZW5ndGg7IGkrKykge1xuICAgIHJlcy5wdXNoKGYoeHNbaV0sIGkpKTtcbiAgfVxuICByZXR1cm4gcmVzO1xufVxuXG52YXIgb2JqZWN0S2V5cyA9IE9iamVjdC5rZXlzIHx8IGZ1bmN0aW9uIChvYmopIHtcbiAgdmFyIHJlcyA9IFtdO1xuICBmb3IgKHZhciBrZXkgaW4gb2JqKSB7XG4gICAgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChvYmosIGtleSkpIHJlcy5wdXNoKGtleSk7XG4gIH1cbiAgcmV0dXJuIHJlcztcbn07XG4iLCIndXNlIHN0cmljdCc7XG5cbmV4cG9ydHMuZGVjb2RlID0gZXhwb3J0cy5wYXJzZSA9IHJlcXVpcmUoJy4vZGVjb2RlJyk7XG5leHBvcnRzLmVuY29kZSA9IGV4cG9ydHMuc3RyaW5naWZ5ID0gcmVxdWlyZSgnLi9lbmNvZGUnKTtcbiIsIi8vIENvcHlyaWdodCBKb3llbnQsIEluYy4gYW5kIG90aGVyIE5vZGUgY29udHJpYnV0b3JzLlxuLy9cbi8vIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhXG4vLyBjb3B5IG9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlXG4vLyBcIlNvZnR3YXJlXCIpLCB0byBkZWFsIGluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmdcbi8vIHdpdGhvdXQgbGltaXRhdGlvbiB0aGUgcmlnaHRzIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCxcbi8vIGRpc3RyaWJ1dGUsIHN1YmxpY2Vuc2UsIGFuZC9vciBzZWxsIGNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXRcbi8vIHBlcnNvbnMgdG8gd2hvbSB0aGUgU29mdHdhcmUgaXMgZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZVxuLy8gZm9sbG93aW5nIGNvbmRpdGlvbnM6XG4vL1xuLy8gVGhlIGFib3ZlIGNvcHlyaWdodCBub3RpY2UgYW5kIHRoaXMgcGVybWlzc2lvbiBub3RpY2Ugc2hhbGwgYmUgaW5jbHVkZWRcbi8vIGluIGFsbCBjb3BpZXMgb3Igc3Vic3RhbnRpYWwgcG9ydGlvbnMgb2YgdGhlIFNvZnR3YXJlLlxuLy9cbi8vIFRIRSBTT0ZUV0FSRSBJUyBQUk9WSURFRCBcIkFTIElTXCIsIFdJVEhPVVQgV0FSUkFOVFkgT0YgQU5ZIEtJTkQsIEVYUFJFU1Ncbi8vIE9SIElNUExJRUQsIElOQ0xVRElORyBCVVQgTk9UIExJTUlURUQgVE8gVEhFIFdBUlJBTlRJRVMgT0Zcbi8vIE1FUkNIQU5UQUJJTElUWSwgRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UgQU5EIE5PTklORlJJTkdFTUVOVC4gSU5cbi8vIE5PIEVWRU5UIFNIQUxMIFRIRSBBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLFxuLy8gREFNQUdFUyBPUiBPVEhFUiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SXG4vLyBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSwgT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFXG4vLyBVU0UgT1IgT1RIRVIgREVBTElOR1MgSU4gVEhFIFNPRlRXQVJFLlxuXG52YXIgcHVueWNvZGUgPSByZXF1aXJlKCdwdW55Y29kZScpO1xuXG5leHBvcnRzLnBhcnNlID0gdXJsUGFyc2U7XG5leHBvcnRzLnJlc29sdmUgPSB1cmxSZXNvbHZlO1xuZXhwb3J0cy5yZXNvbHZlT2JqZWN0ID0gdXJsUmVzb2x2ZU9iamVjdDtcbmV4cG9ydHMuZm9ybWF0ID0gdXJsRm9ybWF0O1xuXG5leHBvcnRzLlVybCA9IFVybDtcblxuZnVuY3Rpb24gVXJsKCkge1xuICB0aGlzLnByb3RvY29sID0gbnVsbDtcbiAgdGhpcy5zbGFzaGVzID0gbnVsbDtcbiAgdGhpcy5hdXRoID0gbnVsbDtcbiAgdGhpcy5ob3N0ID0gbnVsbDtcbiAgdGhpcy5wb3J0ID0gbnVsbDtcbiAgdGhpcy5ob3N0bmFtZSA9IG51bGw7XG4gIHRoaXMuaGFzaCA9IG51bGw7XG4gIHRoaXMuc2VhcmNoID0gbnVsbDtcbiAgdGhpcy5xdWVyeSA9IG51bGw7XG4gIHRoaXMucGF0aG5hbWUgPSBudWxsO1xuICB0aGlzLnBhdGggPSBudWxsO1xuICB0aGlzLmhyZWYgPSBudWxsO1xufVxuXG4vLyBSZWZlcmVuY2U6IFJGQyAzOTg2LCBSRkMgMTgwOCwgUkZDIDIzOTZcblxuLy8gZGVmaW5lIHRoZXNlIGhlcmUgc28gYXQgbGVhc3QgdGhleSBvbmx5IGhhdmUgdG8gYmVcbi8vIGNvbXBpbGVkIG9uY2Ugb24gdGhlIGZpcnN0IG1vZHVsZSBsb2FkLlxudmFyIHByb3RvY29sUGF0dGVybiA9IC9eKFthLXowLTkuKy1dKzopL2ksXG4gICAgcG9ydFBhdHRlcm4gPSAvOlswLTldKiQvLFxuXG4gICAgLy8gUkZDIDIzOTY6IGNoYXJhY3RlcnMgcmVzZXJ2ZWQgZm9yIGRlbGltaXRpbmcgVVJMcy5cbiAgICAvLyBXZSBhY3R1YWxseSBqdXN0IGF1dG8tZXNjYXBlIHRoZXNlLlxuICAgIGRlbGltcyA9IFsnPCcsICc+JywgJ1wiJywgJ2AnLCAnICcsICdcXHInLCAnXFxuJywgJ1xcdCddLFxuXG4gICAgLy8gUkZDIDIzOTY6IGNoYXJhY3RlcnMgbm90IGFsbG93ZWQgZm9yIHZhcmlvdXMgcmVhc29ucy5cbiAgICB1bndpc2UgPSBbJ3snLCAnfScsICd8JywgJ1xcXFwnLCAnXicsICdgJ10uY29uY2F0KGRlbGltcyksXG5cbiAgICAvLyBBbGxvd2VkIGJ5IFJGQ3MsIGJ1dCBjYXVzZSBvZiBYU1MgYXR0YWNrcy4gIEFsd2F5cyBlc2NhcGUgdGhlc2UuXG4gICAgYXV0b0VzY2FwZSA9IFsnXFwnJ10uY29uY2F0KHVud2lzZSksXG4gICAgLy8gQ2hhcmFjdGVycyB0aGF0IGFyZSBuZXZlciBldmVyIGFsbG93ZWQgaW4gYSBob3N0bmFtZS5cbiAgICAvLyBOb3RlIHRoYXQgYW55IGludmFsaWQgY2hhcnMgYXJlIGFsc28gaGFuZGxlZCwgYnV0IHRoZXNlXG4gICAgLy8gYXJlIHRoZSBvbmVzIHRoYXQgYXJlICpleHBlY3RlZCogdG8gYmUgc2Vlbiwgc28gd2UgZmFzdC1wYXRoXG4gICAgLy8gdGhlbS5cbiAgICBub25Ib3N0Q2hhcnMgPSBbJyUnLCAnLycsICc/JywgJzsnLCAnIyddLmNvbmNhdChhdXRvRXNjYXBlKSxcbiAgICBob3N0RW5kaW5nQ2hhcnMgPSBbJy8nLCAnPycsICcjJ10sXG4gICAgaG9zdG5hbWVNYXhMZW4gPSAyNTUsXG4gICAgaG9zdG5hbWVQYXJ0UGF0dGVybiA9IC9eW2EtejAtOUEtWl8tXXswLDYzfSQvLFxuICAgIGhvc3RuYW1lUGFydFN0YXJ0ID0gL14oW2EtejAtOUEtWl8tXXswLDYzfSkoLiopJC8sXG4gICAgLy8gcHJvdG9jb2xzIHRoYXQgY2FuIGFsbG93IFwidW5zYWZlXCIgYW5kIFwidW53aXNlXCIgY2hhcnMuXG4gICAgdW5zYWZlUHJvdG9jb2wgPSB7XG4gICAgICAnamF2YXNjcmlwdCc6IHRydWUsXG4gICAgICAnamF2YXNjcmlwdDonOiB0cnVlXG4gICAgfSxcbiAgICAvLyBwcm90b2NvbHMgdGhhdCBuZXZlciBoYXZlIGEgaG9zdG5hbWUuXG4gICAgaG9zdGxlc3NQcm90b2NvbCA9IHtcbiAgICAgICdqYXZhc2NyaXB0JzogdHJ1ZSxcbiAgICAgICdqYXZhc2NyaXB0Oic6IHRydWVcbiAgICB9LFxuICAgIC8vIHByb3RvY29scyB0aGF0IGFsd2F5cyBjb250YWluIGEgLy8gYml0LlxuICAgIHNsYXNoZWRQcm90b2NvbCA9IHtcbiAgICAgICdodHRwJzogdHJ1ZSxcbiAgICAgICdodHRwcyc6IHRydWUsXG4gICAgICAnZnRwJzogdHJ1ZSxcbiAgICAgICdnb3BoZXInOiB0cnVlLFxuICAgICAgJ2ZpbGUnOiB0cnVlLFxuICAgICAgJ2h0dHA6JzogdHJ1ZSxcbiAgICAgICdodHRwczonOiB0cnVlLFxuICAgICAgJ2Z0cDonOiB0cnVlLFxuICAgICAgJ2dvcGhlcjonOiB0cnVlLFxuICAgICAgJ2ZpbGU6JzogdHJ1ZVxuICAgIH0sXG4gICAgcXVlcnlzdHJpbmcgPSByZXF1aXJlKCdxdWVyeXN0cmluZycpO1xuXG5mdW5jdGlvbiB1cmxQYXJzZSh1cmwsIHBhcnNlUXVlcnlTdHJpbmcsIHNsYXNoZXNEZW5vdGVIb3N0KSB7XG4gIGlmICh1cmwgJiYgaXNPYmplY3QodXJsKSAmJiB1cmwgaW5zdGFuY2VvZiBVcmwpIHJldHVybiB1cmw7XG5cbiAgdmFyIHUgPSBuZXcgVXJsO1xuICB1LnBhcnNlKHVybCwgcGFyc2VRdWVyeVN0cmluZywgc2xhc2hlc0Rlbm90ZUhvc3QpO1xuICByZXR1cm4gdTtcbn1cblxuVXJsLnByb3RvdHlwZS5wYXJzZSA9IGZ1bmN0aW9uKHVybCwgcGFyc2VRdWVyeVN0cmluZywgc2xhc2hlc0Rlbm90ZUhvc3QpIHtcbiAgaWYgKCFpc1N0cmluZyh1cmwpKSB7XG4gICAgdGhyb3cgbmV3IFR5cGVFcnJvcihcIlBhcmFtZXRlciAndXJsJyBtdXN0IGJlIGEgc3RyaW5nLCBub3QgXCIgKyB0eXBlb2YgdXJsKTtcbiAgfVxuXG4gIHZhciByZXN0ID0gdXJsO1xuXG4gIC8vIHRyaW0gYmVmb3JlIHByb2NlZWRpbmcuXG4gIC8vIFRoaXMgaXMgdG8gc3VwcG9ydCBwYXJzZSBzdHVmZiBsaWtlIFwiICBodHRwOi8vZm9vLmNvbSAgXFxuXCJcbiAgcmVzdCA9IHJlc3QudHJpbSgpO1xuXG4gIHZhciBwcm90byA9IHByb3RvY29sUGF0dGVybi5leGVjKHJlc3QpO1xuICBpZiAocHJvdG8pIHtcbiAgICBwcm90byA9IHByb3RvWzBdO1xuICAgIHZhciBsb3dlclByb3RvID0gcHJvdG8udG9Mb3dlckNhc2UoKTtcbiAgICB0aGlzLnByb3RvY29sID0gbG93ZXJQcm90bztcbiAgICByZXN0ID0gcmVzdC5zdWJzdHIocHJvdG8ubGVuZ3RoKTtcbiAgfVxuXG4gIC8vIGZpZ3VyZSBvdXQgaWYgaXQncyBnb3QgYSBob3N0XG4gIC8vIHVzZXJAc2VydmVyIGlzICphbHdheXMqIGludGVycHJldGVkIGFzIGEgaG9zdG5hbWUsIGFuZCB1cmxcbiAgLy8gcmVzb2x1dGlvbiB3aWxsIHRyZWF0IC8vZm9vL2JhciBhcyBob3N0PWZvbyxwYXRoPWJhciBiZWNhdXNlIHRoYXQnc1xuICAvLyBob3cgdGhlIGJyb3dzZXIgcmVzb2x2ZXMgcmVsYXRpdmUgVVJMcy5cbiAgaWYgKHNsYXNoZXNEZW5vdGVIb3N0IHx8IHByb3RvIHx8IHJlc3QubWF0Y2goL15cXC9cXC9bXkBcXC9dK0BbXkBcXC9dKy8pKSB7XG4gICAgdmFyIHNsYXNoZXMgPSByZXN0LnN1YnN0cigwLCAyKSA9PT0gJy8vJztcbiAgICBpZiAoc2xhc2hlcyAmJiAhKHByb3RvICYmIGhvc3RsZXNzUHJvdG9jb2xbcHJvdG9dKSkge1xuICAgICAgcmVzdCA9IHJlc3Quc3Vic3RyKDIpO1xuICAgICAgdGhpcy5zbGFzaGVzID0gdHJ1ZTtcbiAgICB9XG4gIH1cblxuICBpZiAoIWhvc3RsZXNzUHJvdG9jb2xbcHJvdG9dICYmXG4gICAgICAoc2xhc2hlcyB8fCAocHJvdG8gJiYgIXNsYXNoZWRQcm90b2NvbFtwcm90b10pKSkge1xuXG4gICAgLy8gdGhlcmUncyBhIGhvc3RuYW1lLlxuICAgIC8vIHRoZSBmaXJzdCBpbnN0YW5jZSBvZiAvLCA/LCA7LCBvciAjIGVuZHMgdGhlIGhvc3QuXG4gICAgLy9cbiAgICAvLyBJZiB0aGVyZSBpcyBhbiBAIGluIHRoZSBob3N0bmFtZSwgdGhlbiBub24taG9zdCBjaGFycyAqYXJlKiBhbGxvd2VkXG4gICAgLy8gdG8gdGhlIGxlZnQgb2YgdGhlIGxhc3QgQCBzaWduLCB1bmxlc3Mgc29tZSBob3N0LWVuZGluZyBjaGFyYWN0ZXJcbiAgICAvLyBjb21lcyAqYmVmb3JlKiB0aGUgQC1zaWduLlxuICAgIC8vIFVSTHMgYXJlIG9ibm94aW91cy5cbiAgICAvL1xuICAgIC8vIGV4OlxuICAgIC8vIGh0dHA6Ly9hQGJAYy8gPT4gdXNlcjphQGIgaG9zdDpjXG4gICAgLy8gaHR0cDovL2FAYj9AYyA9PiB1c2VyOmEgaG9zdDpjIHBhdGg6Lz9AY1xuXG4gICAgLy8gdjAuMTIgVE9ETyhpc2FhY3MpOiBUaGlzIGlzIG5vdCBxdWl0ZSBob3cgQ2hyb21lIGRvZXMgdGhpbmdzLlxuICAgIC8vIFJldmlldyBvdXIgdGVzdCBjYXNlIGFnYWluc3QgYnJvd3NlcnMgbW9yZSBjb21wcmVoZW5zaXZlbHkuXG5cbiAgICAvLyBmaW5kIHRoZSBmaXJzdCBpbnN0YW5jZSBvZiBhbnkgaG9zdEVuZGluZ0NoYXJzXG4gICAgdmFyIGhvc3RFbmQgPSAtMTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGhvc3RFbmRpbmdDaGFycy5sZW5ndGg7IGkrKykge1xuICAgICAgdmFyIGhlYyA9IHJlc3QuaW5kZXhPZihob3N0RW5kaW5nQ2hhcnNbaV0pO1xuICAgICAgaWYgKGhlYyAhPT0gLTEgJiYgKGhvc3RFbmQgPT09IC0xIHx8IGhlYyA8IGhvc3RFbmQpKVxuICAgICAgICBob3N0RW5kID0gaGVjO1xuICAgIH1cblxuICAgIC8vIGF0IHRoaXMgcG9pbnQsIGVpdGhlciB3ZSBoYXZlIGFuIGV4cGxpY2l0IHBvaW50IHdoZXJlIHRoZVxuICAgIC8vIGF1dGggcG9ydGlvbiBjYW5ub3QgZ28gcGFzdCwgb3IgdGhlIGxhc3QgQCBjaGFyIGlzIHRoZSBkZWNpZGVyLlxuICAgIHZhciBhdXRoLCBhdFNpZ247XG4gICAgaWYgKGhvc3RFbmQgPT09IC0xKSB7XG4gICAgICAvLyBhdFNpZ24gY2FuIGJlIGFueXdoZXJlLlxuICAgICAgYXRTaWduID0gcmVzdC5sYXN0SW5kZXhPZignQCcpO1xuICAgIH0gZWxzZSB7XG4gICAgICAvLyBhdFNpZ24gbXVzdCBiZSBpbiBhdXRoIHBvcnRpb24uXG4gICAgICAvLyBodHRwOi8vYUBiL2NAZCA9PiBob3N0OmIgYXV0aDphIHBhdGg6L2NAZFxuICAgICAgYXRTaWduID0gcmVzdC5sYXN0SW5kZXhPZignQCcsIGhvc3RFbmQpO1xuICAgIH1cblxuICAgIC8vIE5vdyB3ZSBoYXZlIGEgcG9ydGlvbiB3aGljaCBpcyBkZWZpbml0ZWx5IHRoZSBhdXRoLlxuICAgIC8vIFB1bGwgdGhhdCBvZmYuXG4gICAgaWYgKGF0U2lnbiAhPT0gLTEpIHtcbiAgICAgIGF1dGggPSByZXN0LnNsaWNlKDAsIGF0U2lnbik7XG4gICAgICByZXN0ID0gcmVzdC5zbGljZShhdFNpZ24gKyAxKTtcbiAgICAgIHRoaXMuYXV0aCA9IGRlY29kZVVSSUNvbXBvbmVudChhdXRoKTtcbiAgICB9XG5cbiAgICAvLyB0aGUgaG9zdCBpcyB0aGUgcmVtYWluaW5nIHRvIHRoZSBsZWZ0IG9mIHRoZSBmaXJzdCBub24taG9zdCBjaGFyXG4gICAgaG9zdEVuZCA9IC0xO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbm9uSG9zdENoYXJzLmxlbmd0aDsgaSsrKSB7XG4gICAgICB2YXIgaGVjID0gcmVzdC5pbmRleE9mKG5vbkhvc3RDaGFyc1tpXSk7XG4gICAgICBpZiAoaGVjICE9PSAtMSAmJiAoaG9zdEVuZCA9PT0gLTEgfHwgaGVjIDwgaG9zdEVuZCkpXG4gICAgICAgIGhvc3RFbmQgPSBoZWM7XG4gICAgfVxuICAgIC8vIGlmIHdlIHN0aWxsIGhhdmUgbm90IGhpdCBpdCwgdGhlbiB0aGUgZW50aXJlIHRoaW5nIGlzIGEgaG9zdC5cbiAgICBpZiAoaG9zdEVuZCA9PT0gLTEpXG4gICAgICBob3N0RW5kID0gcmVzdC5sZW5ndGg7XG5cbiAgICB0aGlzLmhvc3QgPSByZXN0LnNsaWNlKDAsIGhvc3RFbmQpO1xuICAgIHJlc3QgPSByZXN0LnNsaWNlKGhvc3RFbmQpO1xuXG4gICAgLy8gcHVsbCBvdXQgcG9ydC5cbiAgICB0aGlzLnBhcnNlSG9zdCgpO1xuXG4gICAgLy8gd2UndmUgaW5kaWNhdGVkIHRoYXQgdGhlcmUgaXMgYSBob3N0bmFtZSxcbiAgICAvLyBzbyBldmVuIGlmIGl0J3MgZW1wdHksIGl0IGhhcyB0byBiZSBwcmVzZW50LlxuICAgIHRoaXMuaG9zdG5hbWUgPSB0aGlzLmhvc3RuYW1lIHx8ICcnO1xuXG4gICAgLy8gaWYgaG9zdG5hbWUgYmVnaW5zIHdpdGggWyBhbmQgZW5kcyB3aXRoIF1cbiAgICAvLyBhc3N1bWUgdGhhdCBpdCdzIGFuIElQdjYgYWRkcmVzcy5cbiAgICB2YXIgaXB2Nkhvc3RuYW1lID0gdGhpcy5ob3N0bmFtZVswXSA9PT0gJ1snICYmXG4gICAgICAgIHRoaXMuaG9zdG5hbWVbdGhpcy5ob3N0bmFtZS5sZW5ndGggLSAxXSA9PT0gJ10nO1xuXG4gICAgLy8gdmFsaWRhdGUgYSBsaXR0bGUuXG4gICAgaWYgKCFpcHY2SG9zdG5hbWUpIHtcbiAgICAgIHZhciBob3N0cGFydHMgPSB0aGlzLmhvc3RuYW1lLnNwbGl0KC9cXC4vKTtcbiAgICAgIGZvciAodmFyIGkgPSAwLCBsID0gaG9zdHBhcnRzLmxlbmd0aDsgaSA8IGw7IGkrKykge1xuICAgICAgICB2YXIgcGFydCA9IGhvc3RwYXJ0c1tpXTtcbiAgICAgICAgaWYgKCFwYXJ0KSBjb250aW51ZTtcbiAgICAgICAgaWYgKCFwYXJ0Lm1hdGNoKGhvc3RuYW1lUGFydFBhdHRlcm4pKSB7XG4gICAgICAgICAgdmFyIG5ld3BhcnQgPSAnJztcbiAgICAgICAgICBmb3IgKHZhciBqID0gMCwgayA9IHBhcnQubGVuZ3RoOyBqIDwgazsgaisrKSB7XG4gICAgICAgICAgICBpZiAocGFydC5jaGFyQ29kZUF0KGopID4gMTI3KSB7XG4gICAgICAgICAgICAgIC8vIHdlIHJlcGxhY2Ugbm9uLUFTQ0lJIGNoYXIgd2l0aCBhIHRlbXBvcmFyeSBwbGFjZWhvbGRlclxuICAgICAgICAgICAgICAvLyB3ZSBuZWVkIHRoaXMgdG8gbWFrZSBzdXJlIHNpemUgb2YgaG9zdG5hbWUgaXMgbm90XG4gICAgICAgICAgICAgIC8vIGJyb2tlbiBieSByZXBsYWNpbmcgbm9uLUFTQ0lJIGJ5IG5vdGhpbmdcbiAgICAgICAgICAgICAgbmV3cGFydCArPSAneCc7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICBuZXdwYXJ0ICs9IHBhcnRbal07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIHdlIHRlc3QgYWdhaW4gd2l0aCBBU0NJSSBjaGFyIG9ubHlcbiAgICAgICAgICBpZiAoIW5ld3BhcnQubWF0Y2goaG9zdG5hbWVQYXJ0UGF0dGVybikpIHtcbiAgICAgICAgICAgIHZhciB2YWxpZFBhcnRzID0gaG9zdHBhcnRzLnNsaWNlKDAsIGkpO1xuICAgICAgICAgICAgdmFyIG5vdEhvc3QgPSBob3N0cGFydHMuc2xpY2UoaSArIDEpO1xuICAgICAgICAgICAgdmFyIGJpdCA9IHBhcnQubWF0Y2goaG9zdG5hbWVQYXJ0U3RhcnQpO1xuICAgICAgICAgICAgaWYgKGJpdCkge1xuICAgICAgICAgICAgICB2YWxpZFBhcnRzLnB1c2goYml0WzFdKTtcbiAgICAgICAgICAgICAgbm90SG9zdC51bnNoaWZ0KGJpdFsyXSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAobm90SG9zdC5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgcmVzdCA9ICcvJyArIG5vdEhvc3Quam9pbignLicpICsgcmVzdDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRoaXMuaG9zdG5hbWUgPSB2YWxpZFBhcnRzLmpvaW4oJy4nKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIGlmICh0aGlzLmhvc3RuYW1lLmxlbmd0aCA+IGhvc3RuYW1lTWF4TGVuKSB7XG4gICAgICB0aGlzLmhvc3RuYW1lID0gJyc7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIGhvc3RuYW1lcyBhcmUgYWx3YXlzIGxvd2VyIGNhc2UuXG4gICAgICB0aGlzLmhvc3RuYW1lID0gdGhpcy5ob3N0bmFtZS50b0xvd2VyQ2FzZSgpO1xuICAgIH1cblxuICAgIGlmICghaXB2Nkhvc3RuYW1lKSB7XG4gICAgICAvLyBJRE5BIFN1cHBvcnQ6IFJldHVybnMgYSBwdW55IGNvZGVkIHJlcHJlc2VudGF0aW9uIG9mIFwiZG9tYWluXCIuXG4gICAgICAvLyBJdCBvbmx5IGNvbnZlcnRzIHRoZSBwYXJ0IG9mIHRoZSBkb21haW4gbmFtZSB0aGF0XG4gICAgICAvLyBoYXMgbm9uIEFTQ0lJIGNoYXJhY3RlcnMuIEkuZS4gaXQgZG9zZW50IG1hdHRlciBpZlxuICAgICAgLy8geW91IGNhbGwgaXQgd2l0aCBhIGRvbWFpbiB0aGF0IGFscmVhZHkgaXMgaW4gQVNDSUkuXG4gICAgICB2YXIgZG9tYWluQXJyYXkgPSB0aGlzLmhvc3RuYW1lLnNwbGl0KCcuJyk7XG4gICAgICB2YXIgbmV3T3V0ID0gW107XG4gICAgICBmb3IgKHZhciBpID0gMDsgaSA8IGRvbWFpbkFycmF5Lmxlbmd0aDsgKytpKSB7XG4gICAgICAgIHZhciBzID0gZG9tYWluQXJyYXlbaV07XG4gICAgICAgIG5ld091dC5wdXNoKHMubWF0Y2goL1teQS1aYS16MC05Xy1dLykgP1xuICAgICAgICAgICAgJ3huLS0nICsgcHVueWNvZGUuZW5jb2RlKHMpIDogcyk7XG4gICAgICB9XG4gICAgICB0aGlzLmhvc3RuYW1lID0gbmV3T3V0LmpvaW4oJy4nKTtcbiAgICB9XG5cbiAgICB2YXIgcCA9IHRoaXMucG9ydCA/ICc6JyArIHRoaXMucG9ydCA6ICcnO1xuICAgIHZhciBoID0gdGhpcy5ob3N0bmFtZSB8fCAnJztcbiAgICB0aGlzLmhvc3QgPSBoICsgcDtcbiAgICB0aGlzLmhyZWYgKz0gdGhpcy5ob3N0O1xuXG4gICAgLy8gc3RyaXAgWyBhbmQgXSBmcm9tIHRoZSBob3N0bmFtZVxuICAgIC8vIHRoZSBob3N0IGZpZWxkIHN0aWxsIHJldGFpbnMgdGhlbSwgdGhvdWdoXG4gICAgaWYgKGlwdjZIb3N0bmFtZSkge1xuICAgICAgdGhpcy5ob3N0bmFtZSA9IHRoaXMuaG9zdG5hbWUuc3Vic3RyKDEsIHRoaXMuaG9zdG5hbWUubGVuZ3RoIC0gMik7XG4gICAgICBpZiAocmVzdFswXSAhPT0gJy8nKSB7XG4gICAgICAgIHJlc3QgPSAnLycgKyByZXN0O1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8vIG5vdyByZXN0IGlzIHNldCB0byB0aGUgcG9zdC1ob3N0IHN0dWZmLlxuICAvLyBjaG9wIG9mZiBhbnkgZGVsaW0gY2hhcnMuXG4gIGlmICghdW5zYWZlUHJvdG9jb2xbbG93ZXJQcm90b10pIHtcblxuICAgIC8vIEZpcnN0LCBtYWtlIDEwMCUgc3VyZSB0aGF0IGFueSBcImF1dG9Fc2NhcGVcIiBjaGFycyBnZXRcbiAgICAvLyBlc2NhcGVkLCBldmVuIGlmIGVuY29kZVVSSUNvbXBvbmVudCBkb2Vzbid0IHRoaW5rIHRoZXlcbiAgICAvLyBuZWVkIHRvIGJlLlxuICAgIGZvciAodmFyIGkgPSAwLCBsID0gYXV0b0VzY2FwZS5sZW5ndGg7IGkgPCBsOyBpKyspIHtcbiAgICAgIHZhciBhZSA9IGF1dG9Fc2NhcGVbaV07XG4gICAgICB2YXIgZXNjID0gZW5jb2RlVVJJQ29tcG9uZW50KGFlKTtcbiAgICAgIGlmIChlc2MgPT09IGFlKSB7XG4gICAgICAgIGVzYyA9IGVzY2FwZShhZSk7XG4gICAgICB9XG4gICAgICByZXN0ID0gcmVzdC5zcGxpdChhZSkuam9pbihlc2MpO1xuICAgIH1cbiAgfVxuXG5cbiAgLy8gY2hvcCBvZmYgZnJvbSB0aGUgdGFpbCBmaXJzdC5cbiAgdmFyIGhhc2ggPSByZXN0LmluZGV4T2YoJyMnKTtcbiAgaWYgKGhhc2ggIT09IC0xKSB7XG4gICAgLy8gZ290IGEgZnJhZ21lbnQgc3RyaW5nLlxuICAgIHRoaXMuaGFzaCA9IHJlc3Quc3Vic3RyKGhhc2gpO1xuICAgIHJlc3QgPSByZXN0LnNsaWNlKDAsIGhhc2gpO1xuICB9XG4gIHZhciBxbSA9IHJlc3QuaW5kZXhPZignPycpO1xuICBpZiAocW0gIT09IC0xKSB7XG4gICAgdGhpcy5zZWFyY2ggPSByZXN0LnN1YnN0cihxbSk7XG4gICAgdGhpcy5xdWVyeSA9IHJlc3Quc3Vic3RyKHFtICsgMSk7XG4gICAgaWYgKHBhcnNlUXVlcnlTdHJpbmcpIHtcbiAgICAgIHRoaXMucXVlcnkgPSBxdWVyeXN0cmluZy5wYXJzZSh0aGlzLnF1ZXJ5KTtcbiAgICB9XG4gICAgcmVzdCA9IHJlc3Quc2xpY2UoMCwgcW0pO1xuICB9IGVsc2UgaWYgKHBhcnNlUXVlcnlTdHJpbmcpIHtcbiAgICAvLyBubyBxdWVyeSBzdHJpbmcsIGJ1dCBwYXJzZVF1ZXJ5U3RyaW5nIHN0aWxsIHJlcXVlc3RlZFxuICAgIHRoaXMuc2VhcmNoID0gJyc7XG4gICAgdGhpcy5xdWVyeSA9IHt9O1xuICB9XG4gIGlmIChyZXN0KSB0aGlzLnBhdGhuYW1lID0gcmVzdDtcbiAgaWYgKHNsYXNoZWRQcm90b2NvbFtsb3dlclByb3RvXSAmJlxuICAgICAgdGhpcy5ob3N0bmFtZSAmJiAhdGhpcy5wYXRobmFtZSkge1xuICAgIHRoaXMucGF0aG5hbWUgPSAnLyc7XG4gIH1cblxuICAvL3RvIHN1cHBvcnQgaHR0cC5yZXF1ZXN0XG4gIGlmICh0aGlzLnBhdGhuYW1lIHx8IHRoaXMuc2VhcmNoKSB7XG4gICAgdmFyIHAgPSB0aGlzLnBhdGhuYW1lIHx8ICcnO1xuICAgIHZhciBzID0gdGhpcy5zZWFyY2ggfHwgJyc7XG4gICAgdGhpcy5wYXRoID0gcCArIHM7XG4gIH1cblxuICAvLyBmaW5hbGx5LCByZWNvbnN0cnVjdCB0aGUgaHJlZiBiYXNlZCBvbiB3aGF0IGhhcyBiZWVuIHZhbGlkYXRlZC5cbiAgdGhpcy5ocmVmID0gdGhpcy5mb3JtYXQoKTtcbiAgcmV0dXJuIHRoaXM7XG59O1xuXG4vLyBmb3JtYXQgYSBwYXJzZWQgb2JqZWN0IGludG8gYSB1cmwgc3RyaW5nXG5mdW5jdGlvbiB1cmxGb3JtYXQob2JqKSB7XG4gIC8vIGVuc3VyZSBpdCdzIGFuIG9iamVjdCwgYW5kIG5vdCBhIHN0cmluZyB1cmwuXG4gIC8vIElmIGl0J3MgYW4gb2JqLCB0aGlzIGlzIGEgbm8tb3AuXG4gIC8vIHRoaXMgd2F5LCB5b3UgY2FuIGNhbGwgdXJsX2Zvcm1hdCgpIG9uIHN0cmluZ3NcbiAgLy8gdG8gY2xlYW4gdXAgcG90ZW50aWFsbHkgd29ua3kgdXJscy5cbiAgaWYgKGlzU3RyaW5nKG9iaikpIG9iaiA9IHVybFBhcnNlKG9iaik7XG4gIGlmICghKG9iaiBpbnN0YW5jZW9mIFVybCkpIHJldHVybiBVcmwucHJvdG90eXBlLmZvcm1hdC5jYWxsKG9iaik7XG4gIHJldHVybiBvYmouZm9ybWF0KCk7XG59XG5cblVybC5wcm90b3R5cGUuZm9ybWF0ID0gZnVuY3Rpb24oKSB7XG4gIHZhciBhdXRoID0gdGhpcy5hdXRoIHx8ICcnO1xuICBpZiAoYXV0aCkge1xuICAgIGF1dGggPSBlbmNvZGVVUklDb21wb25lbnQoYXV0aCk7XG4gICAgYXV0aCA9IGF1dGgucmVwbGFjZSgvJTNBL2ksICc6Jyk7XG4gICAgYXV0aCArPSAnQCc7XG4gIH1cblxuICB2YXIgcHJvdG9jb2wgPSB0aGlzLnByb3RvY29sIHx8ICcnLFxuICAgICAgcGF0aG5hbWUgPSB0aGlzLnBhdGhuYW1lIHx8ICcnLFxuICAgICAgaGFzaCA9IHRoaXMuaGFzaCB8fCAnJyxcbiAgICAgIGhvc3QgPSBmYWxzZSxcbiAgICAgIHF1ZXJ5ID0gJyc7XG5cbiAgaWYgKHRoaXMuaG9zdCkge1xuICAgIGhvc3QgPSBhdXRoICsgdGhpcy5ob3N0O1xuICB9IGVsc2UgaWYgKHRoaXMuaG9zdG5hbWUpIHtcbiAgICBob3N0ID0gYXV0aCArICh0aGlzLmhvc3RuYW1lLmluZGV4T2YoJzonKSA9PT0gLTEgP1xuICAgICAgICB0aGlzLmhvc3RuYW1lIDpcbiAgICAgICAgJ1snICsgdGhpcy5ob3N0bmFtZSArICddJyk7XG4gICAgaWYgKHRoaXMucG9ydCkge1xuICAgICAgaG9zdCArPSAnOicgKyB0aGlzLnBvcnQ7XG4gICAgfVxuICB9XG5cbiAgaWYgKHRoaXMucXVlcnkgJiZcbiAgICAgIGlzT2JqZWN0KHRoaXMucXVlcnkpICYmXG4gICAgICBPYmplY3Qua2V5cyh0aGlzLnF1ZXJ5KS5sZW5ndGgpIHtcbiAgICBxdWVyeSA9IHF1ZXJ5c3RyaW5nLnN0cmluZ2lmeSh0aGlzLnF1ZXJ5KTtcbiAgfVxuXG4gIHZhciBzZWFyY2ggPSB0aGlzLnNlYXJjaCB8fCAocXVlcnkgJiYgKCc/JyArIHF1ZXJ5KSkgfHwgJyc7XG5cbiAgaWYgKHByb3RvY29sICYmIHByb3RvY29sLnN1YnN0cigtMSkgIT09ICc6JykgcHJvdG9jb2wgKz0gJzonO1xuXG4gIC8vIG9ubHkgdGhlIHNsYXNoZWRQcm90b2NvbHMgZ2V0IHRoZSAvLy4gIE5vdCBtYWlsdG86LCB4bXBwOiwgZXRjLlxuICAvLyB1bmxlc3MgdGhleSBoYWQgdGhlbSB0byBiZWdpbiB3aXRoLlxuICBpZiAodGhpcy5zbGFzaGVzIHx8XG4gICAgICAoIXByb3RvY29sIHx8IHNsYXNoZWRQcm90b2NvbFtwcm90b2NvbF0pICYmIGhvc3QgIT09IGZhbHNlKSB7XG4gICAgaG9zdCA9ICcvLycgKyAoaG9zdCB8fCAnJyk7XG4gICAgaWYgKHBhdGhuYW1lICYmIHBhdGhuYW1lLmNoYXJBdCgwKSAhPT0gJy8nKSBwYXRobmFtZSA9ICcvJyArIHBhdGhuYW1lO1xuICB9IGVsc2UgaWYgKCFob3N0KSB7XG4gICAgaG9zdCA9ICcnO1xuICB9XG5cbiAgaWYgKGhhc2ggJiYgaGFzaC5jaGFyQXQoMCkgIT09ICcjJykgaGFzaCA9ICcjJyArIGhhc2g7XG4gIGlmIChzZWFyY2ggJiYgc2VhcmNoLmNoYXJBdCgwKSAhPT0gJz8nKSBzZWFyY2ggPSAnPycgKyBzZWFyY2g7XG5cbiAgcGF0aG5hbWUgPSBwYXRobmFtZS5yZXBsYWNlKC9bPyNdL2csIGZ1bmN0aW9uKG1hdGNoKSB7XG4gICAgcmV0dXJuIGVuY29kZVVSSUNvbXBvbmVudChtYXRjaCk7XG4gIH0pO1xuICBzZWFyY2ggPSBzZWFyY2gucmVwbGFjZSgnIycsICclMjMnKTtcblxuICByZXR1cm4gcHJvdG9jb2wgKyBob3N0ICsgcGF0aG5hbWUgKyBzZWFyY2ggKyBoYXNoO1xufTtcblxuZnVuY3Rpb24gdXJsUmVzb2x2ZShzb3VyY2UsIHJlbGF0aXZlKSB7XG4gIHJldHVybiB1cmxQYXJzZShzb3VyY2UsIGZhbHNlLCB0cnVlKS5yZXNvbHZlKHJlbGF0aXZlKTtcbn1cblxuVXJsLnByb3RvdHlwZS5yZXNvbHZlID0gZnVuY3Rpb24ocmVsYXRpdmUpIHtcbiAgcmV0dXJuIHRoaXMucmVzb2x2ZU9iamVjdCh1cmxQYXJzZShyZWxhdGl2ZSwgZmFsc2UsIHRydWUpKS5mb3JtYXQoKTtcbn07XG5cbmZ1bmN0aW9uIHVybFJlc29sdmVPYmplY3Qoc291cmNlLCByZWxhdGl2ZSkge1xuICBpZiAoIXNvdXJjZSkgcmV0dXJuIHJlbGF0aXZlO1xuICByZXR1cm4gdXJsUGFyc2Uoc291cmNlLCBmYWxzZSwgdHJ1ZSkucmVzb2x2ZU9iamVjdChyZWxhdGl2ZSk7XG59XG5cblVybC5wcm90b3R5cGUucmVzb2x2ZU9iamVjdCA9IGZ1bmN0aW9uKHJlbGF0aXZlKSB7XG4gIGlmIChpc1N0cmluZyhyZWxhdGl2ZSkpIHtcbiAgICB2YXIgcmVsID0gbmV3IFVybCgpO1xuICAgIHJlbC5wYXJzZShyZWxhdGl2ZSwgZmFsc2UsIHRydWUpO1xuICAgIHJlbGF0aXZlID0gcmVsO1xuICB9XG5cbiAgdmFyIHJlc3VsdCA9IG5ldyBVcmwoKTtcbiAgT2JqZWN0LmtleXModGhpcykuZm9yRWFjaChmdW5jdGlvbihrKSB7XG4gICAgcmVzdWx0W2tdID0gdGhpc1trXTtcbiAgfSwgdGhpcyk7XG5cbiAgLy8gaGFzaCBpcyBhbHdheXMgb3ZlcnJpZGRlbiwgbm8gbWF0dGVyIHdoYXQuXG4gIC8vIGV2ZW4gaHJlZj1cIlwiIHdpbGwgcmVtb3ZlIGl0LlxuICByZXN1bHQuaGFzaCA9IHJlbGF0aXZlLmhhc2g7XG5cbiAgLy8gaWYgdGhlIHJlbGF0aXZlIHVybCBpcyBlbXB0eSwgdGhlbiB0aGVyZSdzIG5vdGhpbmcgbGVmdCB0byBkbyBoZXJlLlxuICBpZiAocmVsYXRpdmUuaHJlZiA9PT0gJycpIHtcbiAgICByZXN1bHQuaHJlZiA9IHJlc3VsdC5mb3JtYXQoKTtcbiAgICByZXR1cm4gcmVzdWx0O1xuICB9XG5cbiAgLy8gaHJlZnMgbGlrZSAvL2Zvby9iYXIgYWx3YXlzIGN1dCB0byB0aGUgcHJvdG9jb2wuXG4gIGlmIChyZWxhdGl2ZS5zbGFzaGVzICYmICFyZWxhdGl2ZS5wcm90b2NvbCkge1xuICAgIC8vIHRha2UgZXZlcnl0aGluZyBleGNlcHQgdGhlIHByb3RvY29sIGZyb20gcmVsYXRpdmVcbiAgICBPYmplY3Qua2V5cyhyZWxhdGl2ZSkuZm9yRWFjaChmdW5jdGlvbihrKSB7XG4gICAgICBpZiAoayAhPT0gJ3Byb3RvY29sJylcbiAgICAgICAgcmVzdWx0W2tdID0gcmVsYXRpdmVba107XG4gICAgfSk7XG5cbiAgICAvL3VybFBhcnNlIGFwcGVuZHMgdHJhaWxpbmcgLyB0byB1cmxzIGxpa2UgaHR0cDovL3d3dy5leGFtcGxlLmNvbVxuICAgIGlmIChzbGFzaGVkUHJvdG9jb2xbcmVzdWx0LnByb3RvY29sXSAmJlxuICAgICAgICByZXN1bHQuaG9zdG5hbWUgJiYgIXJlc3VsdC5wYXRobmFtZSkge1xuICAgICAgcmVzdWx0LnBhdGggPSByZXN1bHQucGF0aG5hbWUgPSAnLyc7XG4gICAgfVxuXG4gICAgcmVzdWx0LmhyZWYgPSByZXN1bHQuZm9ybWF0KCk7XG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuXG4gIGlmIChyZWxhdGl2ZS5wcm90b2NvbCAmJiByZWxhdGl2ZS5wcm90b2NvbCAhPT0gcmVzdWx0LnByb3RvY29sKSB7XG4gICAgLy8gaWYgaXQncyBhIGtub3duIHVybCBwcm90b2NvbCwgdGhlbiBjaGFuZ2luZ1xuICAgIC8vIHRoZSBwcm90b2NvbCBkb2VzIHdlaXJkIHRoaW5nc1xuICAgIC8vIGZpcnN0LCBpZiBpdCdzIG5vdCBmaWxlOiwgdGhlbiB3ZSBNVVNUIGhhdmUgYSBob3N0LFxuICAgIC8vIGFuZCBpZiB0aGVyZSB3YXMgYSBwYXRoXG4gICAgLy8gdG8gYmVnaW4gd2l0aCwgdGhlbiB3ZSBNVVNUIGhhdmUgYSBwYXRoLlxuICAgIC8vIGlmIGl0IGlzIGZpbGU6LCB0aGVuIHRoZSBob3N0IGlzIGRyb3BwZWQsXG4gICAgLy8gYmVjYXVzZSB0aGF0J3Mga25vd24gdG8gYmUgaG9zdGxlc3MuXG4gICAgLy8gYW55dGhpbmcgZWxzZSBpcyBhc3N1bWVkIHRvIGJlIGFic29sdXRlLlxuICAgIGlmICghc2xhc2hlZFByb3RvY29sW3JlbGF0aXZlLnByb3RvY29sXSkge1xuICAgICAgT2JqZWN0LmtleXMocmVsYXRpdmUpLmZvckVhY2goZnVuY3Rpb24oaykge1xuICAgICAgICByZXN1bHRba10gPSByZWxhdGl2ZVtrXTtcbiAgICAgIH0pO1xuICAgICAgcmVzdWx0LmhyZWYgPSByZXN1bHQuZm9ybWF0KCk7XG4gICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIHJlc3VsdC5wcm90b2NvbCA9IHJlbGF0aXZlLnByb3RvY29sO1xuICAgIGlmICghcmVsYXRpdmUuaG9zdCAmJiAhaG9zdGxlc3NQcm90b2NvbFtyZWxhdGl2ZS5wcm90b2NvbF0pIHtcbiAgICAgIHZhciByZWxQYXRoID0gKHJlbGF0aXZlLnBhdGhuYW1lIHx8ICcnKS5zcGxpdCgnLycpO1xuICAgICAgd2hpbGUgKHJlbFBhdGgubGVuZ3RoICYmICEocmVsYXRpdmUuaG9zdCA9IHJlbFBhdGguc2hpZnQoKSkpO1xuICAgICAgaWYgKCFyZWxhdGl2ZS5ob3N0KSByZWxhdGl2ZS5ob3N0ID0gJyc7XG4gICAgICBpZiAoIXJlbGF0aXZlLmhvc3RuYW1lKSByZWxhdGl2ZS5ob3N0bmFtZSA9ICcnO1xuICAgICAgaWYgKHJlbFBhdGhbMF0gIT09ICcnKSByZWxQYXRoLnVuc2hpZnQoJycpO1xuICAgICAgaWYgKHJlbFBhdGgubGVuZ3RoIDwgMikgcmVsUGF0aC51bnNoaWZ0KCcnKTtcbiAgICAgIHJlc3VsdC5wYXRobmFtZSA9IHJlbFBhdGguam9pbignLycpO1xuICAgIH0gZWxzZSB7XG4gICAgICByZXN1bHQucGF0aG5hbWUgPSByZWxhdGl2ZS5wYXRobmFtZTtcbiAgICB9XG4gICAgcmVzdWx0LnNlYXJjaCA9IHJlbGF0aXZlLnNlYXJjaDtcbiAgICByZXN1bHQucXVlcnkgPSByZWxhdGl2ZS5xdWVyeTtcbiAgICByZXN1bHQuaG9zdCA9IHJlbGF0aXZlLmhvc3QgfHwgJyc7XG4gICAgcmVzdWx0LmF1dGggPSByZWxhdGl2ZS5hdXRoO1xuICAgIHJlc3VsdC5ob3N0bmFtZSA9IHJlbGF0aXZlLmhvc3RuYW1lIHx8IHJlbGF0aXZlLmhvc3Q7XG4gICAgcmVzdWx0LnBvcnQgPSByZWxhdGl2ZS5wb3J0O1xuICAgIC8vIHRvIHN1cHBvcnQgaHR0cC5yZXF1ZXN0XG4gICAgaWYgKHJlc3VsdC5wYXRobmFtZSB8fCByZXN1bHQuc2VhcmNoKSB7XG4gICAgICB2YXIgcCA9IHJlc3VsdC5wYXRobmFtZSB8fCAnJztcbiAgICAgIHZhciBzID0gcmVzdWx0LnNlYXJjaCB8fCAnJztcbiAgICAgIHJlc3VsdC5wYXRoID0gcCArIHM7XG4gICAgfVxuICAgIHJlc3VsdC5zbGFzaGVzID0gcmVzdWx0LnNsYXNoZXMgfHwgcmVsYXRpdmUuc2xhc2hlcztcbiAgICByZXN1bHQuaHJlZiA9IHJlc3VsdC5mb3JtYXQoKTtcbiAgICByZXR1cm4gcmVzdWx0O1xuICB9XG5cbiAgdmFyIGlzU291cmNlQWJzID0gKHJlc3VsdC5wYXRobmFtZSAmJiByZXN1bHQucGF0aG5hbWUuY2hhckF0KDApID09PSAnLycpLFxuICAgICAgaXNSZWxBYnMgPSAoXG4gICAgICAgICAgcmVsYXRpdmUuaG9zdCB8fFxuICAgICAgICAgIHJlbGF0aXZlLnBhdGhuYW1lICYmIHJlbGF0aXZlLnBhdGhuYW1lLmNoYXJBdCgwKSA9PT0gJy8nXG4gICAgICApLFxuICAgICAgbXVzdEVuZEFicyA9IChpc1JlbEFicyB8fCBpc1NvdXJjZUFicyB8fFxuICAgICAgICAgICAgICAgICAgICAocmVzdWx0Lmhvc3QgJiYgcmVsYXRpdmUucGF0aG5hbWUpKSxcbiAgICAgIHJlbW92ZUFsbERvdHMgPSBtdXN0RW5kQWJzLFxuICAgICAgc3JjUGF0aCA9IHJlc3VsdC5wYXRobmFtZSAmJiByZXN1bHQucGF0aG5hbWUuc3BsaXQoJy8nKSB8fCBbXSxcbiAgICAgIHJlbFBhdGggPSByZWxhdGl2ZS5wYXRobmFtZSAmJiByZWxhdGl2ZS5wYXRobmFtZS5zcGxpdCgnLycpIHx8IFtdLFxuICAgICAgcHN5Y2hvdGljID0gcmVzdWx0LnByb3RvY29sICYmICFzbGFzaGVkUHJvdG9jb2xbcmVzdWx0LnByb3RvY29sXTtcblxuICAvLyBpZiB0aGUgdXJsIGlzIGEgbm9uLXNsYXNoZWQgdXJsLCB0aGVuIHJlbGF0aXZlXG4gIC8vIGxpbmtzIGxpa2UgLi4vLi4gc2hvdWxkIGJlIGFibGVcbiAgLy8gdG8gY3Jhd2wgdXAgdG8gdGhlIGhvc3RuYW1lLCBhcyB3ZWxsLiAgVGhpcyBpcyBzdHJhbmdlLlxuICAvLyByZXN1bHQucHJvdG9jb2wgaGFzIGFscmVhZHkgYmVlbiBzZXQgYnkgbm93LlxuICAvLyBMYXRlciBvbiwgcHV0IHRoZSBmaXJzdCBwYXRoIHBhcnQgaW50byB0aGUgaG9zdCBmaWVsZC5cbiAgaWYgKHBzeWNob3RpYykge1xuICAgIHJlc3VsdC5ob3N0bmFtZSA9ICcnO1xuICAgIHJlc3VsdC5wb3J0ID0gbnVsbDtcbiAgICBpZiAocmVzdWx0Lmhvc3QpIHtcbiAgICAgIGlmIChzcmNQYXRoWzBdID09PSAnJykgc3JjUGF0aFswXSA9IHJlc3VsdC5ob3N0O1xuICAgICAgZWxzZSBzcmNQYXRoLnVuc2hpZnQocmVzdWx0Lmhvc3QpO1xuICAgIH1cbiAgICByZXN1bHQuaG9zdCA9ICcnO1xuICAgIGlmIChyZWxhdGl2ZS5wcm90b2NvbCkge1xuICAgICAgcmVsYXRpdmUuaG9zdG5hbWUgPSBudWxsO1xuICAgICAgcmVsYXRpdmUucG9ydCA9IG51bGw7XG4gICAgICBpZiAocmVsYXRpdmUuaG9zdCkge1xuICAgICAgICBpZiAocmVsUGF0aFswXSA9PT0gJycpIHJlbFBhdGhbMF0gPSByZWxhdGl2ZS5ob3N0O1xuICAgICAgICBlbHNlIHJlbFBhdGgudW5zaGlmdChyZWxhdGl2ZS5ob3N0KTtcbiAgICAgIH1cbiAgICAgIHJlbGF0aXZlLmhvc3QgPSBudWxsO1xuICAgIH1cbiAgICBtdXN0RW5kQWJzID0gbXVzdEVuZEFicyAmJiAocmVsUGF0aFswXSA9PT0gJycgfHwgc3JjUGF0aFswXSA9PT0gJycpO1xuICB9XG5cbiAgaWYgKGlzUmVsQWJzKSB7XG4gICAgLy8gaXQncyBhYnNvbHV0ZS5cbiAgICByZXN1bHQuaG9zdCA9IChyZWxhdGl2ZS5ob3N0IHx8IHJlbGF0aXZlLmhvc3QgPT09ICcnKSA/XG4gICAgICAgICAgICAgICAgICByZWxhdGl2ZS5ob3N0IDogcmVzdWx0Lmhvc3Q7XG4gICAgcmVzdWx0Lmhvc3RuYW1lID0gKHJlbGF0aXZlLmhvc3RuYW1lIHx8IHJlbGF0aXZlLmhvc3RuYW1lID09PSAnJykgP1xuICAgICAgICAgICAgICAgICAgICAgIHJlbGF0aXZlLmhvc3RuYW1lIDogcmVzdWx0Lmhvc3RuYW1lO1xuICAgIHJlc3VsdC5zZWFyY2ggPSByZWxhdGl2ZS5zZWFyY2g7XG4gICAgcmVzdWx0LnF1ZXJ5ID0gcmVsYXRpdmUucXVlcnk7XG4gICAgc3JjUGF0aCA9IHJlbFBhdGg7XG4gICAgLy8gZmFsbCB0aHJvdWdoIHRvIHRoZSBkb3QtaGFuZGxpbmcgYmVsb3cuXG4gIH0gZWxzZSBpZiAocmVsUGF0aC5sZW5ndGgpIHtcbiAgICAvLyBpdCdzIHJlbGF0aXZlXG4gICAgLy8gdGhyb3cgYXdheSB0aGUgZXhpc3RpbmcgZmlsZSwgYW5kIHRha2UgdGhlIG5ldyBwYXRoIGluc3RlYWQuXG4gICAgaWYgKCFzcmNQYXRoKSBzcmNQYXRoID0gW107XG4gICAgc3JjUGF0aC5wb3AoKTtcbiAgICBzcmNQYXRoID0gc3JjUGF0aC5jb25jYXQocmVsUGF0aCk7XG4gICAgcmVzdWx0LnNlYXJjaCA9IHJlbGF0aXZlLnNlYXJjaDtcbiAgICByZXN1bHQucXVlcnkgPSByZWxhdGl2ZS5xdWVyeTtcbiAgfSBlbHNlIGlmICghaXNOdWxsT3JVbmRlZmluZWQocmVsYXRpdmUuc2VhcmNoKSkge1xuICAgIC8vIGp1c3QgcHVsbCBvdXQgdGhlIHNlYXJjaC5cbiAgICAvLyBsaWtlIGhyZWY9Jz9mb28nLlxuICAgIC8vIFB1dCB0aGlzIGFmdGVyIHRoZSBvdGhlciB0d28gY2FzZXMgYmVjYXVzZSBpdCBzaW1wbGlmaWVzIHRoZSBib29sZWFuc1xuICAgIGlmIChwc3ljaG90aWMpIHtcbiAgICAgIHJlc3VsdC5ob3N0bmFtZSA9IHJlc3VsdC5ob3N0ID0gc3JjUGF0aC5zaGlmdCgpO1xuICAgICAgLy9vY2NhdGlvbmFseSB0aGUgYXV0aCBjYW4gZ2V0IHN0dWNrIG9ubHkgaW4gaG9zdFxuICAgICAgLy90aGlzIGVzcGVjaWFseSBoYXBwZW5zIGluIGNhc2VzIGxpa2VcbiAgICAgIC8vdXJsLnJlc29sdmVPYmplY3QoJ21haWx0bzpsb2NhbDFAZG9tYWluMScsICdsb2NhbDJAZG9tYWluMicpXG4gICAgICB2YXIgYXV0aEluSG9zdCA9IHJlc3VsdC5ob3N0ICYmIHJlc3VsdC5ob3N0LmluZGV4T2YoJ0AnKSA+IDAgP1xuICAgICAgICAgICAgICAgICAgICAgICByZXN1bHQuaG9zdC5zcGxpdCgnQCcpIDogZmFsc2U7XG4gICAgICBpZiAoYXV0aEluSG9zdCkge1xuICAgICAgICByZXN1bHQuYXV0aCA9IGF1dGhJbkhvc3Quc2hpZnQoKTtcbiAgICAgICAgcmVzdWx0Lmhvc3QgPSByZXN1bHQuaG9zdG5hbWUgPSBhdXRoSW5Ib3N0LnNoaWZ0KCk7XG4gICAgICB9XG4gICAgfVxuICAgIHJlc3VsdC5zZWFyY2ggPSByZWxhdGl2ZS5zZWFyY2g7XG4gICAgcmVzdWx0LnF1ZXJ5ID0gcmVsYXRpdmUucXVlcnk7XG4gICAgLy90byBzdXBwb3J0IGh0dHAucmVxdWVzdFxuICAgIGlmICghaXNOdWxsKHJlc3VsdC5wYXRobmFtZSkgfHwgIWlzTnVsbChyZXN1bHQuc2VhcmNoKSkge1xuICAgICAgcmVzdWx0LnBhdGggPSAocmVzdWx0LnBhdGhuYW1lID8gcmVzdWx0LnBhdGhuYW1lIDogJycpICtcbiAgICAgICAgICAgICAgICAgICAgKHJlc3VsdC5zZWFyY2ggPyByZXN1bHQuc2VhcmNoIDogJycpO1xuICAgIH1cbiAgICByZXN1bHQuaHJlZiA9IHJlc3VsdC5mb3JtYXQoKTtcbiAgICByZXR1cm4gcmVzdWx0O1xuICB9XG5cbiAgaWYgKCFzcmNQYXRoLmxlbmd0aCkge1xuICAgIC8vIG5vIHBhdGggYXQgYWxsLiAgZWFzeS5cbiAgICAvLyB3ZSd2ZSBhbHJlYWR5IGhhbmRsZWQgdGhlIG90aGVyIHN0dWZmIGFib3ZlLlxuICAgIHJlc3VsdC5wYXRobmFtZSA9IG51bGw7XG4gICAgLy90byBzdXBwb3J0IGh0dHAucmVxdWVzdFxuICAgIGlmIChyZXN1bHQuc2VhcmNoKSB7XG4gICAgICByZXN1bHQucGF0aCA9ICcvJyArIHJlc3VsdC5zZWFyY2g7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJlc3VsdC5wYXRoID0gbnVsbDtcbiAgICB9XG4gICAgcmVzdWx0LmhyZWYgPSByZXN1bHQuZm9ybWF0KCk7XG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuXG4gIC8vIGlmIGEgdXJsIEVORHMgaW4gLiBvciAuLiwgdGhlbiBpdCBtdXN0IGdldCBhIHRyYWlsaW5nIHNsYXNoLlxuICAvLyBob3dldmVyLCBpZiBpdCBlbmRzIGluIGFueXRoaW5nIGVsc2Ugbm9uLXNsYXNoeSxcbiAgLy8gdGhlbiBpdCBtdXN0IE5PVCBnZXQgYSB0cmFpbGluZyBzbGFzaC5cbiAgdmFyIGxhc3QgPSBzcmNQYXRoLnNsaWNlKC0xKVswXTtcbiAgdmFyIGhhc1RyYWlsaW5nU2xhc2ggPSAoXG4gICAgICAocmVzdWx0Lmhvc3QgfHwgcmVsYXRpdmUuaG9zdCkgJiYgKGxhc3QgPT09ICcuJyB8fCBsYXN0ID09PSAnLi4nKSB8fFxuICAgICAgbGFzdCA9PT0gJycpO1xuXG4gIC8vIHN0cmlwIHNpbmdsZSBkb3RzLCByZXNvbHZlIGRvdWJsZSBkb3RzIHRvIHBhcmVudCBkaXJcbiAgLy8gaWYgdGhlIHBhdGggdHJpZXMgdG8gZ28gYWJvdmUgdGhlIHJvb3QsIGB1cGAgZW5kcyB1cCA+IDBcbiAgdmFyIHVwID0gMDtcbiAgZm9yICh2YXIgaSA9IHNyY1BhdGgubGVuZ3RoOyBpID49IDA7IGktLSkge1xuICAgIGxhc3QgPSBzcmNQYXRoW2ldO1xuICAgIGlmIChsYXN0ID09ICcuJykge1xuICAgICAgc3JjUGF0aC5zcGxpY2UoaSwgMSk7XG4gICAgfSBlbHNlIGlmIChsYXN0ID09PSAnLi4nKSB7XG4gICAgICBzcmNQYXRoLnNwbGljZShpLCAxKTtcbiAgICAgIHVwKys7XG4gICAgfSBlbHNlIGlmICh1cCkge1xuICAgICAgc3JjUGF0aC5zcGxpY2UoaSwgMSk7XG4gICAgICB1cC0tO1xuICAgIH1cbiAgfVxuXG4gIC8vIGlmIHRoZSBwYXRoIGlzIGFsbG93ZWQgdG8gZ28gYWJvdmUgdGhlIHJvb3QsIHJlc3RvcmUgbGVhZGluZyAuLnNcbiAgaWYgKCFtdXN0RW5kQWJzICYmICFyZW1vdmVBbGxEb3RzKSB7XG4gICAgZm9yICg7IHVwLS07IHVwKSB7XG4gICAgICBzcmNQYXRoLnVuc2hpZnQoJy4uJyk7XG4gICAgfVxuICB9XG5cbiAgaWYgKG11c3RFbmRBYnMgJiYgc3JjUGF0aFswXSAhPT0gJycgJiZcbiAgICAgICghc3JjUGF0aFswXSB8fCBzcmNQYXRoWzBdLmNoYXJBdCgwKSAhPT0gJy8nKSkge1xuICAgIHNyY1BhdGgudW5zaGlmdCgnJyk7XG4gIH1cblxuICBpZiAoaGFzVHJhaWxpbmdTbGFzaCAmJiAoc3JjUGF0aC5qb2luKCcvJykuc3Vic3RyKC0xKSAhPT0gJy8nKSkge1xuICAgIHNyY1BhdGgucHVzaCgnJyk7XG4gIH1cblxuICB2YXIgaXNBYnNvbHV0ZSA9IHNyY1BhdGhbMF0gPT09ICcnIHx8XG4gICAgICAoc3JjUGF0aFswXSAmJiBzcmNQYXRoWzBdLmNoYXJBdCgwKSA9PT0gJy8nKTtcblxuICAvLyBwdXQgdGhlIGhvc3QgYmFja1xuICBpZiAocHN5Y2hvdGljKSB7XG4gICAgcmVzdWx0Lmhvc3RuYW1lID0gcmVzdWx0Lmhvc3QgPSBpc0Fic29sdXRlID8gJycgOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc3JjUGF0aC5sZW5ndGggPyBzcmNQYXRoLnNoaWZ0KCkgOiAnJztcbiAgICAvL29jY2F0aW9uYWx5IHRoZSBhdXRoIGNhbiBnZXQgc3R1Y2sgb25seSBpbiBob3N0XG4gICAgLy90aGlzIGVzcGVjaWFseSBoYXBwZW5zIGluIGNhc2VzIGxpa2VcbiAgICAvL3VybC5yZXNvbHZlT2JqZWN0KCdtYWlsdG86bG9jYWwxQGRvbWFpbjEnLCAnbG9jYWwyQGRvbWFpbjInKVxuICAgIHZhciBhdXRoSW5Ib3N0ID0gcmVzdWx0Lmhvc3QgJiYgcmVzdWx0Lmhvc3QuaW5kZXhPZignQCcpID4gMCA/XG4gICAgICAgICAgICAgICAgICAgICByZXN1bHQuaG9zdC5zcGxpdCgnQCcpIDogZmFsc2U7XG4gICAgaWYgKGF1dGhJbkhvc3QpIHtcbiAgICAgIHJlc3VsdC5hdXRoID0gYXV0aEluSG9zdC5zaGlmdCgpO1xuICAgICAgcmVzdWx0Lmhvc3QgPSByZXN1bHQuaG9zdG5hbWUgPSBhdXRoSW5Ib3N0LnNoaWZ0KCk7XG4gICAgfVxuICB9XG5cbiAgbXVzdEVuZEFicyA9IG11c3RFbmRBYnMgfHwgKHJlc3VsdC5ob3N0ICYmIHNyY1BhdGgubGVuZ3RoKTtcblxuICBpZiAobXVzdEVuZEFicyAmJiAhaXNBYnNvbHV0ZSkge1xuICAgIHNyY1BhdGgudW5zaGlmdCgnJyk7XG4gIH1cblxuICBpZiAoIXNyY1BhdGgubGVuZ3RoKSB7XG4gICAgcmVzdWx0LnBhdGhuYW1lID0gbnVsbDtcbiAgICByZXN1bHQucGF0aCA9IG51bGw7XG4gIH0gZWxzZSB7XG4gICAgcmVzdWx0LnBhdGhuYW1lID0gc3JjUGF0aC5qb2luKCcvJyk7XG4gIH1cblxuICAvL3RvIHN1cHBvcnQgcmVxdWVzdC5odHRwXG4gIGlmICghaXNOdWxsKHJlc3VsdC5wYXRobmFtZSkgfHwgIWlzTnVsbChyZXN1bHQuc2VhcmNoKSkge1xuICAgIHJlc3VsdC5wYXRoID0gKHJlc3VsdC5wYXRobmFtZSA/IHJlc3VsdC5wYXRobmFtZSA6ICcnKSArXG4gICAgICAgICAgICAgICAgICAocmVzdWx0LnNlYXJjaCA/IHJlc3VsdC5zZWFyY2ggOiAnJyk7XG4gIH1cbiAgcmVzdWx0LmF1dGggPSByZWxhdGl2ZS5hdXRoIHx8IHJlc3VsdC5hdXRoO1xuICByZXN1bHQuc2xhc2hlcyA9IHJlc3VsdC5zbGFzaGVzIHx8IHJlbGF0aXZlLnNsYXNoZXM7XG4gIHJlc3VsdC5ocmVmID0gcmVzdWx0LmZvcm1hdCgpO1xuICByZXR1cm4gcmVzdWx0O1xufTtcblxuVXJsLnByb3RvdHlwZS5wYXJzZUhvc3QgPSBmdW5jdGlvbigpIHtcbiAgdmFyIGhvc3QgPSB0aGlzLmhvc3Q7XG4gIHZhciBwb3J0ID0gcG9ydFBhdHRlcm4uZXhlYyhob3N0KTtcbiAgaWYgKHBvcnQpIHtcbiAgICBwb3J0ID0gcG9ydFswXTtcbiAgICBpZiAocG9ydCAhPT0gJzonKSB7XG4gICAgICB0aGlzLnBvcnQgPSBwb3J0LnN1YnN0cigxKTtcbiAgICB9XG4gICAgaG9zdCA9IGhvc3Quc3Vic3RyKDAsIGhvc3QubGVuZ3RoIC0gcG9ydC5sZW5ndGgpO1xuICB9XG4gIGlmIChob3N0KSB0aGlzLmhvc3RuYW1lID0gaG9zdDtcbn07XG5cbmZ1bmN0aW9uIGlzU3RyaW5nKGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gXCJzdHJpbmdcIjtcbn1cblxuZnVuY3Rpb24gaXNPYmplY3QoYXJnKSB7XG4gIHJldHVybiB0eXBlb2YgYXJnID09PSAnb2JqZWN0JyAmJiBhcmcgIT09IG51bGw7XG59XG5cbmZ1bmN0aW9uIGlzTnVsbChhcmcpIHtcbiAgcmV0dXJuIGFyZyA9PT0gbnVsbDtcbn1cbmZ1bmN0aW9uIGlzTnVsbE9yVW5kZWZpbmVkKGFyZykge1xuICByZXR1cm4gIGFyZyA9PSBudWxsO1xufVxuIiwiLyohXG5Db3B5cmlnaHQgMjAxMyBIZXdsZXR0LVBhY2thcmQgRGV2ZWxvcG1lbnQgQ29tcGFueSwgTC5QLlxuXG5MaWNlbnNlZCB1bmRlciB0aGUgQXBhY2hlIExpY2Vuc2UsIFZlcnNpb24gMi4wICh0aGUgXCJMaWNlbnNlXCIpO1xueW91IG1heSBub3QgdXNlIHRoaXMgZmlsZSBleGNlcHQgaW4gY29tcGxpYW5jZSB3aXRoIHRoZSBMaWNlbnNlLlxuWW91IG1heSBvYnRhaW4gYSBjb3B5IG9mIHRoZSBMaWNlbnNlIGF0XG5cbiAgICAgICBodHRwOi8vd3d3LmFwYWNoZS5vcmcvbGljZW5zZXMvTElDRU5TRS0yLjBcblxuVW5sZXNzIHJlcXVpcmVkIGJ5IGFwcGxpY2FibGUgbGF3IG9yIGFncmVlZCB0byBpbiB3cml0aW5nLCBzb2Z0d2FyZVxuZGlzdHJpYnV0ZWQgdW5kZXIgdGhlIExpY2Vuc2UgaXMgZGlzdHJpYnV0ZWQgb24gYW4gXCJBUyBJU1wiIEJBU0lTLFxuV0lUSE9VVCBXQVJSQU5USUVTIE9SIENPTkRJVElPTlMgT0YgQU5ZIEtJTkQsIGVpdGhlciBleHByZXNzIG9yIGltcGxpZWQuXG5TZWUgdGhlIExpY2Vuc2UgZm9yIHRoZSBzcGVjaWZpYyBsYW5ndWFnZSBnb3Zlcm5pbmcgcGVybWlzc2lvbnMgYW5kXG5saW1pdGF0aW9ucyB1bmRlciB0aGUgTGljZW5zZS5cbiovXG5cInVzZSBzdHJpY3RcIjtcbm1vZHVsZS5leHBvcnRzID0gcmVxdWlyZSgnLi9saWIvbWFpbicpO1xuIiwiLyohXG5Db3B5cmlnaHQgMjAxMyBIZXdsZXR0LVBhY2thcmQgRGV2ZWxvcG1lbnQgQ29tcGFueSwgTC5QLlxuXG5MaWNlbnNlZCB1bmRlciB0aGUgQXBhY2hlIExpY2Vuc2UsIFZlcnNpb24gMi4wICh0aGUgXCJMaWNlbnNlXCIpO1xueW91IG1heSBub3QgdXNlIHRoaXMgZmlsZSBleGNlcHQgaW4gY29tcGxpYW5jZSB3aXRoIHRoZSBMaWNlbnNlLlxuWW91IG1heSBvYnRhaW4gYSBjb3B5IG9mIHRoZSBMaWNlbnNlIGF0XG5cbiAgICAgICBodHRwOi8vd3d3LmFwYWNoZS5vcmcvbGljZW5zZXMvTElDRU5TRS0yLjBcblxuVW5sZXNzIHJlcXVpcmVkIGJ5IGFwcGxpY2FibGUgbGF3IG9yIGFncmVlZCB0byBpbiB3cml0aW5nLCBzb2Z0d2FyZVxuZGlzdHJpYnV0ZWQgdW5kZXIgdGhlIExpY2Vuc2UgaXMgZGlzdHJpYnV0ZWQgb24gYW4gXCJBUyBJU1wiIEJBU0lTLFxuV0lUSE9VVCBXQVJSQU5USUVTIE9SIENPTkRJVElPTlMgT0YgQU5ZIEtJTkQsIGVpdGhlciBleHByZXNzIG9yIGltcGxpZWQuXG5TZWUgdGhlIExpY2Vuc2UgZm9yIHRoZSBzcGVjaWZpYyBsYW5ndWFnZSBnb3Zlcm5pbmcgcGVybWlzc2lvbnMgYW5kXG5saW1pdGF0aW9ucyB1bmRlciB0aGUgTGljZW5zZS5cbiovXG5cbi8qKlxuICogRnVuY3Rpb25zIHRvIGdlbmVyYXRlIG1lc3NhZ2VzIHdpdGggSlNPTi1SUEMgMi4wIGZvcm1hdC5cbiAqXG4gKiBDQUYgdXNlcyBhIHN1YnNldCBvZiB0aGlzIHNwZWMgYW5kLCBmb3IgZXhhbXBsZSwgUlBDIGFyZ3VtZW50cyBhcmVcbiAqIG5ldmVyIHBhc3NlZCBieSBuYW1lLCB1c2luZyBpbnN0ZWFkIGFuIGFycmF5LlxuICpcbiAqIENBRiBhbHdheXMgYWRkcyBhbiBpbXBsaWNpdCBmaXJzdCBhcmd1bWVudCB0b1xuICogcmVxdWVzdHMvbm90aWZpY2F0aW9ucyBjb250YWluaW5nIG1ldGEtZGF0YSwgZm9yIGluc3RhbmNlOlxuICpcbiAqICAgICAgICB7XG4gKiAgICAgICAgICAgXCJ0b2tlblwiOiBzdHJpbmcsIC8vIHNlY3VyaXR5IHRva2VuIGZvciBhdXRoZW50aWNhdGlvblxuICogICAgICAgICAgIFwic2Vzc2lvbklkXCI6IHN0cmluZywvLyBsb2dpY2FsIHNlc3Npb24gbmFtZVxuICogICAgICAgICAgIFwidG9cIjogc3RyaW5nLCAvLyB0YXJnZXQgQ0FcbiAqICAgICAgICAgICBcImZyb21cIjogc3RyaW5nIC8vIHNvdXJjZSBDQVxuICogICAgICAgIH1cbiAqXG4gKiBXZSBhbHNvIGFkZCB0aGUgc2FtZSBtZXRhLWRhdGEgdG8gcmVwbGllcyBidXQgaW4gdGhpcyBjYXNlIHRoZSBqc29uLXJwYyByZXBseVxuICogbWVzc2FnZSBmb3JtYXQgY29tcGxpY2F0ZXMgdGhpbmdzOlxuICpcbiAqICAtICpBcHBsaWNhdGlvbi1sZXZlbCBlcnJvcnMqIHVzZSBhIHNpbWlsYXIgYXBwcm9hY2ggdG8gbm9kZS5qc1xuICogY2FsbGJhY2tzLiBXZSB1c2UgYW4gYXJyYXkgd2l0aCAzIGFyZ3VtZW50cyBbbWV0YSwgZXJyb3IsIGRhdGFdIHdpdGggdGhlXG4gKiBzZWNvbmQgb25lIHVzaW5nIGEgZmFsc3kgaWYgZXZlcnl0aGluZyB3ZW50IGZpbmUuIFRoaXMgbWVhbnMgdGhhdFxuICogd2UgKk5FVkVSKiB1c2UgdGhlIEpTT04tUlBDIGVycm9yIHJlc3BvbnNlIG9iamVjdCBmb3IgcHJvcGFnYXRpbmdcbiAqIGFwcGxpY2F0aW9uIGVycm9ycy5cbiAqXG4gKiAgLSAqU3lzdGVtLWxldmVsIGVycm9ycyogKGUuZy4sIG5vbi1wYXJzYWJsZSBKU09OIG9yIG1pc3NpbmcgdGFyZ2V0XG4gKiBDQSkgZG8gdXNlIHRoZSBlcnJvciByZXNwb25zZSBvYmplY3QgdXNpbmcgZXhwb3J0cy5FUlJPUl9DT0RFUy4gSW4gdGhhdFxuICogY2FzZSB3ZSB1c2UgYSB0dXBsZSAoaS5lLiwgYXJyYXkpIGluIHRoZSBkYXRhIGZpZWxkIHRvIGFkZCB0aGUgbWV0YS1kYXRhLFxuICogaS5lLiwgeyBcImVycm9yXCI6IHtcImRhdGFcIjogW21ldGEsIGV4dHJhRGF0YV19fS5cbiAqXG4gKiBVc2UgcHJvdmlkZWQgZ2V0dGVycyBhbmQgc2V0dGVycyB0byBoaWRlIHRoaXMgY29tcGxleGl0eS5cbiAqXG4gKlxuICogQG1vZHVsZSBqc29uX3JwY1xuICovXG4oZnVuY3Rpb24gKCkge1xuICAgICBcInVzZSBzdHJpY3RcIjtcblxuICAgICB2YXIganNvbl9ycGMgPSB7fTtcblxuICAgICB2YXIgcm9vdCwgcHJldmlvdXNfanNvbl9ycGM7XG4gICAgIHJvb3QgPSB0aGlzIHx8ICgwLCBldmFsKSgndGhpcycpOy8vIGdsb2JhbCBvYmplY3QgaW4gc3RyaWN0IG1vZGVcblxuICAgICBpZiAocm9vdCAhPT0gbnVsbCkge1xuICAgICAgICAgcHJldmlvdXNfanNvbl9ycGMgPSByb290Lmpzb25fcnBjO1xuICAgICB9XG5cbiAgICAganNvbl9ycGMubm9Db25mbGljdCA9IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgIHJvb3QuanNvbl9ycGMgPSBwcmV2aW91c19qc29uX3JwYztcbiAgICAgICAgIHJldHVybiBqc29uX3JwYztcbiAgICAgfTtcblxuICAgICB2YXIgTkFNRV9TRVBBUkFUT1IgPSBqc29uX3JwYy5OQU1FX1NFUEFSQVRPUiA9ICctJztcblxuICAgICAvKiogRW51bSB3aXRoIGVycm9yIGNvZGVzLiAqL1xuICAgICB2YXIgRVJST1JfQ09ERVMgPSBqc29uX3JwYy5FUlJPUl9DT0RFUyA9IHtcbiAgICAgICAgIHBhcnNlRXJyb3I6IC0zMjcwMCxcbiAgICAgICAgIGludmFsaWRSZXF1ZXN0OiAtMzI2MDAsXG4gICAgICAgICBtZXRob2ROb3RGb3VuZDogLTMyNjAxLFxuICAgICAgICAgaW52YWxpZFBhcmFtczogLTMyNjAyLFxuICAgICAgICAgaW50ZXJuYWxFcnJvcjogLTMyNjAzLFxuICAgICAgICAgLy8tMzIwMDAgdG8gLTMyMDk5IGZvciBpbXBsZW1lbnRhdGlvbi1kZWZpbmVkIHNlcnZlci1lcnJvcnNcbiAgICAgICAgIG5vU3VjaENBOiAtMzIwMDAsXG4gICAgICAgICBzaHV0ZG93bkNBOiAtMzIwMDEsXG4gICAgICAgICBjaGVja3BvaW50RmFpbHVyZTogLTMyMDAyLFxuICAgICAgICAgcHJlcGFyZUZhaWx1cmU6IC0zMjAwMyxcbiAgICAgICAgIGV4Y2VwdGlvblRocm93bjogLTMyMDA0LFxuICAgICAgICAgY29tbWl0RmFpbHVyZTogLTMyMDA1LFxuICAgICAgICAgZm9yY2VSZWRpcmVjdDogLTMyMDA2LFxuICAgICAgICAgbm90QXV0aG9yaXplZDogLTMyMDA3LFxuICAgICAgICAgYmVnaW5GYWlsdXJlOiAtMzIwMDgsXG4gICAgICAgICBub3RBdXRoZW50aWNhdGVkOiAtMzIwMDlcbiAgICAgfTtcblxuXG4gICAgIC8qKiBEZWZhdWx0IElEIGluIHJlcXVlc3RzIHRoYXQgY29tZSBmcm9tIGVudGl0aWVzIHRoYXQgaGF2ZSBubyBwcm9wZXJcbiAgICAgIGlkICovXG4gICAgIHZhciBERUZBVUxUX0ZST01fSUQgPSBqc29uX3JwYy5ERUZBVUxUX0ZST01fSUQgPSAnVU5LTk9XTic7XG4gICAgIC8qKiBEZWZhdWx0IHVzZXJuYW1lIHdoZW4gdXNlciBpcyB1bmtub3duLiovXG4gICAgIHZhciBERUZBVUxUX0ZST01fVVNFUk5BTUUgPSBqc29uX3JwYy5ERUZBVUxUX0ZST01fVVNFUk5BTUUgPVxuICAgICAgICAganNvbl9ycGMuTk9CT0RZID0gJ05PQk9EWSc7XG4gICAgIC8qKiBEZWZhdWx0IHNvdXJjZSBvZiBhbiBleHRlcm5hbCByZXF1ZXN0LiAqL1xuICAgICB2YXIgREVGQVVMVF9GUk9NID0ganNvbl9ycGMuREVGQVVMVF9GUk9NID0gIERFRkFVTFRfRlJPTV9VU0VSTkFNRSArICctJyArXG4gICAgICAgICBERUZBVUxUX0ZST01fSUQ7XG4gICAgIC8qKiBEZWZhdWx0IGV4dGVybmFsIHNlc3Npb24uKi9cbiAgICAgdmFyIERFRkFVTFRfU0VTU0lPTiA9ICBqc29uX3JwYy5ERUZBVUxUX1NFU1NJT04gPSAnZGVmYXVsdCc7XG5cbiAgICAgLyoqIERlZmF1bHQgaWQgZm9yIGEgcmVzcG9uc2UgdG8gYW4gaW52YWxpZCByZXF1ZXN0IHdpdGggbm8gaWQuKi9cbiAgICAgdmFyIERFRkFVTFRfUkVRVUVTVF9JRCA9IGpzb25fcnBjLkRFRkFVTFRfUkVRVUVTVF9JRCA9IDQyO1xuXG4gICAgIC8qKiBEZWZhdWx0IHRva2VuIHdpdGggbm8gYXV0aGVudGljYXRpb24uICovXG4gICAgIHZhciBEVU1NWV9UT0tFTiA9IGpzb25fcnBjLkRVTU1ZX1RPS0VOID0gJ0lOVkFMSUQnO1xuXG4gICAgIC8qKiBTZXNzaW9uIGlkIGZvciBpbnRlcm5hbCBzZXNzaW9ucy4gV2UgdXNlIHRoZSBERUZBVUxUX1NFU1NJT04uKi9cbiAgICAganNvbl9ycGMuU1lTVEVNX1NFU1NJT05fSUQgPSBERUZBVUxUX1NFU1NJT047XG4gICAgIC8qKiBSZXNlcnZlZCBmcm9tIGlkIGZvciBpbnRlcm5hbCwgbG9jYWwgc2Vzc2lvbnMuKi9cbiAgICAgdmFyIFNZU1RFTV9GUk9NX0lEID0ganNvbl9ycGMuU1lTVEVNX0ZST01fSUQgPSAnc3lzMSc7XG4gICAgIC8qKiBSZXNlcnZlZCB1c2VybmFtZSBmb3IgaW50ZXJuYWwsIGxvY2FsIHNlc3Npb25zLiovXG4gICAgIHZhciBTWVNURU1fVVNFUk5BTUUgPSBqc29uX3JwYy5TWVNURU1fVVNFUk5BTUUgPSAnIVNZU1RFTSc7XG4gICAgIC8qKiBSZXNlcnZlZCB1c2VybmFtZV9mcm9taWQgZm9yIGludGVybmFsLCBsb2NhbCBzZXNzaW9ucy4qL1xuICAgICB2YXIgU1lTVEVNX0ZST00gPSBqc29uX3JwYy5TWVNURU1fRlJPTSA9XG4gICAgICAgICBTWVNURU1fVVNFUk5BTUUgKyAnLScgKyBTWVNURU1fRlJPTV9JRDtcblxuICAgICAvKiogUmVzZXJ2ZWQgdG9rZW4gIGZvciBpbnRlcm5hbCwgbG9jYWwgc2Vzc2lvbnMuKi9cbiAgICAganNvbl9ycGMuU1lTVEVNX1RPS0VOID0gRFVNTVlfVE9LRU47XG5cbiAgICAgLyoqIEdlbmVyYXRlIGEgcmFuZG9tIHN0cmluZy5cbiAgICAgICpcbiAgICAgICogQHJldHVybiB7c3RyaW5nfVxuICAgICAgKiBAZnVuY3Rpb25cbiAgICAgICovXG4gICAgIHZhciByYW5kb21JZCA9IGpzb25fcnBjLnJhbmRvbUlkID0gZnVuY3Rpb24oKSB7XG4gICAgICAgICB2YXIgdW5pcXVlID0gTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogMTAwMDAwMDAwMDAwMDAwMDApO1xuICAgICAgICAgdmFyIHJlc3VsdCA9ICcnICsgKG5ldyBEYXRlKCkpLmdldFRpbWUoKSArIHVuaXF1ZTtcbiAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgIH07XG5cbiAgICAgLyoqIFRlc3RzIGlmIGl0IGlzIGEgbm90aWZpY2F0aW9uIG1lc3NhZ2UuXG4gICAgICAqXG4gICAgICAqIEBwYXJhbSB7Y2FmLm1zZ30gbXNnXG4gICAgICAqIEByZXR1cm4ge2Jvb2xlYW59XG4gICAgICAqXG4gICAgICAqIEBmdW5jdGlvblxuICAgICAgKi9cbiAgICAgdmFyIGlzTm90aWZpY2F0aW9uID0ganNvbl9ycGMuaXNOb3RpZmljYXRpb24gPSBmdW5jdGlvbihtc2cpIHtcbiAgICAgICAgIHJldHVybiAobXNnICYmIChtc2cuanNvbnJwYyA9PT0gJzIuMCcpICYmXG4gICAgICAgICAgICAgICAgIChtc2cubWV0aG9kKSAmJlxuICAgICAgICAgICAgICAgICAobXNnLnBhcmFtcyAmJiBtc2cucGFyYW1zLmxlbmd0aCA+IDApICYmXG4gICAgICAgICAgICAgICAgICghbXNnLmlkKSk7XG4gICAgIH07XG5cbiAgICAgLyoqIENyZWF0ZXMgbm90aWZpY2F0aW9uIG1lc3NhZ2UuXG4gICAgICAqXG4gICAgICAqIEBwYXJhbSB7c3RyaW5nfSB0b1xuICAgICAgKiBAcGFyYW0ge3N0cmluZ30gZnJvbVxuICAgICAgKiBAcGFyYW0ge3N0cmluZ30gc2Vzc2lvbklkXG4gICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtZXRob2ROYW1lXG4gICAgICAqIEBwYXJhbSB7YW55Li4ufSB2YXJfYXJnc1xuICAgICAgKiBAcmV0dXJuIHtjYWYubXNnfVxuICAgICAgKlxuICAgICAgKiBAZnVuY3Rpb25cbiAgICAgICovXG4gICAgIHZhciBub3RpZmljYXRpb24gPSBqc29uX3JwYy5ub3RpZmljYXRpb24gPSBmdW5jdGlvbih0bywgZnJvbSwgc2Vzc2lvbklkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbWV0aG9kTmFtZSwgdmFyX2FyZ3MpIHtcbiAgICAgICAgIHZhciBhcmdzQXJyYXkgPSBBcnJheS5wcm90b3R5cGUuc2xpY2UuY2FsbChhcmd1bWVudHMpO1xuICAgICAgICAgYXJnc0FycmF5LnNwbGljZSgwLCA0KTtcbiAgICAgICAgIHZhciBmaXJzdEFyZyA9IHsnc2Vzc2lvbklkJyA6IHNlc3Npb25JZCwgJ3RvJyA6IHRvLCAnZnJvbScgOiBmcm9tfTtcbiAgICAgICAgIGFyZ3NBcnJheS51bnNoaWZ0KGZpcnN0QXJnKTtcbiAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgJ2pzb25ycGMnOiAnMi4wJyxcbiAgICAgICAgICAgICAnbWV0aG9kJyA6IG1ldGhvZE5hbWUsXG4gICAgICAgICAgICAgJ3BhcmFtcycgOiBhcmdzQXJyYXlcbiAgICAgICAgIH07XG4gICAgIH07XG5cbiAgICAgLyoqIFRlc3RzIGlmIGl0IGlzIGEgcmVxdWVzdCBtZXNzYWdlLlxuICAgICAgKlxuICAgICAgKiBAcGFyYW0ge2NhZi5tc2d9IG1zZ1xuICAgICAgKiBAcmV0dXJuIHtib29sZWFufVxuICAgICAgKlxuICAgICAgKiBAZnVuY3Rpb25cbiAgICAgICovXG4gICAgIHZhciBpc1JlcXVlc3QgPSBqc29uX3JwYy5pc1JlcXVlc3QgPSBmdW5jdGlvbihtc2cpIHtcbiAgICAgICAgIHJldHVybiAobXNnICYmIChtc2cuanNvbnJwYyA9PT0gJzIuMCcpICYmXG4gICAgICAgICAgICAgICAgIChtc2cubWV0aG9kKSAmJlxuICAgICAgICAgICAgICAgICAobXNnLnBhcmFtcyAmJiBtc2cucGFyYW1zLmxlbmd0aCA+IDApICYmXG4gICAgICAgICAgICAgICAgIChtc2cuaWQpKTtcbiAgICAgfTtcblxuICAgICAvKiogQ3JlYXRlcyBhIHJlcXVlc3QgbWVzc2FnZS5cbiAgICAgICpcbiAgICAgICogQHBhcmFtIHtzdHJpbmd9IHRva2VuXG4gICAgICAqIEBwYXJhbSB7c3RyaW5nfSB0b1xuICAgICAgKiBAcGFyYW0ge3N0cmluZ30gZnJvbVxuICAgICAgKiBAcGFyYW0ge3N0cmluZ30gc2Vzc2lvbklkXG4gICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtZXRob2ROYW1lXG4gICAgICAqIEBwYXJhbSB7YW55Li4ufSB2YXJfYXJnc1xuICAgICAgKiBAcmV0dXJuIHtjYWYubXNnfVxuICAgICAgKlxuICAgICAgKiBAZnVuY3Rpb25cbiAgICAgICovXG4gICAgIHZhciByZXF1ZXN0ID0ganNvbl9ycGMucmVxdWVzdCA9IGZ1bmN0aW9uKHRva2VuLCB0bywgZnJvbSwgc2Vzc2lvbklkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBtZXRob2ROYW1lLCB2YXJfYXJncykge1xuICAgICAgICAgdmFyIGFyZ3NBcnJheSA9IEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGFyZ3VtZW50cyk7XG4gICAgICAgICBhcmdzQXJyYXkuc2hpZnQoKTsgLy8gZ2V0IHJpZCBvZiB0b2tlblxuICAgICAgICAgdmFyIHJlc3VsdCA9IG5vdGlmaWNhdGlvbi5hcHBseShub3RpZmljYXRpb24sIGFyZ3NBcnJheSk7XG4gICAgICAgICByZXN1bHQuaWQgPSByYW5kb21JZCgpO1xuICAgICAgICAgc2V0VG9rZW4ocmVzdWx0LCB0b2tlbik7XG4gICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICB9O1xuXG5cbiAgICAgLyoqIENyZWF0ZXMgYSBzeXN0ZW0gcmVxdWVzdCBtZXNzYWdlLlxuICAgICAgKlxuICAgICAgKiBAcGFyYW0ge3N0cmluZ30gdG9cbiAgICAgICogQHBhcmFtIHtzdHJpbmd9IG1ldGhvZE5hbWVcbiAgICAgICogQHBhcmFtIHthbnkuLi59IHZhcl9hcmdzXG4gICAgICAqIEByZXR1cm4ge2NhZi5tc2d9XG4gICAgICAqXG4gICAgICAqIEBmdW5jdGlvblxuICAgICAgKi9cbiAgICAganNvbl9ycGMuc3lzdGVtUmVxdWVzdCA9IGZ1bmN0aW9uKHRvLCBtZXRob2ROYW1lLCB2YXJfYXJncykge1xuICAgICAgICAgdmFyIGFyZ3NBcnJheSA9IEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGFyZ3VtZW50cyk7XG4gICAgICAgICB2YXIgdmFyQXJnc0FycmF5ID0gYXJnc0FycmF5LnNsaWNlKDIpO1xuICAgICAgICAgdmFyIGFyZ3MgPSBbanNvbl9ycGMuU1lTVEVNX1RPS0VOLCB0bywganNvbl9ycGMuU1lTVEVNX0ZST00sXG4gICAgICAgICAgICAgICAgICAgICBqc29uX3JwYy5TWVNURU1fU0VTU0lPTl9JRCwgbWV0aG9kTmFtZV1cbiAgICAgICAgICAgICAuY29uY2F0KHZhckFyZ3NBcnJheSk7XG4gICAgICAgICByZXR1cm4gcmVxdWVzdC5hcHBseShyZXF1ZXN0LCBhcmdzKTtcbiAgICAgfTtcblxuICAgICAvKiogVGVzdHMgaWYgaXQgaXMgYW4gYXBwbGljYXRpb24gcmVwbHkgbWVzc2FnZS5cbiAgICAgICpcbiAgICAgICogQHBhcmFtIHtjYWYubXNnfSBtc2dcbiAgICAgICogQHJldHVybiB7Ym9vbGVhbn1cbiAgICAgICpcbiAgICAgICogQGZ1bmN0aW9uXG4gICAgICAqL1xuICAgICB2YXIgaXNBcHBSZXBseSA9IGpzb25fcnBjLmlzQXBwUmVwbHkgPSBmdW5jdGlvbihtc2cpIHtcbiAgICAgICAgIHJldHVybiAobXNnICYmIChtc2cuanNvbnJwYyA9PT0gJzIuMCcpICYmXG4gICAgICAgICAgICAgICAgIChtc2cucmVzdWx0ICYmIChtc2cucmVzdWx0Lmxlbmd0aCA9PT0gMykpICYmXG4gICAgICAgICAgICAgICAgIChtc2cuaWQpKTtcbiAgICAgfTtcblxuICAgICB2YXIgbmV3UmVwbHlNZXRhID0gZnVuY3Rpb24ocmVxdWVzdCkge1xuICAgICAgICAgdmFyIHJlc3VsdCA7XG4gICAgICAgICB0cnkge1xuICAgICAgICAgICAgIHJlc3VsdCA9IHtcbiAgICAgICAgICAgICAgICAgJ3Rva2VuJyA6IGdldFRva2VuKHJlcXVlc3QpLFxuICAgICAgICAgICAgICAgICAnc2Vzc2lvbklkJyA6IGdldFNlc3Npb25JZChyZXF1ZXN0KSxcbiAgICAgICAgICAgICAgICAgJ3RvJyA6IGdldEZyb20ocmVxdWVzdCksXG4gICAgICAgICAgICAgICAgICdmcm9tJyA6IGdldFRvKHJlcXVlc3QpXG4gICAgICAgICAgICAgfTtcbiAgICAgICAgIH0gY2F0Y2goZXJyKSB7XG4gICAgICAgICAgICAgLy8gYmFkIHJlcXVlc3QgbWVzc2FnZSBkaWQgbm90IGhhdmUgbWV0YSBzZWN0aW9uXG4gICAgICAgICAgICAgcmVzdWx0ID0ge1xuICAgICAgICAgICAgICAgICAndG9rZW4nIDogRFVNTVlfVE9LRU4sXG4gICAgICAgICAgICAgICAgICdzZXNzaW9uSWQnIDogIERFRkFVTFRfU0VTU0lPTixcbiAgICAgICAgICAgICAgICAgJ3RvJyA6IERFRkFVTFRfRlJPTSxcbiAgICAgICAgICAgICAgICAgJ2Zyb20nIDogU1lTVEVNX0ZST01cbiAgICAgICAgICAgICB9O1xuICAgICAgICAgfVxuICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgfTtcblxuICAgICAvKipcbiAgICAgICogQ3JlYXRlcyBhbiBhcHBsaWNhdGlvbiByZXBseSBtZXNzYWdlLlxuICAgICAgKlxuICAgICAgKiBAcGFyYW0ge2NhZi5tc2d9IHJlcXVlc3RcbiAgICAgICogQHBhcmFtIHtjYWYuanNvbj19IGVycm9yXG4gICAgICAqIEBwYXJhbSB7Y2FmLmpzb259IHZhbHVlXG4gICAgICAqIEByZXR1cm4ge2NhZi5tc2d9XG4gICAgICAqXG4gICAgICAqIEBmdW5jdGlvblxuICAgICAgKlxuICAgICAgKi9cbiAgICAgdmFyIGFwcFJlcGx5ID0gZnVuY3Rpb24ocmVxdWVzdCwgZXJyb3IsIHZhbHVlKSB7XG4gICAgICAgICBlcnJvciA9IHRvRXJyb3JPYmplY3QoZXJyb3IpO1xuICAgICAgICAgaWYgKGVycm9yICYmICh0eXBlb2YgZXJyb3IgPT09ICdvYmplY3QnKSkge1xuICAgICAgICAgICAgIGVycm9yLnJlcXVlc3QgPSByZXF1ZXN0O1xuICAgICAgICAgfVxuICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAnanNvbnJwYyc6ICcyLjAnLFxuICAgICAgICAgICAgICdyZXN1bHQnIDogW25ld1JlcGx5TWV0YShyZXF1ZXN0KSwgZXJyb3IsIHZhbHVlXSxcbiAgICAgICAgICAgICAnaWQnOiByZXF1ZXN0LmlkXG4gICAgICAgICB9O1xuICAgICB9O1xuXG4gICAgIC8qKiBUZXN0cyBpZiBpdCBpcyBhIHN5c3RlbSBlcnJvciBtZXNzYWdlLlxuICAgICAgKlxuICAgICAgKiBAcGFyYW0ge2NhZi5tc2d9IG1zZ1xuICAgICAgKiBAcmV0dXJuIHtib29sZWFufVxuICAgICAgKlxuICAgICAgKiBAZnVuY3Rpb25cbiAgICAgICovXG4gICAgIHZhciBpc1N5c3RlbUVycm9yID0ganNvbl9ycGMuaXNTeXN0ZW1FcnJvciA9IGZ1bmN0aW9uKG1zZykge1xuICAgICAgICAgcmV0dXJuIChtc2cgJiYgKG1zZy5qc29ucnBjID09PSAnMi4wJykgJiZcbiAgICAgICAgICAgICAgICAgKG1zZy5lcnJvciAmJiBtc2cuZXJyb3IuY29kZSkgJiZcbiAgICAgICAgICAgICAgICAgKG1zZy5lcnJvci5kYXRhKSAmJiAobXNnLmVycm9yLmRhdGEubGVuZ3RoID09PSAyKSAmJlxuICAgICAgICAgICAgICAgICAobXNnLmlkKSk7XG4gICAgIH07XG5cblxuICAgICB2YXIgdG9FcnJvck9iamVjdCA9IGZ1bmN0aW9uKGVycikge1xuICAgICAgICAgaWYgKCFlcnIgfHwgKHR5cGVvZiBlcnIgIT09ICdvYmplY3QnKSkge1xuICAgICAgICAgICAgIHJldHVybiBlcnI7XG4gICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgIHZhciBvYmogPSB7fTtcbiAgICAgICAgICAgICBPYmplY3QuZ2V0T3duUHJvcGVydHlOYW1lcyhlcnIpIC8vIGluY2x1ZGUgc3RhY2tcbiAgICAgICAgICAgICAgICAgLmZvckVhY2goZnVuY3Rpb24oa2V5KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvYmpba2V5XSA9ICBlcnJba2V5XTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgcmV0dXJuIG9iajtcbiAgICAgICAgIH1cbiAgICAgfTtcblxuICAgICAvKiogQ3JlYXRlcyBhIHN5c3RlbSBlcnJvciBtZXNzYWdlLlxuICAgICAgKlxuICAgICAgKiBAcGFyYW0ge2NhZi5tc2d9IHJlcXVlc3RcbiAgICAgICogQHBhcmFtIHtudW1iZXJ9IGNvZGVcbiAgICAgICogQHBhcmFtIHtzdHJpbmd9IGVyck1zZ1xuICAgICAgKiBAcGFyYW0ge0Vycm9yPX0gZXJyIE9wdGlvbmFsIHNvdXJjZSBlcnJvci5cbiAgICAgICogQHJldHVybiB7Y2FmLm1zZ31cbiAgICAgICpcbiAgICAgICogQGZ1bmN0aW9uXG4gICAgICAqL1xuICAgICB2YXIgc3lzdGVtRXJyb3IgID0gZnVuY3Rpb24ocmVxdWVzdCwgY29kZSwgZXJyTXNnLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZXJyKSB7XG4gICAgICAgICBlcnIgPSBlcnIgfHwgbmV3IEVycm9yKGVyck1zZyk7XG4gICAgICAgICBlcnIgPSB0b0Vycm9yT2JqZWN0KGVycik7XG4gICAgICAgICBpZiAodHlwZW9mIGVyciA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgICAgICBlcnIucmVxdWVzdCA9IHJlcXVlc3Q7XG4gICAgICAgICB9XG4gICAgICAgICB2YXIgZXJyb3IgPSB7XG4gICAgICAgICAgICAgJ2NvZGUnIDogY29kZSxcbiAgICAgICAgICAgICAnbWVzc2FnZScgOiBlcnJNc2csXG4gICAgICAgICAgICAgJ2RhdGEnIDogW25ld1JlcGx5TWV0YShyZXF1ZXN0KSwgZXJyXVxuICAgICAgICAgfTtcbiAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgJ2pzb25ycGMnOiAnMi4wJyxcbiAgICAgICAgICAgICAnZXJyb3InIDogZXJyb3IsXG4gICAgICAgICAgICAgJ2lkJzogcmVxdWVzdC5pZCB8fCBERUZBVUxUX1JFUVVFU1RfSURcbiAgICAgICAgIH07XG4gICAgIH07XG5cbiAgICAgLyoqXG4gICAgICAqIFdyYXBzIGFuIEVycm9yIG9iamVjdCBvZiB0eXBlIFN5c3RlbUVycm9yOlxuICAgICAgKlxuICAgICAgKiB7bmFtZTogJ1N5c3RlbUVycm9yJywgbXNnOiBjYWZfbXNnLCBjb2RlOiBudW1iZXIsIGVycm9yU3RyOiBzdHJpbmcsXG4gICAgICAqICBlcnJvcjogRXJyb3J9XG4gICAgICAqXG4gICAgICAqIEByZXR1cm4ge2NhZi5lcnJvcn1cbiAgICAgICpcbiAgICAgICovXG4gICAgIHZhciBuZXdTeXNFcnJvciA9IGpzb25fcnBjLm5ld1N5c0Vycm9yID0gZnVuY3Rpb24obXNnLCBjb2RlLCBlcnJvclN0cixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlcnJvck9yZykge1xuICAgICAgICAgdmFyIGVycm9yID0gbmV3IEVycm9yKGVycm9yU3RyKTtcbiAgICAgICAgIGVycm9yLmVycm9yID0gdG9FcnJvck9iamVjdChlcnJvck9yZyk7XG4gICAgICAgICBlcnJvci5uYW1lID0gJ1N5c3RlbUVycm9yJztcbiAgICAgICAgIGVycm9yLm1zZyA9IG1zZztcbiAgICAgICAgIGVycm9yLmNvZGUgPSBjb2RlO1xuICAgICAgICAgZXJyb3IuZXJyb3JTdHIgPSBlcnJvclN0cjtcbiAgICAgICAgIHJldHVybiBlcnJvcjtcbiAgICAgfTtcblxuICAgICAvKipcbiAgICAgICogV3JhcHMgYW4gRXJyb3Igb2JqZWN0IG9mIHR5cGUgQXBwRXJyb3I6XG4gICAgICAqXG4gICAgICAqIHtuYW1lOiAnQXBwRXJyb3InLCBtc2c6IGNhZl9tc2csICBlcnJvclN0cjogc3RyaW5nLCBlcnJvcjogRXJyb3J9XG4gICAgICAqXG4gICAgICAqICBAcmV0dXJuIHtjYWYuZXJyb3J9XG4gICAgICAqL1xuICAgICB2YXIgbmV3QXBwRXJyb3IgPSBqc29uX3JwYy5uZXdBcHBFcnJvciA9ICBmdW5jdGlvbihtc2csIGVycm9yU3RyLCBlcnJvck9yZykge1xuICAgICAgICAgdmFyIGVycm9yID0gbmV3IEVycm9yKGVycm9yU3RyKTtcbiAgICAgICAgIGVycm9yLmVycm9yID0gdG9FcnJvck9iamVjdChlcnJvck9yZyk7XG4gICAgICAgICBlcnJvci5uYW1lID0gJ0FwcEVycm9yJztcbiAgICAgICAgIGVycm9yLm1zZyA9IG1zZztcbiAgICAgICAgIGVycm9yLmVycm9yU3RyID0gZXJyb3JTdHI7XG4gICAgICAgICByZXR1cm4gZXJyb3I7XG4gICAgIH07XG5cbiAgICAgLyoqIENoZWNrcyBpZiBpdCB0aGVyZSBpcyBhIHJlY292ZXJhYmxlIGVycm9yIGluIG1lc3NhZ2UuXG4gICAgICAqXG4gICAgICAqIEBwYXJhbSB7Y2FmLm1zZ30gbXNnXG4gICAgICAqIEByZXR1cm4ge2Jvb2xlYW59XG4gICAgICAqXG4gICAgICAqIEBmdW5jdGlvblxuICAgICAgKi9cbiAgICAgdmFyIGlzRXJyb3JSZWNvdmVyYWJsZSA9IGpzb25fcnBjLmlzRXJyb3JSZWNvdmVyYWJsZSA9IGZ1bmN0aW9uKG1zZykge1xuICAgICAgICAgdmFyIGNvZGUgPSBnZXRTeXN0ZW1FcnJvckNvZGUobXNnKTtcbiAgICAgICAgIC8vIE5vbi1kZXRlcm1pbmlzdGljIGVycm9ycyBvciBzcGVjaWZpYyB0byBhIHBhcnRpY3VsYXIgbm9kZVxuICAgICAgICAgcmV0dXJuICgoY29kZSA9PT0gRVJST1JfQ09ERVMubm9TdWNoQ0EpIHx8XG4gICAgICAgICAgICAgICAgIChjb2RlID09PSBFUlJPUl9DT0RFUy5zaHV0ZG93bkNBKSB8fFxuICAgICAgICAgICAgICAgICAoY29kZSA9PT0gRVJST1JfQ09ERVMuY2hlY2twb2ludEZhaWx1cmUpIHx8XG4gICAgICAgICAgICAgICAgIChjb2RlID09PSBFUlJPUl9DT0RFUy5wcmVwYXJlRmFpbHVyZSkgfHxcbiAgICAgICAgICAgICAgICAgKGNvZGUgPT09IEVSUk9SX0NPREVTLmNvbW1pdEZhaWx1cmUpIHx8XG4gICAgICAgICAgICAgICAgIChjb2RlID09PSBFUlJPUl9DT0RFUy5iZWdpbkZhaWx1cmUpIHx8XG4gICAgICAgICAgICAgICAgIChjb2RlID09PSBFUlJPUl9DT0RFUy5pbnRlcm5hbEVycm9yKSk7XG5cbiAgICAgfTtcblxuICAgICAvKipcbiAgICAgICogQ3JlYXRlcyBhbiBlcnJvciByZXBsYXkgbWVzc2FnZVxuICAgICAgKlxuICAgICAgKiBAcGFyYW0ge2NhZi5lcnJ9IGVycm9yXG4gICAgICAqXG4gICAgICAqIEB0aHJvd3Mge0Vycm9yfSBOb3QgYSAgU3lzdGVtRXJyb3Igb3IgQXBwRXJyb3IuXG4gICAgICAqXG4gICAgICAqL1xuICAgICB2YXIgZXJyb3JSZXBseSA9IGZ1bmN0aW9uKGVycm9yKSB7XG4gICAgICAgICBpZiAoZXJyb3IubmFtZSA9PT0gJ1N5c3RlbUVycm9yJykge1xuICAgICAgICAgICAgIHJldHVybiBzeXN0ZW1FcnJvcihlcnJvci5tc2csIGVycm9yLmNvZGUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVycm9yLmVycm9yU3RyLCBlcnJvci5lcnJvcik7XG4gICAgICAgICB9IGVsc2UgaWYgKGVycm9yLm5hbWUgPT09ICdBcHBFcnJvcicpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gYXBwUmVwbHkoZXJyb3IubXNnLCBlcnJvci5lcnJvciwgbnVsbCk7XG4gICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgIHZhciBuZXdFcnIgPSBuZXcgRXJyb3IoJ2Vycm9yUmVwbHk6IG5vdCAgQXBwIG9yIFN5c3RlbSAnICtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KGVycm9yKSk7XG4gICAgICAgICAgICAgbmV3RXJyLmVyciA9IGVycm9yO1xuICAgICAgICAgICAgIHRocm93IG5ld0VycjtcbiAgICAgICAgIH1cbiAgICAgfTtcblxuICAgICAvKiogQ3JlYXRlcyBhIHJlcGx5IG1lc3NhZ2UuXG4gICAgICAqXG4gICAgICAqIEBwYXJhbSB7Y2FmLmVycn0gZXJyb3JcbiAgICAgICogQHBhcmFtIHtjYWYubXNnfSByZXF1ZXN0XG4gICAgICAqIEBwYXJhbSB7Y2FmLmpzb259IHZhbHVlXG4gICAgICAqIEByZXR1cm4ge2NkIGNhZi5tc2d9XG4gICAgICAqXG4gICAgICAqIEBmdW5jdGlvblxuICAgICAgKi9cbiAgICAganNvbl9ycGMucmVwbHkgPSBmdW5jdGlvbihlcnJvciwgcmVxdWVzdCwgdmFsdWUpIHtcbiAgICAgICAgIGlmIChlcnJvcikge1xuICAgICAgICAgICAgIHJldHVybiBlcnJvclJlcGx5KGVycm9yKTtcbiAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgcmV0dXJuIGFwcFJlcGx5KHJlcXVlc3QsIGVycm9yLCB2YWx1ZSk7XG4gICAgICAgICB9XG4gICAgIH07XG5cbiAgICAgLyoqIENyZWF0ZXMgYSByZWRpcmVjdCBtZXNzYWdlLlxuICAgICAgKlxuICAgICAgKiBAcGFyYW0ge2NhZi5tc2d9IHJlcXVlc3RcbiAgICAgICogQHBhcmFtIHtzdHJpbmd9IGVyck1zZ1xuICAgICAgKiBAcGFyYW0ge0Vycm9yfSBlcnJPcmdcbiAgICAgICogQHJldHVybiB7Y2FmLm1zZ31cbiAgICAgICpcbiAgICAgICogQGZ1bmN0aW9uXG4gICAgICAqL1xuICAgICBqc29uX3JwYy5yZWRpcmVjdCA9IGZ1bmN0aW9uKHJlcXVlc3QsIGVyck1zZywgZXJyT3JnKSB7XG4gICAgICAgICAgdmFyIGVycm9yID0ganNvbl9ycGMubmV3U3lzRXJyb3IocmVxdWVzdCwgRVJST1JfQ09ERVMuZm9yY2VSZWRpcmVjdCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlcnJNc2csIGVyck9yZyk7XG4gICAgICAgICByZXR1cm4ganNvbl9ycGMucmVwbHkoZXJyb3IpO1xuICAgICB9O1xuXG4gICAgIC8qKiBUZXN0cyBpZiBpdCBpcyBhIHJlZGlyZWN0IG1lc3NhZ2UuXG4gICAgICAqXG4gICAgICAqIEBwYXJhbSB7Y2FmLm1zZ30gbXNnXG4gICAgICAqIEByZXR1cm4ge2Jvb2xlYW59XG4gICAgICAqXG4gICAgICAqIEBmdW5jdGlvblxuICAgICAgKi9cbiAgICAgdmFyIGlzUmVkaXJlY3QgPSBqc29uX3JwYy5pc1JlZGlyZWN0ID0gZnVuY3Rpb24obXNnKSB7XG4gICAgICAgICByZXR1cm4gKGlzU3lzdGVtRXJyb3IobXNnKSAmJlxuICAgICAgICAgICAgICAgICAoZ2V0U3lzdGVtRXJyb3JDb2RlKG1zZykgPT09IEVSUk9SX0NPREVTLmZvcmNlUmVkaXJlY3QpKTtcbiAgICAgfTtcblxuICAgICAvKipcbiAgICAgICogRXh0cmFjdHMgdGhlIGRlc3RpbmF0aW9uIGFkZHJlc3Mgb2YgYSByZWRpcmVjdGlvbiBtZXNzYWdlLlxuICAgICAgKlxuICAgICAgKiBAcGFyYW0ge2NhZi5tc2d9IG1zZyBBIHJlZGlyZWN0aW9uIG1lc3NhZ2UuXG4gICAgICAqIEByZXR1cm4ge3N0cmluZ3wgbnVsbH0gQSByZWRpcmVjdGlvbiBhZGRyZXNzIG9yIG51bGwgaWYgbm90IGEgdmFsaWRcbiAgICAgICogcmVkaXJlY3Rpb24gbWVzc2FnZS5cbiAgICAgICpcbiAgICAgICogQGZ1bmN0aW9uXG4gICAgICAqL1xuICAgICBqc29uX3JwYy5yZWRpcmVjdERlc3RpbmF0aW9uID0gZnVuY3Rpb24obXNnKSB7XG4gICAgICAgICB2YXIgcmVzdWx0ID0gbnVsbDtcbiAgICAgICAgIGlmIChpc1JlZGlyZWN0KG1zZykgJiYgZ2V0U3lzdGVtRXJyb3JEYXRhKG1zZykpIHtcbiAgICAgICAgICAgICByZXN1bHQgPSBnZXRTeXN0ZW1FcnJvckRhdGEobXNnKS5yZW1vdGVOb2RlO1xuICAgICAgICAgfVxuICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgfTtcblxuICAgICAvKiogQ2hlY2tzIGlmIGl0IGlzIGEgXCJub3QgYXV0aG9yaXplZFwiIG1lc3NhZ2UuXG4gICAgICAqXG4gICAgICAqIEBwYXJhbSB7Y2FmLm1zZ30gbXNnXG4gICAgICAqIEByZXR1cm4ge2Jvb2xlYW59XG4gICAgICAqXG4gICAgICAqIEBmdW5jdGlvblxuICAgICAgKi9cbiAgICAganNvbl9ycGMuaXNOb3RBdXRob3JpemVkID0gZnVuY3Rpb24obXNnKSB7XG4gICAgICAgICByZXR1cm4gKGlzU3lzdGVtRXJyb3IobXNnKSAmJlxuICAgICAgICAgICAgICAgICAoZ2V0U3lzdGVtRXJyb3JDb2RlKG1zZykgPT09IEVSUk9SX0NPREVTLm5vdEF1dGhvcml6ZWQpKTtcbiAgICAgfTtcblxuICAgIC8qKiBDaGVja3MgaWYgaXQgaXMgYSBcInByaW5jaXBhbCBub3QgYXV0aGVudGljYXRlZFwiIG1lc3NhZ2UuXG4gICAgICAqXG4gICAgICAqIEBwYXJhbSB7Y2FmLm1zZ30gbXNnXG4gICAgICAqIEByZXR1cm4ge2Jvb2xlYW59XG4gICAgICAqXG4gICAgICAqIEBmdW5jdGlvblxuICAgICAgKi9cbiAgICAganNvbl9ycGMuaXNOb3RBdXRoZW50aWNhdGVkID0gZnVuY3Rpb24obXNnKSB7XG4gICAgICAgICByZXR1cm4gKGlzU3lzdGVtRXJyb3IobXNnKSAmJlxuICAgICAgICAgICAgICAgICAoZ2V0U3lzdGVtRXJyb3JDb2RlKG1zZykgPT09IEVSUk9SX0NPREVTLm5vdEF1dGhlbnRpY2F0ZWQpKTtcbiAgICAgfTtcblxuXG4gICAgIC8qKiBFeGVjdXRlcyBhbiBhc3luY2hyb25vdXMgbWV0aG9kIGluIGEgdGFyZ2V0IENBICB1c2luZyBhcmd1bWVudHMgaW4gYW5cbiAgICAgICogIFJQQyByZXF1ZXN0IG1lc3NhZ2UuXG4gICAgICAqXG4gICAgICAqIEBwYXJhbSB7Y2FmLm1zZ30gbXNnXG4gICAgICAqIEBwYXJhbSB7T2JqZWN0fSB0YXJnZXRcbiAgICAgICogQHBhcmFtIHtjYWYuY2J9IGNiIFJldHVybnMgZmlyc3QgYXJndW1lbnQgb3B0aW9uYWwgZXJyb3Igb2YgdHlwZVxuICAgICAgKiBjYWYuZXJyb3IgKFN5c3RlbSBvciBBcHAgZXJyb3IpICBvciwgaW4gdGhlIHNlY29uZCBhcmd1bWVudCxcbiAgICAgICogdGhlIHJlc3VsdCBvZiB0aGUgbWV0aG9kIGludm9jYXRpb24uXG4gICAgICAqXG4gICAgICAqIEBmdW5jdGlvblxuICAgICAgKi9cbiAgICAganNvbl9ycGMuY2FsbCA9IGZ1bmN0aW9uKG1zZywgdGFyZ2V0LCBjYikge1xuICAgICAgICAgdmFyIGVycm9yO1xuICAgICAgICAgaWYgKHR5cGVvZiB0YXJnZXQgIT09ICdvYmplY3QnKSB7XG4gICAgICAgICAgICAgZXJyb3IgPSBuZXdTeXNFcnJvcihtc2csIEVSUk9SX0NPREVTLm5vU3VjaENBLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgJ0NBIG5vdCBmb3VuZCcpO1xuICAgICAgICAgfVxuICAgICAgICAgaWYgKCghZXJyb3IpICYmICEoaXNSZXF1ZXN0KG1zZykgfHwgaXNOb3RpZmljYXRpb24obXNnKSkpIHtcbiAgICAgICAgICAgICBlcnJvciA9IG5ld1N5c0Vycm9yKG1zZywgRVJST1JfQ09ERVMuaW52YWxpZFJlcXVlc3QsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAnSW52YWxpZCByZXF1ZXN0Jyk7XG4gICAgICAgICB9XG4gICAgICAgICBpZiAoKCFlcnJvcikgJiYgKHR5cGVvZiB0YXJnZXRbbXNnLm1ldGhvZF0gIT09ICdmdW5jdGlvbicpKSB7XG4gICAgICAgICAgICAgZXJyb3IgPSBuZXdTeXNFcnJvcihtc2csIEVSUk9SX0NPREVTLm1ldGhvZE5vdEZvdW5kLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgJ21ldGhvZCBub3QgZm91bmQnKTtcbiAgICAgICAgIH1cbiAgICAgICAgIGlmICghZXJyb3IpIHtcbiAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICB2YXIgYXJncyA9IG1zZy5wYXJhbXMuc2xpY2UoMSk7IC8vIGdldCByaWQgb2YgbWV0YS1kYXRhXG4gICAgICAgICAgICAgICAgIHZhciBjYjEgPSBmdW5jdGlvbihlcnIsIGRhdGEpIHtcbiAgICAgICAgICAgICAgICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICBlcnIgPSBuZXdBcHBFcnJvcihtc2csICdBcHBFcnJvcicsIGVycik7XG4gICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICBjYihlcnIsIGRhdGEpO1xuICAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgICBhcmdzLnB1c2goY2IxKTtcbiAgICAgICAgICAgICAgICAgdGFyZ2V0W21zZy5tZXRob2RdLmFwcGx5KHRhcmdldCwgYXJncyk7XG4gICAgICAgICAgICAgfSBjYXRjaCAoeCkge1xuICAgICAgICAgICAgICAgICBlcnJvciA9IG5ld1N5c0Vycm9yKG1zZywgRVJST1JfQ09ERVMuZXhjZXB0aW9uVGhyb3duLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICdFeGNlcHRpb24gaW4gYXBwbGljYXRpb24gY29kZScsIHgpO1xuICAgICAgICAgICAgICAgICBjYihlcnJvcik7XG4gICAgICAgICAgICAgfVxuICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICBjYihlcnJvcik7XG4gICAgICAgICB9XG4gICAgIH07XG5cbiAgICAgLyoqIEdldHMgb3JpZ2luYWwgbWV0aG9kIGFyZ3VtZW50cyBmcm9tIG1lc3NhZ2UuXG4gICAgICAqXG4gICAgICAqIEBwYXJhbSB7Y2FmLm1zZ30gbXNnXG4gICAgICAqIEByZXR1cm4ge0FycmF5LjxjYWYuanNvbj59XG4gICAgICAqIEB0aHJvd3Mge0Vycm9yfVxuICAgICAgKiBAZnVuY3Rpb25cbiAgICAgICovXG4gICAgIGpzb25fcnBjLmdldE1ldGhvZEFyZ3MgPSBmdW5jdGlvbihtc2cpIHtcbiAgICAgICAgIGlmIChpc1JlcXVlc3QobXNnKSB8fCBpc05vdGlmaWNhdGlvbihtc2cpKSB7XG4gICAgICAgICAgICAgcmV0dXJuIG1zZy5wYXJhbXMgJiYgbXNnLnBhcmFtcy5zbGljZSgxKTtcbiAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgdmFyIGVyciA9ICBuZXcgRXJyb3IoJ0ludmFsaWQgbXNnJyk7XG4gICAgICAgICAgICAgZXJyLm1zZyA9IG1zZztcbiAgICAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgICB9XG4gICAgIH07XG5cbiAgICAgLyoqIEdldHMgdGhlIG1ldGhvZCBuYW1lIGZyb20gbWVzc2FnZS5cbiAgICAgICpcbiAgICAgICogQHBhcmFtIHtjYWYubXNnfSBtc2dcbiAgICAgICogQHJldHVybiB7c3RyaW5nfVxuICAgICAgKiBAdGhyb3dzIHtFcnJvcn1cbiAgICAgICogQGZ1bmN0aW9uXG4gICAgICAqL1xuICAgICBqc29uX3JwYy5nZXRNZXRob2ROYW1lID0gZnVuY3Rpb24obXNnKSB7XG4gICAgICAgICBpZiAoaXNSZXF1ZXN0KG1zZykgfHwgaXNOb3RpZmljYXRpb24obXNnKSkge1xuICAgICAgICAgICAgIHJldHVybiBtc2cubWV0aG9kO1xuICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICB2YXIgZXJyID0gIG5ldyBFcnJvcignSW52YWxpZCBtc2cnKTtcbiAgICAgICAgICAgICBlcnIubXNnID0gbXNnO1xuICAgICAgICAgICAgIHRocm93IGVycjtcbiAgICAgICAgIH1cbiAgICAgfTtcblxuICAgICAvKiogRnJlZXplcyBtZXRhLWRhdGEgaW4gbWVzc2FnZS5cbiAgICAgICpcbiAgICAgICogQHBhcmFtIHtjYWYubXNnfSBtc2dcbiAgICAgICpcbiAgICAgICpcbiAgICAgICogQHRocm93cyB7RXJyb3J9IGlmIG1zZyBpcyBub3QgYSBwcm9wZXIgY2FmLm1zZyB0eXBlLlxuICAgICAgKiBAZnVuY3Rpb25cbiAgICAgICovXG4gICAgIGpzb25fcnBjLm1ldGFGcmVlemUgPSBmdW5jdGlvbihtc2cpIHtcbiAgICAgICAgIE9iamVjdC5mcmVlemUobXNnKTtcbiAgICAgICAgIGlmIChpc05vdGlmaWNhdGlvbihtc2cpIHx8IGlzUmVxdWVzdChtc2cpKSB7XG4gICAgICAgICAgICAgT2JqZWN0LmZyZWV6ZShtc2cucGFyYW1zKTtcbiAgICAgICAgICAgICBPYmplY3QuZnJlZXplKG1zZy5wYXJhbXNbMF0pO1xuICAgICAgICAgfSBlbHNlIGlmIChpc0FwcFJlcGx5KG1zZykpIHtcbiAgICAgICAgICAgICBPYmplY3QuZnJlZXplKG1zZy5yZXN1bHQpO1xuICAgICAgICAgICAgIE9iamVjdC5mcmVlemUobXNnLnJlc3VsdFswXSk7XG4gICAgICAgICB9IGVsc2UgaWYgKGlzU3lzdGVtRXJyb3IobXNnKSkge1xuICAgICAgICAgICAgIE9iamVjdC5mcmVlemUobXNnLmVycm9yKTtcbiAgICAgICAgICAgICBPYmplY3QuZnJlZXplKG1zZy5lcnJvci5kYXRhKTtcbiAgICAgICAgICAgICBPYmplY3QuZnJlZXplKG1zZy5lcnJvci5kYXRhWzBdKTtcbiAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgdmFyIGVyciA9IG5ldyBFcnJvcignRnJlZXppbmcgIGJhZGx5IGRlZmluZWQgbXNnJyk7XG4gICAgICAgICAgICAgZXJyLm1zZyA9IG1zZztcbiAgICAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgICB9XG4gICAgIH07XG5cbiAgICAgLyoqIEdldHMgbWV0YS1kYXRhIGZyb20gbWVzc2FnZS5cbiAgICAgICpcbiAgICAgICogQHBhcmFtIHtjYWYubXNnfSBtc2dcbiAgICAgICogQHJldHVybiB7Y2FmLm1ldGF9XG4gICAgICAqIEB0aHJvd3Mge0Vycm9yfVxuICAgICAgKlxuICAgICAgKiBAZnVuY3Rpb25cbiAgICAgICovXG4gICAgIHZhciBnZXRNZXRhID0ganNvbl9ycGMuZ2V0TWV0YSA9IGZ1bmN0aW9uKG1zZykge1xuICAgICAgICAgaWYgKGlzUmVxdWVzdChtc2cpIHx8IGlzTm90aWZpY2F0aW9uKG1zZykpIHtcbiAgICAgICAgICAgICByZXR1cm4gbXNnLnBhcmFtc1swXTtcbiAgICAgICAgIH0gZWxzZSBpZiAoaXNBcHBSZXBseShtc2cpKSB7XG4gICAgICAgICAgICAgcmV0dXJuIG1zZy5yZXN1bHRbMF07XG4gICAgICAgICB9IGVsc2UgaWYgKGlzU3lzdGVtRXJyb3IobXNnKSkge1xuICAgICAgICAgICAgIHJldHVybiBtc2cuZXJyb3IuZGF0YVswXTtcbiAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgdmFyIGVyciA9IG5ldyBFcnJvcignTm8gbWV0YSBpbiBtc2cnKTtcbiAgICAgICAgICAgICBlcnIubXNnID0gbXNnO1xuICAgICAgICAgICAgIHRocm93IGVycjtcbiAgICAgICAgIH1cbiAgICAgfTtcblxuICAgICAvKiogU2V0cyBtZXRhLWRhdGEgaW4gbWVzc2FnZS5cbiAgICAgICpcbiAgICAgICogQHBhcmFtIHtjYWYubXNnfSBtc2dcbiAgICAgICogQHBhcmFtIHtjYWYubWV0YX0gbWV0YVxuICAgICAgKlxuICAgICAgKiBAdGhyb3dzIHtFcnJvcn1cbiAgICAgICpcbiAgICAgICogQGZ1bmN0aW9uXG4gICAgICAqL1xuICAgICB2YXIgc2V0TWV0YSA9IGpzb25fcnBjLnNldE1ldGEgPSBmdW5jdGlvbihtc2csIG1ldGEpIHtcbiAgICAgICAgIGlmIChpc1JlcXVlc3QobXNnKSB8fCBpc05vdGlmaWNhdGlvbihtc2cpKSB7XG4gICAgICAgICAgICAgbXNnLnBhcmFtc1swXSA9IG1ldGE7XG4gICAgICAgICB9IGVsc2UgaWYgKGlzQXBwUmVwbHkobXNnKSkge1xuICAgICAgICAgICAgIG1zZy5yZXN1bHRbMF0gPSBtZXRhO1xuICAgICAgICAgfSBlbHNlIGlmIChpc1N5c3RlbUVycm9yKG1zZykpIHtcbiAgICAgICAgICAgICBtc2cuZXJyb3IuZGF0YVswXSA9IG1ldGE7XG4gICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgIHZhciBlcnIgPSBuZXcgRXJyb3IoJ1NldHRpbmcgbWV0YWRhdGEgaW4gYSBiYWRseSBmb3JtYXR0ZWQgbXNnLicpO1xuICAgICAgICAgICAgIGVyci5tc2cgPSBtc2c7XG4gICAgICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICAgfVxuICAgICB9O1xuXG4gICAgIC8qKiBHZXRzIHRva2VuIGZyb20gbWV0YS1kYXRhIGluIG1lc3NhZ2UuXG4gICAgICAqXG4gICAgICAqIEBwYXJhbSB7Y2FmLm1zZ30gbXNnXG4gICAgICAqIEByZXR1cm4ge3N0cmluZyB8IHVuZGVmaW5lZH1cbiAgICAgICpcbiAgICAgICogQGZ1bmN0aW9uXG4gICAgICAqL1xuICAgICB2YXIgZ2V0VG9rZW4gPSBqc29uX3JwYy5nZXRUb2tlbiA9IGZ1bmN0aW9uKG1zZykge1xuICAgICAgICAgdmFyIG1ldGEgPSBnZXRNZXRhKG1zZyk7XG4gICAgICAgICByZXR1cm4gKG1ldGEgPyBtZXRhLnRva2VuIDogdW5kZWZpbmVkKTtcbiAgICAgfTtcblxuICAgICAvKiogR2V0cyBzZXNzaW9uIGlkIGZyb20gbWV0YS1kYXRhIGluIG1lc3NhZ2UuXG4gICAgICAqXG4gICAgICAqIEBwYXJhbSB7Y2FmLm1zZ30gbXNnXG4gICAgICAqIEByZXR1cm4ge3N0cmluZyB8IHVuZGVmaW5lZH1cbiAgICAgICpcbiAgICAgICogQGZ1bmN0aW9uXG4gICAgICAqL1xuICAgICB2YXIgZ2V0U2Vzc2lvbklkID0ganNvbl9ycGMuZ2V0U2Vzc2lvbklkID0gZnVuY3Rpb24obXNnKSB7XG4gICAgICAgICB2YXIgbWV0YSA9IGdldE1ldGEobXNnKTtcbiAgICAgICAgIHJldHVybiAobWV0YSA/IG1ldGEuc2Vzc2lvbklkIDogdW5kZWZpbmVkKTtcbiAgICAgfTtcblxuICAgICAvKiogR2V0cyB0YXJnZXQgQ0EgIGZyb20gbWV0YS1kYXRhIGluIG1lc3NhZ2UuXG4gICAgICAqXG4gICAgICAqIEBwYXJhbSB7Y2FmLm1zZ30gbXNnXG4gICAgICAqIEByZXR1cm4ge3N0cmluZyB8IHVuZGVmaW5lZH1cbiAgICAgICpcbiAgICAgICogQGZ1bmN0aW9uXG4gICAgICAqL1xuICAgICB2YXIgZ2V0VG8gPSBqc29uX3JwYy5nZXRUbyA9IGZ1bmN0aW9uKG1zZykge1xuICAgICAgICAgdmFyIG1ldGEgPSBnZXRNZXRhKG1zZyk7XG4gICAgICAgICByZXR1cm4gKG1ldGEgPyBtZXRhLnRvIDogdW5kZWZpbmVkKTtcbiAgICAgfTtcblxuICAgICAvKiogR2V0cyBzb3VyY2UgQ0EgIGZyb20gbWV0YS1kYXRhIGluIG1lc3NhZ2UuXG4gICAgICAqXG4gICAgICAqIEBwYXJhbSB7Y2FmLm1zZ30gbXNnXG4gICAgICAqIEByZXR1cm4ge3N0cmluZyB8IHVuZGVmaW5lZH1cbiAgICAgICpcbiAgICAgICogQGZ1bmN0aW9uXG4gICAgICAqL1xuICAgICB2YXIgZ2V0RnJvbSA9IGpzb25fcnBjLmdldEZyb20gPSBmdW5jdGlvbihtc2cpIHtcbiAgICAgICAgIHZhciBtZXRhID0gZ2V0TWV0YShtc2cpO1xuICAgICAgICAgcmV0dXJuIChtZXRhID8gbWV0YS5mcm9tIDogdW5kZWZpbmVkKTtcbiAgICAgfTtcblxuXG4gICAgIC8qKiBHZXRzIGVycm9yIGZpZWxkIGZyb20gYXBwbGljYXRpb24gcmVwbHkgbWVzc2FnZS5cbiAgICAgICpcbiAgICAgICogQHBhcmFtIHtjYWYubXNnfSBtc2dcbiAgICAgICogQHJldHVybiB7Y2FmLmVyciB8IHVuZGVmaW5lZH1cbiAgICAgICpcbiAgICAgICogQGZ1bmN0aW9uXG4gICAgICAqL1xuICAgICB2YXIgZ2V0QXBwUmVwbHlFcnJvciA9IGpzb25fcnBjLmdldEFwcFJlcGx5RXJyb3IgPSBmdW5jdGlvbihtc2cpIHtcbiAgICAgICAgIHJldHVybiAoaXNBcHBSZXBseShtc2cpID8gbXNnLnJlc3VsdFsxXSA6IHVuZGVmaW5lZCk7XG4gICAgIH07XG5cbiAgICAgLyoqIEdldHMgZGF0YSBmaWVsZCBmcm9tIGFwcGxpY2F0aW9uIHJlcGx5IG1lc3NhZ2UuXG4gICAgICAqXG4gICAgICAqIEBwYXJhbSB7Y2FmLm1zZ30gbXNnXG4gICAgICAqIEByZXR1cm4ge2NhZi5qc29uIHwgdW5kZWZpbmVkfVxuICAgICAgKlxuICAgICAgKiBAZnVuY3Rpb25cbiAgICAgICovXG4gICAgIHZhciBnZXRBcHBSZXBseURhdGEgPSBqc29uX3JwYy5nZXRBcHBSZXBseURhdGEgPSBmdW5jdGlvbihtc2cpIHtcbiAgICAgICAgIHJldHVybiAoaXNBcHBSZXBseShtc2cpID8gbXNnLnJlc3VsdFsyXSA6IHVuZGVmaW5lZCk7XG4gICAgIH07XG5cbiAgICAgLyoqIEdldHMgc3lzdGVtIGVycm9yIGRhdGEgZnJvbSBtZXNzYWdlLlxuICAgICAgKlxuICAgICAgKiBAcGFyYW0ge2NhZi5tc2d9IG1zZ1xuICAgICAgKiBAcmV0dXJuIHtjYWYuanNvbiB8IHVuZGVmaW5lZH1cbiAgICAgICpcbiAgICAgICogQGZ1bmN0aW9uXG4gICAgICAqL1xuICAgICB2YXIgZ2V0U3lzdGVtRXJyb3JEYXRhID0ganNvbl9ycGMuZ2V0U3lzdGVtRXJyb3JEYXRhID0gZnVuY3Rpb24obXNnKSB7XG4gICAgICAgICByZXR1cm4gKGlzU3lzdGVtRXJyb3IobXNnKSA/IG1zZy5lcnJvci5kYXRhWzFdIDogdW5kZWZpbmVkKTtcbiAgICAgfTtcblxuICAgICAvKiogR2V0cyBzeXN0ZW0gZXJyb3IgY29kZSBmcm9tIG1lc3NhZ2UuXG4gICAgICAqXG4gICAgICAqIEBwYXJhbSB7Y2FmLm1zZ30gbXNnXG4gICAgICAqIEByZXR1cm4ge251bWJlciB8IHVuZGVmaW5lZH1cbiAgICAgICpcbiAgICAgICogQGZ1bmN0aW9uXG4gICAgICAqL1xuICAgICB2YXIgZ2V0U3lzdGVtRXJyb3JDb2RlID0ganNvbl9ycGMuZ2V0U3lzdGVtRXJyb3JDb2RlID0gZnVuY3Rpb24obXNnKSB7XG4gICAgICAgICByZXR1cm4gKGlzU3lzdGVtRXJyb3IobXNnKSA/IG1zZy5lcnJvci5jb2RlIDogdW5kZWZpbmVkKTtcbiAgICAgfTtcblxuICAgICAvKiogR2V0cyBzeXN0ZW0gZXJyb3IgbXNnIGZyb20gbWVzc2FnZS5cbiAgICAgICpcbiAgICAgICogQHBhcmFtIHtjYWYubXNnfSBtc2dcbiAgICAgICogQHJldHVybiB7c3RyaW5nIHwgdW5kZWZpbmVkfVxuICAgICAgKlxuICAgICAgKiBAZnVuY3Rpb25cbiAgICAgICovXG4gICAgIHZhciBnZXRTeXN0ZW1FcnJvck1zZyA9IGpzb25fcnBjLmdldFN5c3RlbUVycm9yTXNnID0gZnVuY3Rpb24obXNnKSB7XG4gICAgICAgICByZXR1cm4gKGlzU3lzdGVtRXJyb3IobXNnKSA/IG1zZy5lcnJvci5tZXNzYWdlIDogdW5kZWZpbmVkKTtcbiAgICAgfTtcblxuICAgICAvKiogU2V0cyBzb3VyY2UgQ0EgaW4gbWVzc2FnZSBtZXRhLWRhdGEuXG4gICAgICAqXG4gICAgICAqIEBwYXJhbSB7Y2FmLm1zZ30gbXNnXG4gICAgICAqIEBwYXJhbSB7c3RyaW5nfSBmcm9tXG4gICAgICAqXG4gICAgICAqIEBmdW5jdGlvblxuICAgICAgKi9cbiAgICAgdmFyIHNldEZyb20gPSBqc29uX3JwYy5zZXRGcm9tID0gZnVuY3Rpb24obXNnLCBmcm9tKSB7XG4gICAgICAgICB2YXIgbWV0YSA9IGdldE1ldGEobXNnKSB8fCB7fTtcbiAgICAgICAgIG1ldGEuZnJvbSA9IGZyb207XG4gICAgICAgICBzZXRNZXRhKG1zZywgbWV0YSk7XG4gICAgIH07XG5cbiAgICAgLyoqIFNldHMgdGFyZ2V0IENBIGluIG1lc3NhZ2UgbWV0YS1kYXRhLlxuICAgICAgKlxuICAgICAgKiBAcGFyYW0ge2NhZi5tc2d9IG1zZ1xuICAgICAgKiBAcGFyYW0ge3N0cmluZ30gdG9cbiAgICAgICpcbiAgICAgICogQGZ1bmN0aW9uXG4gICAgICAqL1xuICAgICB2YXIgc2V0VG8gPSBqc29uX3JwYy5zZXRUbyA9IGZ1bmN0aW9uKG1zZywgdG8pIHtcbiAgICAgICAgIHZhciBtZXRhID0gZ2V0TWV0YShtc2cpIHx8IHt9O1xuICAgICAgICAgbWV0YS50byA9IHRvO1xuICAgICAgICAgc2V0TWV0YShtc2csIG1ldGEpO1xuICAgICB9O1xuXG4gICAgIC8qKiBTZXRzIHNlc3Npb24gaWQgaW4gbWVzc2FnZSBtZXRhLWRhdGEuXG4gICAgICAqXG4gICAgICAqIEBwYXJhbSB7Y2FmLm1zZ30gbXNnXG4gICAgICAqIEBwYXJhbSB7c3RyaW5nfSBzZXNzaW9uSWRcbiAgICAgICpcbiAgICAgICpcbiAgICAgICogQGZ1bmN0aW9uXG4gICAgICAqL1xuICAgICB2YXIgc2V0U2Vzc2lvbklkID0ganNvbl9ycGMuc2V0U2Vzc2lvbklkID0gZnVuY3Rpb24obXNnLCBzZXNzaW9uSWQpIHtcbiAgICAgICAgIHZhciBtZXRhID0gZ2V0TWV0YShtc2cpIHx8IHt9O1xuICAgICAgICAgbWV0YS5zZXNzaW9uSWQgPSBzZXNzaW9uSWQ7XG4gICAgICAgICBzZXRNZXRhKG1zZywgbWV0YSk7XG4gICAgIH07XG5cbiAgICAgLyoqIFNldHMgdG9rZW4gaW4gbWVzc2FnZSBtZXRhLWRhdGEuXG4gICAgICAqXG4gICAgICAqIEBwYXJhbSB7Y2FmLm1zZ30gbXNnXG4gICAgICAqIEBwYXJhbSB7c3RyaW5nfSB0b2tlblxuICAgICAgKlxuICAgICAgKiBAZnVuY3Rpb25cbiAgICAgICovXG4gICAgIHZhciBzZXRUb2tlbiA9IGpzb25fcnBjLnNldFRva2VuID0gZnVuY3Rpb24obXNnLCB0b2tlbikge1xuICAgICAgICAgdmFyIG1ldGEgPSBnZXRNZXRhKG1zZykgfHwge307XG4gICAgICAgICBtZXRhLnRva2VuID0gdG9rZW47XG4gICAgICAgICBzZXRNZXRhKG1zZywgbWV0YSk7XG4gICAgIH07XG5cblxuXG5cbiAgICAgLyoqXG4gICAgICAqIFNwbGl0cyBhIGNvbXBvdW5kIG5hbWUgaW50byBuYW1lc3BhY2Ugcm9vdCBhbmQgbG9jYWwgbmFtZS5cbiAgICAgICogIFRoZSBjb252ZW50aW9uIGlzIHRvIHVzZSB0aGUgY2hhcmFjdGVyICctJyB0byBzZXBhcmF0ZSB0aGVtLlxuICAgICAgKlxuICAgICAgKiBAcGFyYW0ge3N0cmluZ30gbmFtZSBBIG5hbWUgdG8gc3BsaXQuXG4gICAgICAqIEByZXR1cm4ge0FycmF5LjxzdHJpbmc+fSBBbiBhcnJheSB3aXRoIHR3byBlbGVtZW50czogbmFtZXNwYWNlIHJvb3QgYW5kXG4gICAgICAqIGxvY2FsIG5hbWUuXG4gICAgICAqXG4gICAgICAqIEB0aHJvd3Mge0Vycm9yfSBJbnZhbGlkIGNvbXBvdW5kIG5hbWUuXG4gICAgICAqIEBuYW1lICBqc29uX3JwYy9zcGxpdE5hbWVcbiAgICAgICogQGZ1bmN0aW9uXG4gICAgICAqXG4gICAgICAqL1xuICAgICB2YXIgc3BsaXROYW1lID0ganNvbl9ycGMuc3BsaXROYW1lID0gZnVuY3Rpb24obmFtZSkge1xuICAgICAgICAgdmFyIHJlc3VsdCA9IG5hbWUuc3BsaXQoTkFNRV9TRVBBUkFUT1IpO1xuICAgICAgICAgaWYgKHJlc3VsdC5sZW5ndGggPT09IDIpIHtcbiAgICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICB2YXIgZXJyID0gbmV3IEVycm9yKCdJbnZhbGlkIG5hbWUnKTtcbiAgICAgICAgICAgICBlcnIubmFtZSA9IG5hbWU7XG4gICAgICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICAgfVxuICAgICB9O1xuXG5cbiAgICAgaWYgKHR5cGVvZiBtb2R1bGUgIT09ICd1bmRlZmluZWQnICYmIG1vZHVsZS5leHBvcnRzKSB7XG4gICAgICAgICAvLyBub2RlLmpzXG4gICAgICAgICBtb2R1bGUuZXhwb3J0cyA9IGpzb25fcnBjO1xuICAgICB9IGVsc2UgaWYgKHR5cGVvZiBkZWZpbmUgIT09ICd1bmRlZmluZWQnICYmIGRlZmluZS5hbWQpIHtcbiAgICAgICAgIC8vIEFNRCAvIFJlcXVpcmVKU1xuICAgICAgICAgZGVmaW5lKFtdLCBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBqc29uX3JwYztcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgfSBlbHNlIHtcbiAgICAgICAgIC8vIDxzY3JpcHQ+IHRhZ1xuICAgICAgICAgcm9vdC5qc29uX3JwYyA9IGpzb25fcnBjO1xuICAgICB9XG5cbiB9KCkpO1xuIiwiLyohXG5Db3B5cmlnaHQgMjAxNCBIZXdsZXR0LVBhY2thcmQgRGV2ZWxvcG1lbnQgQ29tcGFueSwgTC5QLlxuXG5MaWNlbnNlZCB1bmRlciB0aGUgQXBhY2hlIExpY2Vuc2UsIFZlcnNpb24gMi4wICh0aGUgXCJMaWNlbnNlXCIpO1xueW91IG1heSBub3QgdXNlIHRoaXMgZmlsZSBleGNlcHQgaW4gY29tcGxpYW5jZSB3aXRoIHRoZSBMaWNlbnNlLlxuWW91IG1heSBvYnRhaW4gYSBjb3B5IG9mIHRoZSBMaWNlbnNlIGF0XG5cbiAgICAgICBodHRwOi8vd3d3LmFwYWNoZS5vcmcvbGljZW5zZXMvTElDRU5TRS0yLjBcblxuVW5sZXNzIHJlcXVpcmVkIGJ5IGFwcGxpY2FibGUgbGF3IG9yIGFncmVlZCB0byBpbiB3cml0aW5nLCBzb2Z0d2FyZVxuZGlzdHJpYnV0ZWQgdW5kZXIgdGhlIExpY2Vuc2UgaXMgZGlzdHJpYnV0ZWQgb24gYW4gXCJBUyBJU1wiIEJBU0lTLFxuV0lUSE9VVCBXQVJSQU5USUVTIE9SIENPTkRJVElPTlMgT0YgQU5ZIEtJTkQsIGVpdGhlciBleHByZXNzIG9yIGltcGxpZWQuXG5TZWUgdGhlIExpY2Vuc2UgZm9yIHRoZSBzcGVjaWZpYyBsYW5ndWFnZSBnb3Zlcm5pbmcgcGVybWlzc2lvbnMgYW5kXG5saW1pdGF0aW9ucyB1bmRlciB0aGUgTGljZW5zZS5cbiovXG5cInVzZSBzdHJpY3RcIjtcblxuZXhwb3J0cy5qc29uX3JwYyA9IHJlcXVpcmUoJy4vanNvbl9ycGMnKTtcblxuLy8gbW9kdWxlXG5leHBvcnRzLmdldE1vZHVsZSA9IGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiBtb2R1bGU7XG59O1xuIiwiXG4vKipcbiAqIE1vZHVsZSBkZXBlbmRlbmNpZXMuXG4gKi9cblxudmFyIGdsb2JhbCA9IChmdW5jdGlvbigpIHsgcmV0dXJuIHRoaXM7IH0pKCk7XG5cbi8qKlxuICogV2ViU29ja2V0IGNvbnN0cnVjdG9yLlxuICovXG5cbnZhciBXZWJTb2NrZXQgPSBnbG9iYWwuV2ViU29ja2V0IHx8IGdsb2JhbC5Nb3pXZWJTb2NrZXQ7XG5cbi8qKlxuICogTW9kdWxlIGV4cG9ydHMuXG4gKi9cblxubW9kdWxlLmV4cG9ydHMgPSBXZWJTb2NrZXQgPyB3cyA6IG51bGw7XG5cbi8qKlxuICogV2ViU29ja2V0IGNvbnN0cnVjdG9yLlxuICpcbiAqIFRoZSB0aGlyZCBgb3B0c2Agb3B0aW9ucyBvYmplY3QgZ2V0cyBpZ25vcmVkIGluIHdlYiBicm93c2Vycywgc2luY2UgaXQnc1xuICogbm9uLXN0YW5kYXJkLCBhbmQgdGhyb3dzIGEgVHlwZUVycm9yIGlmIHBhc3NlZCB0byB0aGUgY29uc3RydWN0b3IuXG4gKiBTZWU6IGh0dHBzOi8vZ2l0aHViLmNvbS9laW5hcm9zL3dzL2lzc3Vlcy8yMjdcbiAqXG4gKiBAcGFyYW0ge1N0cmluZ30gdXJpXG4gKiBAcGFyYW0ge0FycmF5fSBwcm90b2NvbHMgKG9wdGlvbmFsKVxuICogQHBhcmFtIHtPYmplY3QpIG9wdHMgKG9wdGlvbmFsKVxuICogQGFwaSBwdWJsaWNcbiAqL1xuXG5mdW5jdGlvbiB3cyh1cmksIHByb3RvY29scywgb3B0cykge1xuICB2YXIgaW5zdGFuY2U7XG4gIGlmIChwcm90b2NvbHMpIHtcbiAgICBpbnN0YW5jZSA9IG5ldyBXZWJTb2NrZXQodXJpLCBwcm90b2NvbHMpO1xuICB9IGVsc2Uge1xuICAgIGluc3RhbmNlID0gbmV3IFdlYlNvY2tldCh1cmkpO1xuICB9XG4gIHJldHVybiBpbnN0YW5jZTtcbn1cblxuaWYgKFdlYlNvY2tldCkgd3MucHJvdG90eXBlID0gV2ViU29ja2V0LnByb3RvdHlwZTtcbiIsIi8qIVxuQ29weXJpZ2h0IDIwMTMgSGV3bGV0dC1QYWNrYXJkIERldmVsb3BtZW50IENvbXBhbnksIEwuUC5cblxuTGljZW5zZWQgdW5kZXIgdGhlIEFwYWNoZSBMaWNlbnNlLCBWZXJzaW9uIDIuMCAodGhlIFwiTGljZW5zZVwiKTtcbnlvdSBtYXkgbm90IHVzZSB0aGlzIGZpbGUgZXhjZXB0IGluIGNvbXBsaWFuY2Ugd2l0aCB0aGUgTGljZW5zZS5cbllvdSBtYXkgb2J0YWluIGEgY29weSBvZiB0aGUgTGljZW5zZSBhdFxuXG4gICAgICAgaHR0cDovL3d3dy5hcGFjaGUub3JnL2xpY2Vuc2VzL0xJQ0VOU0UtMi4wXG5cblVubGVzcyByZXF1aXJlZCBieSBhcHBsaWNhYmxlIGxhdyBvciBhZ3JlZWQgdG8gaW4gd3JpdGluZywgc29mdHdhcmVcbmRpc3RyaWJ1dGVkIHVuZGVyIHRoZSBMaWNlbnNlIGlzIGRpc3RyaWJ1dGVkIG9uIGFuIFwiQVMgSVNcIiBCQVNJUyxcbldJVEhPVVQgV0FSUkFOVElFUyBPUiBDT05ESVRJT05TIE9GIEFOWSBLSU5ELCBlaXRoZXIgZXhwcmVzcyBvciBpbXBsaWVkLlxuU2VlIHRoZSBMaWNlbnNlIGZvciB0aGUgc3BlY2lmaWMgbGFuZ3VhZ2UgZ292ZXJuaW5nIHBlcm1pc3Npb25zIGFuZFxubGltaXRhdGlvbnMgdW5kZXIgdGhlIExpY2Vuc2UuXG4qL1xuXG5cInVzZSBzdHJpY3RcIjtcbm1vZHVsZS5leHBvcnRzID0gcmVxdWlyZSgnLi9saWIvbWFpbicpO1xuIl19
