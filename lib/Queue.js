// Modifications copyright 2020 Caf.js Labs and contributors
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

const json_rpc = require('caf_transport').json_rpc;


/*
 * Stringifies an error object so that the stack is properly formatted in the
 * console.
 *
 * @param {Error} err An error object to log or send.
 *
 * @return {string} A string representation of the error.
 */
const errToPrettyStr = function(err) {
    const errToStr = function(err) {
        const obj = {};
        Object.getOwnPropertyNames(err)
            .forEach(function(key) { obj[key] = err[key]; });
        return JSON.stringify(obj, null, 2);
    };

    let result = errToStr(err);
    if (typeof result === 'string') {
        result = result.replace(/\\n/g, '\n');
    }
    return result;
};


/**
 * A queue of pending requests.
 *
 * This class is internal.
 *
 * @module caf_cli/Queue
 */
exports.Queue = function(caId, options) {
    var queue = [];
    const that = {};
    var pending = null;
    var messagesProcessed = 0;
    var lastMessagesProcessed = -1;

    // duplicate, move to util
    const safeSetImmediate = function(f) {
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

    const drain = function(webSocket) {
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
        const doThrow = function(msg) {
            const err = new Error(msg);
            err['method'] = method;
            err['args'] = args;
            err['expectedArgs'] = expectedArgs;
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
        if (args.length !== expectedArgs.length + 1) { //'cb' removed by server
            doThrow('Unexpected number of arguments');
        }

        const cb = args.pop();
        if (typeof cb !== 'function') {
            doThrow('No callback');
        }
        const all = [options.token, caId, options.from, options.session, method]
            .concat(args);

        const req = json_rpc.request.apply(json_rpc.request, all);
        queue.push({cb, req});
        if (options.maxQueueLength && (queue.length > options.maxQueueLength)) {
            const {cb, req} = queue.shift();
            const err = new Error('Max queue length exceeded');
            err['maxQueueLength'] = true;
            err['request'] = req;
            safeSetImmediate(() => cb(err));
        }
        drain(webSocket);
    };

    that.processAppReply = function(webSocket, reply) {
        if (pending && pending.req && (reply.id === pending.req.id) &&
            json_rpc.isAppReply(reply)) {
            const cb = pending.cb;
            const err = json_rpc.getAppReplyError(reply);
            const data = json_rpc.getAppReplyData(reply);
            options.timeAdjuster && options.timeAdjuster.endRequest(reply);
            safeSetImmediate(() => cb(err, data));
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
