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

'use strict';

var json_rpc = require('caf_transport').json_rpc;


/**
 * Stringifies an error object so that the stack is properly formatted in the
 * console.
 *
 * @param {Error} err An error object to log or send.
 *
 * @return {string} A string representation of the error.
 */
var errToPrettyStr = function(err) {
    var errToStr = function(err) {
        var obj = {};
        Object.getOwnPropertyNames(err)
            .forEach(function(key) { obj[key] = err[key]; });
        return JSON.stringify(obj, null, 2);
    };

    var result = errToStr(err);
    if (typeof result === 'string') {
        result = result.replace(/\\n/g, '\n');
    }
    return result;
};


/**
 * A queue of pending requests.
 *
 * @module caf_cli/Queue
 */
exports.Queue = function(caId, options) {
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
            options.timeAdjuster && options.timeAdjuster
                .startRequest(pending.req);
            webSocket.send(JSON.stringify(pending.req));
        } catch (err) {
            /* Cannot send, wait for a new websocket that
             * with its open event will trigger 'retry'.
             *
             */
            options.log('Exception sending request ' + err);
            options.log(errToPrettyStr(err));
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
            var err = new Error(msg);
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
        queue.push({cb: cb, req: req});
        drain(webSocket);
    };

    that.processAppReply = function(webSocket, reply) {
        if (pending && pending.req && (reply.id === pending.req.id) &&
            (json_rpc.isAppReply(reply))) {
            var cb = pending.cb;
            var err = json_rpc.getAppReplyError(reply);
            var data = json_rpc.getAppReplyData(reply);
            options.timeAdjuster && options.timeAdjuster.endRequest(reply);
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
