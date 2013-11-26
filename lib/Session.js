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
/**
 *
 * A communication session object with a CA that provides  a channel for remote
 * invocations and another one for notifications.
 *
 *  It emits an 'error' event when disconnects permanently due to channel
 * failure.
 *
 * It delegates to a dispatcher object notifications from the CA.
 *
 * @module caf_cli/Session
 */


var util = require('util');
var events = require('events');
var caf = require('caf_core');
var json_rpc = caf.json_rpc;
var Channel = require('./Channel').Channel;
var BackChannel = require('./BackChannel').BackChannel;
var url = require('url');
var util_accounts = require('./util_accounts');

var extractName = function(urlStr) {
    var p = url.parse(urlStr).pathname.split('/ca/');
    return p.pop();
};

/**
 * Constructor for a Session object.
 *
 * spec format is
 *
 *     { appHostname: string,
 *       appProtocol:string,
 *       caName:string,
 *       url:string, // e.g.,'http://helloworld.cafjs.com/ca/antonio_hello'
 *       proxy:string, // an optional http proxy to traverse local firewalls
 *       loginUrl:string, // basic authentication url
 *       accountsUrl:string, // Url of an external authentication service
 *                           // e.g., http://accounts.cafjs.com
 *       username:<string>,
 *       password:<string>,
 *       token:<string>,
 *       sessionId:<string>,
 *       cbObject:<object>, //object to handle notifications
 *       cbMethod:<string>, // method name to notify, defaults to 'dispatcher'
 *       myId:<string>,
 *       maxRetries:<number>,
 *       retryTimeout:<number>,
 *       log:<object>,
 *       disableBackChannel:<boolean>}
 *
 * where only url (or appHostname/appProtocol/caName) and  password (when
 * security is on) do not have sensible defaults.
 *
 * @param {Object} spec Config data for the session.
 * @constructor
 */
var Session = exports.Session = function(spec) {

    var self = this;
    events.EventEmitter.call(this);

    this.url = spec.url;
    if (!this.url) {
        // assemble target URL
        var appHostname = spec.appHostname || 'localhost';
        var appProtocol = spec.appProtocol || 'http:';
        // A name for our target CA. By convention we use '<owner>_<localName>'
        var caName = spec.caName;
        this.url = appProtocol + '//' + appHostname + '/ca/' + caName;
        spec.url = this.url;
    }
    this.loginUrl = spec.loginUrl;
    if (!this.loginUrl) {
        this.loginUrl = this.url.split('/ca/')[0] + '/login/' +
            this.url.split('/ca/')[1];
    }

    this.accountsUrl = spec.accountsUrl;

    this.caName = extractName(this.url);
    this.username = (spec.username ? spec.username : this.caName.split('_')[0]);
    this.caLocalName =  this.caName.split('_')[1];
    this.password = spec.password || 'changeme';
    this.token = spec.token || json_rpc.DUMMY_TOKEN;

    // Only the CA owner can pull the backChannel
    this.disableBackChannel = spec.disableBackChannel ||
        (this.username !== this.caName.split('_')[0]);

    // An optional id to populate the 'from' field of requests
    this.myId = spec.myId || this.username + '_' + json_rpc.DEFAULT_FROM_ID;

    // a logical name for this session that maps to an output queue in the CA
    this.sessionId = spec.sessionId || 'default';

    // Object registered to receive notifications
    this.cbObject = spec.cbObject || null;
    // Method name in that Object that will be called with the notif
    this.cbMethod = spec.cbMethod || 'dispatcher';

    // Session level retries to reconnect after 'offline'
    this.maxRetries = spec.maxRetries || 10000000000;
    this.retryTimeout = spec.retryTimeout || 1000; //msec

    this.log = spec.log || null;

    this.proxy = spec.proxy;

    this.reqChannel = new Channel(spec);
    this.reqChannel
        .on('error', function(err) {
                self.disconnectHandler(err);
            })
        .on('badToken', function(lastToken) {
                self.newLogin(lastToken);
            });

    // reuse the cookie jar for both channels
    spec.cookieJar = this.reqChannel.cookieJar;
    if (!(this.disableBackChannel)) {
        var req = {'getToken': this.getTokenF(), 'to' : this.caName,
                   'from' : this.myId,
                   'sessionId' : this.sessionId,
                   /* methodName in the backchanel request is just used for
                    *  future notifications from the CA since the pull method
                    * name of any CA is fixed. So it is not a method of the CA
                    * it is just a method of the local 'cbObject'
                    */
                   'methodName': this.cbMethod,
                   'argsList' : []};
        this.backChannel = new BackChannel(spec, req);
        this.backChannel
            .on('error', function(err) {
                    self.disconnectHandler(err);
                })
            .on('notified', function(notif) {
                    self.notificationHandler(notif);
                })
            .on('badToken', function(lastToken) {
                    self.newLogin(lastToken);
                });
        this.backChannel.pull();
    } else {
        this.log && this.log.warn('BackChannel disabled.');
    }

    if (!this.accountsUrl) {
        spec.url = this.loginUrl;
        this.loginChannel = new Channel(spec);
        this.loginChannel
            .on('error', function(err) {
                    self.disconnectHandler(err);
                })
            .on('badToken', function(lastToken) {
                    // password failed
                    self.badLogin(lastToken, 'BadToken emitted in login ' +
                                  'channel');
                });
    }
    this.loginPending = false;
};

util.inherits(Session, events.EventEmitter);

// Public API

/**
 *  Invokes asynchronously a remote CA's method.
 *
 * @param {string} methodName A method to be called.
 * @param {Array.<caf.json>} argsList An array with the method arguments.
 * @param {caf.cb} cb A standard node.js callback to return method
 * results or errors.
 *
 *
 */
Session.prototype.remoteInvoke = function(methodName, argsList, cb) {
    var req = {'getToken': this.getTokenF(), 'to' : this.caName,
               'from' : this.myId,
               'sessionId' : this.sessionId,
               'methodName': methodName, 'argsList' : argsList};
    this.reqChannel.invokeAsync(req, cb);
};


/**
 * Ensures that the session is ready. This is convenient to minimize
 * latency of the first command or to handle session errors before issuing
 * commands.
 *
 * @param {caf.cb} cb A standard node.js callback to return session errors.
 *
 */
Session.prototype.touch = function(cb) {
    this.remoteInvoke('__external_ca_touch__',[], cb);
};

/**
 * Shutdowns the session.
 *
 */
Session.prototype.shutdown = function() {
    this.reqChannel.shutdown();
    this.backChannel && this.backChannel.shutdown();
    this.loginChannel && this.loginChannel.shutdown();
};

// Internal methods


Session.prototype.badLogin = function(lastToken, info) {
    var self = this;
    var logMsg = 'Session: Bad Login: Last Token:' + lastToken +
        ' info:' + JSON.stringify(info);
    this.log && this.log.error(logMsg);
    if (lastToken === this.token) {
        self.disconnectHandler('Authorization failed');
    }
};

Session.prototype.newLogin = function(lastToken) {
    if (!this.loginPending) {
        var self = this;
        var logMsg = 'Session: New Login: Last Token: ' + lastToken;
        this.log && this.log.error(logMsg);
        var cb = function(err, token) {
            self.loginPending = false;
            if (err) {
                self.badLogin(lastToken, err);
            } else {
                self.token = token;
            }
        };
        if (lastToken === this.token) {
            this.loginPending = true;
            if (this.accountsUrl) {
                util_accounts.requestToken(this.accountsUrl, this.proxy,
                                           this.log, this.username,
                                           this.password,
                                           this.url, this.caLocalName, cb);
            } else {
                var req = {'getToken': this.getTokenF(), 'to' : this.caName,
                           'from' : this.myId,
                           'sessionId' : this.sessionId,
                           'methodName': 'authenticate',
                           'argsList' : [this.username, this.password]};
                this.loginChannel.invokeAsync(req, cb);
            }
        }
    }  else {
        this.log && this.log.debug("Ignoring parallel login request");
    }
};

Session.prototype.disconnectHandler = function(err) {
    var logMsg = 'Session: Error' + JSON.stringify(err);
    this.log && this.log.error(logMsg);
    this.shutdown();
    this.emit('error', err);
};

Session.prototype.notificationHandler = function(notif) {
    if (this.cbObject) {
        var cb = function(err) {
            if (err) {
                var errorLogMsg = 'Session: got notification error ' +
                    JSON.stringify(err);
                this.log && this.log.debug(errorLogMsg);
            }
        };
        json_rpc.call(notif, this.cbObject, cb);
    } else {
        var logMsg = 'Session: got notification ' + JSON.stringify(notif);
        this.log && this.log.debug(logMsg);
    }
};


Session.prototype.getTokenF = function() {
    var self = this;
    return function() {
        return self.token;
    };
};

