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
"use strict";

exports.methods = {
    "__ca_init__" : function(cb) {
        this.$.log.debug("++++++++++++++++Calling init");
        this.state.pulses = 0;
        cb(null);
    },
    "__ca_resume__" : function(cp, cb) {
        this.$.log.debug("++++++++++++++++Calling resume: pulses=" +
                         this.state.pulses);

        cb(null);
    },
    "__ca_pulse__" : function(cb) {
        var self = this;
        this.state.pulses = this.state.pulses + 1;
        this.$.log.debug('<<< Calling Pulse>>>' + this.state.pulses);
        if (this.state.notify) {
            this.state.notify.forEach(function(x) {
                                          self.$.session.notify(x);
                                      });
            this.state.notify = [];
        }
        cb(null);
    },
    hello: function(msg, cb) {
        this.state.lastMsg = msg;
        cb(null, 'Bye:' + msg);
    },
    helloFail: function(msg, cb) {
        this.state.lastMsg = msg;
        var err = new Error('Something bad happened');
        err.msg = 'helloFail';
        cb(err);
    },
    helloException: function(msg, cb) {
        this.state.lastMsg = msg;
        var f = function() {
            var err = new Error('Something really bad happened');
            err.msg = 'helloException';
            throw err;
        };
        f();
    },
    helloDelayException: function(msg, cb) {
        this.state.lastMsg = msg;
        var f = function() {
            var err = new Error('Something really bad happened');
            err.msg = 'helloDelayException';
            throw err;
        };
        setTimeout(f, 100);
    },
    helloNotify: function(msg, cb) {
        this.state.notify = this.state.notify || [];
        this.state.notify.push(['helloNotify:'+msg]);
        cb(null);
    },
    failPrepareAlt: function(msg, cb) {
        /* 'scratch' is non-transactional, non-persistent.
         *
         *  The following works because there is no CA shutdown between calls.
         *
         * Using 'state' does not work because the exception rolls-back changes,
         * and it always fails...
         */
        if (!this.scratch[msg]) {
            // fail
            var p = {};
            p.x = p; // circular, non-serializable, fails in prepare
            this.state.p = p;
            this.scratch[msg] = true;
        } else {
            // no failure
            this.scratch[msg] = false;
        }
        cb(null, 'Bye:' + msg);
    },
    getLastMessage: function(cb) {
        cb(null, this.state.lastMsg);
    },
    getQueueLength: function(cb) {
        cb(null, this.$.inq.queueLength());
    }
};
