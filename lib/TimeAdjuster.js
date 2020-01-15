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

const json_rpc = require('caf_transport').json_rpc;

/**
 * Approximates a time offset to match the UTC time in the server.
 *
 * This is needed when the client does not have accurate time, e.g., it
 * cannot rely on NTP, or an RTC with battery.
 *
 * The approach that follows is very similar to NTP: assume symmetric
 * propagation times in a round trip, and pick the shortest round trip time
 * within a window of requests. If needed, we also low pass filter the
 * resulting time offsets.
 *
 * Every client request to a CA piggybacks time information. And after a few
 * requests, the time error after applying the offset is <100ms in most cases.
 *
 * @module caf_cli/TimeAdjuster
 *
 */

const MORE_HARM_THAN_GOOD = 300;/* Max RTT in msec, a larger value adds too much
                                 error. */
const MAX_WINDOW_SIZE = 8;

const SMOOTH = 1.0; // no filtering

const TimeWindow = function(options) {
    const that = {};
    const window = [];
    var lastDelta = 0;
    const smooth = typeof options.timeSmooth === 'number' ?
        options.timeSmooth :
        SMOOTH;
    const maxRTT = typeof options.timeMaxRTT === 'number' ?
        options.timeMaxRTT :
        MORE_HARM_THAN_GOOD;
    const maxWindow = typeof options.timeMaxWindow === 'number' ?
        options.timeMaxWindow :
        MAX_WINDOW_SIZE;

    that.adjust = function(rtt, delta) {
        if (rtt <= maxRTT) {
            if (window.length >= maxWindow) {
                window.shift();
            }
            window.push({rtt: rtt, delta: delta});
            var minRTT = 99999999999999999999;
            var minIndex = -1;
            for (let i = 0; i < window.length; i++) {
                if (window[i].rtt < minRTT) {
                    minRTT = window[i].rtt;
                    minIndex = i;
                }
            }
            // low pass filter with exponential moving average
            lastDelta = Math.round(smooth * window[minIndex].delta +
                                   (1 - smooth) * lastDelta);
        }
        return lastDelta;
    };

    return that;
};

/**
 * Constructor.
 *
 * See `types.js` for a description of type `timeAdjusterOptionsType`.
 *
 * @param {timeAdjusterOptionsType} options Configuration options.
 *
 * @memberof! module:caf_cli/TimeAdjuster
 * @alias TimeAdjuster
 */
exports.TimeAdjuster = function(options) {
    const t1 = {};
    var offset = 0;
    const timeWindow = TimeWindow(options);

    const that = {};

    /**
     * Starts a request to be timed.
     *
     * @param {msgType} request A request to be timed.
     *
     * @memberof! module:caf_cli/TimeAdjuster#
     * @alias startRequest
     */
    that.startRequest = function(request) {
        const id = request.id;
        const old = t1[id];
        if (typeof old === 'number') {
            // retry, ignoring timing.
            delete t1[id];
        } else {
            t1[id] = new Date().getTime();
        }
    };

    /**
     * Ends a roundtrip with a response.
     *
     * @param {msgType} response A response.
     *
     * @memberof! module:caf_cli/TimeAdjuster#
     * @alias endRequest
     */
    that.endRequest = function(response) {
        const id = response.id;
        if (id) {
            const meta = json_rpc.getMeta(response);
            const myT1 = t1[id];
            delete t1[id];
            if ((typeof myT1 === 'number') && meta.startTime && meta.endTime) {
                const t2 = meta.startTime;
                const t3 = meta.endTime;
                const t4 = new Date().getTime();
                const rtt = (t4 - myT1) - (t3 -t2);
                const delta = Math.round(((t2 - myT1) + (t3 - t4))/2);
                offset = timeWindow.adjust(rtt, delta);
            }
        }
    };

    /**
     * Returns the time offset.
     *
     * Add this value to the current time to match server time, e.g.:
     *
     *      const now = new Date().getTime();
     *      now = now + timeAdjuster.getOffset();
     *
     * @return {number} A time offset
     *
     * @memberof! module:caf_cli/TimeAdjuster#
     * @alias offset
     */
    that.getOffset = function() {
        return offset;
    };

    return that;
};
